/* 量各层的实际盒子（相对方盒的百分比），诊断"黑胶盖满表盘"的问题 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9360;
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900',
  '--user-data-dir=D:\\DS\\.preview\\cp-measure', 'about:blank'
], { stdio: 'ignore' });

let ws, seq = 0; const pending = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify(s ? { id, method: m, params: p, sessionId: s } : { id, method: m, params: p }));
});
let v = null;
for (let i = 0; i < 60 && !v; i++) {
  await sleep(250);
  try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
}
ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: 'http://127.0.0.1:8848/index.html' });
await sleep(2500);
const js = async (x) => {
  const r = await S('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
await js(`document.getElementById('enterArrow').click(); true`);
await sleep(3400);

console.log(JSON.stringify(await js(`(function(){
  var d = document.getElementById('dial').getBoundingClientRect();
  var rel = function (sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var b = el.getBoundingClientRect();
    if (!b.width) return 'zero';
    return { w: +(b.width / d.width).toFixed(3), h: +(b.height / d.height).toFixed(3),
             dx: +((b.left + b.width/2 - d.left - d.width/2) / d.width).toFixed(3),
             dy: +((b.top + b.height/2 - d.top - d.height/2) / d.height).toFixed(3) };
  };
  return {
    dial: +d.width.toFixed(1),
    bplate: rel('.dial-bplate'),
    bezel: rel('.dial-bezel'),
    face: rel('.dial-face'),
    q1: rel('.dial-q1'),
    texture: rel('.dial-texture'),
    disc: rel('.vinyl-disc'),
    cover: rel('.vinyl-cover'),
    hour: rel('#dialHour'),
    min: rel('#dialMin')
  };
})()`, null, 1)));
ws.close(); chrome.kill(); process.exit(0);
