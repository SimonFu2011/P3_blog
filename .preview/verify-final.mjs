/* ============================================================
   收尾自检：覆盖主流脚本没碰到的边界
     · 超宽 2560 / 超窄 320
     · 矮窗口（700 高）+ 移动端抽屉展开
     · prefers-reduced-motion
     · 键盘可达性：Tab 顺序、跳转链接、focus-visible
     · 资源完整性：本地文件是否存在（头像 / 配图 / 图标）
     · 链接完整性：站内链接是否都指向真实文件
     · 文章详情与 404 未受极简皮肤影响（仍是深水底）
   用法：node .preview/serve.mjs 然后 node .preview/verify-final.mjs
   ============================================================ */
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.env.PREVIEW_OUT || 'D:\\DS\\.preview';
const ROOT = 'D:\\DS\\blog-enter';
const BASE = process.env.SERVE_URL || 'http://127.0.0.1:8848';
const PORT = 9501;

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900',
  '--user-data-dir=' + OUT + '\\cp-final', 'about:blank'
], { stdio: 'ignore' });
let ws, seq = 0; const pending = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify(s ? { id, method: m, params: p, sessionId: s } : { id, method: m, params: p }));
});
let v = null;
for (let i = 0; i < 60 && !v; i++) { await sleep(250); try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {} }
if (!v) { console.error('chrome 没起来'); process.exit(1); }
ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') events.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') events.push('[console.error] ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') events.push('[log] ' + m.params.entry.text);
};
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable');
const setSize = (w, h, mobile) => S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile });
await setSize(1440, 900, false);
const js = async (x) => {
  const r = await S('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const goto = async (url, ms = 1100) => { events.length = 0; await S('Page.navigate', { url: BASE + url }); await sleep(ms); };
const shot = async (name) => {
  const r = await S('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}\\${name}.png`, Buffer.from(r.data, 'base64'));
};

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const OVERFLOW = `(function(){
  const vw = document.documentElement.clientWidth;
  const inScroller = function (el) {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') return true;
      p = p.parentElement;
    }
    return false;
  };
  const bad = [];
  document.querySelectorAll('body *').forEach(function (el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if ((r.right > vw + 1.5 || r.left < -1.5) && !inScroller(el)) bad.push(el.tagName + '.' + el.className + ' R' + Math.round(r.right));
  });
  return { vw: vw, scrollW: document.documentElement.scrollWidth, bad: bad.slice(0, 6) };
})()`;

/* ============================================================
   1. 资源与链接完整性（纯文件系统检查，不依赖浏览器）
   ============================================================ */
console.log('\n== 静态资源与站内链接 ==');
{
  const pages = ['index.html', 'about.html', 'archive.html', 'article.html', '404.html'];
  const missing = [];
  const hrefs = new Set();
  for (const p of pages) {
    const html = readFileSync(join(ROOT, p), 'utf8');
    /* src / href 里的本地相对路径（跳过 #、http、mailto、data:） */
    const re = /(?:src|href)="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) {
      const url = m[1];
      if (/^(#|https?:|mailto:|data:)/.test(url)) continue;
      hrefs.add(url.split('?')[0]);
    }
  }
  for (const url of hrefs) {
    if (!existsSync(join(ROOT, url))) missing.push(url);
  }
  ok('所有本地 src/href 都指向真实文件（共 ' + hrefs.size + ' 个）', missing.length === 0, missing);

  /* 文章正文里引用的图片 */
  const posts = readFileSync(join(ROOT, 'js', 'posts.js'), 'utf8');
  const imgs = new Set();
  const re2 = /src=\\?"([^"\\]+\.(?:svg|png|jpg|webp))\\?"/g;
  let m2;
  while ((m2 = re2.exec(posts))) imgs.add(m2[1]);
  const missingImg = Array.from(imgs).filter((u) => !existsSync(join(ROOT, u)));
  ok('文章正文引用的配图都存在（共 ' + imgs.size + ' 张）', missingImg.length === 0, missingImg);

  /* 样式表之间不该有"已废弃"的联动：geo.css 只被两页引用 */
  const about = readFileSync(join(ROOT, 'about.html'), 'utf8');
  const archive = readFileSync(join(ROOT, 'archive.html'), 'utf8');
  const article = readFileSync(join(ROOT, 'article.html'), 'utf8');
  const e404 = readFileSync(join(ROOT, '404.html'), 'utf8');
  ok('about/archive 走"pages + geo"两层皮肤',
    /pages\.css/.test(about) && /geo\.css/.test(about) && /pages\.css/.test(archive) && /geo\.css/.test(archive));
  ok('article/404 保持深水底（不引 geo.css）',
    /pages\.css/.test(article) && !/geo\.css/.test(article) && /pages\.css/.test(e404) && !/geo\.css/.test(e404));

  /* 五个页面都必须显式声明编码，避免中文乱码 */
  const noCharset = pages.filter((p) => !/<meta charset="utf-8">/i.test(readFileSync(join(ROOT, p), 'utf8')));
  ok('五个页面都声明了 UTF-8', noCharset.length === 0, noCharset);

  /* 每个页面都要有唯一 h1、viewport、title */
  const badPages = pages.filter((p) => {
    const h = readFileSync(join(ROOT, p), 'utf8');
    const h1 = (h.match(/<h1[\s>]/g) || []).length;
    return h1 !== 1 || !/name="viewport"/.test(h) || !/<title>/.test(h);
  });
  ok('每页恰好一个 h1 + viewport + title', badPages.length === 0, badPages);
  /* 硬编码在 HTML 里的站点名必须与 js/data.js 的 SITE.name 一致：
     脚本没跑起来时（file:// 下脚本失败等）用户看到的就是这份兜底文案，
     两边不一致会让"没 JS 的 1 秒"里出现两个不同的站名。 */
  const dataJs = readFileSync(join(ROOT, 'js', 'data.js'), 'utf8');
  const siteName = (dataJs.match(/name:\s*'([^']+)'/) || [])[1];
  const drift = [];
  for (const p of pages) {
    const h = readFileSync(join(ROOT, p), 'utf8');
    /* 找所有"看起来像站名"的硬编码：data-site-name / f-brand 的内容 */
    const re = /data-site-name[^>]*>([^<]+)</g;
    let m;
    while ((m = re.exec(h))) {
      if (m[1].trim() !== siteName) drift.push(p + ': ' + m[1].trim() + ' ≠ ' + siteName);
    }
  }
  ok('HTML 兜底站名与 SITE.name 一致（' + siteName + '）', drift.length === 0, drift);
}

/* ============================================================
   2. 超宽 / 超窄
   ============================================================ */
console.log('\n== 边界宽度 ==');
for (const [w, h, mobile, tag] of [[2560, 1440, false, '2560'], [320, 720, true, '320']]) {
  await setSize(w, h, mobile);
  for (const url of ['/about.html', '/archive.html', '/archive.html?view=timeline', '/article.html?slug=water-entry', '/404.html']) {
    await goto(url, 1100);
    const o = await js(OVERFLOW);
    ok(tag + ' ' + url.replace(/\?.*/, '') + ' 无溢出', o.scrollW <= o.vw + 1 && o.bad.length === 0, o);
  }
  if (w === 2560) { await goto('/about.html', 1100); await shot('final-2560-about'); }
  if (w === 320) { await goto('/archive.html', 1100); await shot('final-320-archive'); }
}

/* ============================================================
   3. 矮窗口 + 抽屉展开
   ============================================================ */
console.log('\n== 矮窗口 900×560（移动端抽屉） ==');
await setSize(900, 560, true);
await goto('/about.html');
await js(`document.querySelector('.nav-toggle').click(); true`);
await sleep(360);
{
  const r = await js(`(function(){
    const nav = document.querySelector('.nav');
    const list = document.querySelector('.nav-list');
    const b = nav.getBoundingClientRect();
    const cs = getComputedStyle(nav);
    return { navBox: [Math.round(b.top), Math.round(b.height)], vh: innerHeight,
             canScroll: nav.scrollHeight > nav.clientHeight + 1,
             overflowY: cs.overflowY, listVisible: getComputedStyle(list).display !== 'none' };
  })()`);
  ok('抽屉展开后可滚动（矮窗口不会把菜单截断且无法访问）',
    r.listVisible && (r.canScroll || r.navBox[1] <= r.vh), r);
}
{
  const o = await js(OVERFLOW);
  ok('抽屉展开无横向溢出', o.scrollW <= o.vw + 1, o);
}
await shot('final-short-drawer');

/* ============================================================
   4. reduced-motion
   ============================================================ */
console.log('\n== prefers-reduced-motion ==');
await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await setSize(1440, 900, false);
for (const url of ['/about.html', '/archive.html', '/article.html?slug=water-entry']) {
  await goto(url, 900);
  const r = await js(`(function(){
    const bad = [];
    document.querySelectorAll('.main *, .page *').forEach(function (el) {
      const cs = getComputedStyle(el);
      const dur = parseFloat(cs.transitionDuration) || 0;
      const adur = parseFloat(cs.animationDuration) || 0;
      /* 阈值 0.15s：pages.css 的 reduced-motion 块把过渡统一压到 .12s
         （"可感知为瞬时"的经验值）。真正的失败是动画仍在跑整段时长。 */
      if (dur > 0.15 || adur > 0.15) bad.push(el.tagName + '.' + el.className + ' trans=' + dur + ' anim=' + adur);
    });
    return bad.slice(0, 5);
  })()`);
  ok(url.replace(/\?.*/, '') + ' reduced-motion 下无长过渡/动画', r.length === 0, r);
}
await S('Emulation.setEmulatedMedia', { features: [] });

/* ============================================================
   5. 键盘可达性
   ============================================================ */
console.log('\n== 键盘可达性 ==');
for (const [url, name] of [['/about.html', '关于我'], ['/archive.html', '博客文章'], ['/article.html?slug=water-entry', '文章详情']]) {
  await goto(url);
  const r = await js(`(function(){
    const focusables = Array.from(document.querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])'))
      .filter(function (el) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      });
    const first = document.querySelector('.skip');
    const skipFirst = focusables.length > 0 && focusables[0] === first;
    /* 触摸/指针尺寸：主要交互目标不小于 24×24 */
    const small = focusables.filter(function (el) {
      const b = el.getBoundingClientRect();
      return (b.width < 24 || b.height < 24) && !el.classList.contains('skip');
    }).map((el) => el.tagName + '.' + el.className + ' ' + Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height));
    return { count: focusables.length, skipFirst: skipFirst, small: small.slice(0, 6) };
  })()`);
  ok(name + ' 可聚焦元素 ≥ 8 且跳转链接排第一', r.count >= 8 && r.skipFirst, r);
  ok(name + ' 无过小的点击目标', r.small.length === 0, r.small);
}

/* ============================================================
   6. 主界面回归（菜单与首屏文案仍由 data.js 驱动）
   ============================================================ */
console.log('\n== 主界面 ==');
await goto('/index.html', 1400);
{
  const r = await js(`(function(){
    const cfg = window.SITE;
    return {
      title: document.title,
      wantTitle: 'ENTER — ' + cfg.name,
      entryName: document.querySelector('.entry-name').textContent,
      tagline: document.querySelector('.entry-tag').textContent,
      credit: document.querySelector('.credit').textContent,
      wantCredit: cfg.footer.replace('{year}', String(new Date().getFullYear())),
      menuCount: document.querySelectorAll('.fan-item').length,
      wantMenu: cfg.menu.length
    };
  })()`);
  ok('首屏文案来自 SITE', r.entryName === r.title.split(' — ')[1] && r.tagline.length > 0, r);
  ok('页面标题与署名由 SITE 生成', r.title === r.wantTitle && r.credit === r.wantCredit, r);
  ok('菜单条目数与 SITE.menu 一致', r.menuCount === r.wantMenu, r);
}

/* ============================================================
   7. 三个"入口"都能回到主界面
   ============================================================ */
console.log('\n== 回主界面路径 ==');
for (const url of ['/about.html', '/archive.html', '/article.html?slug=water-entry', '/404.html']) {
  await goto(url);
  const r = await js(`(function(){
    const back = document.querySelector('.nav-back');
    const brand = document.querySelector('.nav-brand');
    return { back: back ? back.getAttribute('href') : null, brand: brand ? brand.getAttribute('href') : null };
  })()`);
  ok(url.replace(/\?.*/, '') + ' 侧边栏有回主界面入口', r.back === 'index.html' && r.brand === 'index.html', r);
}

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
ws.close(); chrome.kill();
process.exit(fail ? 1 : 0);
