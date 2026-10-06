/* ============================================================
   评论区浏览器验签（真实 Chrome + CDP，只看不改）
   ------------------------------------------------------------
   跑法（在能访问公网、且装有 Chrome 的机器上）：
     node blog-enter/server/tests/verify-comments-live.mjs
   可用环境变量覆盖：
     CHROME_PATH / SITE_URL / CDP_PORT / PREVIEW_OUT / COMMENT_SLUG

   它验的是"接口正确"之外的最后一公里 —— 这几件事只有真浏览器才知道：
     1) 自托管的 waline.js / waline.css 真的被加载并执行了（不是 404 静默失败）
     2) Waline 真的把 UI 渲染进了 #commentsMount，控制台没有报错
     3) 文章存在时，客户端确实请求了 /comments/api/comment
     4) 文章**不存在**时，评论区不出现、并且**一次评论接口都不请求**
        （只看"看不见"是不够的：初始化没被触发才是真的没请求）

   本脚本**不写任何数据**（不发评论、不登录），所以可以随时对线上跑。
   发评论这条端到端路径由 ADMIN.md 里那份人工清单负责。
   ============================================================ */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SITE = (process.env.SITE_URL || 'http://43.108.100.116').replace(/\/$/, '');
const SLUG = process.env.COMMENT_SLUG || 'water-entry';
const PORT = Number(process.env.CDP_PORT || 9368);
const OUT = process.env.PREVIEW_OUT || 'D:\\DS\\.preview';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

/* ------------------------------------------------------------
   CDP 样板（与 verify-admin-ui.mjs 同一手法：内置 fetch + WebSocket）
   ------------------------------------------------------------ */
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
  console.error('');
  if (chromeClosed !== null) {
    console.error('浏览器进程起来后立刻退出了（exit code ' + chromeClosed + '），没能开出调试端口。');
    console.error('常见原因：当前环境限制了 Chrome 的进程/内存操作（crashpad 会报 OpenProcess 拒绝访问）。');
  } else if (spawnFailed) {
    console.error('无法启动浏览器：' + spawnFailed.message);
  } else {
    console.error('等不到 Chrome 的调试端口（检查 CHROME_PATH，或端口 ' + PORT + ' 是否被占用）。');
  }
  console.error('本脚本需要真实浏览器；不依赖浏览器的部分请跑 run-all.mjs。');
  process.exit(5);
}

ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

const consoleErrors = [];
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
  if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
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

const js = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const goto = async (url, waitMs) => {
  requests = [];
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

/* 等 Waline 把 UI 渲染出来（客户端是动态 import，要给它时间） */
const waitForWidget = async (maxMs) => {
  const deadline = Date.now() + (maxMs || 15000);
  while (Date.now() < deadline) {
    const state = await js(`(function(){
      const mount = document.getElementById('commentsMount');
      return {
        mounted: !!mount && mount.querySelectorAll('*').length > 0,
        panel: !!document.querySelector('#commentsMount .wl-panel'),
        editor: !!document.querySelector('#commentsMount .wl-editor'),
        comments: document.getElementById('comments') ? !document.getElementById('comments').hidden : false
      };
    })()`);
    if (state.panel) return state;
    await sleep(400);
  }
  return null;
};

/* ============================================================
   1. 存在的文章：评论区应该渲染出来
   ============================================================ */
console.log('站点：' + SITE + '   文章：' + SLUG);
console.log('');
console.log('1) 存在的文章');
await goto(SITE + '/article.html?slug=' + encodeURIComponent(SLUG), 1200);

const articleOk = await js(`!!(window.Article && window.Article.slug)`);
ok('正文渲染成功（window.Article 已就绪）', articleOk,
  JSON.stringify(await js(`window.Article ? window.Article.slug : null`)));

const widget = await waitForWidget(20000);
ok('Waline 面板渲染进 #commentsMount', !!widget && widget.panel, JSON.stringify(widget));
ok('评论输入框存在', !!widget && widget.editor, JSON.stringify(widget));
if (widget) ok('评论区可见（不是 hidden）', widget.comments);

/* 顺带守住一个已经踩过的坑：`.notfound-box{display:grid}` 会把 hidden 打穿，
   于是每篇文章页底部都挂着"NOT FOUND / 这篇文章不存在"。看属性不够，要看计算值。 */
const nfDisplay = await js(`getComputedStyle(document.getElementById('notFound')).display`);
ok('文章存在时"文章不存在"那一块是真藏的（hidden 没被 CSS 打穿）', nfDisplay === 'none', nfDisplay);

const apiHits = requests.filter((u) => u.includes('/comments/api/'));
ok('客户端确实请求了评论接口', apiHits.length > 0, JSON.stringify(apiHits.slice(0, 3)));
const bundleHits = requests.filter((u) => u.includes('/comments/waline.'));
ok('自托管客户端资源被加载', bundleHits.length >= 2, JSON.stringify(bundleHits));
/* 按 hostname 比，不按前缀比：Chrome 会先把 http 升级成 https 试一次，
   同一台机器上会同时出现两种写法的同源请求。 */
const SITE_HOST = new URL(SITE).hostname;
const external = requests.filter((u) => {
  try { return new URL(u).hostname !== SITE_HOST; } catch { return !/^(data|blob):/.test(u); }
});
ok('除评论服务外没有外部请求（本站零外部依赖）', external.length === 0, JSON.stringify(external.slice(0, 5)));
ok('控制台没有报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
/* 截图对准评论区本身 —— 文章很长，不滚过去的话截到的只是正文开头 */
await js(`document.getElementById('comments').scrollIntoView({block:'start'}); true`);
await sleep(700);
await shot('comments-article');

/* ============================================================
   2. 不存在的文章：评论区不出现，且一次评论请求都没有
   ============================================================ */
console.log('');
console.log('2) 不存在的文章');
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
const strayApi = requests.filter((u) => u.includes('/comments/api/'));
ok('没有对评论接口发起任何请求', strayApi.length === 0, JSON.stringify(strayApi.slice(0, 3)));
const strayBundle = requests.filter((u) => u.includes('/comments/waline.'));
ok('也没有多下载客户端资源', strayBundle.length === 0, JSON.stringify(strayBundle.slice(0, 3)));
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
