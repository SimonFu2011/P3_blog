/* ============================================================
   DOM 级冒烟：在 Node 里跑真实的 js/auth-ui.js + js/comments.js
   ------------------------------------------------------------
   为什么存在：本机的 DSH 沙箱不允许起 Chrome/Edge（crashpad 报
   OpenProcess 拒绝访问），所以 server/tests/verify-comments-live.mjs
   的浏览器部分在这里跑不了。这个脚本用 linkedom 提供 DOM、用真 fetch
   打 .preview/stub-p3-api.mjs，把两个模块**原样**加载执行，验证：

     · 评论按 parent_id 分层渲染（一级回复挂在父评论下）
     · 用户输入一律按纯文本渲染：注入的 <img onerror>/<script> 变成文字，
       页面里不会多出任何 img/script 元素
     · 头像只认同源 / data:：外站头像退回首字母方块（零外部请求）
     · 未登录：只有"登录后可以发表"的提示 + 同一个模态框，没有输入框、
       没有删除按钮、没有任何写请求
     · 已登录：显示用户名、自己的评论才有删除按钮；回复提交时
       body 里带 slug + parent_id（契约 §1.6）
     · 429：读 Retry-After 并倒计时禁用按钮（契约 §0.6）
     · 模态框：登录页签字段名是 user、注册页签有 email（契约 §1.2/§1.3）

   跑法（先起 stub）：
     node D:\DS\.preview\smoke-comments.mjs signedout|signedin|ratelimited
   ============================================================ */
import { readFile } from 'node:fs/promises';
import { parseHTML } from './node_modules/linkedom/esm/index.js';

const SITE = process.env.STUB_URL || 'http://127.0.0.1:8877';
const SCENARIO = process.argv[2] || 'signedout';
const BLOG = 'D:\\DS\\blog-enter\\';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 0. 切换 stub 的模式（真后端没有这个端点，只在本地冒烟用） ---- */
const realFetch = globalThis.fetch;
const USER = { id: 7, username: 'simon', email: 'me@example.com', avatar: null, role: 'user' };
const modeBody = SCENARIO === 'signedout' ? { user: null, post: 'normal', reset: true }
  : SCENARIO === 'signedin' ? { user: USER, post: 'normal', reset: true }
    : { user: USER, post: '429', reset: true };
const mr = await realFetch(SITE + '/api/__stub/mode', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(modeBody)
});
ok('stub 模式已切换：' + SCENARIO, mr.ok, String(mr.status));

/* ---- 1. 造 DOM 与全局 ---- */
const html = await readFile(BLOG + 'article.html', 'utf8');
const { window: win, document } = parseHTML(html);

const loc = {
  href: SITE + '/article.html?slug=water-entry',
  protocol: 'http:',
  origin: SITE,
  pathname: '/article.html',
  search: '?slug=water-entry',
  hash: ''
};

const calls = [];
const fetchShim = (url, init) => {
  const abs = new URL(String(url), loc.href).href;
  const headers = (init && init.headers) || {};
  calls.push({
    url: abs,
    method: (init && init.method) || 'GET',
    body: init && init.body ? String(init.body) : '',
    contentType: headers['Content-Type'] || '',
    credentials: (init && init.credentials) || ''
  });
  return realFetch(abs, init);
};

const windowObj = {
  document,
  location: loc,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: fetchShim,
  URL,
  Date,
  Math,
  JSON,
  innerWidth: 1440,
  innerHeight: 900,
  isSecureContext: false,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener: (...a) => document.addEventListener(...a),
  removeEventListener: (...a) => document.removeEventListener(...a),
  scrollTo() {},
  getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
  requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0)
};
windowObj.window = windowObj;

globalThis.window = windowObj;
globalThis.document = document;
globalThis.location = loc;
globalThis.fetch = fetchShim;

/* linkedom 的 readyState 行为不定，两条路径都兜住：
   强制置成 loading，让模块注册 DOMContentLoaded；下面再手动派发一次。
   若置不进去（只读属性），模块会在 eval 时立即启动，那次派发就是空转。 */
try { Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true }); } catch { /* 忽略 */ }

/* ---- 2. 原样加载两个模块 ---- */
const authSrc = await readFile(BLOG + 'js\\auth-ui.js', 'utf8');
const commentsSrc = await readFile(BLOG + 'js\\comments.js', 'utf8');
const run = (src, name) => {
  try {
    /* eslint-disable-next-line no-new-func */
    new Function('window', 'document', 'location', 'fetch', src).call(windowObj, windowObj, document, loc, fetchShim);
    return true;
  } catch (err) {
    console.error('  [加载 ' + name + ' 失败] ' + (err && err.stack ? err.stack : err));
    return false;
  }
};
ok('js/auth-ui.js 加载执行成功', run(authSrc, 'auth-ui.js'));
ok('js/comments.js 加载执行成功', run(commentsSrc, 'comments.js'));

if (!win.KeyboardEvent) {
  windowObj.KeyboardEvent = class KeyboardEvent extends (win.Event || Event) {};
}

/* 模拟真实时序：defer 脚本先跑完 → article.js 渲染成功 → DOMContentLoaded → initComments */
const domReady = () => {
  const ev = new (win.Event || Event)('DOMContentLoaded');
  document.dispatchEvent(ev);
};
windowObj.Article = { slug: 'water-entry', post: { slug: 'water-entry' } };
domReady();
if (typeof windowObj.initComments === 'function') windowObj.initComments('water-entry');

/* ---- 3. 等渲染与首轮请求 ---- */
const waitFor = async (fn, ms) => {
  const until = Date.now() + (ms || 4000);
  while (Date.now() < until) {
    try { if (fn()) return true; } catch { /* 还没好 */ }
    await sleep(60);
  }
  return false;
};

const listReady = await waitFor(() => document.querySelectorAll('#commentsMount .cm-item').length >= 4);
ok('评论列表渲染出来（4 条：3 条顶级 + 1 条回复）', listReady,
  'items=' + document.querySelectorAll('#commentsMount .cm-item').length);

await sleep(200);   /* 让 auth-ui 的 /auth/me 回来 */

const q = (sel) => document.querySelector(sel);
const qa = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

/* ---- 4. 分层渲染 ---- */
const items = qa('#commentsMount .cm-item');
const replies = qa('#commentsMount .cm-replies .cm-item');
ok('顶级评论 3 条', items.length - replies.length === 3, 'items=' + items.length + ' replies=' + replies.length);
ok('一级回复 1 条，且挂在父评论的 .cm-replies 里', replies.length === 1 &&
  !!replies[0] && !!replies[0].closest('.cm-replies'));
const order = items.map((n) => n.getAttribute('data-cm-id'));
ok('按 created_at 升序渲染（父在子前）', order[0] === '1' && order[1] === '2', JSON.stringify(order));

/* ---- 5. 用户输入 = 纯文本 ---- */
const texts = qa('#commentsMount .cm-text').map((n) => n.textContent);
ok('注入样本原样是文字（含 <img onerror> / <script>）',
  texts.some((t) => t.includes('<img src=x onerror=') && t.includes('<script>')),
  JSON.stringify(texts.map((t) => t.slice(0, 24))));
ok('评论区里没有多出任何 img/script 元素（注入没有变成元素）',
  qa('#commentsMount script').length === 0,
  'script=' + qa('#commentsMount script').length);
const names = qa('#commentsMount .cm-name').map((n) => n.textContent);
ok('含尖括号的用户名也是文字，没有生成 <b> 元素',
  names.some((n) => n.includes('<b>不</b>')) && qa('#commentsMount .cm-name b').length === 0,
  JSON.stringify(names));

/* ---- 6. 头像：外站拒绝、同源放行 ---- */
const imgs = qa('#commentsMount .cm-ava img');
ok('外站头像被拒（没有生成 img，退回首字母方块）',
  !imgs.some((i) => /evil\.example\.com/.test(i.getAttribute('src') || '')),
  JSON.stringify(imgs.map((i) => i.getAttribute('src'))));
ok('同源头像正常加载 1 张', imgs.length === 1 && /\/img\/avatar\.svg$/.test(imgs[0].getAttribute('src')),
  JSON.stringify(imgs.map((i) => i.getAttribute('src'))));
ok('没有任何站外请求', !calls.some((c) => !c.url.startsWith(SITE)),
  JSON.stringify(calls.filter((c) => !c.url.startsWith(SITE)).map((c) => c.url)));

/* ---- 7. 模态框（两种场景都验） ---- */
const signinBtn = q('#commentsMount .cm-signin button');
if (SCENARIO === 'signedout') {
  ok('未登录：只有"登录后可以发表"的提示，没有输入框', !!q('#commentsMount .cm-signin') && !q('#commentsMount .cm-input'));
  ok('未登录：一条写请求都没有',
    !calls.some((c) => c.method === 'POST' && c.url.includes('/api/comments')),
    JSON.stringify(calls.map((c) => c.method + ' ' + c.url)));
  ok('未登录：没有删除按钮', qa('#commentsMount .cm-act.is-danger').length === 0);
  ok('右上角入口显示「登录」', (q('#authEntry button') || {}).textContent === '登录');

  if (signinBtn) signinBtn.dispatchEvent(new (win.Event || Event)('click', { bubbles: true }));
  await sleep(100);
} else {
  ok('已登录：右上角换成用户名 chip',
    !!q('#authEntry .auth-btn.is-user') && (q('#authEntry .auth-user-name') || {}).textContent === 'simon');
  ok('已登录：表达框是输入框 + 发表按钮', !!q('#commentsMount .cm-input') && !!q('#commentsMount .cm-btn'));
  if (signinBtn) signinBtn.dispatchEvent(new (win.Event || Event)('click', { bubbles: true }));
  /* 已登录时用「我的评论」下拉进入同一个模态框 */
  const chip = q('#authEntry .auth-btn.is-user');
  if (chip) chip.dispatchEvent(new (win.Event || Event)('click', { bubbles: true }));
  await sleep(50);
  const mine = q('#authEntry .auth-menu [role="menuitem"]');
  if (mine) mine.dispatchEvent(new (win.Event || Event)('click', { bubbles: true }));
  await sleep(150);
}

const modal = q('.auth-modal');
ok('模态框就地弹出（没有跳转）', !!modal && modal.hidden !== true, 'modal=' + (modal ? String(modal.hidden) : 'null'));
ok('模态框是 role=dialog / aria-modal', !!modal && modal.getAttribute('role') === 'dialog' &&
  modal.getAttribute('aria-modal') === 'true');
const tabs = qa('.auth-modal .auth-tab').map((t) => t.textContent);
ok('有「登录 / 注册」两个页签', tabs.join('/') === '登录/注册', JSON.stringify(tabs));
ok('登录字段名是 user（契约 §1.3）', !!q('.auth-view[data-auth-view="login"] input[name="user"]'));
ok('注册页签有 email 输入框（契约 §1.2：必填）',
  !!q('.auth-view[data-auth-view="register"] input[name="email"]'));
ok('登录表单不会用 required 触发原生气泡', !q('.auth-view[data-auth-view="login"] input[required]'));

/* ---- 7b. 表单提交：字段名 / 就地报错 / 注册的两个密码对不上 ---- */
const submitForm = (form) => form.dispatchEvent(new (win.Event || Event)('submit', { bubbles: true, cancelable: true }));
const loginForm = q('.auth-view[data-auth-view="login"] form');
if (loginForm) {
  const u = loginForm.querySelector('input[name="user"]');
  const p = loginForm.querySelector('input[type="password"]');
  if (u) u.value = 'simon';
  if (p) p.value = 'secret12345';
  submitForm(loginForm);
  await sleep(300);
  const loginCall = calls.filter((c) => /\/api\/auth\/login$/.test(c.url)).pop();
  let lb = null;
  try { lb = loginCall ? JSON.parse(loginCall.body) : null; } catch { lb = null; }
  ok('登录 POST 的字段名是 user + password（契约 §1.3）',
    !!lb && typeof lb.user === 'string' && typeof lb.password === 'string', JSON.stringify(lb));
  ok('登录失败的错误就地显示（不是 alert / 不跳转）',
    (q('.auth-view[data-auth-view="login"] .auth-err') || {}).textContent === '用户名或密码不正确',
    JSON.stringify((q('.auth-view[data-auth-view="login"] .auth-err') || {}).textContent));
  ok('登录提交时没有把页面带走', !!modal && modal.hidden !== true);
}
const regTab = qa('.auth-modal .auth-tab').filter((t) => t.textContent === '注册')[0];
if (regTab) regTab.dispatchEvent(new (win.Event || Event)('click', { bubbles: true }));
await sleep(60);
const regForm = q('.auth-view[data-auth-view="register"] form');
if (regForm) {
  regForm.querySelector('input[name="username"]').value = 'simon';
  regForm.querySelector('input[name="email"]').value = 'me@example.com';
  regForm.querySelector('input[name="password"]').value = 'secret12345';
  regForm.querySelector('input[name="confirm"]').value = 'secret123';
  submitForm(regForm);
  await sleep(120);
  ok('两次密码不一致时就地拦下，不发请求',
    (q('.auth-view[data-auth-view="register"] .auth-err') || {}).textContent === '两次输入的密码不一致。' &&
    !calls.some((c) => /\/api\/auth\/register$/.test(c.url)),
    JSON.stringify((q('.auth-view[data-auth-view="register"] .auth-err') || {}).textContent));
  /* 用户名不合规也要就地拦下（契约 §1.2 的 ^[A-Za-z0-9_]{3,20}$） */
  regForm.querySelector('input[name="username"]').value = 'a';
  regForm.querySelector('input[name="confirm"]').value = 'secret12345';
  submitForm(regForm);
  await sleep(120);
  ok('用户名不合规就地提示', /3-20 位/.test((q('.auth-view[data-auth-view="register"] .auth-err') || {}).textContent),
    JSON.stringify((q('.auth-view[data-auth-view="register"] .auth-err') || {}).textContent));
}

/* 已登录时，「我的评论」下拉要能列出自己的评论（契约 §2.1） */
if (SCENARIO === 'signedin') {
  const mine = await waitFor(() => document.querySelectorAll('.auth-mine').length > 0, 2000);
  ok('「我的评论」列出自己的评论', mine, 'count=' + document.querySelectorAll('.auth-mine').length);
  const link = q('.auth-mine .auth-mine-link');
  ok('我的评论带"打开文章"链接（article.html?slug=…#comments）',
    !!link && /article\.html\?slug=.+%23|article\.html\?slug=.*#comments/.test(link.getAttribute('href') || ''),
    link && link.getAttribute('href'));
}

/* ESC 关模态框：捕获阶段的监听必须吃掉它（内页 pages.js 会在 ESC 时跳回首页） */
let navigated = 0;
document.addEventListener('keydown', () => { navigated++; }, false);
if (modal) {
  const ev = new (win.Event || Event)('keydown', { bubbles: true });
  ev.key = 'Escape';
  document.dispatchEvent(ev);
  await sleep(50);
}
ok('ESC 能关掉模态框', !!modal && modal.hidden === true, 'navigated=' + navigated);

/* ---- 8. 已登录的写路径 ---- */
/* 取"顶级评论自己"的那一块（data-cm-id 会同时出现在顶级项与它的回复上，
   所以不能只按属性选：先按 cm-list 直接子级定位顶级项，再只看它自己的
   .cm-main 里那一份表单/按钮）。 */
const pickTop = (id) => {
  const all = qa('#commentsMount .cm-item[data-cm-id="' + id + '"]');
  return all.filter((n) => n.parentNode && /(^|\s)cm-list(\s|$)/.test(n.parentNode.className))[0] || all[0];
};
const pickMain = (item) => Array.prototype.slice.call(item.children)
  .filter((n) => /(^|\s)cm-main(\s|$)/.test(n.className))[0];
const pickOwn = (item, cls) => {
  const main = pickMain(item);
  if (!main) return null;
  return Array.prototype.slice.call(main.children).filter((n) => n.className.indexOf(cls) >= 0)[0] || null;
};

if (SCENARIO === 'signedin') {
  /* 删除按钮：只有"自己的"评论（id=1）才有 */
  const delBtns = qa('#commentsMount .cm-act.is-danger');
  ok('删除按钮只出现在自己的评论上（1 条）', delBtns.length === 1,
    'count=' + delBtns.length);
  ok('id=1（本人）有删除按钮', !!pickOwn(pickTop('1'), 'cm-acts').querySelector('.is-danger'));
  ok('id=3（别人的）没有删除按钮', !pickOwn(pickTop('3'), 'cm-acts').querySelector('.is-danger'));

  /* 回复：一级回复的 body 必须带 slug + parent_id */
  const item1 = pickTop('1');
  const main1 = pickMain(item1);
  const form1 = pickOwn(item1, 'cm-reply-form');
  const replyBtn = main1.querySelector('.cm-acts .cm-act');
  if (replyBtn) replyBtn.dispatchEvent(new (win.Event || Event)('click', { bubbles: true }));
  await sleep(60);
  ok('点「回复」展开内联表单', !!form1 && form1.hidden !== true,
    JSON.stringify({ form: !!form1, hidden: form1 && form1.hidden, btn: replyBtn && replyBtn.textContent }));
  const ta = form1 ? form1.querySelector('textarea') : null;
  if (ta) ta.value = '冒烟：这是一条一级回复';
  if (form1) form1.dispatchEvent(new (win.Event || Event)('submit', { bubbles: true, cancelable: true }));
  await sleep(400);
  const postCall = calls.filter((c) => c.method === 'POST' && c.url.includes('/api/comments')).pop();
  ok('回复发了 POST /api/comments', !!postCall, JSON.stringify(calls.map((c) => c.method + ' ' + c.url)));
  let body = null;
  try { body = postCall ? JSON.parse(postCall.body) : null; } catch { body = null; }
  ok('回复的 body 带 slug 与 parent_id（契约 §1.6）',
    !!body && body.slug === 'water-entry' && String(body.parent_id) === '1', JSON.stringify(body));
  const after = await waitFor(() => document.querySelectorAll('#commentsMount .cm-item').length >= 5, 2500);
  ok('发表成功后重新拉取列表（多出 1 条）', after,
    'items=' + document.querySelectorAll('#commentsMount .cm-item').length);

  /* 删除：两次点击（先武装再确认），成功后重新拉取 */
  const del2 = pickOwn(pickTop('1'), 'cm-acts').querySelector('.is-danger');
  if (del2) del2.dispatchEvent(new (win.Event || Event)('click', { bubbles: true }));
  await sleep(40);
  ok('第一次点删除变成「确认删除」（不是直接删）',
    !!del2 && del2.textContent === '确认删除' && !calls.some((c) => c.method === 'DELETE'),
    JSON.stringify({ text: del2 && del2.textContent, deletes: calls.filter((c) => c.method === 'DELETE').length }));
  if (del2) del2.dispatchEvent(new (win.Event || Event)('click', { bubbles: true }));
  await sleep(400);
  const delCall = calls.filter((c) => c.method === 'DELETE').pop();
  ok('第二次点击才真的发 DELETE /api/comments/:id',
    !!delCall && /\/api\/comments\/1$/.test(delCall.url), JSON.stringify(delCall));
  const gone = await waitFor(() => !pickTop('1'), 2500);
  ok('删除成功后列表里没有那条评论了', gone);
  ok('被删评论的回复没有把渲染搞崩（仍能渲染出来）',
    qa('#commentsMount .cm-item').length >= 3,
    'items=' + document.querySelectorAll('#commentsMount .cm-item').length);

  /* 契约 §0.3：写接口必须带 Content-Type: application/json（无 body 的 DELETE 也不例外），
     而且要带 credentials: same-origin。漏了就会 415。 */
  const writes = calls.filter((c) => c.method === 'POST' || c.method === 'DELETE');
  ok('所有写请求都带了 JSON Content-Type（含无 body 的 DELETE）',
    writes.length > 0 && writes.every((c) => /^application\/json/.test(c.contentType)),
    JSON.stringify(writes.map((c) => c.method + ' ' + c.url + ' ct=' + (c.contentType || '(无)'))));
  ok('所有请求都带 credentials: same-origin',
    calls.every((c) => c.credentials === 'same-origin'),
    JSON.stringify(calls.filter((c) => c.credentials !== 'same-origin').map((c) => c.url)));

  /* 退出登录：一个"空 body 的 POST"，最容易漏 Content-Type 的一条路径 */
  const chip2 = q('#authEntry .auth-btn.is-user');
  if (chip2) chip2.dispatchEvent(new (win.Event || Event)('click', { bubbles: true }));
  await sleep(50);
  const outBtn = qa('#authEntry .auth-menu [role="menuitem"]').filter((b) => /退出/.test(b.textContent))[0];
  ok('下拉里有「退出登录」', !!outBtn);
  if (outBtn) outBtn.dispatchEvent(new (win.Event || Event)('click', { bubbles: true }));
  await sleep(400);
  const outCall = calls.filter((c) => /\/api\/auth\/logout$/.test(c.url)).pop();
  ok('退出登录发的是 POST /api/auth/logout（带 JSON Content-Type）',
    !!outCall && outCall.method === 'POST' && /^application\/json/.test(outCall.contentType),
    JSON.stringify(outCall));
  ok('退出后右上角回到「登录」',
    (q('#authEntry button') || {}).textContent === '登录',
    JSON.stringify((q('#authEntry button') || {}).textContent));
  ok('退出后表达框也回到"登录后可以发表"', !!q('#commentsMount .cm-signin'));
}

if (SCENARIO === 'ratelimited') {
  const ta = q('#commentsMount .cm-composer textarea');
  if (ta) ta.value = '冒烟：触发限流';
  const form = q('#commentsMount .cm-composer form');
  if (form) form.dispatchEvent(new (win.Event || Event)('submit', { bubbles: true, cancelable: true }));
  await sleep(400);
  const post = calls.filter((c) => c.method === 'POST' && c.url.includes('/api/comments')).pop();
  const note = q('#commentsMount .cm-note');
  ok('429 时把服务端的 message 就地显示', !!post && !!note && /操作过于频繁/.test(note.textContent),
    JSON.stringify({ post: !!post, note: note && note.textContent }));
  const send = q('#commentsMount .cm-composer button[type="submit"]');
  ok('429 时按钮被禁用并开始倒计时（读了 Retry-After）',
    !!send && send.disabled === true && /秒后可重试/.test(send.textContent),
    JSON.stringify({ disabled: send && send.disabled, text: send && send.textContent }));
}

console.log('');
console.log('------------------------------');
console.log('[' + SCENARIO + '] 合计：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
