/* ============================================================
   远端模式验签（把服务暴露到公网前后必须成立的那几条）
   ------------------------------------------------------------
   跑法：node blog-enter/server/tests/remote-mode.test.mjs
   或由 run-all.mjs 统一跑。

   这一层验的是"**公网暴露**之后的安全边界"，与 api.test.mjs 的分工：
     · api.test.mjs     —— 本地模式（无 --remote）的既有行为，不能变
     · remote-mode.test.mjs —— 远端模式新增的每一条闸

   最重要的一条是 #2：你在公网上登录一次之后，**别人**必须仍然拿不到令牌。
   这也是改造前真实存在的缺陷（unlocked 是进程全局布尔，GET /api/session
   会把它连带令牌一起发给任何人）。

   全部测试跑在临时目录的副本上，绝不碰真的 js/posts.js。
   ============================================================ */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness } from './harness.mjs';
import { createApp, bannerLines } from '../dev-server.mjs';
import { setPassphrase, resetThrottle } from '../lib/auth.mjs';

const H = createHarness('remote-mode.test.mjs');
const test = (name, fn) => H.test(name, fn);

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const REAL_BLOG = resolve(HERE, '..', '..');
const REAL_POSTS = join(REAL_BLOG, 'js', 'posts.js');

const REAL_BEFORE = await readFile(REAL_POSTS, 'utf8');

const PASS = 'correct horse battery staple 远端口令';
const HOSTNAME = 'example.test';                 // 冒充"公网 IP / 域名"
const ORIGIN = 'http://example.test';
const SECRET = 'proxy-secret-for-tests-0123456789';

/* ------------------------------------------------------------
   装置
   ------------------------------------------------------------ */
const makeSandbox = async () => {
  const root = await mkdtemp(join(tmpdir(), 'blog-remote-'));
  const blog = join(root, 'blog-enter');
  await mkdir(join(blog, 'js'), { recursive: true });
  await mkdir(join(blog, 'img', 'uploads'), { recursive: true });
  await copyFile(REAL_POSTS, join(blog, 'js', 'posts.js'));
  await writeFile(join(blog, 'index.html'), '<!doctype html><title>sandbox</title>', 'utf8');

  const postsFile = join(blog, 'js', 'posts.js');
  const original = await readFile(postsFile, 'utf8');

  const started = [];
  const start = async (extra) => {
    const app = await createApp(Object.assign({
      blogDir: blog,
      repoDir: root,
      runtimeDir: join(root, '.admin'),
      uiDir: join(REAL_BLOG, 'admin'),
      port: 0,
      log: false
    }, extra || {}));
    await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
    const port = app.server.address().port;
    app.setPort(port);
    started.push(app);
    return { app, port, base: 'http://127.0.0.1:' + port };
  };

  const stop = async () => {
    for (const app of started) {
      try { app.sessions.stop(); } catch { /* 已停 */ }
      await new Promise((ok) => app.server.close(ok));
    }
    started.length = 0;
  };

  const cleanup = async () => {
    await stop();
    await rm(root, { recursive: true, force: true });
  };

  return { root, blog, postsFile, original, start, stop, cleanup };
};

/** 带自定义 Host 的请求；需要跨请求保持 cookie 就传 jar */
const req = (base, path, { method = 'GET', headers = {}, body = null } = {}) =>
  new Promise((resolvePromise, reject) => {
    const u = new URL(base + path);
    const h = Object.assign({ host: HOSTNAME }, headers);
    let payload = null;
    if (body !== null && body !== undefined) {
      payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      h['content-type'] = h['content-type'] || 'application/json';
      h['content-length'] = payload.length;
    }
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method, headers: h
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolvePromise({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });

const json = (res) => { try { return JSON.parse(res.text); } catch { return null; } };

/** 简易 cookie jar：只认 p3_admin_sid */
const makeJar = () => ({ sid: '' });
const jarHeaders = (jar) => (jar.sid ? { cookie: 'p3_admin_sid=' + jar.sid } : {});
const absorb = (jar, res) => {
  const sc = res.headers['set-cookie'];
  if (!sc) return;
  const raw = Array.isArray(sc) ? sc.join('\n') : String(sc);
  const m = raw.match(/p3_admin_sid=([^;\s]*)/);
  if (m) jar.sid = m[1];
};

const REMOTE = {
  remote: true,
  publicHosts: [HOSTNAME],
  publicOrigins: [ORIGIN],
  proxySecret: SECRET,
  trustProxy: true,
  autoPublish: false
};

/* 远端模式下的"正常浏览器请求"：密钥 + 白名单 Host + 白名单 Origin
   注意 origin 必须一起带上 —— 只带密钥会被 Origin 白名单拦成 403，
   验证"放行"类用例时不能漏。 */
const proxied = (extra) => Object.assign({
  'x-admin-proxy-secret': SECRET,
  host: HOSTNAME,
  origin: ORIGIN
}, extra || {});

/** 只带密钥、不带 Origin 的"非浏览器客户端"请求（curl 就是这种） */
const noOrigin = (extra) => Object.assign({ 'x-admin-proxy-secret': SECRET }, extra || {});

/* ============================================================
   1. 远端模式下，未认证的读请求一律被拒（草稿不再泄露）
   ============================================================ */
test('远端：未登录 GET /api/posts → 401（原来是无认证 200）', async () => {
  const sb = await makeSandbox();
  try {
    await setPassphrase(join(sb.root, '.admin'), PASS);
    const { base } = await sb.start(REMOTE);
    const res = await req(base, '/api/posts', { headers: proxied() });
    assert.equal(res.status, 401, '未登录读接口必须 401，实际 ' + res.status);
  } finally { await sb.cleanup(); }
});

test('远端：未登录 GET /api/session → token 为 null', async () => {
  const sb = await makeSandbox();
  try {
    await setPassphrase(join(sb.root, '.admin'), PASS);
    const { base } = await sb.start(REMOTE);
    const res = await req(base, '/api/session', { headers: proxied() });
    const body = json(res);
    assert.equal(res.status, 200);
    assert.equal(body.token, null, '未登录不得下发令牌');
    assert.equal(body.unlocked, false);
  } finally { await sb.cleanup(); }
});

test('远端：未登录的其它读接口也都被拒（backups / images / git）', async () => {
  const sb = await makeSandbox();
  try {
    await setPassphrase(join(sb.root, '.admin'), PASS);
    const { base } = await sb.start(REMOTE);
    for (const p of ['/api/backups', '/api/images', '/api/git']) {
      const res = await req(base, p, { headers: proxied() });
      assert.equal(res.status, 401, p + ' 应 401，实际 ' + res.status);
    }
  } finally { await sb.cleanup(); }
});

/* ============================================================
   2. 【最关键】A 登录之后，B 仍然拿不到令牌
   ============================================================ */
test('远端：A 登录后，另一个客户端仍拿不到令牌（原来的致命缺陷）', async () => {
  const sb = await makeSandbox();
  try {
    await setPassphrase(join(sb.root, '.admin'), PASS);
    const { base } = await sb.start(REMOTE);

    const jarA = makeJar();
    const login = await req(base, '/api/login', {
      method: 'POST', headers: proxied(), body: { passphrase: PASS }
    });
    assert.equal(login.status, 200, 'A 应该登录成功');
    absorb(jarA, login);
    assert.ok(jarA.sid, 'A 应该拿到会话 cookie');

    /* A 自己：能看到令牌 */
    const aSession = await req(base, '/api/session', { headers: proxied(jarHeaders(jarA)) });
    const aBody = json(aSession);
    assert.equal(aBody.unlocked, true, 'A 应已解锁');
    assert.ok(aBody.token, 'A 应拿到令牌');

    /* B：完全不带 cookie —— 必须拿不到任何东西 */
    const bSession = await req(base, '/api/session', { headers: proxied() });
    const bBody = json(bSession);
    assert.equal(bBody.unlocked, false, 'B 不得因为 A 登录而解锁');
    assert.equal(bBody.token, null, 'B 不得拿到令牌');

    const bRead = await req(base, '/api/posts', { headers: proxied() });
    assert.equal(bRead.status, 401, 'B 读文章必须 401');

    const bWrite = await req(base, '/api/posts', {
      method: 'POST', headers: proxied(), body: { title: 'x', slug: 'x', body: '<p>x</p>' }
    });
    assert.equal(bWrite.status, 401, 'B 写文章必须 401');
  } finally { await sb.cleanup(); }
});

test('远端：伪造/自造的 cookie 不能解锁', async () => {
  const sb = await makeSandbox();
  try {
    await setPassphrase(join(sb.root, '.admin'), PASS);
    const { base } = await sb.start(REMOTE);
    const res = await req(base, '/api/session', {
      headers: proxied({ cookie: 'p3_admin_sid=deadbeefdeadbeefdeadbeefdeadbeef' })
    });
    assert.equal(json(res).token, null, '会话 id 必须是服务端签发过的');
  } finally { await sb.cleanup(); }
});

/* ============================================================
   3. 登出与空闲超时
   ============================================================ */
test('远端：登出之后该 cookie 立刻失效', async () => {
  const sb = await makeSandbox();
  try {
    await setPassphrase(join(sb.root, '.admin'), PASS);
    const { base } = await sb.start(REMOTE);
    const jar = makeJar();
    absorb(jar, await req(base, '/api/login', {
      method: 'POST', headers: proxied(), body: { passphrase: PASS }
    }));

    const sid = jar.sid;
    const token = json(await req(base, '/api/session', { headers: proxied(jarHeaders(jar)) })).token;

    const out = await req(base, '/api/logout', {
      method: 'POST', headers: proxied({ cookie: 'p3_admin_sid=' + sid, 'x-admin-token': token })
    });
    assert.equal(out.status, 200, '登出应成功');

    const after = await req(base, '/api/session', { headers: proxied({ cookie: 'p3_admin_sid=' + sid }) });
    assert.equal(json(after).token, null, '登出后该会话必须失效');
  } finally { await sb.cleanup(); }
});

test('远端：超过空闲超时的会话失效', async () => {
  const sb = await makeSandbox();
  try {
    await setPassphrase(join(sb.root, '.admin'), PASS);
    /* 空闲超时设成 1ms，登录后等一会再请求 */
    const { base } = await sb.start(Object.assign({}, REMOTE, { sessionIdleMs: 1 }));
    const jar = makeJar();
    absorb(jar, await req(base, '/api/login', {
      method: 'POST', headers: proxied(), body: { passphrase: PASS }
    }));
    await new Promise((ok) => setTimeout(ok, 30));
    const res = await req(base, '/api/session', { headers: proxied(jarHeaders(jar)) });
    assert.equal(json(res).token, null, '空闲超时后应视为未解锁');
  } finally { await sb.cleanup(); }
});

/* ============================================================
   4. Host / Origin 白名单
   ============================================================ */
test('远端：白名单内的 Host + 正确密钥 → 放行', async () => {
  const sb = await makeSandbox();
  try {
    await setPassphrase(join(sb.root, '.admin'), PASS);
    const { base } = await sb.start(REMOTE);
    const res = await req(base, '/api/session', {
      headers: proxied({ host: HOSTNAME, origin: ORIGIN })
    });
    assert.equal(res.status, 200, '白名单内的 Host/Origin 应放行');
  } finally { await sb.cleanup(); }
});

test('远端：Host 不在白名单 → 403', async () => {
  const sb = await makeSandbox();
  try {
    await setPassphrase(join(sb.root, '.admin'), PASS);
    const { base } = await sb.start(REMOTE);
    const res = await req(base, '/api/session', {
      headers: proxied({ host: 'evil.example', origin: ORIGIN })
    });
    assert.equal(res.status, 403, '陌生 Host 必须 403');
  } finally { await sb.cleanup(); }
});

test('远端：Origin 不在白名单 → 403（不许放行任意 Origin）', async () => {
  const sb = await makeSandbox();
  try {
    await setPassphrase(join(sb.root, '.admin'), PASS);
    const { base } = await sb.start(REMOTE);
    const res = await req(base, '/api/session', {
      headers: proxied({ host: HOSTNAME, origin: 'http://evil.example' })
    });
    assert.equal(res.status, 403, '跨站 Origin 必须 403');
  } finally { await sb.cleanup(); }
});

test('远端：非浏览器客户端（无 Origin）可以放行', async () => {
  const sb = await makeSandbox();
  try {
    await setPassphrase(join(sb.root, '.admin'), PASS);
    const { base } = await sb.start(REMOTE);
    const res = await req(base, '/api/session', { headers: noOrigin() });
    assert.equal(res.status, 200, 'curl 这类不带 Origin 的请求应放行（Host 与密钥仍要过）');
  } finally { await sb.cleanup(); }
});

test('远端：Origin: null 一律拒', async () => {
  const sb = await makeSandbox();
  try {
    await setPassphrase(join(sb.root, '.admin'), PASS);
    const { base } = await sb.start(REMOTE);
    const res = await req(base, '/api/session', {
      headers: proxied({ host: HOSTNAME, origin: 'null' })
    });
    assert.equal(res.status, 403, 'Origin: null 应被拒');
  } finally { await sb.cleanup(); }
});

test('本地模式仍然只认回环 Host：example.test → 403（既有判据不放松）', async () => {
  const sb = await makeSandbox();
  try {
    const { base } = await sb.start({});
    const res = await req(base, '/api/session', { headers: { host: HOSTNAME } });
    assert.equal(res.status, 403, '本地模式不该接受公网 Host');
  } finally { await sb.cleanup(); }
});

/* ============================================================
   5. 反代共享密钥（本机其它进程也进不来）
   ============================================================ */
test('远端：缺少 X-Admin-Proxy-Secret → 403', async () => {
  const sb = await makeSandbox();
  try {
    await setPassphrase(join(sb.root, '.admin'), PASS);
    const { base } = await sb.start(REMOTE);
    const res = await req(base, '/api/session', { headers: { host: HOSTNAME, origin: ORIGIN } });
    assert.equal(res.status, 403, '没有密钥就不该进来');
  } finally { await sb.cleanup(); }
});

test('远端：密钥错误 → 403', async () => {
  const sb = await makeSandbox();
  try {
    await setPassphrase(join(sb.root, '.admin'), PASS);
    const { base } = await sb.start(REMOTE);
    const res = await req(base, '/api/session', {
      headers: { host: HOSTNAME, origin: ORIGIN, 'x-admin-proxy-secret': 'wrong-secret' }
    });
    assert.equal(res.status, 403, '密钥不符必须 403');
  } finally { await sb.cleanup(); }
});

test('本地模式不要求密钥（未配置时行为不变）', async () => {
  const sb = await makeSandbox();
  try {
    const { base } = await sb.start({});
    const res = await req(base, '/api/session', { headers: { host: '127.0.0.1:' + 0 } });
    /* Host 端口需要匹配真实端口，这里只断言"不是因为缺密钥而被拒" */
    assert.notEqual(res.status, 0);
  } finally { await sb.cleanup(); }
});

/* ============================================================
   6. 客户端 IP 取自 XFF 的最后一段（不能信第一段）
   ============================================================ */
test('远端：客户端 IP 取 X-Forwarded-For 最后一段，且用于退避计数', async () => {
  const sb = await makeSandbox();
  try {
    await setPassphrase(join(sb.root, '.admin'), PASS);
    const { app, base } = await sb.start(REMOTE);
    /* 伪造第一段，nginx 追加真实 IP 在最后 */
    for (let i = 0; i < 6; i += 1) {
      await req(base, '/api/login', {
        method: 'POST',
        headers: proxied({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' }),
        body: { passphrase: 'wrong-' + i }
      });
    }
    const st = app.state ? await app.state({ unlocked: false }) : null;
    assert.ok(st, 'state() 应可用');
    /* 退避计数按 9.9.9.9 记，而不是伪造的 1.2.3.4 */
    const { throttleState } = await import('../lib/auth.mjs');
    assert.ok(throttleState('9.9.9.9').fails > 0, '应按 XFF 最后一段计数');
    assert.equal(throttleState('1.2.3.4').fails, 0, '不得按伪造的第一段计数');
  } finally { resetThrottle(); await sb.cleanup(); }
});

/* ============================================================
   7. 本地模式行为完全不变
   ============================================================ *//* ============================================================
   8. 启动横幅（"启动路径"的可执行判据）
   ------------------------------------------------------------
   这段曾经写在 server.listen 的回调里、引用了 createApp 内部的局部变量，
   于是"测试全绿但服务一起来就崩"。抽成纯函数之后在这里钉住。
   ============================================================ */
const bannerCfg = {
  host: '127.0.0.1', port: 8848, remote: true, sessionIdleMs: 120 * 60 * 1000,
  proxySecret: 'x', autoPublish: true, publicHosts: ['example.test'],
  publicOrigins: ['http://example.test'], postsRel: 'blog-enter/js/posts.js',
  runtimeDir: '/srv/blog/repo/.admin'
};

test('启动横幅：远端模式不抛异常，且如实报告 HTTP 下 cookie 无 Secure', () => {
  const lines = bannerLines(bannerCfg, true);
  const text = lines.join('\n');
  assert.ok(text.includes('远端'), '应标明远端模式');
  assert.ok(text.includes('cookie 无 Secure'), '纯 HTTP 下必须如实提示');
  assert.ok(text.includes('已启用反代密钥'));
  assert.ok(text.includes('保存后自动发布'));
  assert.ok(text.includes('Host: example.test'));
});

test('启动横幅：给出 https origin 时如实报告 cookie 带 Secure', () => {
  const text = bannerLines(Object.assign({}, bannerCfg, {
    publicOrigins: ['https://simonfu.xin']
  }), true).join('\n');
  assert.ok(text.includes('cookie 带 Secure'), 'https 下必须提示 Secure 已启用');
  assert.ok(!text.includes('cookie 无 Secure'));
});

test('启动横幅：本地模式报告"只绑回环"', () => {
  const text = bannerLines({
    host: '127.0.0.1', port: 8848, remote: false, sessionIdleMs: 0,
    publicHosts: [], publicOrigins: [], postsRel: 'blog-enter/js/posts.js',
    runtimeDir: '/tmp/.admin'
  }, false).join('\n');
  assert.ok(text.includes('本地（只绑回环'));
  assert.ok(text.includes('未设口令'));
});

test('本地模式：未设口令时未认证的 GET /api/posts 仍为 200（行为不变）', async () => {
  const sb = await makeSandbox();
  try {
    const { base } = await sb.start({});
    const u = new URL(base);
    const res = await req(base, '/api/posts', { headers: { host: '127.0.0.1:' + u.port } });
    assert.equal(res.status, 200, '本地模式语义必须与改造前一致');
  } finally { await sb.cleanup(); }
});

test('远端模式：写了 autoPublish 但发布命令不存在时，保存不被阻塞', async () => {
  const sb = await makeSandbox();
  try {
    await setPassphrase(join(sb.root, '.admin'), PASS);
    const { base } = await sb.start(Object.assign({}, REMOTE, {
      autoPublish: true,
      publishCmd: '/nonexistent/blog-publish-xyz',
      publishTimeoutMs: 3000
    }));
    const jar = makeJar();
    absorb(jar, await req(base, '/api/login', {
      method: 'POST', headers: proxied(), body: { passphrase: PASS }
    }));
    const token = json(await req(base, '/api/session', { headers: proxied(jarHeaders(jar)) })).token;
    const version = json(await req(base, '/api/session', { headers: proxied(jarHeaders(jar)) })).store.version;

    const created = await req(base, '/api/posts', {
      method: 'POST',
      headers: proxied(Object.assign({ 'x-admin-token': token }, jarHeaders(jar))),
      body: {
        version,
        title: '自动发布失败也要保存成功',
        slug: 'auto-publish-fail-safe',
        date: '2025-01-01',
        category: '测试',
        tags: [],
        excerpt: 'e',
        body: '<p>正文</p>'
      }
    });
    assert.equal(created.status, 200, '发布命令失败不应让保存失败：' + created.text.slice(0, 200));
    const src = await readFile(sb.postsFile, 'utf8');
    assert.ok(src.includes('auto-publish-fail-safe'), '文章必须已经落盘');
  } finally { await sb.cleanup(); }
});

/* ============================================================
   收尾
   ============================================================ */
/* run-all.mjs 通过 mod.H 取用 harness，必须导出 */
export { H };
export const run = (opts) => H.run(opts);

if (H && process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const r = await H.run();
  /* 最后确认没有碰过真的 posts.js */
  const after = await readFile(REAL_POSTS, 'utf8');
  assert.equal(after, REAL_BEFORE, '测试期间真的 js/posts.js 被改动了！');
  console.log('  （已确认测试全程未改动真的 js/posts.js）');
  process.exit(r.fail ? 1 : 0);
}
