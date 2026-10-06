/* ============================================================
   本地开发服务器（零依赖）
   ------------------------------------------------------------
   一个进程同时提供三样东西：

     /            静态站（与线上产物完全一致，可直接双击打开的那批文件）
     /_admin/     管理页 —— **只存在于这个进程的路由里**
     /api/…       写接口 —— 只监听回环 + 同源判定 + 会话令牌

   所以"只有我能改"这件事的实现方式是：公开发布的那份文件里，
   根本没有管理页、也没有任何写代码。不是"藏起来"，是"不存在"。

   用法：
     node blog-enter/server/dev-server.mjs                 # http://127.0.0.1:8848/
     node blog-enter/server/dev-server.mjs --port 9000
     node blog-enter/server/dev-server.mjs --set-pass --pass "口令"
     node blog-enter/server/dev-server.mjs --clear-pass

   安全设计（逐条都能在 security.mjs / auth.mjs 里查到实现）：
     1. 只绑 127.0.0.1，没有"顺手绑 0.0.0.0"的开关
     2. 对端必须是回环地址（防被反代/隧道转发进来）
     3. Host 头必须是本机名 + 本次端口（防 DNS rebinding）
     4. Origin / Referer / Sec-Fetch-Site 必须同源（防 CSRF）
     5. 写操作要会话令牌，令牌每次启动重新生成
     6. 静态文件限制在站点根内，隐藏目录（.git / .admin / .preview）一律 404
     7. 所有响应 nosniff；管理页额外上严格 CSP 与 noindex

   这个文件既是 CLI 也是模块：createApp() 返回一个未监听的 http.Server，
   验签脚本可以在同一个进程里起它、打真实请求，不需要 spawn 子进程
   （受限环境下 spawn 会因命名管道被拒）。
   ============================================================ */
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from './lib/posts-store.mjs';
import * as security from './lib/security.mjs';
import * as auth from './lib/auth.mjs';
import * as images from './lib/images.mjs';
import * as backup from './lib/backup.mjs';
import * as git from './lib/git.mjs';
import { validatePost, inspectHtml, LIMITS } from './lib/validate.mjs';
import { HttpError, safeJoin, assertInside, human, writeFileAtomic } from './lib/util.mjs';

const SERVER_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const BLOG_DIR = resolve(SERVER_DIR, '..');
const REPO_DIR = resolve(BLOG_DIR, '..');

const MAX_JSON = 1024 * 1024;
const MAX_IMAGE = images.IMAGE_LIMITS.bytes + 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8'
};

/* 管理页只允许这几个文件名，不做目录列举 */
const ADMIN_ASSETS = {
  '/_admin/': 'index.html',
  '/_admin/index.html': 'index.html',
  '/_admin/admin.css': 'admin.css',
  '/_admin/admin.js': 'admin.js'
};

/* ------------------------------------------------------------
   配置
   ------------------------------------------------------------ */
export const resolveConfig = (options) => {
  const o = options || {};
  const blogDir = resolve(o.blogDir || BLOG_DIR);
  const repoDir = resolve(o.repoDir || REPO_DIR);
  return {
    host: o.host || '127.0.0.1',                 // 有意写死：见文件头第 1 条
    port: Number(o.port || 8848),
    blogDir,
    repoDir,
    runtimeDir: resolve(o.runtimeDir || join(repoDir, '.admin')),
    /* 管理页的静态文件是**代码**，放在站点里随仓库走；
       而 .admin/ 只放运行时数据（会话令牌、口令哈希、备份、回收站）。
       两者混在一起的话，.admin 既得入库（代码）又必须忽略（机密），
       迟早会有人把 session.json 提交上去。 */
    uiDir: resolve(o.uiDir || join(blogDir, 'admin')),
    postsFile: join(blogDir, 'js', 'posts.js'),
    uploadsDir: join(blogDir, 'img', 'uploads'),
    postsRel: o.postsRel || 'blog-enter/js/posts.js',
    now: () => Date.now(),

    /* ---------- 远端模式（默认全关，本地行为一字不改） ---------- */
    /* remote=true 时：
         · 所有 /api/*（除 /api/login）都要先过解锁闸，含 GET；
         · 用每客户端会话 cookie 判定解锁，而不是进程全局布尔；
         · 强制要求已设口令（否则拒绝启动，见 main()）。 */
    remote: o.remote === true,
    /* 反代带来的真实站点名（IP / 域名），加进 Host 白名单 */
    publicHosts: Array.isArray(o.publicHosts) ? o.publicHosts.slice() : [],
    /* 允许的 Origin，精确匹配（例如 https://simonfu.xin）。
       给了它，cookie 的 Secure 由它是不是 https 决定。 */
    publicOrigins: Array.isArray(o.publicOrigins) ? o.publicOrigins.slice() : [],
    /* 反代共享密钥：从文件读进来的内容；空则不做这项校验 */
    proxySecret: o.proxySecret || null,
    /* 是否信任 X-Forwarded-For（只有确认请求必经我们的 nginx 时才开） */
    trustProxy: o.trustProxy === true,
    /* 会话空闲超时（毫秒） */
    sessionIdleMs: Number(o.sessionIdleMs || (2 * 60 * 60 * 1000)),
    /* 保存成功后自动跑发布命令（让"改完即上线"） */
    autoPublish: o.autoPublish === true,
    publishCmd: o.publishCmd || '/usr/local/bin/blog-publish',
    /* 实测的发布超时（rsync 一个站点目录，30 秒足够） */
    publishTimeoutMs: Number(o.publishTimeoutMs || 30000)
  };
};

/* ------------------------------------------------------------
   应用
   ------------------------------------------------------------ */
export const createApp = async (options) => {
  const cfg = resolveConfig(options);
  const log = (...args) => { if (!options || options.log !== false) console.log('[admin]', ...args); };

  await backup.ensureDirs(cfg.runtimeDir);
  const session = await auth.loadSession(cfg.runtimeDir);
  let rootHash = null;

  /* 口令模式下的"已解锁"是**服务端状态**：一次 POST /api/login 成功后才置位。
     不接受客户端自带的任何标记 —— 那种做法的名字叫"装饰"。 */
  let unlocked = !(await auth.hasPassphrase(cfg.runtimeDir));
  const unlock = () => { unlocked = true; };

  /* 远端模式的"已解锁"是**每客户端**的：登录成功发一个 sessionId，
     经 HttpOnly cookie 下发，服务端按 cookie 判定。
     本地模式继续用上面那个进程布尔值 —— 单人本机场景下它没问题，
     改成会话只会让 49 项既有验签的语义无谓变动。 */
  const sessions = auth.createSessionStore({ idleMs: cfg.sessionIdleMs });

  /* cookie 是否加 Secure：只有确认访问入口是 https 时才加。
     纯 HTTP 下加了 Secure 浏览器直接不存 cookie —— 表现是"登录成功但刷新即掉线"。 */
  const cookieSecure = cfg.publicOrigins.some((o) => String(o).toLowerCase().startsWith('https://'));

  /* 该请求是否已解锁。远端模式只看 cookie；本地模式看进程状态。 */
  const isUnlockedFor = (req) => {
    if (!cfg.remote) return unlocked;
    const sid = auth.sessionCookieFrom(req);
    return Boolean(sid && sessions.get(sid));
  };

  /* ---------- 安全闸上下文 ---------- */
  const allowedHosts = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
  cfg.publicHosts.forEach((h) => { const n = String(h || '').trim().toLowerCase(); if (n) allowedHosts.add(n); });
  const allowedOrigins = cfg.publicOrigins.length ? new Set(cfg.publicOrigins) : null;

  /* ---------- 保存即发布 ---------- */
  /* 串行化：连续保存两次不要并发 rsync 同一个目录 */
  let publishing = null;
  const publishToWebRoot = async () => {
    if (publishing) return publishing;
    publishing = (async () => {
      const { execFile } = await import('node:child_process');
      return new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        try {
          /* 注意：execFile 的**同步**抛错（受限沙箱下 spawn 会 EPERM）不会走回调，
             会直接冲出 Promise 构造函数、把整个保存打成 500。所以必须包 try/catch。 */
          execFile(cfg.publishCmd, { timeout: cfg.publishTimeoutMs }, (err, stdout, stderr) => {
            if (err) {
              /* 关键：**不阻塞保存**。内容已经安全落盘（含备份），
                 发布失败只记日志 —— 否则 rsync 一挂，你会以为文章没保存。 */
              log('自动发布失败（内容已保存，可手工重跑）：' + String(stderr || err.message).split('\n')[0]);
            } else {
              const tail = String(stdout).trim().split('\n').filter(Boolean).pop() || 'ok';
              log('已发布：' + tail);
            }
            done();
          });
        } catch (err) {
          log('自动发布无法启动（内容已保存）：' + String((err && err.message) || err).split('\n')[0]);
          done();
        }
      });
    })().finally(() => { publishing = null; });
    return publishing;
  };

  /* ---------- 小工具 ---------- */
  const sendJson = (res, status, payload) => {
    if (res.writableEnded) return;
    const body = JSON.stringify(payload);
    res.writeHead(status, security.baseHeaders({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body)
    }));
    res.end(body);
  };

  const sendText = (res, status, text, type) => {
    if (res.writableEnded) return;
    res.writeHead(status, security.baseHeaders({
      'content-type': (type || 'text/plain') + '; charset=utf-8',
      'cache-control': 'no-store'
    }));
    res.end(text);
  };

  const sendError = (res, err) => {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : '服务器内部错误';
    if (status >= 500) console.error('[admin] 500:', err);
    sendJson(res, status, {
      error: message,
      errors: (err && err.extra && err.extra.errors) || undefined
    });
  };

  const readBody = (req, limit) => new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        finish(fail, new HttpError(413, '请求体超过上限（' + human(limit) + '）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish(ok, Buffer.concat(chunks)));
    req.on('error', (err) => finish(fail, new HttpError(400, '读取请求体失败：' + err.message)));
  });

  const readJson = async (req) => {
    const buf = await readBody(req, MAX_JSON);
    if (!buf.length) return {};
    try { return JSON.parse(buf.toString('utf8')); }
    catch { throw new HttpError(400, '请求体不是合法 JSON'); }
  };

  /* ---------- 文章存取 ---------- */
  const readPosts = async () => {
    let source;
    try { source = await readFile(cfg.postsFile, 'utf8'); }
    catch (err) { throw new HttpError(500, '读不到 ' + cfg.postsRel + '：' + err.message); }
    const parsed = store.parse(source);
    rootHash = parsed.hash;
    return parsed;
  };

  const listClean = (parsed) => parsed.posts.map((p) => {
    const c = store.clean(p);
    /* 同样用字节数：管理页列表上的"体积"要给的是文件里的实际占用 */
    c.bytes = Buffer.byteLength(p.body || '', 'utf8');
    return c;
  });

  /**
   * 写一次的统一收尾：**先复核、再备份、最后原子写**。
   * 复核不通过时原文件一个字节都不会动。
   */
  const writePosts = async (nextSource, expected, note) => {
    const check = store.verify(nextSource, expected);
    if (!check.ok) {
      throw new HttpError(500, '写回结果未通过复核，已放弃保存：' + check.reason);
    }
    /* 【备份失败就不要写】backupFile 在磁盘满 / 权限错时会返回 null。
       原来这里只把日志尾巴写成"(备份失败)"然后照写不误 —— 那等于在没有
       任何副本的情况下原地覆盖，与 backup.mjs 开头"写之前一定先备份一份"
       的承诺相反。内容安全优先于可用性：宁可这次保存失败。 */
    const backupPath = await backup.backupFile(cfg.runtimeDir, cfg.postsFile, 'posts');
    if (!backupPath) {
      throw new HttpError(500, '备份失败，已放弃保存（避免没有副本的原地覆盖）。请检查磁盘空间与 .admin/backups 的权限');
    }
    await writeFileAtomic(cfg.postsFile, nextSource);
    await backup.rotateBackups(cfg.runtimeDir, 'posts');
    const after = await readPosts();
    log(note || 'posts.js 已更新', '(备份 ' + backupPath.replace(cfg.repoDir + sep, '') + ')');
    /* 保存即发布：让公开站点立刻看到这篇改动，不用再手工跑 blog-publish。
       失败不抛出 —— 见 publishToWebRoot 里的说明。 */
    if (cfg.autoPublish) await publishToWebRoot();
    return { version: after.hash, backup: backupPath.replace(cfg.repoDir + sep, '') };
  };

  /**
   * 乐观锁：版本号不一致就拒绝，绝不静默覆盖别处的改动。
   *
   * 【必须要有版本号】原来这里是"没带 version 就跳过检查"，于是只要**省略**
   * 这个字段，409 那条路永远不会走 —— 两个标签页同时编辑就变成一个静默
   * 覆盖另一个，"绝不静默覆盖"这句注释是假的。现在缺版本号直接 422。
   */
  const assertFresh = (body) => {
    if (!body || typeof body.version !== 'string' || !body.version) {
      throw new HttpError(422, '缺少 version（请先 GET /api/session 取当前版本号再提交，否则无法判断是否覆盖了别处的改动）');
    }
    if (rootHash && body.version !== rootHash) {
      throw new HttpError(409, 'posts.js 在别处被改动过（可能是手动编辑或另一个标签页），已拒绝覆盖。请刷新后重试');
    }
  };

  /* ---------- 路由 ---------- */
  const routes = [];
  const on = (method, path, handler) => routes.push({ method, path, handler });

  on('GET', '/api/session', async (ctx) => {
    const parsed = await readPosts();
    const st = await git.status(cfg.repoDir);
    const gate = await auth.hasPassphrase(cfg.runtimeDir);
    /* 【关键】令牌只在**当前这个请求自己**已解锁时才下发。
       以前这里是进程全局的 unlocked —— 你在公网上登录一次，之后任何人
       请求这个接口都能拿到写令牌，直到进程重启。 */
    const unlockedNow = Boolean(ctx && ctx.unlocked);
    return {
      ok: true,
      auth: gate ? 'passphrase' : 'token',
      unlocked: unlockedNow,
      /* 令牌只在已解锁时下发 —— 它同时充当 CSRF 令牌 */
      token: unlockedNow ? session.token : null,
      mode: cfg.remote ? 'remote' : 'local',
      store: {
        version: parsed.hash,
        count: parsed.posts.length,
        file: cfg.postsRel,
        /* 一定要用 Buffer.byteLength（UTF-8 字节），不能用 source.length ——
           后者是 UTF-16 码元数，正文里一个汉字算 1 而不是 3，
           于是这个字段会显示成"16845 字节"，而磁盘上其实是 26582 字节。
           名字叫 bytes 就得真是字节，否则每次核对文件大小都要怀疑人生。 */
        bytes: Buffer.byteLength(parsed.source, 'utf8'),
        chars: parsed.source.length,
        limits: LIMITS
      },
      git: st
    };
  });

  on('POST', '/api/login', async (ctx) => {
    const gate = await auth.hasPassphrase(cfg.runtimeDir);
    if (!gate) {
      if (cfg.remote) throw new HttpError(500, '远端模式未设口令，拒绝服务');
      unlock();
      return { ok: true, unlocked: true, token: session.token };
    }
    auth.guardThrottle(ctx.ip);
    const pass = String((ctx.body && ctx.body.passphrase) || '');
    const res = await auth.checkPassphrase(cfg.runtimeDir, pass);
    if (!res.ok) {
      const rec = auth.noteFailure(ctx.ip);
      log('口令失败，来自', ctx.ip, '累计', rec.fails, '次');
      throw new HttpError(401, '口令不正确');
    }
    auth.noteSuccess(ctx.ip);

    if (cfg.remote) {
      /* 每客户端一个会话，经 HttpOnly cookie 下发 */
      const sid = sessions.create({ ip: ctx.ip, ua: String(ctx.req.headers['user-agent'] || '') });
      ctx.res.setHeader('Set-Cookie', auth.buildSessionCookie(sid, {
        secure: cookieSecure,
        maxAgeSec: Math.floor(cfg.sessionIdleMs / 1000)
      }));
      log('口令校验通过，已为该客户端建立会话（当前会话数 ' + sessions.size() + '）');
      return { ok: true, unlocked: true, token: session.token };
    }

    unlock();
    log('口令校验通过，管理接口已解锁');
    return { ok: true, unlocked: true, token: session.token };
  });

  on('POST', '/api/logout', async (ctx) => {
    const sid = auth.sessionCookieFrom(ctx.req);
    if (sid) sessions.destroy(sid);
    ctx.res.setHeader('Set-Cookie', auth.buildSessionCookie('', { secure: cookieSecure, clear: true }));
    return { ok: true, unlocked: false };
  });

  on('GET', '/api/posts', async () => {
    const parsed = await readPosts();
    return { ok: true, version: parsed.hash, count: parsed.posts.length, posts: listClean(parsed) };
  });

  /* 验签脚本用得到：当前状态（是否已解锁、有没有口令、版本号）。
     令牌同样只在**本请求已解锁**时给出。 */
  const state = async (ctx) => {
    const unlockedNow = Boolean(ctx && ctx.unlocked);
    return {
      unlocked: unlockedNow,
      passphrase: await auth.hasPassphrase(cfg.runtimeDir),
      version: rootHash,
      token: unlockedNow ? session.token : null
    };
  };

  on('GET', '/api/posts/one', async (ctx) => {
    const slug = ctx.query.get('slug') || '';
    const parsed = await readPosts();
    const post = parsed.posts.find((p) => String(p.slug) === slug);
    if (!post) throw new HttpError(404, '没有这篇文章：' + slug);
    return { ok: true, version: parsed.hash, post: store.clean(post) };
  });

  on('POST', '/api/posts', async (ctx) => {
    const parsed = await readPosts();
    assertFresh(ctx.body);
    const existing = listClean(parsed);
    const clean = validatePost(ctx.body, existing, { originalSlug: null });
    const next = store.insert(parsed.source, clean, existing);
    const info = await writePosts(next, [clean].concat(existing), '新增文章 ' + clean.slug);
    return Object.assign({ ok: true, slug: clean.slug }, info);
  });

  on('PUT', '/api/posts', async (ctx) => {
    const originalSlug = String((ctx.body && ctx.body.originalSlug) || '').trim();
    if (!originalSlug) throw new HttpError(422, '缺少 originalSlug');

    const parsed = await readPosts();
    assertFresh(ctx.body);
    const existing = listClean(parsed);
    const before = existing.find((p) => p.slug === originalSlug);
    if (!before) throw new HttpError(404, '没有这篇文章：' + originalSlug);

    /* 只覆盖请求里出现的字段，没传的保持原样 */
    const merged = Object.assign({}, before);
    ['slug', 'title', 'date', 'category', 'tags', 'excerpt', 'body', 'isDraft', 'aliases']
      .forEach((k) => { if (k in ctx.body) merged[k] = ctx.body[k]; });
    const clean = validatePost(merged, existing, { originalSlug });

    /* 改名的别名由 store.update 负责补写（validatePost 只做字段合并），
       所以"写进文件的"与"用来复核的"都取自 store.update 的产物：
       两边同源，复核不可能因为两套期望而误报。 */
    const next = store.update(parsed.source, originalSlug, clean, existing);
    /* 复核只看固定字段（verify 里自己会归一化），这里直接给净化后的对象即可 */
    const expected = store.evaluatePosts(next).map((p) => store.clean(p));

    const info = await writePosts(next, expected, '更新文章 ' + originalSlug + ' → ' + clean.slug);
    return Object.assign({ ok: true, slug: clean.slug, renamed: clean.slug !== originalSlug }, info);
  });

  on('POST', '/api/posts/delete', async (ctx) => {
    const slug = String((ctx.body && ctx.body.slug) || '').trim();
    if (!slug) throw new HttpError(422, '缺少 slug');

    const parsed = await readPosts();
    assertFresh(ctx.body);
    const existing = listClean(parsed);
    const victim = existing.find((p) => p.slug === slug);
    if (!victim) throw new HttpError(404, '没有这篇文章：' + slug);
    if (existing.length <= 1) throw new HttpError(422, '这是最后一篇了，删掉之后所有页面都会变成空状态');

    const next = store.remove(parsed.source, slug, existing);
    const trashPath = await backup.trashContent(cfg.runtimeDir, slug, JSON.stringify(victim, null, 2));
    const expected = existing.filter((p) => p.slug !== slug);
    const info = await writePosts(next, expected, '删除文章 ' + slug);
    return Object.assign({ ok: true, trash: trashPath.replace(cfg.repoDir + sep, '') }, info);
  });

  on('POST', '/api/posts/check', async (ctx) => {
    const parsed = await readPosts();
    const post = (ctx.body && ctx.body.post) || null;
    const html = inspectHtml((post && post.body) || '');
    let fieldErrors = [];
    if (post) {
      try {
        validatePost(post, listClean(parsed), { originalSlug: (ctx.body && ctx.body.originalSlug) || null });
      } catch (err) {
        fieldErrors = (err.extra && err.extra.errors) || [err.message];
      }
    }
    return { ok: html.ok && fieldErrors.length === 0, html, errors: fieldErrors };
  });

  on('POST', '/api/images', async (ctx) => {
    if (!ctx.raw || !ctx.raw.length) {
      throw new HttpError(422, '没有收到图片数据（二进制放在请求体里，文件名放在 X-File-Name 头）');
    }
    let name = '';
    try { name = decodeURIComponent(String(ctx.req.headers['x-file-name'] || '')); }
    catch { name = String(ctx.req.headers['x-file-name'] || ''); }
    const saved = await images.saveImage(cfg.uploadsDir, ctx.raw, name || 'image');
    log('图片已保存', saved.src, '(' + human(saved.bytes) + ')');
    return Object.assign({ ok: true }, saved);
  });

  on('GET', '/api/images', async () => {
    const { readdir, stat: statFile } = await import('node:fs/promises');
    let names = [];
    try { names = await readdir(cfg.uploadsDir); } catch { names = []; }
    const out = [];
    for (const n of names.sort()) {
      try {
        const st = await statFile(join(cfg.uploadsDir, n));
        out.push({ name: n, src: 'img/uploads/' + n, bytes: st.size, at: st.mtime.toISOString() });
      } catch { /* 竞态：刚好被删掉 */ }
    }
    return { ok: true, images: out };
  });

  on('GET', '/api/backups', async () => ({
    ok: true,
    backups: await backup.listBackups(cfg.runtimeDir, 'posts'),
    trash: await backup.listTrash(cfg.runtimeDir)
  }));

  on('POST', '/api/backups/restore', async (ctx) => {
    const name = String((ctx.body && ctx.body.name) || '');
    if (!/^posts-[\w.:-]+\.js$/.test(name)) throw new HttpError(422, '备份文件名不合法');
    const file = safeJoin(join(cfg.runtimeDir, 'backups'), name);
    let content;
    try { content = await readFile(file, 'utf8'); }
    catch { throw new HttpError(404, '找不到这份备份'); }

    const parsed = store.parse(content);              // 备份本身也要能求值
    if (!parsed.posts.length) throw new HttpError(422, '这份备份里没有文章，拒绝恢复');

    await backup.backupFile(cfg.runtimeDir, cfg.postsFile, 'posts');
    await writeFileAtomic(cfg.postsFile, content);
    const after = await readPosts();
    log('已从备份恢复', name);
    return { ok: true, restored: name, version: after.hash, count: after.posts.length };
  });

  on('GET', '/api/git', async () => ({
    ok: true,
    status: await git.status(cfg.repoDir),
    log: await git.log(cfg.repoDir, 5)
  }));

  on('POST', '/api/git', async (ctx) => {
    const action = String((ctx.body && ctx.body.action) || 'commit');
    if (action !== 'commit') throw new HttpError(422, '只支持 action=commit（push 请自己在终端做）');

    /* 提交前强制复核：所有文章都要能被求值、正文要能过安全检查 */
    const parsed = await readPosts();
    const bad = [];
    parsed.posts.forEach((p) => {
      const html = inspectHtml(p.body || '');
      if (!html.ok) bad.push(p.slug + '：' + html.errors.join('；'));
    });
    if (bad.length) throw new HttpError(422, '有文章没通过复核，拒绝提交', { errors: bad });

    const message = String((ctx.body && ctx.body.message) || '').trim() ||
      'feat(blog-enter): 更新文章（' + parsed.posts.length + ' 篇）';

    const res = await git.commit(cfg.repoDir, cfg.repoDir,
      [cfg.postsRel, 'blog-enter/img/uploads'], message);
    if (!res.ok) return { ok: false, reason: res.reason, detail: res.detail };
    log('已提交', res.hash, message);
    return res;
  });

  /* ---------- 静态文件 ---------- */
  /**
   * 发一个文件。root 是"这个文件允许来自哪个根"——
   * 站点文件对着 blogDir，管理页文件对着 uiDir。
   * 之前这里写死对着 blogDir，于是 .admin/ui 下的管理页**永远** 403：
   * 越界断言用错了根，把正常情况判成了越界。
   */
  const serveFile = (res, file, extra, root) => new Promise((done) => {
    try { assertInside(root || cfg.blogDir, file); }
    catch { sendText(res, 403, 'forbidden'); done(); return; }
    const headers = security.baseHeaders(Object.assign({
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store'
    }, extra || {}));
    const stream = createReadStream(file);
    stream.on('error', () => {
      if (!res.headersSent) sendText(res, 404, 'not found');
      else res.end();
      done();
    });
    stream.on('open', () => {
      res.writeHead(200, headers);
      stream.pipe(res);
    });
    res.on('close', done);
  });

  /* 这个服务器只应该发"公开产物"。blogDir 里同时住着源码（server/）、
     管理页 UI（admin/）、测试、文档（*.md）—— 它们是**代码**，不是站点内容。
     发布脚本本来就排除它们，nginx 也挡了一层；但这里是同一个进程在服务，
     没有理由把它自己的源码发出去（一条配错的 nginx location / 就等于全泄）。
     所以按扩展名白名单 + 目录黑名单两道收口。 */
  const STATIC_EXT_ALLOW = new Set(['.html', '.css', '.js', '.json', '.svg', '.png', '.jpg',
    '.jpeg', '.gif', '.webp', '.ico', '.avif', '.mp3', '.wav', '.txt', '.woff', '.woff2']);
  const STATIC_DIR_DENY = new Set(['server', 'admin', 'tests', 'deploy', 'node_modules']);

  const serveStatic = async (res, urlPath) => {
    let rel = urlPath;
    try { rel = decodeURIComponent(urlPath); } catch { sendText(res, 400, 'bad path'); return; }
    if (rel === '/' || rel === '') rel = '/index.html';
    if (rel.includes('\0')) { sendText(res, 400, 'bad path'); return; }

    /* safeJoin 挡 ../ 与绝对路径 */
    let file;
    try { file = safeJoin(cfg.blogDir, rel.replace(/^[/\\]+/, '')); }
    catch { sendText(res, 403, 'forbidden'); return; }

    const relToRoot = file.slice(cfg.blogDir.length).split(sep).filter(Boolean);
    /* 隐藏目录（.git / .admin / .preview）不通过这个服务器暴露 */
    if (relToRoot.some((seg) => seg.startsWith('.'))) { sendText(res, 404, 'not found'); return; }
    /* 源码目录不发 */
    if (relToRoot.some((seg) => STATIC_DIR_DENY.has(seg.toLowerCase()))) { sendText(res, 404, 'not found'); return; }
    /* 非产物扩展名不发：.mjs/.cjs/.md/.env/.bak… 一律 404 */
    const dot = file.lastIndexOf('.');
    const ext = dot >= 0 ? file.slice(dot).toLowerCase() : '';
    if (!STATIC_EXT_ALLOW.has(ext)) { sendText(res, 404, 'not found'); return; }

    let st;
    try { st = await stat(file); }
    catch { sendText(res, 404, 'not found'); return; }
    if (st.isDirectory()) { sendText(res, 404, 'not found'); return; }
    await serveFile(res, file);
  };

  /* ---------- 主处理 ---------- */
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://' + cfg.host + ':' + cfg.port);
    const path = url.pathname;

    /* 0) 所有请求都先过 反代密钥 / 对端 / Host / 同源 四道闸 */
    security.guard(req, {
      port: cfg.port,
      allowedHosts,
      allowedOrigins,
      proxySecret: cfg.proxySecret
    });

    const ctx = {
      req, res,
      ip: security.clientIp(req, { trustProxy: cfg.trustProxy }),
      query: url.searchParams,
      body: null,
      raw: null,
      /* 每请求判定：远端模式看该请求携带的会话 cookie，本地模式看进程状态 */
      unlocked: isUnlockedFor(req)
    };

    /* 1) 令牌脚本。
       路径本身就不对外暗示（只在服务端路由里存在）；
       这里有意**不**做 Origin 判定 —— 浏览器对 <script src> 这类子资源请求
       会带上页面的 Origin，判定会把管理页自己挡在门外，属于自伤。

       但**必须**检查解锁状态：否则设了口令之后，令牌仍然人人可得，
       口令门就成了摆设（这正是第一版的漏洞）。
       注入时把 "<" 转义掉，使它无法被正文里的持久化 HTML 借走。 */
    if (path === '/_admin/token.js') {
      const gate = await auth.hasPassphrase(cfg.runtimeDir);
      if (gate && !ctx.unlocked) {
        sendText(res, 401, '/* 未解锁：先 POST /api/login，或在管理页输入口令 */',
          'text/javascript');
        return;
      }
      const payload = 'window.__ADMIN_TOKEN__ = ' +
        JSON.stringify(session.token).replace(/</g, '\\u003c') + ';\n';
      res.writeHead(200, security.baseHeaders({
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(payload)
      }));
      res.end(payload);
      return;
    }

    /* 2) 管理页静态文件（白名单，不列举目录） */
    if (Object.prototype.hasOwnProperty.call(ADMIN_ASSETS, path)) {
      const file = join(cfg.uiDir, ADMIN_ASSETS[path]);
      try { await stat(file); }
      catch { sendText(res, 404, '管理页静态文件缺失：' + file); return; }
      await serveFile(res, file, {
        'content-security-policy': security.ADMIN_CSP,
        'x-robots-tag': 'noindex, nofollow'
      }, cfg.uiDir);
      return;
    }
    if (path.startsWith('/_admin')) { sendText(res, 404, 'not found'); return; }

    /* 3) 接口 */
    if (path.startsWith('/api/')) {
      const route = routes.find((r) => r.path === path && r.method === req.method);
      if (!route) throw new HttpError(404, '没有这个接口：' + req.method + ' ' + path);

      if (req.method !== 'GET') {
        /* 登录接口是所有写操作的**前置**，不能要求它自己先解锁 ——
           否则就成了"没解锁 → 不能登录 → 永远解锁不了"的死锁。
           它不需要令牌（还没有令牌可带），安全性由口令校验 + 失败退避负责。

           登出同理：会话一旦过期，携带的令牌也就没用了；如果登出本身也要求
           "已解锁 + 带令牌"，用户就卡在"退不出去"的状态里。所以这两个接口
           单独放行，其余写操作照旧要过"解锁 + 令牌"两道。 */
        if (path === '/api/login' || path === '/api/logout') {
          ctx.body = path === '/api/login' ? await readJson(req) : {};
        } else {
          const gate = await auth.hasPassphrase(cfg.runtimeDir);
          if (gate && !ctx.unlocked) throw new HttpError(401, '未解锁：请先在管理页输入口令');
          auth.requireToken(req, session);
          const isRaw = path === '/api/images';
          ctx.raw = isRaw ? await readBody(req, MAX_IMAGE) : null;
          ctx.body = isRaw ? null : await readJson(req);
        }
      } else if (cfg.remote && path !== '/api/session' && path !== '/api/logout') {
        /* 【远端模式】其它读接口也必须过解锁闸。
           从前只有非 GET 才检查，于是未认证的 GET /api/posts 能读到**全部
           文章** —— listClean 保留 isDraft 与完整 body，所以没发布的草稿是
           全文泄露，不只是标题。GET /api/backups、/api/images、/api/git 同理。
           本地模式（cfg.remote=false）不启用这一条，49 项既有验签的语义不动。

           /api/session 必须**豁免**：它正是"我解锁了没有"这个问题的答案，
           未登录的页面要靠它判断该不该显示口令框。它的令牌只在
           ctx.unlocked 为真时才下发，所以豁免它不会泄露任何东西。 */
        const gate = await auth.hasPassphrase(cfg.runtimeDir);
        if (gate && !ctx.unlocked) {
          throw new HttpError(401, '未解锁：请先在管理页输入口令');
        }
      }
      const out = await route.handler(ctx);
      if (out !== undefined) sendJson(res, 200, out);
      return;
    }

    /* 4) 静态站 */
    if (req.method !== 'GET' && req.method !== 'HEAD') { sendText(res, 405, 'method not allowed'); return; }
    await serveStatic(res, path);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      try { sendError(res, err); }
      catch { try { res.destroy(); } catch { /* 连接已断 */ } }
    });
  });
  server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* 已断 */ }
  });

  return { server, cfg, session, readPosts, listClean, routes, log, state, isUnlocked: () => unlocked,
    sessions, publishNow: publishToWebRoot,
    /* 端口 0 = 系统分配，Host 校验必须用真实端口，不能用配置里的 0 */
    setPort: (p) => { cfg.port = Number(p); } };
};

/* ------------------------------------------------------------
   CLI
   ------------------------------------------------------------ */
const isMain = (() => {
  try {
    const arg = process.argv[1] ? resolve(process.argv[1]) : '';
    return arg === resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

/* ------------------------------------------------------------
   启动横幅：做成纯函数，这样能被测试直接调用
   ------------------------------------------------------------
   为什么单独抽出来：这一整段原来写在 server.listen 的回调里，于是
   "测试全绿但服务一起来就崩"是可能的 —— 有一次就是把 createApp 内部
   的局部变量引用在这里，ReferenceError 只在真实启动时才炸。
   抽成纯函数之后，"启动路径"这四个字就有了可执行的判据。
   ------------------------------------------------------------ */
export const bannerLines = (cfg, needPass) => {
  const secureNow = (cfg.publicOrigins || []).some((o) => String(o).toLowerCase().startsWith('https://'));
  const lines = [
    '',
    '  站点      http://' + cfg.host + ':' + cfg.port + '/',
    '  管理页    http://' + cfg.host + ':' + cfg.port + '/_admin/',
    '  认证      ' + (needPass ? '已设置口令（打开管理页后需要输入）' : '仅本机 + 会话令牌（未设口令）'),
    '  模式      ' + (cfg.remote
      ? ('远端（每客户端会话，空闲超时 ' + Math.round(cfg.sessionIdleMs / 60000) + ' 分钟'
         + (secureNow ? '，cookie 带 Secure' : '，cookie 无 Secure（纯 HTTP）')
         + (cfg.proxySecret ? '，已启用反代密钥' : '，未启用反代密钥')
         + (cfg.autoPublish ? '，保存后自动发布' : '') + '）')
      : '本地（只绑回环，行为与从前一致）')
  ];
  if (cfg.remote) {
    lines.push('  白名单    Host: ' + (cfg.publicHosts || []).join(' ')
      + '   Origin: ' + (cfg.publicOrigins || []).join(' '));
  }
  lines.push('  数据      ' + cfg.postsRel);
  lines.push('  运行时    ' + cfg.runtimeDir + '  （备份 / 回收站 / 会话）');
  lines.push('  停止      Ctrl+C');
  lines.push('');
  return lines;
};

const main = async () => {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes('--' + n);
  const value = (n, d) => {
    const i = argv.indexOf('--' + n);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
  };
  /* 可重复的参数：--public-host a --public-host b */
  const values = (n) => {
    const out = [];
    argv.forEach((a, i) => {
      if (a === '--' + n && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]);
    });
    return out;
  };

  /* ---- 口令设置：不要用 --pass（会进 ps 与 journald）---- */
  const readPassFromStdin = () => new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf.replace(/[\r\n]+$/, '')));
  });

  if (flag('set-pass')) {
    let pass = '';
    if (flag('pass-stdin') || !process.stdin.isTTY) {
      pass = await readPassFromStdin();
    } else {
      process.stdout.write('请输入管理口令（输入不回显，回车确认）：');
      pass = await readPassFromStdin();
      process.stdout.write('\n');
    }
    if (!pass) {
      console.error('没有读到口令。用法：');
      console.error('  printf %s "你的口令" | node blog-enter/server/dev-server.mjs --set-pass --pass-stdin');
      process.exit(2);
    }
    /* 顺手提醒一下弱口令：远端模式下这是唯一的门 */
    if (pass.length < 16) console.warn('提示：口令偏短，公网场景建议 24 位以上随机串。');
    await auth.setPassphrase(cfgRuntimeDirOnly(), pass);
    console.log('口令已设置（PBKDF2-SHA256 哈希存在 .admin/passphrase.json，不存明文）');
    return;
  }

  function cfgRuntimeDirOnly() {
    return resolveConfig({
      port: value('port', process.env.PORT || 8848),
      runtimeDir: value('runtime', undefined),
      blogDir: value('root', undefined)
    }).runtimeDir;
  }

  /* ---- 反代密钥文件 ---- */
  const secretFile = value('proxy-secret-file', '');
  let proxySecret = null;
  if (secretFile) {
    try {
      proxySecret = (await readFile(secretFile, 'utf8')).trim();
      if (!proxySecret) throw new Error('文件是空的');
    } catch (err) {
      console.error('读不到反代密钥文件 ' + secretFile + '：' + err.message);
      process.exit(5);
    }
  }

  const cfg = resolveConfig({
    port: value('port', process.env.PORT || 8848),
    runtimeDir: value('runtime', undefined),
    blogDir: value('root', undefined),
    remote: flag('remote'),
    publicHosts: values('public-host'),
    publicOrigins: values('public-origin'),
    trustProxy: flag('trust-proxy'),
    proxySecret,
    sessionIdleMs: Number(value('session-idle', 0)) > 0 ? Number(value('session-idle')) * 60 * 1000 : undefined,
    autoPublish: flag('auto-publish'),
    publishCmd: value('publish-cmd', undefined)
  });

  await backup.ensureDirs(cfg.runtimeDir);

  if (flag('clear-pass')) {
    await auth.clearPassphrase(cfg.runtimeDir);
    console.log('口令已清除，改回"只靠本机 + 会话令牌"模式');
    return;
  }

  /* ---- 远端模式的硬性前置：没口令就不许启动 ----
     远端模式下 if (gate && !unlocked) 这类判据在"没设口令"时全都不生效
     （gate 为假 = 直接放行），等于把写权限挂到公网上。所以这里必须硬拒。 */
  if (cfg.remote && !(await auth.hasPassphrase(cfg.runtimeDir))) {
    console.error('远端模式必须设置口令。设置方式：');
    console.error('  printf %s "一串 24 位以上的随机口令" | node blog-enter/server/dev-server.mjs --set-pass --pass-stdin');
    process.exit(4);
  }
  if (cfg.remote && (!cfg.publicHosts.length || !cfg.publicOrigins.length)) {
    console.error('远端模式必须显式给出 --public-host 与 --public-origin（Host/Origin 白名单不留通配）。');
    process.exit(4);
  }
  if (cfg.remote && !cfg.proxySecret) {
    /* 【失败要"关"不要"开"】反代之后"对端必须是回环"恒真，所以共享密钥是
       "把本机可达收窄成只有我们的 nginx 可达"的**唯一**手段。原来这里只打
       一句警告就继续启动 —— 忘了加参数 = 静默丢掉这道控制，与本项目其它
       地方"宁可不启动也不带着已知漏洞跑"的取向不一致。 */
    console.error('远端模式必须配置 --proxy-secret-file。');
    console.error('  反代之后对端恒为回环，本机任何进程都能直连本端口拿到写权限；');
    console.error('  没有密钥这道控制就等于没设。生成方式见 deploy/PLAN-ADMIN-LIVE.md 第 6.4 节：');
    console.error('    openssl rand -hex 32 > /etc/p3blog/proxy-secret');
    process.exit(4);
  }

  const app = await createApp(cfg);
  const needPass = await auth.hasPassphrase(cfg.runtimeDir);
  try {
    const parsed = await app.readPosts();
    app.log('posts.js 解析通过：' + parsed.posts.length + ' 篇，' +
      human(Buffer.byteLength(parsed.source, 'utf8')) + '，版本 ' + parsed.hash.slice(0, 12));
  } catch (err) {
    console.error('启动失败：' + err.message);
    process.exit(3);
  }

  app.server.listen(cfg.port, cfg.host, () => {
    bannerLines(cfg, needPass).forEach((l) => console.log(l));
    if (!needPass) {
      console.log('  提示：想再加一道本机口令锁：');
      console.log('        printf %s "你的口令" | node blog-enter/server/dev-server.mjs --set-pass --pass-stdin');
      console.log('');
    }
  });

  const shutdown = () => {
    /* 清掉会话清理定时器，否则它会让进程不退出（setInterval 默认 ref 已 unref，
       这里再显式停一次是防御性的） */
    try { app.sessions.stop(); } catch { /* 已停 */ }
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

if (isMain) {
  main().catch((err) => { console.error('启动异常：', err); process.exit(1); });
}
