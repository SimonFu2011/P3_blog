/* ============================================================
   五个页面的 DOM 冒烟：把真实的 js/auth-ui.js 分别加载进
   index / article / archive / about / 404 的 HTML 里，验证"右上角登录入口"
   在每个页面上都能渲染出来、能打开同一个模态框。

   为什么单独一个脚本：link 的 CSS、扇形菜单的几何、入场遮罩的先后，
   这些只有真浏览器才知道（那部分由 server/tests/verify-comments-live.mjs
   负责，本机沙箱起不了浏览器）。这里只证明"标记 + 脚本在五个页面上都成立"。

   跑法：node D:\DS\.preview\smoke-pages.mjs
   ============================================================ */
import { readFile } from 'node:fs/promises';
import { parseHTML } from './node_modules/linkedom/esm/index.js';

const BLOG = 'D:\\DS\\blog-enter\\';
const PAGES = ['index', 'article', 'archive', 'about', '404'];

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

const authSrc = await readFile(BLOG + 'js\\auth-ui.js', 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const name of PAGES) {
  const html = await readFile(BLOG + name + '.html', 'utf8');
  const { window: win, document } = parseHTML(html);
  const loc = { href: 'http://127.0.0.1:8877/' + name + '.html', protocol: 'http:', origin: 'http://127.0.0.1:8877' };

  /* 这个文件不需要接口：/auth/me 回 401 就够（未登录是默认态），
     而且我们要的正是"未登录时显示登录"。 */
  const calls = [];
  const fetchShim = (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET' });
    return Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify({ ok: true, user: null, db: 'up', session_max_age_days: 30 })),
      headers: { get: () => null }
    });
  };

  const windowObj = {
    document, location: loc, console, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: fetchShim, URL, Date, Math, JSON, innerWidth: 1440, innerHeight: 900,
    addEventListener: (...a) => document.addEventListener(...a),
    removeEventListener: (...a) => document.removeEventListener(...a),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0)
  };
  windowObj.window = windowObj;

  const run = () => new Function('window', 'document', 'location', 'fetch', authSrc)
    .call(windowObj, windowObj, document, loc, fetchShim);

  /* HTML 里的静态标记：脚本挂了也要看得见 */
  const staticBtn = document.querySelector('[data-auth-entry] [data-auth-open]');
  ok(name + '.html: 静态标记里有「登录」按钮', !!staticBtn && staticBtn.textContent.trim() === '登录');

  const ran = (() => { try { run(); return true; } catch (err) { console.error(err); return false; } })();
  ok(name + '.html: js/auth-ui.js 能在这一页执行', ran);

  document.dispatchEvent(new (win.Event || Event)('DOMContentLoaded'));
  await sleep(80);

  const rendered = document.querySelector('[data-auth-entry] button');
  ok(name + '.html: 渲染后右上角仍是「登录」（未登录态）',
    !!rendered && rendered.textContent.trim() === '登录',
    rendered && rendered.textContent.trim());
  ok(name + '.html: 入口归同一条代码路径管理（class 一致）',
    !!document.querySelector('[data-auth-entry] .auth-btn'));

  /* 点它 → 模态框 */
  if (rendered) rendered.dispatchEvent(new (win.Event || Event)('click', { bubbles: true }));
  await sleep(50);
  const modal = document.querySelector('.auth-modal');
  ok(name + '.html: 点入口打开模态框', !!modal && modal.hidden !== true);
  ok(name + '.html: 模态框有两个页签与注册邮箱输入框',
    !!modal &&
    Array.prototype.map.call(modal.querySelectorAll('.auth-tab'), (t) => t.textContent).join('/') === '登录/注册' &&
    !!modal.querySelector('.auth-view[data-auth-view="register"] input[name="email"]'));
  ok(name + '.html: 只问了一次 /auth/me（不重复打接口）',
    calls.filter((c) => /\/api\/auth\/me$/.test(c.url)).length === 1,
    JSON.stringify(calls.map((c) => c.method + ' ' + c.url)));
  ok(name + '.html: 模态框挂在 body 上（不在 .world / .page 里被裁切）',
    !!modal && modal.parentNode === document.body);

  /* 键盘归属：模态框没开时 auth-ui.js 不许碰任何按键（首页的 ENTER / 滚轮必须
     原样交给 boot.js）；打开后才接管（Enter 不外传、ESC 就地吃掉并关框）。 */
  const key = (k) => {
    const ev = new (win.Event || Event)('keydown', { bubbles: true, cancelable: true });
    ev.key = k;
    document.dispatchEvent(ev);
    return ev;
  };
  if (modal) {
    const x = modal.querySelector('[data-auth-close]');
    if (x) x.dispatchEvent(new (win.Event || Event)('click', { bubbles: true }));
  }
  const evIdle = key('Enter');
  ok(name + '.html: 模态框没开时 Enter 不被拦截（入场 ENTER 仍归 boot.js）',
    evIdle.cancelBubble !== true && evIdle.defaultPrevented === false,
    JSON.stringify({ cancelBubble: evIdle.cancelBubble, prevented: evIdle.defaultPrevented }));

  const entryBtn = document.querySelector('[data-auth-entry] button');
  if (entryBtn) entryBtn.dispatchEvent(new (win.Event || Event)('click', { bubbles: true }));
  await sleep(40);
  const evOpen = key('Enter');
  ok(name + '.html: 模态框打开时 Enter 不再外传（不被菜单快捷键抢走）',
    evOpen.cancelBubble === true, JSON.stringify({ cancelBubble: evOpen.cancelBubble }));
  const evEsc = key('Escape');
  const m2 = document.querySelector('.auth-modal');
  ok(name + '.html: 模态框打开时 ESC 就地吃掉并关框（不跳回首页）',
    evEsc.defaultPrevented === true && !!m2 && m2.hidden === true,
    JSON.stringify({ prevented: evEsc.defaultPrevented, hidden: m2 && m2.hidden }));
}

console.log('');
console.log('------------------------------');
console.log('五页 DOM 冒烟合计：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
