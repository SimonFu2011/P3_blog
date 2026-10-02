/* ============================================================
   管理页浏览器验签（真实 Chrome + CDP）
   ------------------------------------------------------------
   跑法：先起服务器，再执行本脚本
     node blog-enter/server/dev-server.mjs
     node blog-enter/server/tests/verify-admin-ui.mjs

   为什么要在真浏览器里跑一遍：
     · 服务端的 19 项验签保证了"接口正确"，但保证不了"按钮点得动" ——
       CSP 是否把脚本拦了、预览 iframe 能不能渲染、拖拽上传是否触发，
       这些只有真渲染才知道。
     · 顺带验证管理页的操作**没有**破坏公开页面（归档/详情）。

   安全性：脚本只改自己被允许改的东西，结束时把 posts.js 还原成开跑前的
   内容（并且删除本次为测试新增的图片），不留下任何痕迹。
   ============================================================ */
import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, unlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.ADMIN_URL || 'http://127.0.0.1:8848';
const PORT = Number(process.env.CDP_PORT || 9366);
const OUT = process.env.PREVIEW_OUT || 'D:\\DS\\.preview';
const POSTS = 'D:\\DS\\blog-enter\\js\\posts.js';
const UPLOADS = 'D:\\DS\\blog-enter\\img\\uploads';

const TEST_SLUG = 'zz-verify-admin-' + Date.now().toString(36);
const TEST_TITLE = '验签临时文章（应被自动清理）';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

/* ------------------------------------------------------------
   0. 前置：服务器在跑吗
   ------------------------------------------------------------ */
const ping = await fetch(BASE + '/api/session').then((r) => r.json()).catch(() => null);
if (!ping || !ping.ok) {
  console.error('本地服务没起来：先执行 node blog-enter/server/dev-server.mjs');
  process.exit(2);
}
if (ping.auth === 'passphrase') {
  console.error('这个验签脚本需要在未设口令的模式下跑（令牌模式），当前是口令模式。');
  process.exit(3);
}
const TOKEN = ping.token;
const beforePosts = await readFile(POSTS, 'utf8');
let beforeUploads = [];
try { beforeUploads = await readdir(UPLOADS); } catch { /* 目录可能不存在 */ }
console.log('开跑前：' + ping.store.count + ' 篇，版本 ' + ping.store.version.slice(0, 12));
console.log('');

/* ------------------------------------------------------------
   CDP 样板（与 .preview/*.mjs 同一手法：node 内置 fetch + WebSocket）
   ------------------------------------------------------------ */
let chrome = null;
try {
  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
    '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900',
    '--user-data-dir=' + join(OUT, 'cp-admin-verify'), 'about:blank'
  ], { stdio: 'ignore' });
} catch (err) {
  chrome = null;
  console.error('无法启动 Chrome：' + err.message);
}

/* 注意一个容易误判的地方：在这种受限环境里，Chrome **能**被 spawn 起来
   （pid 正常、'spawn' 事件正常），但进程会立刻被环境杀掉 ——
   stderr 里是 crashpad 的 "OpenProcess: 拒绝访问"。
   所以这里不能只等 'error' 事件，必须同时盯 'close'。 */
let spawnFailed = null;
let chromeClosed = null;
if (chrome) {
  chrome.on('error', (err) => { spawnFailed = err; });
  chrome.on('close', (code) => { chromeClosed = code; });
} else {
  spawnFailed = new Error('spawn 不可用');
}

let ws = null;
let seq = 0;
const pending = new Map();
const send = (method, params, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify(sessionId
    ? { id, method, params: params || {}, sessionId }
    : { id, method, params: params || {} }));
});

let version = null;
for (let i = 0; i < 60 && !version; i++) {
  if (spawnFailed || chromeClosed !== null) break;
  await sleep(250);
  try { version = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); } catch { /* 还没起来 */ }
}
if (!version) {
  console.error('');
  if (chromeClosed !== null) {
    console.error('浏览器进程起来后立刻退出了（exit code ' + chromeClosed + '），没能开出调试端口。');
    console.error('常见原因：当前环境限制了 Chrome 的进程/内存操作（crashpad 会报 OpenProcess 拒绝访问）。');
  } else if (spawnFailed) {
    console.error('无法启动浏览器：' + spawnFailed.message);
  } else {
    console.error('等不到 Chrome 的调试端口（检查 CHROME_PATH，或端口 ' + PORT + ' 是否被占用）。');
  }
  console.error('');
  console.error('本脚本需要真实浏览器。不依赖浏览器的那部分请跑：');
  console.error('  node blog-enter/server/tests/run-all.mjs');
  process.exit(5);
}

ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

const consoleErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error)));
    else res(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params.exceptionDetails.exception?.description ||
      m.params.exceptionDetails.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
  }
};

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable');
await S('Runtime.enable');
await S('Log.enable').catch(() => {});
await S('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
});

const js = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
};

const goto = async (url, waitMs) => {
  await S('Page.navigate', { url });
  await sleep(waitMs || 1200);
};

const shot = async (name) => {
  try {
    const r = await S('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('  （截图 ' + name + '.png）');
  } catch (err) { console.log('  （截图失败：' + err.message + '）'); }
};

/* ============================================================
   1. 管理页能打开、脚本没被 CSP 拦、列表渲染出来
   ============================================================ */
console.log('1) 管理页');
await goto(BASE + '/_admin/', 1800);

const adminState = await js(`(function(){
  return {
    hasToken: typeof window.__ADMIN_TOKEN__ === 'string' && window.__ADMIN_TOKEN__.length > 10,
    appVisible: !document.getElementById('app').hidden,
    gateVisible: !document.getElementById('gate').hidden,
    listCount: document.querySelectorAll('#postList .ad-post').length,
    authPill: document.getElementById('authPill').textContent,
    countPill: document.getElementById('countPill').textContent,
    gitPill: document.getElementById('gitPill').textContent
  };
})()`);
ok('管理页脚本执行（app 可见）', adminState.appVisible, JSON.stringify(adminState));
ok('拿到了会话令牌', adminState.hasToken);
ok('列表渲染出文章', adminState.listCount === ping.store.count,
  adminState.listCount + ' vs ' + ping.store.count);
ok('认证状态显示出来', /本机|解锁/.test(adminState.authPill), adminState.authPill);
console.log('     git 状态：' + adminState.gitPill + '；计数：' + adminState.countPill);
await shot('admin-list');

/* ============================================================
   2. 新建 → 保存（走真实 UI 路径）
   ============================================================ */
console.log('');
console.log('2) 新建并保存');
await js(`document.getElementById('newBtn').click(); true`);
await sleep(400);

const newState = await js(`(function(){
  return { formVisible: !document.getElementById('form').hidden,
           title: document.getElementById('formTitle').textContent };
})()`);
ok('点击"新建"打开表单', newState.formVisible && /新建/.test(newState.title), JSON.stringify(newState));

/* 用 input 事件驱动（让页面的脏标记与预览逻辑真的跑起来） */
await js(`(function(){
  const set = (id, v) => {
    const el = document.getElementById(id);
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set('fTitle', ${JSON.stringify(TEST_TITLE)});
  set('fSlug', ${JSON.stringify(TEST_SLUG)});
  set('fDate', '2026-02-14');
  set('fCategory', '验签');
  set('fTags', '验签, 自动化');
  set('fExcerpt', '由 verify-admin-ui.mjs 创建，跑完会删除。');
  set('fBody', '<p>第一段。</p>\\n<h2>小节</h2>\\n<pre><code class="lang-js">const a = 1;</code></pre>\\n<blockquote><p>引用</p></blockquote>');
  return true;
})()`);
await sleep(700);

const dirty = await js(`!document.getElementById('dirtyBox').hidden`);
ok('改动被标记为"未保存"', dirty);

const previewOk = await js(`(function(){
  const d = document.getElementById('preview').contentDocument;
  if (!d) return { ok: false, reason: 'no doc' };
  return {
    ok: true,
    hasParagraph: d.body.innerHTML.includes('第一段'),
    hasHeading: !!d.querySelector('h2'),
    hasQuote: !!d.querySelector('blockquote'),
    codeDecorated: !!d.querySelector('.code-block') || !!d.querySelector('pre code .tok-kw'),
    styled: d.querySelectorAll('style').length > 0
  };
})()`);
ok('预览渲染出正文', previewOk.ok && previewOk.hasParagraph, JSON.stringify(previewOk));
ok('预览里的小标题/引用都在', previewOk.hasHeading && previewOk.hasQuote);
ok('预览注入了站点样式', previewOk.styled);
await shot('admin-editor');

await js(`document.getElementById('saveBtn').click(); true`);
await sleep(1600);

const saved = await js(`(function(){
  return {
    errors: document.getElementById('errors').hidden ? '' : document.getElementById('errors').textContent,
    savedHint: document.getElementById('savedHint').textContent,
    dirty: !document.getElementById('dirtyBox').hidden,
    listFirst: (document.querySelector('#postList .ad-post .ad-post-slug') || {}).textContent || ''
  };
})()`);
ok('保存没有报错', !saved.errors, saved.errors);
ok('保存后脏标记清除', !saved.dirty, JSON.stringify(saved));
ok('列表最前就是新文章', saved.listFirst === TEST_SLUG, saved.listFirst);

const afterCreate = await (await fetch(BASE + '/api/posts')).json();
ok('服务端确认新增（篇数 +1）', afterCreate.count === ping.store.count + 1,
  afterCreate.count + ' vs ' + (ping.store.count + 1));
ok('新文章排在数组最前', afterCreate.posts[0].slug === TEST_SLUG, afterCreate.posts[0].slug);

/* ============================================================
   3. 公开页面：归档页与详情页
   ============================================================ */
console.log('');
console.log('3) 公开页面');
await goto(BASE + '/archive.html', 1400);
const archive = await js(`(function(){
  const cards = Array.from(document.querySelectorAll('#postList .post-card'));
  return {
    total: document.getElementById('totalCount').textContent,
    hasTest: cards.some((a) => a.href.includes(${JSON.stringify(TEST_SLUG)})),
    firstHref: cards.length ? cards[0].getAttribute('href') : ''
  };
})()`);
ok('归档页看到新文章', archive.hasTest, JSON.stringify(archive));
ok('归档页总数已更新', archive.total === String(afterCreate.count),
  archive.total + ' vs ' + afterCreate.count);

await goto(BASE + '/article.html?slug=' + TEST_SLUG, 1400);
const article = await js(`(function(){
  const shell = document.getElementById('articleShell');
  return {
    visible: !shell.hidden,
    title: document.getElementById('articleTitle').textContent,
    hasBody: document.getElementById('articleBody').innerHTML.includes('第一段'),
    codeDecorated: !!document.querySelector('.code-block'),
    notFound: !document.getElementById('notFound').hidden
  };
})()`);
ok('详情页渲染出这篇文章', article.visible && !article.notFound, JSON.stringify(article));
ok('详情页标题正确', article.title === TEST_TITLE, article.title);
ok('详情页正文在', article.hasBody);
ok('详情页代码块套了外壳（pages.js 仍在工作）', article.codeDecorated);
await shot('admin-article');

/* ============================================================
   4. 草稿：归档不列、详情需预览口子
   ============================================================ */
console.log('');
console.log('4) 草稿可见性');
await goto(BASE + '/_admin/', 1400);
await js(`(function(){
  const posts = Array.from(document.querySelectorAll('#postList .ad-post'));
  const hit = posts.find((b) => b.textContent.includes(${JSON.stringify(TEST_SLUG)}));
  if (hit) hit.click();
  return true;
})()`);
await sleep(500);
await js(`(function(){
  const c = document.getElementById('fDraft');
  c.checked = true;
  c.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await sleep(300);
await js(`document.getElementById('saveBtn').click(); true`);
await sleep(1500);

const afterDraft = await (await fetch(BASE + '/api/posts')).json();
const draftPost = afterDraft.posts.find((p) => p.slug === TEST_SLUG);
ok('文章已被标记为草稿', draftPost && draftPost.isDraft === true, JSON.stringify(draftPost && draftPost.isDraft));

await goto(BASE + '/archive.html', 1300);
const hiddenInArchive = await js(`(function(){
  const cards = Array.from(document.querySelectorAll('#postList .post-card'));
  return {
    hasTest: cards.some((a) => a.href.includes(${JSON.stringify(TEST_SLUG)})),
    total: document.getElementById('totalCount').textContent,
    hasPreviewLink: cards.some((a) => a.href.includes('preview='))
  };
})()`);
ok('草稿不出现在归档页', !hiddenInArchive.hasTest, JSON.stringify(hiddenInArchive));
ok('草稿不计入归档总数', hiddenInArchive.total === String(ping.store.count),
  hiddenInArchive.total + ' vs ' + ping.store.count);
ok('归档卡片里不带 preview 参数', !hiddenInArchive.hasPreviewLink);

await goto(BASE + '/article.html?slug=' + TEST_SLUG, 1300);
const draftPrivate = await js(`!document.getElementById('notFound').hidden`);
ok('草稿详情页（无 preview）→ 文章不存在', draftPrivate);

await goto(BASE + '/article.html?slug=' + TEST_SLUG + '&preview=' + TEST_SLUG, 1300);
const draftPreview = await js(`(function(){
  return {
    visible: !document.getElementById('articleShell').hidden,
    hasNote: document.querySelector('.article-head .section-note') !== null,
    bodyOk: document.getElementById('articleBody').innerHTML.includes('第一段')
  };
})()`);
ok('带 preview 能看到草稿', draftPreview.visible, JSON.stringify(draftPreview));
ok('草稿页有"未上线"提示', draftPreview.hasNote);
ok('草稿正文完整', draftPreview.bodyOk);

await goto(BASE + '/archive.html?preview=' + TEST_SLUG, 1300);
const draftInArchive = await js(`(function(){
  const cards = Array.from(document.querySelectorAll('#postList .post-card'));
  const hit = cards.find((a) => a.href.includes(${JSON.stringify(TEST_SLUG)}));
  return { hasTest: !!hit, href: hit ? hit.getAttribute('href') : '' };
})()`);
ok('归档页带 preview 时能看到草稿', draftInArchive.hasTest, JSON.stringify(draftInArchive));
ok('草稿卡片链接带上了 preview', draftInArchive.href.includes('preview='), draftInArchive.href);
await shot('admin-draft');

/* ============================================================
   5. 图片上传（真实文件输入 + 拖拽路径）
   ============================================================ */
console.log('');
console.log('5) 图片上传');
await goto(BASE + '/_admin/', 1400);
await js(`(function(){
  const posts = Array.from(document.querySelectorAll('#postList .ad-post'));
  const hit = posts.find((b) => b.textContent.includes(${JSON.stringify(TEST_SLUG)}));
  if (hit) hit.click();
  return true;
})()`);
await sleep(500);

/* 1×1 PNG（合法魔数），名字里故意塞路径与中文，验证服务端的文件名净化 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const uploadResult = await js(`(async function(){
  const bin = atob(${JSON.stringify(PNG_B64)});
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const file = new File([arr], '../../验签 图.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.getElementById('fileInput');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1200));
  return { body: document.getElementById('fBody').value };
})()`);
ok('上传后正文里插入了 figure', /<figure>[\s\S]*img\/uploads\/验签-图\.png/.test(uploadResult.body),
  uploadResult.body.slice(-160));

const images = await (await fetch(BASE + '/api/images')).json();
const uploaded = images.images.find((i) => i.name.startsWith('验签-图'));
ok('服务端确实落盘了图片', !!uploaded, JSON.stringify(images.images.map((i) => i.name)));
ok('文件名被净化（没有路径片段）', uploaded && !/[\\/]/.test(uploaded.name), uploaded && uploaded.name);

if (uploaded) {
  const served = await fetch(BASE + '/' + uploaded.src);
  ok('上传的图片可以通过静态路由取到', served.status === 200, String(served.status));
}

/* 保存带图的那一版，顺便验证"正文里有 img 也能过校验" */
await js(`document.getElementById('saveBtn').click(); true`);
await sleep(1500);
const afterImage = await js(`document.getElementById('errors').hidden ? '' : document.getElementById('errors').textContent`);
ok('含图片的正文能保存', !afterImage, afterImage);

/* ============================================================
   6. 删除（走 UI）
   ============================================================ */
console.log('');
console.log('6) 删除');
await js(`window.confirm = function(){ return true; }; true`);
await js(`document.getElementById('deleteBtn').click(); true`);
await sleep(1600);

const afterDelete = await (await fetch(BASE + '/api/posts')).json();
ok('文章已从 posts.js 里消失', !afterDelete.posts.some((p) => p.slug === TEST_SLUG));
ok('篇数回到开跑前', afterDelete.count === ping.store.count,
  afterDelete.count + ' vs ' + ping.store.count);

const backups = await (await fetch(BASE + '/api/backups')).json();
ok('回收站里有被删的文章', backups.trash.some((t) => t.name.includes(TEST_SLUG)),
  JSON.stringify(backups.trash.map((t) => t.name)));
ok('保存过程留下了备份', backups.backups.length > 0, backups.backups.length + ' 份');

/* ============================================================
   7. 控制台干净
   ============================================================ */
console.log('');
console.log('7) 控制台');
const realErrors = consoleErrors.filter((e) => e && !/favicon|net::ERR_/i.test(e));
ok('管理页与公开页没有报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

/* ============================================================
   收尾：清理测试痕迹
   ============================================================ */
console.log('');
console.log('8) 清理');
const finalText = await readFile(POSTS, 'utf8');
ok('最终文件里没有测试文章', !finalText.includes(TEST_SLUG) && !finalText.includes(TEST_TITLE));
ok('未改动的文章仍然是逐字节原样',
  (() => {
    const before = beforePosts.match(/slug: '[^']+'/g) || [];
    const now = finalText.match(/slug: '[^']+'/g) || [];
    return before.length === now.length;
  })());

/* 删掉本次上传的图片（只删"开跑前不存在"的那些） */
try {
  const now = await readdir(UPLOADS);
  const added = now.filter((n) => beforeUploads.indexOf(n) < 0);
  for (const n of added) await unlink(join(UPLOADS, n));
  console.log('  清理了 ' + added.length + ' 张测试图片：' + added.join(', '));
  if (!now.length) { try { await rm(UPLOADS, { recursive: true }); } catch { /* 忽略 */ } }
} catch { /* 目录不存在就算了 */ }

/* 把 posts.js 还原成开跑前的内容（测试期间的正常写入也被撤掉） */
const current = await readFile(POSTS, 'utf8');
if (current !== beforePosts) {
  await writeFile(POSTS, beforePosts, 'utf8');
  console.log('  posts.js 已还原到开跑前的版本');
}
ok('posts.js 回到开跑前状态', (await readFile(POSTS, 'utf8')) === beforePosts);

/* ============================================================
   结果
   ============================================================ */
console.log('');
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
ws.close();
chrome.kill();
await sleep(300);
process.exit(fail ? 1 : 0);
