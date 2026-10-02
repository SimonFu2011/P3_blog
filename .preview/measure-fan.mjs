/* 量测扇形菜单：半径 / 字号 / 条目盒 / 与视口边界的余量 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.SERVE_URL || 'http://127.0.0.1:8848';
const PORT = 9388;
const W = Number(process.argv[2] || 1440), H = Number(process.argv[3] || 900);

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=' + W + ',' + H, '--user-data-dir=D:\\DS\\.preview\\cp-fan', 'about:blank'
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
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
};
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable');
await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
const js = async (x) => {
  const r = await S('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
await S('Page.navigate', { url: BASE + '/index.html' });
await sleep(1500);
await js(`document.getElementById('enterArrow').click(); true`);
/* 无头 Chrome 的动画时间轴被强节流（2.5s 后 fanOut 才走完 ~70%），
   靠 sleep 等"动画终态"是等不到的。这里直接把动画压到 0 时长，
   量的是静态几何 —— 正是 layout() 该保证的东西。 */
await sleep(3200);
/* 摘掉 fanOut 动画类，回到"基础 transform"（就是动画 100% 那一帧）再量。
   直接压 animation-duration 没用：类是内联加的、且动画带 forwards 填充。 */
await js(`(function(){
  document.querySelectorAll('.fan-item').forEach(function (li) {
    li.classList.remove('is-out', 'is-in');
    li.style.animationDelay = '';
  });
  return true;
})()`);
await sleep(500);

const out = await js(`(function(){
  const items = Array.from(document.querySelectorAll('.fan-item'));
  const rows = items.map(function (li) {
    const a = li.querySelector('.fan-link');
    const r = a.getBoundingClientRect();
    const cs = getComputedStyle(a);
    return {
      en: a.querySelector('.fi-en').textContent,
      fanRadius: getComputedStyle(li).getPropertyValue('--fan-radius').trim(),
      angle: getComputedStyle(li).getPropertyValue('--angle').trim(),
      fontSize: Math.round(parseFloat(cs.fontSize)),
      display: cs.display,
      w: Math.round(r.width), h: Math.round(r.height),
      left: Math.round(r.left), right: Math.round(r.right),
      top: Math.round(r.top), bottom: Math.round(r.bottom)
    };
  });
  const nav = document.getElementById('fan');
  const list = document.getElementById('fanList');
  const nb = nav.getBoundingClientRect(), lb = list.getBoundingClientRect();
  const ncs = getComputedStyle(nav);
  return {
    metrics: window.Menu.metrics,
    spread: getComputedStyle(nav).getPropertyValue('--spread').trim(),
    fontScale: getComputedStyle(nav).getPropertyValue('--font-scale').trim(),
    originX: getComputedStyle(nav).getPropertyValue('--fan-origin-x').trim(),
    fanLeft: ncs.left, fanTransform: ncs.transform,
    navBox: { left: Math.round(nb.left), right: Math.round(nb.right), top: Math.round(nb.top), bottom: Math.round(nb.bottom), w: Math.round(nb.width), h: Math.round(nb.height) },
    listBox: { left: Math.round(lb.left), right: Math.round(lb.right), top: Math.round(lb.top), bottom: Math.round(lb.bottom), w: Math.round(lb.width), h: Math.round(lb.height) },
    vw: innerWidth, vh: innerHeight,
    rows: rows
  };
})()`);
console.log(JSON.stringify(out, null, 2));

/* 蓝色高亮标出每条菜单项的实际盒 */
await js(`(function(){
  const s = document.createElement('style');
  s.textContent = '.fan-link{outline:1px dashed #00ff88 !important}';
  document.head.appendChild(s);
  return true;
})()`);
const margins = out.rows.map((r) => out.vw - r.right);
console.log('\n右余量逐条 =', JSON.stringify(margins), ' 最小 =', Math.min(...margins));
console.log('越界条数 =', margins.filter((m) => m < 0).length);
/* 与左侧时钟面板的重叠检查（水平区间相交 + 垂直区间相交才算真重叠） */
console.log('与 dock 的水平间隙 =', await js(`(function(){
  const dock = document.querySelector('.dock');
  if (!dock) return null;
  const d = dock.getBoundingClientRect();
  const links = Array.from(document.querySelectorAll('.fan-link')).map(a => a.getBoundingClientRect());
  return Math.round(Math.min.apply(null, links.map(r => r.left)) - d.right);
})()`));
ws.close(); chrome.kill(); process.exit(0);
