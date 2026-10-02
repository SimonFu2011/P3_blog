/* 审计：极简浅底页上是否还残留 pages.css 的深色底板 / 底色 / 边框圆角。
   判据：该元素（或伪元素）出现了非透明的 background-color，或者出现了
   不属于本次极简语言（hairline 之外）的边框与圆角。 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.SERVE_URL || 'http://127.0.0.1:8848';
const PORT = 9471;
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900',
  '--user-data-dir=D:\\DS\\.preview\\cp-audit', 'about:blank'
], { stdio: 'ignore' });
let ws, seq = 0; const pending = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify(s ? { id, method: m, params: p, sessionId: s } : { id, method: m, params: p }));
});
let v = null;
for (let i = 0; i < 60 && !v; i++) { await sleep(250); try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {} }
ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const js = async (x) => {
  const r = await S('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

const AUDIT = `(function(){
  /* 白名单 = 本次语言里"本来就该有底色/圆角"的元素：
     细胶囊（chip / view 切换 / 清空）、行悬停的极浅纸色（post-card / contact）、
     标记方块（skill-mark / skill-legend）、圆形图标框与头像框、提示条。
     其余任何深色或半透明底色都算"从 pages.css 漏过来的底板"。 */
  const ALLOW = ['chip', 'view-switch', 'view-btn', 'filter-reset', 'post-card', 'contact',
                 'skill-mark', 'skill-legend', 'contact-icon', 'avatar-frame', 'toast',
                 'mini-timeline', 'nav-toggle', 'empty', 'tl-month', 'post-card'];
  const isAllowed = (el) => {
    const cls = String(el.className || '');
    return ALLOW.some((a) => cls.split(/\\s+/).some((c) => c === a));
  };
  const bad = [];
  document.querySelectorAll('.main *, .foot *').forEach(function (el) {
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const alpha = bg.startsWith('rgba') ? parseFloat(bg.split(',')[3]) : 1;
    if (alpha > 0.02 && !isAllowed(el)) {
      const m = bg.match(/rgba?\\((\\d+), (\\d+), (\\d+)/);
      const dark = m && (Number(m[1]) + Number(m[2]) + Number(m[3])) < 240;
      if (dark || alpha < 0.98) bad.push('BG ' + el.tagName + '.' + el.className + ' → ' + bg);
    }
    /* 圆角 > 6px 且带可见边框 = 旧版卡片壳（胶囊类已在白名单里） */
    const br = parseFloat(cs.borderTopLeftRadius) || 0;
    if (br > 6 && parseFloat(cs.borderTopWidth) > 0 && !isAllowed(el)) {
      bad.push('CARD ' + el.tagName + '.' + el.className + ' → radius ' + br + 'px');
    }
    /* 投影：浅底极简语言里只允许提示条有 */
    if (cs.boxShadow !== 'none' && cs.boxShadow.indexOf('inset') < 0 && !isAllowed(el)) {
      bad.push('SHADOW ' + el.tagName + '.' + el.className + ' → ' + cs.boxShadow.slice(0, 56));
    }
    /* 位移：旧版悬停的 translateX 若漏过来，行会莫名其妙地抖 */
    if (cs.transform !== 'none' && el.matches('a, button') && !isAllowed(el)) {
      bad.push('TRANSFORM ' + el.tagName + '.' + el.className + ' → ' + cs.transform);
    }
  });
  return { count: bad.length, list: bad.slice(0, 30), vw: innerWidth, scrollW: document.documentElement.scrollWidth };
})()`;

/* 悬停态也要查：旧版 :hover 规则会盖上来 */
const HOVER = `(function(){
  const out = [];
  document.querySelectorAll('.post-card, .contact, .chip, .view-btn, .filter-reset, .tl-item').forEach(function (el) {
    el.classList.add('__probe-hover');
  });
  const s = document.createElement('style');
  s.textContent = '.__probe-hover { background: var(--g-paper) !important; }';
  document.head.appendChild(s);
  const a = document.querySelector('.post-card');
  if (a) out.push('post-card bg on hover-probe: ' + getComputedStyle(a).backgroundColor);
  const c = document.querySelector('.contact');
  if (c) out.push('contact transform: ' + getComputedStyle(c).transform);
  return out;
})()`;

for (const url of ['/about.html', '/archive.html', '/archive.html?view=timeline']) {
  await S('Page.navigate', { url: BASE + url });
  await sleep(1400);
  const r = await js(AUDIT);
  console.log('\n== ' + url + ' ==');
  console.log('  问题数 ' + r.count + '   scrollW ' + r.scrollW + ' / vw ' + r.vw);
  r.list.forEach((s) => console.log('   - ' + s));
  if (url === '/about.html') {
    (await js(HOVER)).forEach((s) => console.log('   hover: ' + s));
  }
}
ws.close(); chrome.kill(); process.exit(0);
