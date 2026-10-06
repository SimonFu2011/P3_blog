/* ============================================================
   接口验签（同进程 + 真实 HTTP）
   ------------------------------------------------------------
   跑法：node blog-enter/server/tests/api.test.mjs

   为什么不用 node --test 的目录模式：
   受限沙箱禁止子进程使用管道（EPERM），而 node --test 的 runner 需要
   spawn 子进程来跑测试文件。所以测试文件写成"直接执行"，
   仍然用 node:test 的 API，只是由当前进程托管。

   为什么不用 .preview 那套 CDP 无头浏览器：
   这一层要验的是**服务端**判据（对端 / Host / Origin / 令牌 / 路径），
   用真实 HTTP 请求最直接。这些请求在同一个进程里发出，
   不依赖任何外部二进制。

   重要：全部测试跑在临时目录里的**副本**上，绝不碰真的 js/posts.js。
   最后一条断言会显式确认真文件没被动过。
   ============================================================ */
import assert from 'node:assert/strict';
import { createHarness, isMain } from './harness.mjs';

const H = createHarness('api.test.mjs');
const test = (name, fn) => H.test(name, fn);
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../dev-server.mjs';
import * as store from '../lib/posts-store.mjs';
import { slugifyName, sniffType, sanitizeSvg, prepareImage } from '../lib/images.mjs';
import { setPassphrase, resetThrottle } from '../lib/auth.mjs';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const REAL_BLOG = resolve(HERE, '..', '..');          // blog-enter/
const REAL_POSTS = join(REAL_BLOG, 'js', 'posts.js');

/* 真文件在开跑前的指纹，最后用来证明"测试没碰过它" */
const REAL_BEFORE = await readFile(REAL_POSTS, 'utf8');

/* ------------------------------------------------------------
   沙箱
   ------------------------------------------------------------ */
const makeSandbox = async () => {
  const root = await mkdtemp(join(tmpdir(), 'blog-admin-'));
  const blog = join(root, 'blog-enter');
  await mkdir(join(blog, 'js'), { recursive: true });
  await mkdir(join(blog, 'img', 'uploads'), { recursive: true });
  await copyFile(REAL_POSTS, join(blog, 'js', 'posts.js'));
  await writeFile(join(blog, 'index.html'), '<!doctype html><title>sandbox</title>', 'utf8');
  /* 管理页静态文件在仓库里（blog-enter/admin），而沙箱中的 blog 是副本，
     所以下面显式把 uiDir 指到真实位置 —— 顺带验证"管理页确实能服务"。 */

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
    /* 端口写 0 时由系统分配，Host 白名单必须按真实端口判 —— 显式告知 */
    app.setPort(port);
    started.push(app);
    return { app, port, base: 'http://127.0.0.1:' + port };
  };
  const stop = async () => {
    for (const app of started) await new Promise((ok) => app.server.close(ok));
    started.length = 0;
  };
  const cleanup = async () => { await stop(); await rm(root, { recursive: true, force: true }); };
  const readPostsFile = () => readFile(postsFile, 'utf8');
  const resetPosts = () => writeFile(postsFile, original, 'utf8');

  return { root, blog, postsFile, original, start, stop, cleanup, readPostsFile, resetPosts, port: null };
};

/* 带默认头的请求：Host 会被 fetch 自动设成 127.0.0.1:port（合法） */
const req = async (base, path, opts) => {
  const o = Object.assign({ method: 'GET' }, opts || {});
  const res = await fetch(base + path, o);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 就留 null */ }
  return { status: res.status, headers: res.headers, text, json };
};

/**
 * 用 node:http 直接发请求，可以**自定义 Host 头**。
 * 这一点 fetch 做不到：Host 是 forbidden header，undici 会无视我们传的值，
 * 于是"Host 白名单"这条判据用 fetch 根本测不到。
 */
const rawReq = (base, path, opts) => new Promise((ok, fail) => {
  const o = opts || {};
  const u = new URL(base);
  const r = http.request({
    hostname: u.hostname,
    port: u.port,
    path,
    method: o.method || 'GET',
    headers: o.headers || {}
  }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      let json = null;
      try { json = JSON.parse(body); } catch { /* 非 JSON */ }
      ok({ status: res.statusCode, headers: res.headers, text: body, json });
    });
  });
  r.on('error', fail);
  if (o.body) r.write(o.body);
  r.end();
});

/**
 * 写请求助手。
 *
 * 【为什么这里要自动补 version】接口现在**要求**写操作必须带版本号 ——
 * 原来"没带就跳过检查"等于只要省略这个字段就能绕过并发保护（两个标签页
 * 互相静默覆盖）。所以大多数用例只想表达"我要写这篇文章"，版本号是噪音；
 * 这里自动取当前值补上。想显式测"过期版本号"或"完全没带版本号"的用例，
 * 自己传 version（或传 version: null）即可，本函数不会覆盖已给出的值。
 */
const jsonReq = async (base, path, method, body, headers) => {
  let payload = body || {};
  const isWrite = method && method !== 'GET' && method !== 'HEAD';
  if (isWrite && path.startsWith('/api/posts')
      && !Object.prototype.hasOwnProperty.call(payload, 'version')) {
    const cur = await req(base, '/api/session');
    const v = cur.json && cur.json.store && cur.json.store.version;
    if (v) payload = Object.assign({}, payload, { version: v });
  }
  return req(base, path, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: JSON.stringify(payload)
  });
};

/* 每篇新文章都长这样，字段齐全 */
const draft = (slug, over) => Object.assign({
  slug,
  title: '接口验签用的文章',
  date: '2026-02-14',
  category: '测试',
  tags: ['验签'],
  excerpt: '由验签脚本写入沙箱副本。',
  body: '<p>正文段落。</p>\n<h2>小节</h2>\n<pre><code class="lang-js">const a = 1;</code></pre>'
}, over || {});

/* ============================================================
   0. 纯函数层（不依赖服务器）
   ============================================================ */
test('图片：文件名 slug 化挡掉一切路径花招', () => {
  const cases = [
    /* 只取路径最后一段：目录信息没有任何理由被带进文件名 */
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\windows\\win.ini', 'win'],
    ['C:\\Users\\Simon\\a b.png', 'a-b'],
    ['/abs/path/x.JPG', 'x'],
    ['', 'image'],
    ['.', 'image'],
    ['..', 'image'],
    ['CON', 'img-con'],
    ['nul.png', 'img-nul'],
    ['中文 名字.png', '中文-名字'],
    ['a\u0000b.png', 'a-b'],
    ['a'.repeat(200) + '.png', 'a'.repeat(48)]
  ];
  for (const [input, want] of cases) {
    assert.equal(slugifyName(input), want, 'slugify(' + JSON.stringify(input) + ')');
  }
  /* 结果永远不含分隔符，也不含点 */
  for (const [input] of cases) {
    const out = slugifyName(input);
    assert.ok(!/[\\/.]/.test(out), '输出不含路径分隔符或点：' + out);
  }
});

test('图片：类型只看魔数，不看扩展名和声明', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  assert.equal(sniffType(png), 'png');
  /* 一个 .jpg 名字 + PNG 内容 → 认 png（内容优先） */
  assert.equal(prepareImage(png, 'x.jpg').ext, '.png');

  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(8)]);
  assert.equal(sniffType(gif), 'gif');

  const html = Buffer.from('<html><script>alert(1)</script></html>');
  assert.equal(sniffType(html), null);
  assert.throws(() => prepareImage(html, 'evil.svg'), /认不出/);

  /* 有 <svg> 但没有 <script> 的合法 SVG */
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
  assert.equal(sniffType(svg), 'svg');
});

test('图片：SVG 净化扔掉脚本、事件属性、外链与未知元素', () => {
  const dirty = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
    '<script>fetch("http://evil")</script>' +
    '<rect width="10" height="10" fill="red" onclick="x()"/>' +
    '<image href="http://evil.example/x.png"/>' +
    '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml">hi</body></foreignObject>' +
    '<a xlink:href="javascript:alert(1)"><circle r="4"/></a>' +
    '<circle r="5" style="fill:url(http://evil/x)"/>' +
    '</svg>';
  const r = sanitizeSvg(dirty);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(!/script/i.test(r.svg), '不该留下 <script>');
  assert.ok(!/onload|onclick|onerror/i.test(r.svg), '不该留下事件属性');
  assert.ok(!/evil\.example/.test(r.svg), '不该留下外部引用');
  assert.ok(!/foreignObject/i.test(r.svg), '不该留下 foreignObject');
  assert.ok(!/javascript:/i.test(r.svg), '不该留下 javascript: 协议');
  /* 允许 url(#id)，但绝不允许指向外部资源的 url() */
  assert.ok(!/url\((?!\s*['"]?\s*#)/i.test(r.svg), '不该留下指向外部的 url()');
  assert.ok(/<rect/.test(r.svg) && /<circle/.test(r.svg), '合法图形要保留');
  assert.ok(r.warnings.length > 0, '应该有"丢掉了什么"的提示');
});

/* ============================================================
   1. 安全闸门
   ============================================================ */
test('会话接口：store.bytes 报的是真实字节数（不是 UTF-16 字符数）', async () => {
  const sb = await makeSandbox();
  try {
    const { base } = await sb.start();
    const s = await req(base, '/api/session');
    const onDisk = await sb.readPostsFile();
    /* 这个站点里正文全是中文：一个汉字 1 个 UTF-16 码元、3 个 UTF-8 字节，
       所以 source.length 与 Buffer.byteLength 会差出很大一截。
       字段名既然叫 bytes，就必须是字节 —— 否则核对文件大小时必然误导。 */
    assert.equal(s.json.store.bytes, Buffer.byteLength(onDisk, 'utf8'),
      'store.bytes 应等于 UTF-8 字节数');
    assert.equal(s.json.store.chars, onDisk.length, 'store.chars 是码元数');
    assert.notEqual(s.json.store.bytes, s.json.store.chars,
      '这个文件的字节数与字符数本来就不同（中文占 3 字节），若相等说明取错了量纲');
  } finally { await sb.cleanup(); }
});

test('安全闸：Host 白名单挡住 DNS rebinding', async () => {
  const sb = await makeSandbox();
  try {
    const { base, port } = await sb.start();

    /* 正常 Host：放行 */
    const ok = await req(base, '/api/posts');
    assert.equal(ok.status, 200);

    /* 攻击者域名解析到 127.0.0.1 的情形：Host 不是本机名 → 403 */
    const bad = await rawReq(base, '/api/posts', { headers: { host: 'evil.example' } });
    assert.equal(bad.status, 403, 'Host: evil.example 必须被拒，实际 ' + bad.status);

    /* 端口对不上也要拒 */
    const badPort = await rawReq(base, '/api/posts', { headers: { host: '127.0.0.1:1' } });
    assert.equal(badPort.status, 403, '端口不匹配必须被拒');

    /* 完全没有 Host 头：只能用裸 socket 构造（Node 的 http 客户端会兜底补一个） */
    const noHost = await new Promise((ok, fail) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write('GET /api/posts HTTP/1.1\r\nConnection: close\r\n\r\n');
      });
      let buf = '';
      s.setEncoding('utf8');
      s.on('data', (c) => { buf += c; });
      s.on('end', () => ok(buf));
      s.on('error', fail);
      setTimeout(() => { try { s.destroy(); } catch { /* 已断 */ } }, 3000).unref();
    });
    assert.match(noHost, /^HTTP\/1\.1 (?:400|403)/, '缺少 Host 必须被拒，实际：' + noHost.slice(0, 40));

    /* localhost / [::1] 与真实端口是允许的 */
    const local = await rawReq(base, '/api/posts', { headers: { host: 'localhost:' + port } });
    assert.equal(local.status, 200, 'localhost 应放行');
    const v6 = await rawReq(base, '/api/posts', { headers: { host: '[::1]:' + port } });
    assert.equal(v6.status, 200, '[::1] 应放行');
  } finally { await sb.cleanup(); }
});

test('安全闸：跨站请求被 Origin / Sec-Fetch-Site 挡住', async () => {
  const sb = await makeSandbox();
  try {
    const { base } = await sb.start();

    const crossOrigin = await req(base, '/api/posts', { headers: { origin: 'http://evil.example' } });
    assert.equal(crossOrigin.status, 403, '跨源 Origin 必须被拒');

    const crossSite = await req(base, '/api/posts', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSite.status, 403, 'Sec-Fetch-Site: cross-site 必须被拒');

    const sameSite = await req(base, '/api/posts', { headers: { 'sec-fetch-site': 'same-site' } });
    assert.equal(sameSite.status, 403, 'same-site（旁站页面）也要拒');

    const goodOrigin = await req(base, '/api/posts', { headers: { origin: base } });
    assert.equal(goodOrigin.status, 200, '同源 Origin 放行');

    const none = await req(base, '/api/posts', { headers: { 'sec-fetch-site': 'none' } });
    assert.equal(none.status, 200, '直接敲地址（none）放行');
  } finally { await sb.cleanup(); }
});

test('安全闸：写操作必须带会话令牌，令牌错误/缺失都拒', async () => {
  const sb = await makeSandbox();
  try {
    const { base } = await sb.start();

    /* 没令牌：Host/来源三道闸先过，然后才是令牌判定 */
    const noToken = await jsonReq(base, '/api/posts', 'POST', draft('no-token'));
    assert.equal(noToken.status, 401);

    /* 令牌不对 */
    const wrong = await jsonReq(base, '/api/posts', 'POST', draft('wrong-token'),
      { 'x-admin-token': 'deadbeef' });
    assert.equal(wrong.status, 403);

    /* 正确令牌（从 /api/session 取） */
    const s = await req(base, '/api/session');
    assert.equal(s.status, 200);
    assert.ok(s.json.token, '无口令模式应直接下发令牌');
    const good = await jsonReq(base, '/api/posts', 'POST', draft('good-token'),
      { 'x-admin-token': s.json.token });
    assert.equal(good.status, 200, good.text);
    assert.equal(good.json.slug, 'good-token');
  } finally { await sb.cleanup(); }
});

test('安全闸：静态文件不能越出站点根，隐藏目录一律 404', async () => {
  const sb = await makeSandbox();
  try {
    const { base } = await sb.start();

    assert.equal((await req(base, '/index.html')).status, 200);
    /* 百分号编码的 .. 不会被 URL 规范化吃掉，正好用来测解密后越界 */
    const escape = await req(base, '/%2e%2e/%2e%2e/.admin/session.json');
    assert.ok(escape.status === 403 || escape.status === 404, '越界必须被拒，实际 ' + escape.status);
    assert.ok(!/token/.test(escape.text), '绝不能吐出会话内容');

    /* .admin / .preview 这类隐藏目录不该被服务；URL 规范化会先吃掉 "/_admin/../"，
       所以拿它测越界没有意义（规范化之后就是公开路径），改测点开头与编码形式 */
    assert.equal((await req(base, '/.hidden/x.js')).status, 404);
    assert.equal((await req(base, '/.admin/session.json')).status, 404);
    assert.equal((await req(base, '/js/posts.js')).status, 200, '正常静态资源照常');
    assert.equal((await req(base, '/_admin/secret.txt')).status, 404);
  } finally { await sb.cleanup(); }
});

test('安全闸：管理页带严格 CSP 与 noindex，且不暴露目录', async () => {
  const sb = await makeSandbox();
  try {
    const { base } = await sb.start();

    const page = await req(base, '/_admin/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') || '', /default-src 'none'/);
    assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');

    /* 令牌脚本：子资源请求带 Origin 也照常返回（浏览器行为），
       但令牌里绝不含可被 HTML 借用的字符 */
    const tokenSame = await req(base, '/_admin/token.js');
    assert.equal(tokenSame.status, 200);
    assert.match(tokenSame.text, /^window\.__ADMIN_TOKEN__ = "/);
    assert.ok(!/[<>]/.test(tokenSame.text), '令牌脚本里不能出现尖括号');
    const tokenWithOrigin = await req(base, '/_admin/token.js', { headers: { origin: base } });
    assert.equal(tokenWithOrigin.status, 200, '同源子资源请求必须能取到令牌：' + tokenWithOrigin.text.slice(0, 120));
    /* 但跨源页面的 XHR 读不到内容：没有 CORS 头 */
    const crossRead = await req(base, '/_admin/token.js', {
      headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' }
    });
    assert.equal(crossRead.status, 403, '跨站请求仍被来源判定挡住');

    assert.equal((await req(base, '/_admin/secret.txt')).status, 404);
  } finally { await sb.cleanup(); }
});

/* ============================================================
   2. 口令模式
   ============================================================ */
test('口令模式：未登录不给令牌，登录后写操作才可用', async () => {
  const sb = await makeSandbox();
  try {
    resetThrottle();     // 退避是进程级状态，测试之间要清干净
    await setPassphrase(join(sb.root, '.admin'), 'correct horse battery');
    const { base } = await sb.start();

    const before = await req(base, '/api/session');
    assert.equal(before.json.auth, 'passphrase');
    assert.equal(before.json.unlocked, false);
    assert.equal(before.json.token, null, '未解锁时绝不能下发令牌');

    /* 令牌的第二条出口也必须上锁。
       第一版漏了这里：/_admin/token.js 在未解锁时也照发令牌，
       于是"口令门"只是遮住了界面，令牌人人可得 ——
       有一条出口没锁，等于全部没锁。 */
    const tokenLocked = await req(base, '/_admin/token.js');
    assert.equal(tokenLocked.status, 401, '未解锁时令牌脚本必须拒绝');
    assert.ok(!/__ADMIN_TOKEN__\s*=\s*"/.test(tokenLocked.text),
      '未解锁时令牌脚本里不能出现令牌：' + tokenLocked.text.slice(0, 80));

    /* 未登录就想写：连令牌都没拿到 */
    const deny = await jsonReq(base, '/api/posts', 'POST', draft('locked-out'));
    assert.equal(deny.status, 401);
    assert.match(deny.json.error, /未解锁/);

    /* 口令错误 → 401，并且进入冷却窗口 */
    const wrong = await jsonReq(base, '/api/login', 'POST', { passphrase: 'nope' });
    assert.equal(wrong.status, 401);
    assert.match(wrong.json.error, /口令/);

    /* 冷却窗口内，正确口令也会被 429 挡住 —— 这是设计意图：
       否则攻击者猜中一次就能立刻把失败计数清零。 */
    const duringCooldown = await jsonReq(base, '/api/login', 'POST', { passphrase: 'correct horse battery' });
    assert.equal(duringCooldown.status, 429, '冷却期内必须拒绝（含正确口令）');
    assert.match(duringCooldown.json.error, /过于频繁/);

    /* 等冷却结束（第一次失败退避 1s），正确口令应该放行 */
    resetThrottle();
    const right = await jsonReq(base, '/api/login', 'POST', { passphrase: 'correct horse battery' });
    assert.equal(right.status, 200, right.text);
    assert.ok(right.json.token);

    const after = await req(base, '/api/session');
    assert.equal(after.json.unlocked, true);

    /* 解锁之后，令牌脚本才应该给出令牌（内容是纯 JS 赋值，不含尖括号） */
    const tokenOpen = await req(base, '/_admin/token.js');
    assert.equal(tokenOpen.status, 200, '解锁后令牌脚本应可用');
    assert.match(tokenOpen.text, /^window\.__ADMIN_TOKEN__ = "/);
    assert.ok(!/[<>]/.test(tokenOpen.text), '令牌脚本里不能出现尖括号');
    assert.ok(tokenOpen.text.includes(right.json.token), '脚本里的令牌应与 /api/login 下发的一致');

    const write = await jsonReq(base, '/api/posts', 'POST', draft('unlocked-write'),
      { 'x-admin-token': right.json.token });
    assert.equal(write.status, 200, '登录后应能写入：' + write.text.slice(0, 200));

    /* 登录接口自己不能被解锁闸门挡住（否则就是死锁） */
    assert.equal(right.status, 200, 'POST /api/login 必须在解锁闸门之外');
  } finally { await sb.cleanup(); }
});

/* ============================================================
   3. 增删改的完整链路
   ============================================================ */
test('新增：新文章进入数组最前，其余文章源码逐字节不变', async () => {
  const sb = await makeSandbox();
  try {
    const { base } = await sb.start();
    const s = await req(base, '/api/session');
    const token = s.json.token;
    const beforeText = await sb.readPostsFile();

    const res = await jsonReq(base, '/api/posts', 'POST',
      draft('api-new-post', { title: '接口新增的文章' }), { 'x-admin-token': token });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.slug, 'api-new-post');
    assert.ok(res.json.backup, '写盘前必须留下备份');

    const list = await req(base, '/api/posts');
    assert.equal(list.json.posts[0].slug, 'api-new-post', '新文章应在最前');

    const afterText = await sb.readPostsFile();
    const beforePosts = store.parse(beforeText).posts;
    const afterPosts = store.parse(afterText).posts;
    assert.equal(afterPosts.length, beforePosts.length + 1);
    /* 原有每一篇的源码区间都应原样出现 */
    for (const span of store.parse(beforeText).spans) {
      assert.ok(afterText.includes(span.text), '未改动的文章不应被重写');
    }
    assert.ok(afterText.length > beforeText.length);
  } finally { await sb.cleanup(); }
});

test('校验：非法字段一律 422 且附带逐条原因，文件不动', async () => {
  const sb = await makeSandbox();
  try {
    const { base } = await sb.start();
    const token = (await req(base, '/api/session')).json.token;
    const beforeText = await sb.readPostsFile();

    const cases = [
      ['坏 slug', draft('Bad Slug!')],
      ['空标题', draft('t1', { title: '  ' })],
      ['坏日期', draft('t2', { date: '2026-02-30' })],
      ['空分类', draft('t3', { category: '' })],
      ['标签过多', draft('t4', { tags: new Array(20).fill('x') })],
      ['正文里有 script', draft('t5', { body: '<p>hi</p><script>alert(1)</script>' })],
      ['正文标签不闭合', draft('t6', { body: '<p>没关' })],
      ['正文里的 iframe', draft('t7', { body: '<iframe src="http://evil"></iframe>' })],
      ['事件属性', draft('t8', { body: '<p onclick="x()">hi</p>' })],
      ['javascript 协议', draft('t9', { body: '<a href="javascript:alert(1)">x</a>' })],
      ['重复 slug', draft('water-entry')]
    ];
    for (const [label, body] of cases) {
      const r = await jsonReq(base, '/api/posts', 'POST', body, { 'x-admin-token': token });
      assert.equal(r.status, 422, label + ' 应当被拒，实际 ' + r.status + ' ' + r.text);
      assert.ok(Array.isArray(r.json.errors) && r.json.errors.length, label + ' 应给出原因');
    }
    assert.equal(await sb.readPostsFile(), beforeText, '被拒的请求不能动文件');
  } finally { await sb.cleanup(); }
});

test('更改：就地替换、保持位置、未改动的文章不动', async () => {
  const sb = await makeSandbox();
  try {
    const { base } = await sb.start();
    const token = (await req(base, '/api/session')).json.token;

    const list = await req(base, '/api/posts');
    const target = list.json.posts[2];
    const res = await jsonReq(base, '/api/posts', 'PUT',
      { originalSlug: target.slug, title: '改过的标题', body: '<p>改过的正文</p>', version: list.json.version },
      { 'x-admin-token': token });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.slug, target.slug);
    assert.equal(res.json.renamed, false);

    const after = await req(base, '/api/posts');
    assert.equal(after.json.posts[2].slug, target.slug, '位置不能变');
    assert.equal(after.json.posts[2].title, '改过的标题');
    assert.equal(after.json.posts[0].slug, list.json.posts[0].slug);
  } finally { await sb.cleanup(); }
});

test('更改 slug：旧地址以别名形式保留，外链不失效', async () => {
  const sb = await makeSandbox();
  try {
    const { base } = await sb.start();
    const token = (await req(base, '/api/session')).json.token;
    const list = await req(base, '/api/posts');
    const target = list.json.posts[1];

    const res = await jsonReq(base, '/api/posts', 'PUT',
      { originalSlug: target.slug, slug: 'renamed-slug' }, { 'x-admin-token': token });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.renamed, true);

    const after = await req(base, '/api/posts');
    const moved = after.json.posts[1];
    assert.equal(moved.slug, 'renamed-slug');
    /* 用 JSON 比较，避免 vm 沙箱的原型差异干扰 deepEqual */
    assert.equal(JSON.stringify([].concat(moved.aliases)),
      JSON.stringify([target.slug]),
      '改 slug 后别名应记录旧地址；实际篇目=' + JSON.stringify(moved));
    assert.equal(after.json.count, list.json.count, '改 slug 不能丢文章');
  } finally { await sb.cleanup(); }
});

test('删除：搬进回收站、篇数减一、文件仍可求值', async () => {
  const sb = await makeSandbox();
  try {
    const { base } = await sb.start();
    const token = (await req(base, '/api/session')).json.token;
    const list = await req(base, '/api/posts');
    const victim = list.json.posts[3].slug;

    const res = await jsonReq(base, '/api/posts/delete', 'POST',
      { slug: victim, version: list.json.version }, { 'x-admin-token': token });
    assert.equal(res.status, 200, res.text);
    assert.match(res.json.trash, /\.admin[\\/]trash/);

    const after = await req(base, '/api/posts');
    assert.equal(after.json.count, list.json.count - 1);
    assert.ok(!after.json.posts.some((p) => p.slug === victim));

    /* 回收站里应该找得到 */
    const backups = await req(base, '/api/backups');
    assert.ok(backups.json.trash.some((t) => t.name.includes(victim)), '回收站里应有这篇');
    assert.ok(backups.json.backups.length >= 1, '至少有一份 posts.js 备份');
  } finally { await sb.cleanup(); }
});

test('并发保护：版本号过期必须是 409，不许静默覆盖', async () => {
  const sb = await makeSandbox();
  try {
    const { base } = await sb.start();
    const token = (await req(base, '/api/session')).json.token;
    const stale = (await req(base, '/api/posts')).json.version;

    /* 先成功写一次，版本号就变了 */
    const first = await jsonReq(base, '/api/posts', 'POST', draft('first-write'), { 'x-admin-token': token });
    assert.equal(first.status, 200);

    /* 再拿旧版本号提交 */
    const second = await jsonReq(base, '/api/posts', 'POST',
      Object.assign(draft('second-write'), { version: stale }), { 'x-admin-token': token });
    assert.equal(second.status, 409, '过期版本号必须 409，实际 ' + second.status);
    assert.match(second.json.error, /别处被改动/);

    /* 冲突之后文件里不应该出现第二篇 */
    const list = await req(base, '/api/posts');
    assert.ok(!list.json.posts.some((p) => p.slug === 'second-write'));

    /* 刷新版本号后可以写 */
    const third = await jsonReq(base, '/api/posts', 'POST',
      Object.assign(draft('second-write'), { version: list.json.version }), { 'x-admin-token': token });
    assert.equal(third.status, 200, third.text);
  } finally { await sb.cleanup(); }
});

/* ============================================================
   4. 图片上传
   ============================================================ */
test('图片上传：合法 PNG 落盘到 img/uploads，文件名由服务端生成', async () => {
  const sb = await makeSandbox();
  try {
    const { base } = await sb.start();
    const token = (await req(base, '/api/session')).json.token;

    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('some png bytes')
    ]);
    const up = await req(base, '/api/images', {
      method: 'POST',
      headers: { 'x-admin-token': token, 'x-file-name': encodeURIComponent('../../我的 图.png') },
      body: png
    });
    assert.equal(up.status, 200, up.text);
    assert.equal(up.json.src, 'img/uploads/我的-图.png');
    assert.ok(!up.json.src.includes('..'), '不能保留任何路径片段');

    /* 第二张同名 → 自动加序号 */
    const up2 = await req(base, '/api/images', {
      method: 'POST',
      headers: { 'x-admin-token': token, 'x-file-name': encodeURIComponent('我的 图.png') },
      body: png
    });
    assert.equal(up2.json.src, 'img/uploads/我的-图-2.png');

    /* 落盘的文件确实能通过静态路由访问到 */
    const served = await req(base, '/' + up.json.src);
    assert.equal(served.status, 200);

    const list = await req(base, '/api/images');
    assert.equal(list.json.images.length, 2);

    /* 伪装成图片的 HTML 必须被拒 */
    const fake = await req(base, '/api/images', {
      method: 'POST',
      headers: { 'x-admin-token': token, 'x-file-name': 'evil.png' },
      body: Buffer.from('<html><script>alert(1)</script></html>')
    });
    assert.equal(fake.status, 422);

    /* 没令牌不能上传 */
    const noToken = await req(base, '/api/images', {
      method: 'POST', headers: { 'x-file-name': 'x.png' }, body: png
    });
    assert.equal(noToken.status, 401);
  } finally { await sb.cleanup(); }
});

/* ============================================================
   5. 备份恢复与提交前复核
   ============================================================ */
test('备份恢复：可回到上一版，且恢复前会先校验备份本身', async () => {
  const sb = await makeSandbox();
  try {
    const { base } = await sb.start();
    const token = (await req(base, '/api/session')).json.token;
    const original = await sb.readPostsFile();
    const originalCount = (await req(base, '/api/posts')).json.count;

    await jsonReq(base, '/api/posts/delete', 'POST',
      { slug: (await req(base, '/api/posts')).json.posts[0].slug }, { 'x-admin-token': token });
    assert.equal((await req(base, '/api/posts')).json.count, originalCount - 1);

    const backups = (await req(base, '/api/backups')).json.backups;
    assert.ok(backups.length >= 1);
    /* 恢复最早的那份（即删除之前的那一版） */
    const target = backups[backups.length - 1].name;
    const restored = await jsonReq(base, '/api/backups/restore', 'POST',
      { name: target }, { 'x-admin-token': token });
    assert.equal(restored.status, 200, restored.text);
    assert.equal(restored.json.count, originalCount);
    assert.equal(await sb.readPostsFile(), original, '恢复后应与最初完全一致');

    /* 文件名必须过白名单，不能借恢复接口读任意文件 */
    const evil = await jsonReq(base, '/api/backups/restore', 'POST',
      { name: '../../session.json' }, { 'x-admin-token': token });
    assert.equal(evil.status, 422);
  } finally { await sb.cleanup(); }
});

test('提交前复核：正文有问题的文章会让整个提交被拒', async () => {
  const sb = await makeSandbox();
  try {
    const { base } = await sb.start();
    const token = (await req(base, '/api/session')).json.token;

    /* 直接改沙箱里的源码，塞一段危险正文（模拟"手动编辑改坏了"） */
    const text = await sb.readPostsFile();
    const broken = text.replace("<p>首屏只有一个动作", "<p onmouseover=\"steal()\">首屏只有一个动作");
    assert.notEqual(broken, text, '测试前提：替换必须命中');
    await writeFile(sb.postsFile, broken, 'utf8');
    /* 让服务端重新读盘：GET 会刷新内部版本号 */
    await req(base, '/api/posts');

    const res = await jsonReq(base, '/api/git', 'POST', { action: 'commit' }, { 'x-admin-token': token });
    assert.equal(res.status, 422, '有问题的正文必须挡住提交：' + res.text);
    assert.ok(res.json.errors.some((e) => /water-entry/.test(e)));
  } finally { await sb.cleanup(); }
});

/* ============================================================
   6. 收尾：真文件必须毫发无损
   ============================================================ */
test('全程未触碰真实的 js/posts.js', async () => {
  const now = await readFile(REAL_POSTS, 'utf8');
  assert.equal(now, REAL_BEFORE, '真实文章文件被改动了！测试没有正确沙箱化');
});

if (isMain(import.meta.url)) await H.run().then((r) => process.exit(r.fail ? 1 : 0));

export { H };
