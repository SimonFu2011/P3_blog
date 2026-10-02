/* 对比度实测：取页面头部区域的真实渲染像素，算最亮背景 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.env.PREVIEW_OUT || 'D:\\DS\\.preview';
const BASE = process.env.SERVE_URL || 'http://127.0.0.1:8848';
const PORT = 9441;
mkdirSync(OUT + '\\contrast', { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900',
  '--user-data-dir=' + OUT + '\\cp-contrast', 'about:blank'
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
await S('Page.navigate', { url: BASE + '/about.html' });
await sleep(1400);

/* 先把文字层隐掉：getImageData 拿到的是合成后的像素，
   白色的字形会被当成"很亮的背景"，把结论带偏（第一版 p95 直接是 0.93）。
   visibility:hidden 保留布局与背景，只去掉字形。 */
await js(`(function(){
  const s = document.createElement('style');
  s.textContent = '.page-head *, .nav *, .foot * { visibility: hidden !important; color: transparent !important; }' +
                  '.page-head, .nav, .foot { background-image: none !important; }';
  document.head.appendChild(s);
  return true;
})()`);
await sleep(260);

/* 直接用 canvas 采样？跨源没关系（同源）。更简单：把整页画到 canvas 上不行，
   所以改用 CDP 截图 + 在页面里用 createImageBitmap 解像素。 */
const r = await S('Page.captureScreenshot', { format: 'png' });
const b64 = r.data;
const res = await js(`(async function(){
  const bin = atob(${JSON.stringify(b64)});
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([arr], { type: 'image/png' }));
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cv.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const box = document.querySelector('.page-head').getBoundingClientRect();
  const x0 = Math.round(box.left), y0 = Math.round(box.top);
  const x1 = Math.min(bmp.width, Math.round(box.right)), y1 = Math.min(bmp.height, Math.round(box.bottom));
  const data = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data;
  /* 取该区域最亮的一批像素（排除文字本身：文字是暖白/彩色，这里只关心底色），
     做法是把像素按亮度分桶，取第 95 百分位作为"最亮的背景" */
  const lums = [];
  for (let i = 0; i < data.length; i += 4) {
    const r0 = data[i] / 255, g0 = data[i+1] / 255, b0 = data[i+2] / 255;
    const f = (c) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    lums.push(0.2126 * f(r0) + 0.7152 * f(g0) + 0.0722 * f(b0));
  }
  lums.sort((a, b) => a - b);
  const pick = (q) => lums[Math.min(lums.length - 1, Math.floor(lums.length * q))];
  const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
  return { box: [x0, y0, x1 - x0, y1 - y0], n: lums.length,
           p50: pick(.5), p80: pick(.8), p95: pick(.95), p99: pick(.99), mean: mean };
})()`);
const ratio = (fg, L) => {
  const srgb = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const hex = fg.replace('#', '');
  const n = parseInt(hex, 16);
  const l = 0.2126 * srgb(n >> 16 & 255) + 0.7152 * srgb(n >> 8 & 255) + 0.0722 * srgb(n & 255);
  return ((Math.max(l, L) + 0.05) / (Math.min(l, L) + 0.05));
};
console.log('page-head 区域:', JSON.stringify(res.box), '像素数', res.n);
console.log('背景亮度 中位', res.p50.toFixed(4), '80%', res.p80.toFixed(4), '95%', res.p95.toFixed(4), '99%', res.p99.toFixed(4));
console.log('\n文字色 vs 最亮背景(95%) 与中位背景:');
for (const [n, c] of [['--sky #38bdf8', '#38bdf8'], ['--sky-2 #7dd3fc', '#7dd3fc'], ['--red #ff1f3d', '#ff1f3d'], ['--red-2 #ff4257', '#ff4257'], ['--cyan-2 #7fe6ff', '#7fe6ff'], ['--white #ffffff', '#ffffff']]) {
  console.log('  ' + n.padEnd(18), 'p95:', ratio(c, res.p95).toFixed(2), ' p50:', ratio(c, res.p50).toFixed(2));
}

/* 采样点：.page-head 里几个"小字"所在的行，逐点取背景（含坐标便于定位） */
const probes = await js(`(async function(){
  const bin = atob(${JSON.stringify(b64)});
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([arr], { type: 'image/png' }));
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cv.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const out = [];
  const targets = [['kicker', '.page-kicker'], ['title', '.page-title'], ['lead', '.page-lead'],
                   ['section-title', '.section-title'], ['brand', '.nav-brand-name'], ['navlink', '.nav-link']];
  for (const [name, sel] of targets) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + 2), y = Math.round(r.top + r.height / 2);
    const row = ctx.getImageData(x, y, Math.min(80, bmp.width - x), 1).data;
    let maxL = 0;
    for (let i = 0; i < row.length; i += 4) {
      const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      const l = 0.2126 * f(row[i]) + 0.7152 * f(row[i+1]) + 0.0722 * f(row[i+2]);
      if (l > maxL) maxL = l;
    }
    out.push({ name: name, at: [x, y], bgLum: Number(maxL.toFixed(4)) });
  }
  return out;
})()`);
console.log('\n各元素所在行的最亮背景:');
for (const p of probes) {
  const r = (c, L) => {
    const srgb = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const n = parseInt(c.slice(1), 16);
    const l = 0.2126 * srgb(n >> 16 & 255) + 0.7152 * srgb(n >> 8 & 255) + 0.0722 * srgb(n & 255);
    return ((Math.max(l, L) + 0.05) / (Math.min(l, L) + 0.05)).toFixed(2);
  };
  console.log('  ' + p.name.padEnd(14), 'y=' + p.at[1], 'bgLum=' + p.bgLum,
    ' sky-2:', r('#7dd3fc', p.bgLum), ' sky:', r('#38bdf8', p.bgLum), ' white:', r('#ffffff', p.bgLum));
}
ws.close(); chrome.kill(); process.exit(0);
