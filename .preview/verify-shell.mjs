/* ============================================================
   站点外壳验证：侧边栏收起 / 访问统计 / 标签云
   ------------------------------------------------------------
   跑法（先起静态服务器）：
     node .preview/serve.mjs            # 另开一个终端，8848
     node .preview/verify-shell.mjs     # 本脚本，headless Chrome + CDP

   断言的是"行为 + 真实渲染"而不是类名：
     · 收起：宽度真的变了、图标真出现、偏好真的落盘、刷新后绘制前就是收起态
     · 统计：三个数字有值、刷新会累加、首屏入水前后可见性正确、不与其它角标重叠
     · 标签云：字号随热度单调、点击数真的要等于文章数、焦点要回到原处、
               与胶囊的高亮必须同步（同一份状态的两个视图）
     · 布局：12 种宽度 × 收起/展开，逐个体检横向溢出
   截图落在 .preview/（已被 .gitignore 排除）。
   ============================================================ */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9347;
const BASE = process.env.SHELL_URL || 'http://127.0.0.1:8848';
const OUT = process.env.PREVIEW_OUT || 'D:\\DS\\.preview';

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
  '--window-size=1440,900',
  '--user-data-dir=' + join(OUT, 'cp-shell'), 'about:blank'
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map(); const events = [];
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify(s ? { id, method: m, params: p, sessionId: s } : { id, method: m, params: p }));
});

let v = null;
for (let i = 0; i < 60 && !v; i++) {
  await sleep(250);
  try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
}
if (!v) { console.error('× 连不上 headless Chrome'); process.exit(1); }
ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
    return;
  }
  if (m.method) events.push(m);
};

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable'); await S('Network.enable');

const js = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

let pass = 0; let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       → ' + extra : '')); }
};
const section = (t) => console.log('\n' + t);

/* JS 层错误：异常与 console.error。
   资源层的 4xx/5xx 归 netFails()（那里才有 URL 可点名）—— 两边分工，
   免得同一条"Failed to load resource"被记两次、又说不清是谁。 */
const consoleErrors = () => events
  .filter((m) => (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') ||
                 m.method === 'Runtime.exceptionThrown')
  .map((m) => (m.method === 'Runtime.exceptionThrown'
    ? (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
    : (m.params.args || []).map((a) => a.value || a.description || '').join(' ')));

/* 资源层：任何 4xx/5xx 响应或加载失败都要点名到 URL ——
   "Failed to load resource" 这类日志本身不带地址，只靠它查不出来是谁挂了。
   唯一豁免：/api/auth/me 与 /api/stats/hit —— 前者是右上角登录入口加载时探会话，
   后者是访问统计的计数请求；这套静态预览（.preview/serve.mjs）没有 /api，
   真机上由 p3-public 应答。这一条是**改动前就有**的：拿 HEAD 的干净站点跑
   verify-geo 得到的也是同一处 404（实测 45 通过 / 2 失败，与改动后完全一致）。 */
const netFails = () => {
  const out = [];
  events.forEach((m) => {
    if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
      const url = m.params.response.url;
      /* favicon 是浏览器自动请求的，且不同预览服务器的处理不一样：
         serve.mjs 特判回 204，stub-p3-api.mjs 会老老实实 404。
         它与站点代码无关，所以不参与"资源完整性"的判定。 */
      if (/\/favicon\.ico$/.test(url)) return;
      if (/\/api\/(auth\/me|stats\/hit)\b/.test(url)) return;
      out.push(m.params.response.status + ' ' + url);
    }
    if (m.method === 'Network.loadingFailed') {
      out.push('loadingFailed ' + m.params.errorText + ' ' + (m.params.requestId || ''));
    }
  });
  return out;
};

const setSize = (w, h) => S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });

/* 绘制前就应用了收起偏好 —— 用新文档注入脚本记录 DOMContentLoaded 那一刻的值。
   这是"刷新后不闪一下"的唯一硬证据：那一刻宽度就已经是 76px。 */
await S('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__w0 = null;
    document.addEventListener('DOMContentLoaded', function () {
      var n = document.querySelector('.nav');
      var p = document.querySelector('.page');
      window.__w0 = {
        state: document.documentElement.getAttribute('data-nav'),
        navW: n ? Math.round(n.getBoundingClientRect().width) : -1,
        pagePL: p ? Math.round(parseFloat(getComputedStyle(p).paddingLeft)) : -1
      };
    });
  `
});

const goto = async (url, w = 1440, h = 900, wait = 900) => {
  await setSize(w, h);
  await S('Page.navigate', { url: BASE + url });
  await sleep(wait);
};

const shot = async (name, w = 1440, h = 1000) => {
  await setSize(w, h);
  await sleep(320);
  const r = await S('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
};

/* 页面里反复用到的几何/样式读数 */
const PROBE = `(function(){
  var q = function (s) { return document.querySelector(s); };
  var r = function (el) { if (!el) return null; var b = el.getBoundingClientRect();
    return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; };
  var vis = function (el) { if (!el) return false; var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.01; };
  var nav = q('.nav'); var page = q('.page'); var stats = q('[data-stats]');
  var foot = q('.foot');
  var overlap = function (a, b) { if (!a || !b) return 0;
    var ox = Math.min(a.r, b.r) - Math.max(a.l, b.l); var oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
    return (ox > 0 && oy > 0) ? Math.round(ox * oy) : 0; };
  return {
    navState: document.documentElement.getAttribute('data-nav'),
    navW: nav ? Math.round(nav.getBoundingClientRect().width) : -1,
    pagePL: page ? Math.round(parseFloat(getComputedStyle(page).paddingLeft)) : -1,
    railVisible: vis(q('.nav-rail')),
    markVisible: vis(q('.nav-brand-mark')),
    iconVisible: vis(q('.nav-link .nl-ic')),
    enVisible: vis(q('.nav-link .nl-en')),
    tip: (q('.nav-link') || {}).dataset ? q('.nav-link').dataset.tip : null,
    tipCount: document.querySelectorAll('.nav-link[data-tip]').length,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    overflowBody: document.body.scrollWidth - window.innerWidth,
    stats: stats ? {
      visible: vis(stats), hidden: stats.hidden,
      inNav: !!(stats.closest && stats.closest('.nav')),
      keys: Array.prototype.map.call(stats.querySelectorAll('.stat'), function (s) {
        return { k: s.querySelector('.stat-k').textContent, v: s.querySelector('.stat-v').textContent }; }),
      src: (stats.querySelector('[data-stat-src]') || {}).textContent || '',
      mainFont: parseFloat(getComputedStyle(stats.querySelector('.stat.is-main .stat-v')).fontSize) || 0,
      subFont: (function () { var s = stats.querySelectorAll('.stat:not(.is-main) .stat-v');
        return s.length ? parseFloat(getComputedStyle(s[0]).fontSize) : 0; })(),
      rect: r(stats),
      noise: stats.classList.contains('is-noise')
    } : null,
    footRect: r(foot),
    navRect: r(nav),
    navFootRect: r(q('.nav .nav-foot')),
    storage: (function () { try { return localStorage.getItem('p3.shell.nav'); } catch (e) { return 'ERR'; } })(),
    w0: window.__w0,
    errs: 0
  };
})()`;

const probe = () => js(PROBE);

/* ------------------------------------------------------------
   A. 关于我：收起 / 展开 + 偏好持久化
   ------------------------------------------------------------ */
section('A. 侧边栏收起（about.html @1440×900）');
await goto('/about.html');
await js(`try{localStorage.clear()}catch(e){}; true`);
await goto('/about.html');

let p = await probe();
ok('w0 收起按钮存在且可见', p.railVisible === true);
const expandedW = p.navW;
ok('展开态侧边栏宽度是完整栏（>240px）', p.navW > 240, 'navW=' + p.navW);
ok('展开态不显示图标、显示文字', p.iconVisible === false && p.enVisible === true);
ok('导航文案已镜像成 data-tip（收起态气泡用）', p.tipCount === 3 && !!p.tip, 'tip=' + p.tip);

await js(`document.querySelector('[data-nav-collapse]').click(); true`);
await sleep(450);
p = await probe();
ok('点击后 html[data-nav] = collapsed', p.navState === 'collapsed', 'state=' + p.navState);
ok('侧边栏收成图标栏（≈76px）', Math.abs(p.navW - 76) <= 2, 'navW=' + p.navW);
ok('内容区跟着让位（padding-left 变小且 ≈ 76+rail）', p.pagePL > 60 && p.pagePL < expandedW, 'pagePL=' + p.pagePL);
ok('收起态显示图标、隐藏文字', p.iconVisible === true && p.enVisible === false);
ok('收起态显示品牌缩写', p.markVisible === true);
ok('偏好写进 localStorage', p.storage === 'collapsed', 'storage=' + p.storage);
ok('收起后没有横向溢出', p.overflow <= 1, 'overflow=' + p.overflow + 'px');

/* 刷新：新文档在 DOMContentLoaded 那一刻就该是收起的（无闪动） */
await goto('/about.html');
p = await probe();
ok('刷新后仍是收起态', p.navState === 'collapsed' && Math.abs(p.navW - 76) <= 2, 'navW=' + p.navW);
ok('首屏绘制前就已应用（DOMContentLoaded 时 nav 宽度 = 76）',
  p.w0 && p.w0.state === 'collapsed' && Math.abs(p.w0.navW - 76) <= 2,
  JSON.stringify(p.w0));

await js(`document.querySelector('[data-nav-collapse]').click(); true`);
await sleep(450);
p = await probe();
ok('再点一次展开、偏好改回 open', p.navState === 'open' && p.storage === 'open' && p.navW > 240,
  'state=' + p.navState + ' storage=' + p.storage + ' navW=' + p.navW);
ok('展开态 aria-expanded=true', await js(`document.querySelector('[data-nav-collapse]').getAttribute('aria-expanded') === 'true'`));

/* 键盘快捷键 [ */
await js(`document.body.focus(); document.dispatchEvent(new KeyboardEvent('keydown', {key:'[', bubbles:true})); true`);
await sleep(350);
ok('快捷键 [ 也能收起', (await probe()).navState === 'collapsed');
await js(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'[', bubbles:true})); true`);
await sleep(350);
ok('快捷键再按一次展开', (await probe()).navState === 'open');

/* 图标栏里的链接仍可点（导航不能被收起功能弄坏） */
await js(`window.SiteShell.nav.set(true); true`);
await sleep(400);
const collapsedHref = await js(`(function(){ var a = document.querySelector('.nav-link');
  var b = a.getBoundingClientRect();
  return { href: a.getAttribute('href'), w: Math.round(b.width), h: Math.round(b.height),
    aria: document.querySelector('[data-nav-collapse]').getAttribute('aria-expanded') }; })()`);
ok('收起态导航项是 46×46 的图标按钮且 href 正常',
  collapsedHref.href === 'about.html' && collapsedHref.w === 46 && collapsedHref.h > 40 && collapsedHref.aria === 'false',
  JSON.stringify(collapsedHref));
await js(`window.SiteShell.nav.set(false); true`);
await sleep(400);
ok('set(false) 幂等地回到展开态', (await probe()).navState === 'open');

/* 收起态的图标栏：几何不许互相压、图标颜色必须看得见。
   这两条都是"照着截图放大看"才发现的缺陷（收起按钮压在品牌缩写上；
   当前页那一枚图标因为继承了深色皮肤的白色文字色而在白侧栏上消失），
   所以必须写成断言 —— 只查"宽度对不对"是抓不到的。 */
await js(`window.SiteShell.nav.set(true); true`);
await sleep(450);
const rail = await js(`(function () {
  var r = function (el) { var b = el.getBoundingClientRect();
    return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  var ov = function (a, b) {
    var ox = Math.min(a.r, b.r) - Math.max(a.l, b.l);
    var oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
    return (ox > 0 && oy > 0) ? Math.round(ox * oy) : 0; };
  var lum = function (c) {
    var m = c.match(/[\\d.]+/g) || [];
    return (Number(m[0]) * 0.299 + Number(m[1]) * 0.587 + Number(m[2]) * 0.072) / 255; };
  var svgs = document.querySelectorAll('.nav-link .nl-ic svg');
  var cur = document.querySelector('.nav-link[aria-current="page"] .nl-en');
  var back = document.querySelector('.nav-back');
  return {
    btnMarkOverlap: ov(r(document.querySelector('.nav-rail')), r(document.querySelector('.nav-brand-mark'))),
    icons: Array.prototype.map.call(svgs, function (s) { return getComputedStyle(s).stroke; }),
    iconLum: Array.prototype.map.call(svgs, function (s) { return Math.round(lum(getComputedStyle(s).stroke) * 100) / 100; }),
    curLabel: cur ? getComputedStyle(cur).color : '',
    curLabelLum: cur ? Math.round(lum(getComputedStyle(cur).color) * 100) / 100 : -1,
    backTextHidden: getComputedStyle(back.querySelector('.nb-text')).display === 'none',
    backArrowShown: back.getBoundingClientRect().width > 0
  };
})()`);
ok('收起态的收起按钮没有压住品牌缩写', rail.btnMarkOverlap === 0, 'overlap=' + rail.btnMarkOverlap + 'px²');
ok('三枚图标都拿到了能看见的颜色（白侧栏上不能是白）',
  rail.iconLum.length === 3 && rail.iconLum.every((l) => l < 0.55), JSON.stringify(rail.icons));
ok('当前页的导航文字不是白字（深色皮肤那条规则不许漏到浅底页）',
  rail.curLabelLum >= 0 && rail.curLabelLum < 0.55, rail.curLabel + ' lum=' + rail.curLabelLum);
ok('收起态页脚只留箭头、文字收起', rail.backTextHidden === true && rail.backArrowShown === true);
await js(`window.SiteShell.nav.set(false); true`);
await sleep(400);

/* 侧边栏内容整体左移：内距 = 基准内距 - --ui-nav-shift，
   而缩放键量的是 .nav 的**右**边缘，所以它一动不动。
   这两条一起才是需求说的"除了缩放键以外都左移"。 */
const shift = await js(`(function(){
  var nav = document.querySelector('.nav');
  var cs = getComputedStyle(nav);
  var link = document.querySelector('.nav-link');
  var rail = document.querySelector('.nav-rail');
  var page = document.querySelector('.page');
  var nr = nav.getBoundingClientRect();
  var lr = link.getBoundingClientRect();
  var rr = rail.getBoundingClientRect();
  return { padLeft: Math.round(parseFloat(cs.paddingLeft) * 100) / 100,
    /* 期望值要用**解析后**的基准：--g-rail 本身是 clamp(...) 的 token 文本，
       parseFloat 拿不到数；而 .page 的右内距正是 var(--g-rail) 的解析值 */
    railBase: Math.round(parseFloat(getComputedStyle(page).paddingRight) * 100) / 100,
    shift: Math.round(parseFloat(cs.getPropertyValue('--ui-nav-shift')) * 100) / 100,
    navL: nr.left, navR: nr.right, linkL: lr.left,
    railInset: Math.round((nr.right - rr.right) * 100) / 100 };
})()`);
const wantPad = Math.max(0, shift.railBase - shift.shift);
ok('侧边栏内容整体左移（内距 = 基准 rail − --ui-nav-shift）',
  shift.shift >= 8 && Math.abs(shift.padLeft - wantPad) < 0.8,
  JSON.stringify(shift) + ' expect=' + wantPad);
ok('导航项确实跟着内距走（左边缘 = 侧边栏左内距）',
  Math.abs(shift.linkL - shift.navL - shift.padLeft) < 1.5,
  JSON.stringify({ linkL: shift.linkL, navL: shift.navL, padLeft: shift.padLeft }));
ok('缩放键位置不受左移影响（它量的是侧边栏右边缘）',
  Math.abs(shift.railInset - 14) < 1.5, 'railInset=' + shift.railInset);

/* ------------------------------------------------------------
   B. 关于我：布局规整（含本轮修的邮箱锚点）
   ------------------------------------------------------------ */
section('B. 布局与间距（about.html）');
const layout = await js(`(function(){
  var rows = document.querySelectorAll('.contact');
  var first = rows[0];
  var secs = document.querySelectorAll('.main > .section');
  var gaps = Array.prototype.map.call(secs, function (s) { return Math.round(parseFloat(getComputedStyle(s).marginTop)); });
  var hs = Array.prototype.map.call(document.querySelectorAll('h1,h2,h3'), function (h) { return Number(h.tagName.slice(1)); });
  var hskip = false; for (var i = 1; i < hs.length; i++) { if (hs[i] - hs[i-1] > 1) hskip = true; }
  var heads = Array.prototype.map.call(document.querySelectorAll('.section-head'), function (s) {
    return Math.round(parseFloat(getComputedStyle(s).paddingBottom)); });
  return {
    contacts: rows.length,
    mailIcon: !!first.querySelector('.contact-icon svg'),
    mailText: (first.querySelector('.contact-value') || {}).textContent || '',
    mailNum: (first.querySelector('.contact-num') || {}).textContent || '',
    gaps: gaps, heads: heads,
    hskip: hskip, h1: document.querySelectorAll('h1').length,
    radius: getComputedStyle(document.querySelector('.chip') || document.body).borderRadius
  };
})()`);
ok('联系方式三行都在（首行邮箱锚点已修好）',
  layout.contacts === 3 && layout.mailIcon && /@/.test(layout.mailText) && layout.mailNum === '01',
  JSON.stringify(layout));
ok('各小节间距是同一档（统一为 --ui-sect-gap）',
  layout.gaps.length > 1 && new Set(layout.gaps).size === 1, 'gaps=' + layout.gaps.join(','));
ok('小节标题内距统一', new Set(layout.heads).size === 1, 'heads=' + layout.heads.join(','));
ok('标题层级没有跳级（h1→h2→h3）', layout.hskip === false);

/* ------------------------------------------------------------
   C. 访问统计
   ------------------------------------------------------------ */
section('C. 访问统计');
await js(`window.SiteShell.stats.clear(); true`);
await goto('/about.html');
p = await probe();
/* 来源是"实际显示的数字来自哪"，所以断言要跟着它分叉：
   · 静态预览（.preview/serve.mjs 没有 /api）→ 必须如实退回本机记录，
     第三个槽位是"已记录天数"，来源标注写"本机记录"
   · 接了真后端（SHELL_URL 指到线上/桩）→ 必须是后端数字，
     第三个槽位是"访客数"，来源标注写"后端"
   这一段因此对两种环境都成立 —— 部署后可以直接拿它验线上。 */
const statsSrc = await js(`window.SiteShell.stats.source()`);
ok('内页有统计条且可见', p.stats && p.stats.visible === true && p.stats.hidden === false);
ok('统计条是三项（总访问量 / 今日访问量 / 第三个随来源）',
  p.stats && p.stats.keys.length === 3 &&
  p.stats.keys[0].k === '总访问量' && p.stats.keys[1].k === '今日访问量',
  JSON.stringify(p.stats && p.stats.keys));
ok('数字都有值（不是占位 —）',
  p.stats && p.stats.keys.every((s) => /^\d[\d,]*$/.test(s.v)), JSON.stringify(p.stats && p.stats.keys));
if (statsSrc === 'remote') {
  ok('接了后端：来源标注如实写"后端"，第三项是访客数',
    /后端/.test(p.stats.src) && p.stats.keys[2].k === '访客数',
    p.stats.src + ' / ' + p.stats.keys[2].k);
  const t1 = Number(String(p.stats.keys[0].v).replace(/,/g, ''));
  await goto('/about.html');
  p = await probe();
  const t2 = Number(String(p.stats.keys[0].v).replace(/,/g, ''));
  ok('刷新一次总访问量 +1（后端真的记了一次 PV）', t2 === t1 + 1, t1 + ' → ' + t2);
} else {
  ok('没接后端时如实标注"本机记录"，并把第三项换成已记录天数',
    /本机记录/.test(p.stats.src) && p.stats.keys[2].k === '已记录天数',
    p.stats.src + ' / ' + p.stats.keys[2].k);
  const total1 = Number(String(p.stats.keys[0].v).replace(/,/g, ''));
  await goto('/about.html');
  p = await probe();
  const total2 = Number(String(p.stats.keys[0].v).replace(/,/g, ''));
  ok('刷新一次总访问量 +1（本机 PV 计数）', total2 === total1 + 1, total1 + ' → ' + total2);
}
ok('在侧边栏下部：位于 .nav 内、且排在 .nav-foot 之前',
  p.stats.inNav === true && p.navFootRect && p.stats.rect.b <= p.navFootRect.t + 1,
  JSON.stringify({ inNav: p.stats.inNav, statsB: p.stats.rect.b, footT: p.navFootRect && p.navFootRect.t }));
ok('主指标明显更大（总访问量字号 > 其余两项）',
  p.stats.mainFont >= 22 && p.stats.mainFont > p.stats.subFont + 4,
  'main=' + p.stats.mainFont + 'px sub=' + p.stats.subFont + 'px');

/* 侧边栏只有 ~235px 可用内容宽：这一块必须连**内部元素**都不越界
   （测的是每个后代的最右边缘，不是外层盒子的宽 —— 盒子内溢出一样是问题） */
const fit = await js(`(function(){
  var s = document.querySelector('[data-stats]'); var nav = document.querySelector('.nav');
  var sr = s.getBoundingClientRect(); var nr = nav.getBoundingClientRect();
  var worst = 0; var who = '';
  Array.prototype.forEach.call(s.querySelectorAll('*'), function (el) {
    var r = el.getBoundingClientRect();
    if (r.width && r.right > worst) { worst = r.right; who = String(el.className || el.tagName); }
  });
  return { boxR: Math.round(sr.right), boxW: Math.round(sr.width),
    navR: Math.round(nr.right), navL: Math.round(nr.left),
    contentL: Math.round(nr.left + parseFloat(getComputedStyle(nav).paddingLeft)),
    worstR: Math.round(worst), worstEl: who,
    srcR: Math.round(s.querySelector('[data-stat-src]').getBoundingClientRect().right) };
})()`);
ok('统计块（含内部元素）不越过侧边栏右边界',
  fit.worstR <= fit.navR + 1 && fit.boxR <= fit.navR + 1, JSON.stringify(fit));

/* 悬停"乱码 1 秒再落定"：这是本轮的新交互，得真派发鼠标事件验，而不是看类名 */
const before = await js(`(function(){ var s = document.querySelector('[data-stats]');
  var b = s.getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
    vals: Array.prototype.map.call(s.querySelectorAll('.stat-v'), function (v) { return v.textContent; }) }; })()`);
await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x, y: before.y });
await sleep(260);
const noise = await js(`(function(){ var s = document.querySelector('[data-stats]');
  return { on: s.classList.contains('is-noise'),
    vals: Array.prototype.map.call(s.querySelectorAll('.stat-v'), function (v) { return v.textContent; }),
    aria: Array.prototype.map.call(s.querySelectorAll('.stat-v'), function (v) { return v.getAttribute('aria-hidden'); }) }; })()`);
ok('悬停后先进入乱码：值不等于真值、且标了 aria-hidden（读屏不念随机数）',
  noise.on === true && JSON.stringify(noise.vals) !== JSON.stringify(before.vals)
  && noise.aria.every((a) => a === 'true'),
  JSON.stringify(noise));
await sleep(1200);
const noiseSettled = await js(`(function(){ var s = document.querySelector('[data-stats]');
  return { on: s.classList.contains('is-noise'),
    vals: Array.prototype.map.call(s.querySelectorAll('.stat-v'), function (v) { return v.textContent; }),
    aria: Array.prototype.map.call(s.querySelectorAll('.stat-v'), function (v) { return v.getAttribute('aria-hidden'); }) }; })()`);
ok('约 1 秒后落定回真值，且 aria-hidden 摘掉',
  noiseSettled.on === false && JSON.stringify(noiseSettled.vals) === JSON.stringify(before.vals)
  && noiseSettled.aria.every((a) => a === null),
  JSON.stringify(noiseSettled) + ' vs ' + JSON.stringify(before.vals));

/* ------------------------------------------------------------
   D. 标签云（archive.html）
   ------------------------------------------------------------ */
section('D. 词云（archive.html）');
await goto('/archive.html');
const cloud = await js(`(function(){
  var host = document.querySelector('#tagCloud');
  var tags = Array.prototype.slice.call(host.querySelectorAll('.tc-tag'));
  var cont = host.getBoundingClientRect();
  var rects = tags.map(function (t) { var b = t.getBoundingClientRect();
    return { name: t.querySelector('.tc-name').textContent, n: Number(t.querySelector('.tc-n').textContent),
      fs: parseFloat(getComputedStyle(t).fontSize), heat: t.dataset.heat || '',
      left: t.style.left, top: t.style.top,
      l: b.left, t2: b.top, r: b.right, b2: b.bottom, w: b.width, h: b.height }; });
  /* 视觉矩形两两相交检查：词云一旦重叠，可读性与可点性同时崩 */
  var overlaps = [];
  for (var i = 0; i < rects.length; i++) for (var j = i + 1; j < rects.length; j++) {
    var a = rects[i]; var c = rects[j];
    var ox = Math.min(a.r, c.r) - Math.max(a.l, c.l);
    var oy = Math.min(a.b2, c.b2) - Math.max(a.t2, c.t2);
    if (ox > 1.5 && oy > 1.5) overlaps.push(a.name + '×' + c.name + '=' + Math.round(ox) + '×' + Math.round(oy));
  }
  var minL = Math.min.apply(null, rects.map(function (r) { return r.l; }));
  var minT = Math.min.apply(null, rects.map(function (r) { return r.t2; }));
  var maxR = Math.max.apply(null, rects.map(function (r) { return r.r; }));
  var maxB = Math.max.apply(null, rects.map(function (r) { return r.b2; }));
  var outside = rects.filter(function (r) {
    return r.l < cont.left - 1.5 || r.t2 < cont.top - 1.5 || r.r > cont.right + 1.5 || r.b2 > cont.bottom + 1.5; }).length;
  var inner = host.querySelector('.cloud-inner');
  var zoom = 1;
  if (inner) {
    var m = /matrix\(([^)]+)\)/.exec(getComputedStyle(inner).transform);
    if (m) zoom = parseFloat(m[1].split(',')[0]) || 1;
  }
  var sorted = rects.slice().sort(function (a, b) { return b.n - a.n; });
  var hot = sorted[0]; var cold = sorted[sorted.length - 1];
  var totals = window.Archive.totals();
  return { count: tags.length, chipTags: document.querySelectorAll('#tagChips .chip').length - 1,
    allN: Number((document.querySelector('#cloudAll .tc-n') || {}).textContent || -1),
    allInside: !document.querySelector('#tagCloud .tc-all'),
    sizes: rects.map(function (r) { return { name: r.name, n: r.n, fs: r.fs, heat: r.heat, left: r.left, top: r.top }; }),
    hot: { name: hot.name, n: hot.n, fs: hot.fs }, cold: { name: cold.name, n: cold.n, fs: cold.fs },
    overlaps: overlaps, outside: outside, zoom: Math.round(zoom * 100) / 100,
    fillW: Math.round(((maxR - minL) / cont.width) * 100) / 100,
    fillH: Math.round(((maxB - minT) / cont.height) * 100) / 100,
    contDetected: cont.width > 50 && cont.height > 50,
    total: totals.total, shown: totals.shown,
    cards: document.querySelectorAll('#postList .post-card').length,
    twoCol: (function () { var f = document.querySelector('.filters');
      return f ? getComputedStyle(f).gridTemplateColumns.split(' ').length : 0; })(),
    cloudRightOfChips: (function () {
      var pane = document.querySelector('.filter-pane'); var box = document.querySelector('#cloudBox');
      if (!pane || !box) return false;
      var a = pane.getBoundingClientRect(); var c = box.getBoundingClientRect();
      return c.left >= a.right - 2; })(),
    hskip: (function () { var hs = Array.prototype.map.call(document.querySelectorAll('h1,h2,h3'),
        function (h) { return Number(h.tagName.slice(1)); });
      for (var i = 1; i < hs.length; i++) { if (hs[i] - hs[i-1] > 1) return true; } return false; })(),
    secHeads: document.querySelectorAll('#listSection .section-head .section-num').length,
    inlineMargin: !!document.querySelector('#listSection').getAttribute('style') };
})()`);
ok('词云的词数 = 标签数（"全部"不在云里）',
  cloud.count >= 2 && cloud.count === cloud.chipTags && cloud.allInside === true,
  JSON.stringify({ count: cloud.count, chipTags: cloud.chipTags, allInside: cloud.allInside }));
ok('"全部"在抬头行，篇数 = 全部文章数', cloud.allN === cloud.total, cloud.allN + ' vs ' + cloud.total);
ok('版式：筛选区两列，词云在分类/标签的右侧',
  cloud.twoCol === 2 && cloud.cloudRightOfChips === true,
  JSON.stringify({ twoCol: cloud.twoCol, right: cloud.cloudRightOfChips }));
ok('词是绝对定位排布的（不是换行流）——每个词都有算出来的 left/top',
  cloud.sizes.every((s) => /^\d+px$/.test(s.left) && /^\d+px$/.test(s.top)),
  JSON.stringify(cloud.sizes.slice(0, 3)));
ok('词之间零重叠（碰撞检测生效）', cloud.overlaps.length === 0, cloud.overlaps.join(' | '));
ok('所有词都在容器内（含整层缩放后）', cloud.outside === 0 && cloud.contDetected === true,
  'outside=' + cloud.outside);
ok('整朵云铺满容器（长或宽至少填到 90%）',
  Math.max(cloud.fillW, cloud.fillH) >= 0.9 && cloud.fillW <= 1.02 && cloud.fillH <= 1.02,
  'zoom=' + cloud.zoom + ' fillW=' + cloud.fillW + ' fillH=' + cloud.fillH);
ok('字号随热度单调（最热 > 最冷）', cloud.hot.fs - cloud.cold.fs >= 4,
  JSON.stringify({ hot: cloud.hot, cold: cloud.cold }));
ok('热度分档（hot/warm/cool 至少出现两档）',
  new Set(cloud.sizes.map((s) => s.heat)).size >= 2,
  JSON.stringify(cloud.sizes.map((s) => s.name + ':' + s.heat)));
ok('两页的小节编号风格一致（归档有小节头 01/02）', cloud.secHeads === 1 && cloud.inlineMargin === false);
ok('归档页标题层级没有跳级', cloud.hskip === false);

/* 点最热的词：先聚焦再点。因为不再重建 DOM，焦点本来就该原地不动
   （旧实现是"重画之后再把焦点 focus 回去"） */
const hotName = cloud.hot.name;
await js(`(function(){ var t = Array.prototype.filter.call(document.querySelectorAll('#tagCloud .tc-tag'),
  function (x) { return x.querySelector('.tc-name').textContent === ${JSON.stringify(hotName)}; })[0];
  t.focus(); t.click(); })(); true`);
await sleep(350);
const afterClick = await js(`(function(){
  var t = Array.prototype.filter.call(document.querySelectorAll('#tagCloud .tc-tag'),
    function (x) { return x.querySelector('.tc-name').textContent === ${JSON.stringify(hotName)}; })[0];
  var chip = Array.prototype.filter.call(document.querySelectorAll('#tagChips .chip'),
    function (x) { return x.childNodes[0].nodeValue === ${JSON.stringify(hotName)}; })[0];
  return { pressed: t.getAttribute('aria-pressed'), chipPressed: chip ? chip.getAttribute('aria-pressed') : null,
    active: document.activeElement === t, cards: document.querySelectorAll('#postList .post-card').length,
    count: document.querySelector('#filterCount').textContent,
    pos: Array.prototype.map.call(document.querySelectorAll('#tagCloud .tc-tag'),
      function (x) { return x.style.left + ',' + x.style.top; }).join('|'),
    url: location.search, resetDisabled: document.querySelector('#filterReset').disabled };
})()`);
ok('点击词后该标签为选中态，且与胶囊同步',
  afterClick.pressed === 'true' && afterClick.chipPressed === 'true', JSON.stringify(afterClick));
ok('筛出的文章数 = 该词的篇数', afterClick.cards === cloud.hot.n,
  'cards=' + afterClick.cards + ' expect=' + cloud.hot.n);
ok('筛选状态写进 URL', afterClick.url.indexOf('tag=') >= 0, afterClick.url);
ok('键盘焦点仍在被点的那一枚上（不再重建 DOM，所以不会掉）', afterClick.active === true);
ok('点词不会让整朵云重排（位置逐字节不变）',
  afterClick.pos === cloud.sizes.map((s) => s.left + ',' + s.top).join('|'),
  '重排了：位置发生了变化');
ok('计数提示同步', /命中/.test(afterClick.count), afterClick.count);

/* 悬停反馈：派发真实鼠标移动，比对颜色与位移。
   两点必须注意：
     · html 上有 scroll-behavior: smooth —— scrollIntoView 会**动画**滚动，
       在同一个 evaluate 里量坐标会量到滚动前的位置，鼠标就落空了；
       这里拆成"先滚、等停、再量、再移"四步。
     · 要挑一枚**未选中**的词：选中样式（.tc-tag[aria-pressed="true"]）
       与 :hover 同权重、且在文件里更靠后，本来就该盖住悬停色 ——
       拿一枚已选中的词去测悬停，测到的是选中色，不是悬停色。 */
const HOVER_SEL = `Array.prototype.filter.call(document.querySelectorAll('#tagCloud .tc-tag'),
  function (x) { return x.getAttribute('aria-pressed') !== 'true'; })[0]`;
await js(`(function(){ var t = ${HOVER_SEL}; if (t) t.scrollIntoView({ block: 'center', behavior: 'instant' }); })(); true`);
await sleep(420);
const hoverBefore = await js(`(function(){ var t = ${HOVER_SEL}; var b = t.getBoundingClientRect(); var cs = getComputedStyle(t);
  return { name: t.querySelector('.tc-name').textContent, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
    color: cs.color, transform: cs.transform }; })()`);
await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverBefore.x, y: hoverBefore.y });
await sleep(120);
await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverBefore.x + 1, y: hoverBefore.y + 1 });
await sleep(380);
const hoverAfter = await js(`(function(){ var t = ${HOVER_SEL}; var cs = getComputedStyle(t);
  return { color: cs.color, transform: cs.transform }; })()`);
ok('悬停有明显反馈（颜色变 + 抬起 2px）',
  hoverAfter.color !== hoverBefore.color && /matrix\(1, 0, 0, 1, 0, -2\)/.test(hoverAfter.transform),
  hoverBefore.name + '：' + hoverBefore.color + '/' + hoverBefore.transform + ' → ' + hoverAfter.color + '/' + hoverAfter.transform);

/* 悬停分散：其余词让开，但**不许越界、不许重叠、不许动 left/top**
   （此刻鼠标正停在上一步那一枚上，所以效果应当已经生效） */
await sleep(420);   // 等 .3s 的位移过渡走完
const scatter = await js(`(function(){
  var host = document.querySelector('#tagCloud');
  var cont = host.getBoundingClientRect();
  var words = Array.prototype.slice.call(host.querySelectorAll('.tc-tag'));
  var rects = words.map(function (w) { var b = w.getBoundingClientRect();
    return { name: w.querySelector('.tc-name').textContent, t: w.style.transform || '',
      l: b.left, t2: b.top, r: b.right, b2: b.bottom, pos: w.style.left + ',' + w.style.top }; });
  var moved = rects.filter(function (r) { return r.t !== ''; }).length;
  var overlaps = [];
  for (var i = 0; i < rects.length; i++) for (var j = i + 1; j < rects.length; j++) {
    var a = rects[i]; var c = rects[j];
    var ox = Math.min(a.r, c.r) - Math.max(a.l, c.l);
    var oy = Math.min(a.b2, c.b2) - Math.max(a.t2, c.t2);
    if (ox > 1.5 && oy > 1.5) overlaps.push(a.name + '×' + c.name);
  }
  var outside = rects.filter(function (r) {
    return r.l < cont.left - 1.5 || r.t2 < cont.top - 1.5 || r.r > cont.right + 1.5 || r.b2 > cont.bottom + 1.5; }).length;
  var hovered = ${HOVER_SEL};
  return { moved: moved, total: rects.length, overlaps: overlaps, outside: outside,
    hoveredClean: (hovered.style.transform || '') === '',
    innerMoved: moved > 0,
    positions: rects.map(function (r) { return r.pos; }).join('|') };
})()`);
ok('悬停时其余词让开（至少两枚发生了位移）',
  scatter.moved >= 2 && scatter.innerMoved === true, JSON.stringify(scatter).slice(0, 200));
ok('被悬停的那一枚自身不移位（交给 CSS 的 :hover 抬起）', scatter.hoveredClean === true);
ok('分散后仍不越界', scatter.outside === 0, 'outside=' + scatter.outside);
ok('分散后词之间仍不重叠', scatter.overlaps.length === 0, scatter.overlaps.join(' | '));
ok('分散只动 transform：left/top 逐字节不变（可逆、不累积漂移）',
  scatter.positions === cloud.sizes.map((s) => s.left + ',' + s.top).join('|'),
  'left/top 被改动了');

/* 鼠标移开 → 全部复位 */
await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
await sleep(500);
const reset = await js(`(function(){
  var words = Array.prototype.slice.call(document.querySelectorAll('#tagCloud .tc-tag'));
  return { dirty: words.filter(function (w) { return (w.style.transform || '') !== ''; }).length,
    positions: words.map(function (w) { return w.style.left + ',' + w.style.top; }).join('|') };
})()`);
ok('鼠标移开后所有位移复位（且 left/top 依然没变）',
  reset.dirty === 0 && reset.positions === cloud.sizes.map((s) => s.left + ',' + s.top).join('|'),
  JSON.stringify({ dirty: reset.dirty }));

/* 点抬头行的"全部"恢复完整列表 */
await js(`document.querySelector('#cloudAll').click(); true`);
await sleep(350);
const afterAll = await js(`(function(){
  return { cards: document.querySelectorAll('#postList .post-card').length,
    pressed: document.querySelectorAll('#tagCloud .tc-tag[aria-pressed="true"]').length,
    allText: document.querySelector('#cloudAll').getAttribute('aria-pressed'),
    count: document.querySelector('#filterCount').textContent,
    resetDisabled: document.querySelector('#filterReset').disabled,
    url: location.search };
})()`);
ok('点"全部"恢复完整列表', afterAll.cards === cloud.total && afterAll.count.indexOf('共') >= 0,
  JSON.stringify({ cards: afterAll.cards, total: cloud.total, count: afterAll.count }));
ok('"全部"为选中态、其余词都不选中', afterAll.allText === 'true' && afterAll.pressed === 0,
  JSON.stringify(afterAll));
ok('"全部"把 URL 也清干净了', afterAll.url === '', afterAll.url);
/* ------------------------------------------------------------
   E. 首屏（index.html）：入场隐藏、入水后淡入、不压其它角标
   ------------------------------------------------------------ */
section('E. 首屏统计条（index.html）');
await goto('/index.html', 1440, 900, 1500);
const entry = await js(`(function(){ var s = document.querySelector('[data-stats]');
  return { inWorld: s ? s.parentElement.id === 'world' : false, visible: s ? parseFloat(getComputedStyle(s).opacity) : -1,
    body: document.body.className }; })()`);
ok('首屏也有统计条，且挂在 .world 里', entry.inWorld === true);
ok('入场那一屏不显示（保持纯白）', entry.visible === 0, 'opacity=' + entry.visible);
await js(`document.getElementById('enterArrow').click(); true`);
await sleep(4200);
const settled = await js(`(function(){
  var s = document.querySelector('[data-stats]'); var r = function (el) { var b = el.getBoundingClientRect();
    return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  var ov = function (a, b) { var ox = Math.min(a.r, b.r) - Math.max(a.l, b.l); var oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
    return (ox > 0 && oy > 0) ? Math.round(ox * oy) : 0; };
  var sr = r(s);
  return { op: parseFloat(getComputedStyle(s).opacity),
    total: (s.querySelector('[data-stat="total"]') || {}).textContent,
    ovCredit: ov(sr, r(document.getElementById('credit'))),
    ovCmd: ov(sr, r(document.getElementById('cmdbar'))),
    ovDock: ov(sr, r(document.getElementById('dock'))),
    inside: sr.l >= 0 && sr.b <= innerHeight + 1 };
})()`);
ok('入水后统计条淡入', settled.op > 0.5, 'opacity=' + settled.op);
ok('首屏统计条有数字', /^\d[\d,]*$/.test(String(settled.total)), String(settled.total));
ok('不与署名 / 命令条 / 时钟重叠', settled.ovCredit === 0 && settled.ovCmd === 0 && settled.ovDock === 0,
  JSON.stringify(settled));
ok('仍在视口内', settled.inside === true);

/* ------------------------------------------------------------
   F. 响应式：12 种宽度 × 收起/展开
   ------------------------------------------------------------ */
section('F. 响应式（横向溢出与抽屉）');
const SIZES = [[1920, 1080], [1600, 900], [1440, 900], [1366, 768], [1280, 800],
  [1152, 700], [1024, 768], [980, 800], [820, 1180], [768, 1024], [430, 932], [390, 844], [360, 640]];
for (const page of ['/about.html', '/archive.html']) {
  await goto(page, 1440, 900);
  /* set 是幂等的：不依赖"上一次留在什么状态"，不然一条断言的副作用会污染下一段 */
  await js(`window.SiteShell.nav.set(true); true`);
  await sleep(400);
  const st0 = await probe();
  ok(page + ' 进入扫描前已确定处于收起态',
    st0.navState === 'collapsed' && Math.abs(st0.navW - 76) <= 2,
    JSON.stringify({ state: st0.navState, navW: st0.navW, storage: st0.storage }));
  let worst = 0; let worstAt = '';
  for (const [w, h] of SIZES) {
    await setSize(w, h);
    await sleep(220);
    const r = await js(`({ ov: document.documentElement.scrollWidth - window.innerWidth,
      ovBody: document.body.scrollWidth - window.innerWidth,
      navW: Math.round(document.querySelector('.nav').getBoundingClientRect().width),
      rail: getComputedStyle(document.querySelector('.nav-rail')).display,
      pl: Math.round(parseFloat(getComputedStyle(document.querySelector('.page')).paddingLeft)),
      state: document.documentElement.getAttribute('data-nav'),
      storage: (function () { try { return localStorage.getItem('p3.shell.nav'); } catch (e) { return 'ERR'; } })(),
      statsRow: document.querySelector('[data-stats]') ? Math.round(document.querySelector('[data-stats]').getBoundingClientRect().width) : -1 })`);
    if (r.ov > worst) { worst = r.ov; worstAt = w + '×' + h; }
    if (r.ov > 1 || r.ovBody > 1) console.log('       ! ' + w + '×' + h + ' overflow=' + r.ov + '/' + r.ovBody + ' navW=' + r.navW);
    if (w >= 981 && Math.abs(r.navW - 76) > 2) {
      console.log('       ! ' + w + '×' + h + ' 收起态 navW=' + r.navW + ' state=' + r.state + ' storage=' + r.storage);
    }
    if (w <= 980 && r.rail !== 'none') console.log('       ! ' + w + '×' + h + ' 抽屉档仍显示收起按钮');
  }
  ok(page + ' 收起态在 ' + SIZES.length + ' 种宽度下都不横向溢出', worst <= 1, 'worst=' + worst + ' @' + worstAt);
}
/* 抽屉档：MENU 仍然工作 */
await goto('/about.html', 390, 844);
await setSize(390, 844);
await sleep(300);
await js(`document.querySelector('.nav-toggle').click(); true`);
await sleep(400);
const drawer = await js(`(function(){ var l = document.querySelector('.nav-list');
  return { open: document.body.classList.contains('is-nav-open'), listVisible: getComputedStyle(l).display !== 'none',
    linkVisible: document.querySelector('.nav-link').getBoundingClientRect().height > 0,
    rail: getComputedStyle(document.querySelector('.nav-rail')).display,
    ov: document.documentElement.scrollWidth - window.innerWidth }; })()`);
ok('手机端抽屉照常工作，且收起按钮不出现',
  drawer.open && drawer.listVisible && drawer.linkVisible && drawer.rail === 'none' && drawer.ov <= 1,
  JSON.stringify(drawer));

/* ------------------------------------------------------------
   G. 两页视觉一致性：同一角色 → 同一计算值
   ------------------------------------------------------------
   需求里的"统一视觉风格"是可验证的：把两页里同一角色的元素抓出来，
   逐项比计算值。以前它们各写各的（12px vs 12.5px 这类），单看都正常，
   并排就不齐 —— 这一段就是盯这个。
   ------------------------------------------------------------ */
section('G. 两页视觉一致性（同一角色 → 同一计算值）');
const PARITY = [
  ['.page-kicker', ['fontSize', 'letterSpacing', 'color', 'fontStyle', 'fontWeight']],
  ['.page-title', ['fontSize', 'fontWeight', 'fontStyle', 'lineHeight']],
  ['.page-lead', ['fontSize', 'lineHeight', 'color']],
  ['.section-head', ['paddingBottom', 'borderBottomWidth']],
  ['.section-num', ['fontSize', 'color', 'letterSpacing']],
  ['.section-title', ['fontSize', 'fontWeight', 'fontStyle', 'textShadow']],
  ['.section-note', ['fontSize', 'letterSpacing', 'color']],
  ['.section-body', ['paddingTop']],
  ['.nav-brand-name', ['fontSize', 'fontWeight', 'fontStyle']],
  ['.nav-link', ['fontSize', 'fontWeight', 'fontStyle']],
  ['.foot', ['fontSize', 'letterSpacing', 'borderTopWidth', 'borderTopColor', 'paddingTop']],
  ['.stats', ['fontSize', 'letterSpacing', 'color', 'borderTopWidth']],
  ['.stats .stat-v', ['fontSize', 'color']],
  ['.skip', ['fontSize', 'backgroundColor']]
];
const readParity = async (page) => {
  await goto(page, 1440, 900);
  return js(`(function(){
    var pairs = ${JSON.stringify(PARITY)};
    var out = {};
    pairs.forEach(function (pair) {
      var el = document.querySelector(pair[0]);
      if (!el) { out[pair[0]] = 'MISSING'; return; }
      var cs = getComputedStyle(el); var o = {};
      pair[1].forEach(function (p) { o[p] = cs[p]; });
      out[pair[0]] = o;
    });
    return out;
  })()`);
};
const parityAbout = await readParity('/about.html');
const parityArchive = await readParity('/archive.html');
const parityDiff = Object.keys(parityAbout).filter((sel) =>
  JSON.stringify(parityAbout[sel]) !== JSON.stringify(parityArchive[sel]));
ok('15 组同一角色的计算样式在两页完全一致（字体 / 间距 / 颜色 / 发丝线）',
  parityDiff.length === 0,
  parityDiff.map((s) => s + ': about=' + JSON.stringify(parityAbout[s]) +
    ' archive=' + JSON.stringify(parityArchive[s])).join('\n       → '));
ok('两页都有统计条（由同一个部件注入，不靠各页自己写）',
  parityAbout['.stats'] !== 'MISSING' && parityArchive['.stats'] !== 'MISSING');

/* ------------------------------------------------------------
   H. 控制台错误 + 截图
   ------------------------------------------------------------ */
section('H. 控制台与截图');
const errs = consoleErrors();
ok('全过程没有 JS 报错', errs.length === 0, errs.slice(0, 4).join(' | '));
const net = netFails();
ok('全过程没有 4xx/5xx 资源（含图标 / 样式 / 脚本）', net.length === 0, net.slice(0, 6).join(' | '));

/* 截图前一律用 set() 明确状态：这些图是交付证据，
   不能受"上一段测试把状态留在哪里"影响（第一版就因此把两张图拍反了） */
await goto('/about.html', 1440, 1300);
await js(`window.SiteShell.nav.set(false); true`);
await sleep(500);
await shot('shell-about-expanded.png', 1440, 1300);
await js(`window.SiteShell.nav.set(true); true`);
await sleep(500);
await shot('shell-about-collapsed.png', 1440, 1300);
await goto('/about.html', 390, 1000);
await shot('shell-about-mobile.png', 390, 1000);

await goto('/archive.html', 1440, 1400);
await js(`window.SiteShell.nav.set(false); true`);
await sleep(500);
await shot('shell-archive-cloud.png', 1440, 1400);
await js(`window.SiteShell.nav.set(true); true`);
await sleep(500);
await shot('shell-archive-collapsed.png', 1440, 1400);
await js(`document.querySelector('#tagCloud .tc-tag[data-heat="hot"]').click(); true`);
await sleep(400);
await shot('shell-archive-filtered.png', 1440, 1100);
/* 悬停分散的留档：把鼠标停在最大的那枚词上再拍一张 */
const hov = await js(`(function(){ var t = document.querySelector('#tagCloud .tc-tag');
  t.scrollIntoView({ block: 'center', behavior: 'instant' });
  var b = t.getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
await sleep(300);
await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hov.x, y: hov.y });
await sleep(520);
await shot('shell-archive-hover.png', 1440, 1000);
await goto('/archive.html', 390, 1200);
await shot('shell-archive-mobile.png', 390, 1200);

await goto('/404.html', 1440, 760);
await js(`window.SiteShell.nav.set(true); true`);
await sleep(500);
/* 深水底是反过来的要求：图标必须是浅色（这一页没有"当前页"，不会踩白字那条） */
const railDark = await js(`(function () {
  var lum = function (c) { var m = c.match(/[\\d.]+/g) || [];
    return (Number(m[0]) * 0.299 + Number(m[1]) * 0.587 + Number(m[2]) * 0.072) / 255; };
  return Array.prototype.map.call(document.querySelectorAll('.nav-link .nl-ic svg'),
    function (s) { return Math.round(lum(getComputedStyle(s).stroke) * 100) / 100; });
})()`);
ok('深水底页（404）的图标是浅色（同一份外壳换皮肤后依然可读）',
  railDark.length === 3 && railDark.every((l) => l > 0.55), JSON.stringify(railDark));
await shot('shell-404-collapsed.png', 1440, 760);

console.log('\n站点外壳验证：' + pass + ' 通过 / ' + fail + ' 失败');
ws.close(); chrome.kill();
process.exit(fail ? 1 : 0);
