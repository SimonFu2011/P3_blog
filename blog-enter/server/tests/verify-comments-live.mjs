/* ============================================================
   登录入口 + 自建评论组件的浏览器验签（真实 Chrome + CDP，只看不改）
   ------------------------------------------------------------
   跑法（在能访问公网、且装有 Chrome 的机器上）：
     node blog-enter/server/tests/verify-comments-live.mjs
   可用环境变量覆盖：
     CHROME_PATH / SITE_URL / CDP_PORT / PREVIEW_OUT / COMMENT_SLUG

   它验的是"接口正确"之外的最后一公里 —— 这几件事只有真浏览器才知道：
     0) 静态闸（**不需要浏览器**，先跑）：五个页面都有登录入口的静态标记、
        文章页不再引用旧的第三方评论客户端、新脚本里没有 innerHTML、
        新增样式与页面都没有外部资源引用
     1) 五个页面右上角都真的看得见登录入口；首页的入口在入场期间是隐藏的，
        入场结束后才出现，且与扇形菜单**没有像素级重叠**
     2) 文章存在时：评论区渲染出来、请求了 /api/comments?slug=、没有去拉
        任何旧评论客户端的资源、没有任何站外请求、控制台无报错
     3) 文章**不存在**时：评论区不出现、并且**一次评论接口都不请求**
        （只看"看不见"是不够的：没被初始化才是真的没请求）
     4) 未登录只能读：发表框变成"登录后可以发表"，点它就**就地**开同一个
        模态框（注册页签里必须有 email 输入框，契约 §1.2 要求必填），
        全程不跳转、也没有任何 POST /api/comments

   本脚本**不写任何数据**（不发评论、不注册）。所以可以随时对线上跑。
   发评论/注册这条端到端路径由 t16 的接口验证与 ADMIN.md 的人工清单负责。
   ============================================================ */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SITE = (process.env.SITE_URL || 'http://43.108.100.116').replace(/\/$/, '');
const SLUG = process.env.COMMENT_SLUG || 'water-entry';
const PORT = Number(process.env.CDP_PORT || 9368);
const OUT = process.env.PREVIEW_OUT || 'D:\\DS\\.preview';
const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));   // blog-enter/

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

const PAGES = ['index', 'article', 'archive', 'about', '404'];
const txt = async (rel) => readFile(join(ROOT, rel), 'utf8');

/* ============================================================
   0. 静态闸：不需要浏览器，先跑
   ============================================================ */
console.log('0) 静态检查（不需要浏览器）');

const files = {};
for (const f of PAGES) files[f] = await txt(f + '.html');
const commentsJs = await txt('js/comments.js');
const authJs = await txt('js/auth-ui.js');
const commentsCss = await txt('css/comments.css');

PAGES.forEach((f) => {
  ok(f + '.html 里写着登录入口的静态标记（脚本挂了也看得见）',
    /data-auth-entry/.test(files[f]) && /data-auth-open/.test(files[f]));
  ok(f + '.html 引入了 js/auth-ui.js', /js\/auth-ui\.js/.test(files[f]));
  ok(f + '.html 引入了 css/comments.css', /css\/comments\.css/.test(files[f]));
  ok(f + '.html 没有外部资源引用（link/script/img 一律同源）',
    !/<(?:link|script|img|iframe)[^>]*(?:href|src)\s*=\s*["']https?:\/\//i.test(files[f]));
});

ok('article.html 不再引用旧评论客户端（waline.js / waline.css / init 调用）',
  !/waline\.js|waline\.css|Waline\.init/i.test(files.article));
ok('article.html 引入自建评论组件（js/comments.js）', /js\/comments\.js/.test(files.article));
ok('article.html 评论区挂载点不再带旧客户端的标记',
  !/data-comments-slot/i.test(files.article));

const dirty = [['js/comments.js', commentsJs], ['js/auth-ui.js', authJs]]
  .filter(([, s]) => /\.innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(s));
ok('两个新脚本都不用 innerHTML / document.write 写数据（一律 textContent）',
  dirty.length === 0, dirty.map((d) => d[0]).join(', '));
ok('评论正文是按 textContent 写进 DOM 的', /\.textContent\s*=/.test(commentsJs));
ok('新增样式里没有 @import / 外部 url()', !/@import|url\(\s*['"]?https?:/i.test(commentsCss));

/* ============================================================
   1. 起浏览器（后面的检查都靠它）
   ============================================================ */
console.log('');
console.log('站点：' + SITE + '   文章：' + SLUG);
console.log('');

let chrome = null;
try {
  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
    '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900',
    '--user-data-dir=' + join(OUT, 'cp-comments-verify'), 'about:blank'
  ], { stdio: 'ignore' });
} catch (err) {
  chrome = null;
  console.error('无法启动 Chrome：' + err.message);
}

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
  console.log('');
  console.log('------------------------------');
  console.log('静态闸：' + pass + ' 通过 / ' + fail + ' 失败（浏览器部分未执行）');
  console.error('');
  if (chromeClosed !== null) {
    console.error('浏览器进程起来后立刻退出了（exit code ' + chromeClosed + '），没能开出调试端口。');
    console.error('常见原因：当前环境限制了 Chrome 的进程/内存操作（crashpad 会报 OpenProcess 拒绝访问）。');
  } else if (spawnFailed) {
    console.error('无法启动浏览器：' + spawnFailed.message);
  } else {
    console.error('等不到 Chrome 的调试端口（检查 CHROME_PATH，或端口 ' + PORT + ' 是否被占用）。');
  }
  console.error('本脚本的浏览器部分需要真实浏览器；接口层验证请跑 t16 的用例。');
  process.exit(fail === 0 ? 5 : 1);
}

ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let consoleErrors = [];
let requests = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error)));
    else res(m.result);
    return;
  }
  if (m.method === 'Network.requestWillBeSent') {
    requests.push({ url: m.params.request.url, method: m.params.request.method });
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
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
await S('Network.enable');
/* 关掉 HTTP 缓存：站点给 js/css 设了 5 分钟 expires，而本脚本用的是**固定**的
   Chrome profile（.preview/cp-comments-verify）。不关缓存的话，第二次跑会拿着
   上一轮的旧 CSS 去判，结论正好相反 —— 这个假故障真的发生过一次。 */
await S('Network.setCacheDisabled', { cacheDisabled: true });
await S('Log.enable').catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
/* 固定 profile 会留住上一轮的登录 cookie —— 本脚本只验"未登录"那条路径，
   每次跑之前必须先把 cookie 清干净，否则会拿着别人的会话去判。 */
await S('Network.clearBrowserCookies').catch(() => {});

const js = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  /* r.result 可能是 null：表达式求值为 undefined、或值不可按值序列化（Promise、
     循环引用、DOM 节点）时，CDP 会把 result 整个省掉。以前这里直接读 .value，
     于是抛 TypeError —— 那是**脚手架自己崩**，不是断言失败：脚本会死在这一行，
     连最后的"合计"行都打不出来，看起来像"页面有问题"，实际上什么都没验完。
     最常踩的场合：目标站点还是旧前端，选择器查不到元素 → 返回 undefined → 崩。
     改为返回 undefined 并把判定交给调用方的断言，让失败点落在真正该失败的地方。 */
  if (!r.result) return undefined;
  return r.result.value;
};
const goto = async (url, waitMs) => {
  requests = [];
  consoleErrors = [];
  await S('Page.navigate', { url });
  await sleep(waitMs || 1500);
};
const shot = async (name) => {
  try {
    const r = await S('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('  （截图 ' + name + '.png）');
  } catch (err) { console.log('  （截图失败：' + err.message + '）'); }
};

/* 登录入口的统一读数：位置 / 可见性 / 与扇形菜单的重叠 */
const readEntry = () => js(`(function(){
  const box = document.querySelector('[data-auth-entry]');
  const btn = box ? box.querySelector('button') : null;
  if (!box || !btn) return { present: false };
  const cs = getComputedStyle(box);
  const r = btn.getBoundingClientRect();
  const fan = Array.prototype.map.call(document.querySelectorAll('.fan-item'), function (n) {
    const b = n.getBoundingClientRect();
    return { w: b.width, h: b.height, l: b.left, t: b.top, r: b.right, b: b.bottom };
  }).filter(function (b) { return b.w > 0 && b.h > 0; });
  const overlap = fan.filter(function (b) {
    return !(r.right <= b.l || r.left >= b.r || r.bottom <= b.t || r.top >= b.b);
  }).length;
  return {
    present: true,
    text: (btn.textContent || '').trim(),
    visibility: cs.visibility,
    opacity: Number(cs.opacity),
    pointer: cs.pointerEvents,
    rect: { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) },
    vw: window.innerWidth, vh: window.innerHeight,
    fanItems: fan.length,
    fanOverlap: overlap,
    settled: document.body.className
  };
})()`);

/* ============================================================
   1. 五个页面的右上角登录入口
   ============================================================ */
console.log('1) 五个页面的右上角登录入口');

for (const f of ['about', 'archive', '404', 'article']) {
  const url = f === 'article' ? SITE + '/article.html?slug=' + encodeURIComponent(SLUG) : SITE + '/' + f + '.html';
  await goto(url, 1400);
  const e = await readEntry();
  ok(f + ': 右上角有「登录」入口', e.present && e.text === '登录', JSON.stringify(e));
  ok(f + ': 入口可见、可点', !!e.present && e.visibility === 'visible' && e.opacity > 0.9 && e.pointer !== 'none',
    JSON.stringify(e));
  ok(f + ': 入口确实落在右上角（右侧 1/4、顶部 1/4）',
    !!e.present && e.rect.l > e.vw * 0.75 && e.rect.t < e.vh * 0.25, JSON.stringify(e.rect));
}

/* 首页：入场期间必须看不见、入场结束后必须看得见，且不与扇形菜单重叠 */
await goto(SITE + '/', 1200);
const before = await readEntry();
ok('index: 登录入口的标记在 HTML 里（DOM 里存在）', !!before.present, JSON.stringify(before));
ok('index: 入场遮罩还在时入口是隐藏的（遮挡不了 ENTER / 滚轮）',
  !!before.present && (before.visibility === 'hidden' || before.opacity === 0) && before.pointer === 'none',
  JSON.stringify(before));
await js(`document.getElementById('enterArrow').click(); true`);
await sleep(3800);
const afterDive = await readEntry();
ok('index: 入场结束后入口出现', !!afterDive.present && afterDive.visibility === 'visible' && afterDive.opacity > 0.9,
  JSON.stringify(afterDive));
ok('index: 与扇形菜单没有像素级重叠',
  !!afterDive.present && afterDive.fanOverlap === 0,
  '重叠 ' + (afterDive && afterDive.fanOverlap) + ' 项 / 扇形 ' + (afterDive && afterDive.fanItems) + ' 项');
ok('index: 面板已经落定（body.is-settled）', /is-settled/.test(afterDive.settled || ''), afterDive.settled);

/* 首页是"键盘最容易被抢"的一页：boot.js 在 window 上听 Enter / 空格 / 方向键 / w / s，
   而模态框就在它的监听范围里。这里把模态框打开、在用户名里打 w/s，然后断言：
     · 打字确实进了输入框（捕获阶段拦键不影响输入框自身的默认行为）
     · 扇形菜单的选中项没有跟着动（按键没有被 boot.js 吃掉）
     · 页面没有被带走（没有因为空格/回车触发菜单跳转） */
const menuIdxBefore = await js(`window.Menu ? window.Menu.index : -1`);
const hrefOnIndex = await js(`location.href`);
await js(`(function(){ const b = document.querySelector('[data-auth-entry] button'); if (b) b.click(); return true; })()`);
await sleep(300);
ok('index: 点右上角入口能打开模态框', await js(`(function(){ const m = document.querySelector('.auth-modal'); return !!m && !m.hidden; })()`));
await js(`(function(){ const i = document.querySelector('.auth-view[data-auth-view="login"] input[name="user"]'); if (i) { i.focus(); } return true; })()`);
for (const k of ['w', 's']) {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', text: k, unmodifiedText: k, key: k }).catch(() => {});
  await S('Input.dispatchKeyEvent', { type: 'keyUp', key: k }).catch(() => {});
}
const typedOnIndex = await js(`document.querySelector('.auth-view[data-auth-view="login"] input[name="user"]').value`);
ok('index: 模态框里能正常打字（键盘被模态框接管后依然打得进去）',
  typeof typedOnIndex === 'string' && typedOnIndex.length >= 2 && /^[ws]+$/.test(typedOnIndex) && typedOnIndex.includes('w') && typedOnIndex.includes('s'),
  JSON.stringify(typedOnIndex));
ok('index: 打字没有惊动扇形菜单（boot.js 的 w/s 快捷键没被触发）',
  (await js(`window.Menu ? window.Menu.index : -1`)) === menuIdxBefore,
  JSON.stringify({ before: menuIdxBefore, after: await js(`window.Menu ? window.Menu.index : -1`) }));
ok('index: 打字没有把页面带走', (await js(`location.href`)) === hrefOnIndex);
await js(`(function(){ const x = document.querySelector('.auth-modal .auth-x'); if (x) x.click(); return true; })()`);
await sleep(250);
ok('index: 关掉模态框后回到原状', await js(`document.querySelector('.auth-modal').hidden === true`));
await shot('comments-index-entry');

/* ============================================================
   2. 存在的文章：评论区渲染出来
   ============================================================ */
console.log('');
console.log('2) 存在的文章');

await goto(SITE + '/article.html?slug=' + encodeURIComponent(SLUG), 1200);

/* 等评论组件把骨架渲染出来（它要等 article.js 确认文章存在 + 一次接口往返） */
let mounted = null;
for (let i = 0; i < 40 && !mounted; i++) {
  mounted = await js(`(function(){
    const mount = document.getElementById('commentsMount');
    const list = mount ? mount.querySelector('.cm-list') : null;
    return list ? {
      list: true,
      items: list.querySelectorAll('.cm-item').length,
      composer: !!mount.querySelector('.cm-composer'),
      signin: !!mount.querySelector('.cm-signin'),
      input: !!mount.querySelector('.cm-input'),
      state: (mount.querySelector('.cm-state') || {}).textContent || ''
    } : null;
  })()`);
  if (!mounted) await sleep(400);
}
ok('评论区渲染进 #commentsMount（自建组件）', !!(mounted && mounted.list), JSON.stringify(mounted));
ok('评论区可见（不是 hidden）', await js(`!document.getElementById('comments').hidden`));
ok('未登录时给的是"登录后可以发表"，不是输入框（写不了）',
  !!(mounted && mounted.signin) && !(mounted && mounted.input), JSON.stringify(mounted));
ok('未登录也能读到评论列表', !!(mounted && mounted.list) && !mounted.state.toString().includes('失败'),
  JSON.stringify(mounted && mounted.state));

ok('正文渲染成功（window.Article 已就绪）',
  await js(`!!(window.Article && window.Article.slug)`),
  JSON.stringify(await js(`window.Article ? window.Article.slug : null`)));

/* 顺带守住一个已经踩过的坑：`.notfound-box{display:grid}` 会把 hidden 打穿，
   于是每篇文章页底部都挂着"NOT FOUND / 这篇文章不存在"。看属性不够，要看计算值。 */
const nfDisplay = await js(`getComputedStyle(document.getElementById('notFound')).display`);
ok('文章存在时"文章不存在"那一块是真藏的（hidden 没被 CSS 打穿）', nfDisplay === 'none', nfDisplay);

const apiHits = requests.filter((r) => r.url.includes('/api/comments'));
ok('组件确实请求了评论接口', apiHits.some((r) => r.method === 'GET'), JSON.stringify(apiHits.slice(0, 3).map((r) => r.method + ' ' + r.url)));
ok('拉评论时带上了 slug', apiHits.some((r) => /[?&]slug=/.test(r.url)), JSON.stringify(apiHits.slice(0, 3).map((r) => r.url)));

const oldBundle = requests.filter((r) => /waline/i.test(r.url));
ok('没有再去拉旧评论客户端的资源', oldBundle.length === 0, JSON.stringify(oldBundle.slice(0, 3).map((r) => r.url)));

/* 按 hostname 比，不按前缀比：Chrome 会先把 http 升级成 https 试一次，
   同一台机器上会同时出现两种写法的同源请求。 */
const SITE_HOST = new URL(SITE).hostname;
const external = requests.filter((r) => {
  try { return new URL(r.url).hostname !== SITE_HOST; } catch { return !/^(data|blob):/.test(r.url); }
});
ok('除本站（含 /api）外没有外部请求（零外部依赖）', external.length === 0, JSON.stringify(external.slice(0, 5).map((r) => r.url)));
ok('控制台没有报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

/* 未登录不许发：整个加载过程里一次 POST /api/comments 都不能有 */
const posts = requests.filter((r) => r.method === 'POST' && /\/api\/comments/.test(r.url));
ok('未登录时没有对评论接口发起任何写请求', posts.length === 0, JSON.stringify(posts.slice(0, 3).map((r) => r.url)));

/* 点"登录 / 注册"：必须在**原地**开模态框，不跳走 */
const hrefBefore = await js(`location.href`);
await js(`(function(){
  const b = document.querySelector('#commentsMount .cm-signin button');
  if (b) b.click();
  return true;
})()`);
await sleep(500);
const modal = await js(`(function(){
  const m = document.querySelector('.auth-modal');
  if (!m || m.hidden) return { open: false };
  const tabs = Array.prototype.map.call(m.querySelectorAll('.auth-tab'), function (t) { return t.textContent.trim(); });
  /* 注册页签里必须有 email 输入框（契约 §1.2：email 必填） */
  const reg = m.querySelector('.auth-view[data-auth-view="register"]');
  const email = reg ? reg.querySelector('input[type="email"], input[name="email"]') : null;
  const login = m.querySelector('.auth-view[data-auth-view="login"]');
  const userField = login ? login.querySelector('input[name="user"]') : null;
  return {
    open: true,
    role: m.getAttribute('role'),
    tabs: tabs,
    email: !!email,
    loginField: userField ? userField.name : null,
    active: document.activeElement ? document.activeElement.tagName : ''
  };
})()`);
ok('未登录提示走的是同一个自建模态框（就地弹出，不跳转）',
  !!(modal && modal.open) && modal.role === 'dialog', JSON.stringify(modal));
ok('模态框有「登录 / 注册」两个页签',
  !!(modal && modal.open) && modal.tabs.join('/') === '登录/注册', JSON.stringify(modal && modal.tabs));
ok('登录页签的字段名是 user（契约 §1.3）', !!(modal && modal.loginField === 'user'), JSON.stringify(modal));
ok('注册页签有 email 输入框（契约 §1.2：必填）', !!(modal && modal.email), JSON.stringify(modal));
ok('开模态框没有把页面带走（地址没变）', (await js(`location.href`)) === hrefBefore);

/* 打开模态框后，键盘归模态框管：在用户名里打 w/s 打不进去就说明拦键拦过头了
   （菜单快捷键的完整验证在首页那一段，那里 boot.js 真的在听 window 的键盘）。 */
await js(`(function(){ const i = document.querySelector('.auth-view[data-auth-view="login"] input[name="user"]'); if (i) i.focus(); return true; })()`);
for (const k of ['w', 's']) {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', text: k, unmodifiedText: k, key: k }).catch(() => {});
  await S('Input.dispatchKeyEvent', { type: 'keyUp', key: k }).catch(() => {});
}
const typed = await js(`document.querySelector('.auth-view[data-auth-view="login"] input[name="user"]').value`);
ok('模态框里能正常打字（捕获阶段拦键不影响输入框）',
  typeof typed === 'string' && typed.length >= 2 && /^[ws]+$/.test(typed),
  JSON.stringify(typed));
await shot('comments-auth-modal');

/* 关掉模态框，再去看评论区本身 */
await js(`(function(){ const x = document.querySelector('.auth-modal .auth-x'); if (x) x.click(); return true; })()`);
await sleep(300);
ok('点 × 能关掉模态框', await js(`document.querySelector('.auth-modal').hidden === true`));

/* 截图对准评论区本身 —— 文章很长，不滚过去的话截到的只是正文开头 */
await js(`(function(){ const c = document.getElementById('comments'); if (c) c.scrollIntoView({block:'start'}); return true; })()`);
await sleep(700);
await shot('comments-article-list');

/* ============================================================
   3. 不存在的文章：评论区不出现，且一次评论请求都没有
   ============================================================ */
console.log('');
console.log('3) 不存在的文章');
await goto(SITE + '/article.html?slug=this-slug-does-not-exist', 2500);

const notFound = await js(`(function(){
  const c = document.getElementById('comments');
  const mount = document.getElementById('commentsMount');
  const nf = document.getElementById('notFound');
  return {
    notFoundShown: !nf.hidden,
    notFoundDisplay: getComputedStyle(nf).display,
    commentsHidden: !!c && c.hidden,
    mountEmpty: !!mount && mount.querySelectorAll('*').length === 0,
    article: window.Article || null
  };
})()`);
ok('显示"这篇文章不存在"', notFound.notFoundShown, JSON.stringify(notFound));
ok('"文章不存在"那一块是真的渲染出来了（不只是摘了 hidden）',
  notFound.notFoundDisplay !== 'none', notFound.notFoundDisplay);
ok('评论区保持 hidden', notFound.commentsHidden, JSON.stringify(notFound));
ok('#commentsMount 是空的（没被初始化）', notFound.mountEmpty, JSON.stringify(notFound));
const strayApi = requests.filter((r) => r.url.includes('/api/comments'));
ok('没有对评论接口发起任何请求', strayApi.length === 0, JSON.stringify(strayApi.slice(0, 3).map((r) => r.url)));
const strayBundle = requests.filter((r) => /waline/i.test(r.url));
ok('也没有多下载任何旧客户端资源', strayBundle.length === 0, JSON.stringify(strayBundle.slice(0, 3).map((r) => r.url)));
ok('这一页控制台也没有报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
await shot('comments-notfound');

/* ============================================================
   收尾
   ============================================================ */
try { ws.close(); } catch { /* ignore */ }
if (chrome && chromeClosed === null) chrome.kill();

console.log('');
console.log('------------------------------');
console.log('合计：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
