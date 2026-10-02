/* 强制倾斜到满值并抓拍：验证"能看到厚度与侧面"这个视觉目标 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = 'D:\\DS\\.preview';
const PORT = 9368;
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900',
  '--user-data-dir=' + OUT + '\\cp-tilt', 'about:blank'], { stdio: 'ignore' });
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
await S('Page.navigate', { url: 'http://127.0.0.1:8848/index.html' });
await sleep(2500);
const js = async (x) => { const r = await S('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const shot = async (name, box) => {
  const b = box || await js(`(function(){ var r = document.getElementById('dial').getBoundingClientRect();
    return { x: Math.round(r.left)-40, y: Math.round(r.top)-40, width: Math.round(r.width)+80, height: Math.round(r.height)+80 }; })()`);
  const r = await S('Page.captureScreenshot', { format: 'png', clip: { ...b, scale: 1 } });
  writeFileSync(`${OUT}\\${name}.png`, Buffer.from(r.data, 'base64'));
};
await js(`document.getElementById('enterArrow').click(); true`);
await sleep(4200);
await js(`(function(){
  var st = document.createElement('style');
  st.textContent = '.dial-clock{animation:none !important}';
  document.head.appendChild(st);
  var m = window.Dock._motion;
  m.hover = true; m.tx = 0.92; m.ty = 0.86; m.dx = 0.92; m.dy = 0.86;
  var d = document.getElementById('dial');
  d.classList.remove('is-idle'); d.classList.add('is-hover');
  d.style.setProperty('--mx', '0.92');
  d.style.setProperty('--my', '0.86');
  return true;
})()`);
await sleep(1500);
const tiltState = await js(`(function(){
  return {
    clock: getComputedStyle(document.getElementById('dialClock')).transform.slice(0, 70),
    vinyl: getComputedStyle(document.getElementById('dialVinyl')).transform.slice(0, 70),
    par: getComputedStyle(document.getElementById('dialParallax')).transform,
    mx: document.getElementById('dial').style.getPropertyValue('--mx')
  };
})()`);
console.log('tilt state:', JSON.stringify(tiltState));
await shot('page-tilt-max', { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
await shot('dial-tilt-max');
console.log('shot dial-tilt-max');

// 反向：鼠标到左上
await js(`(function(){
  var m = window.Dock._motion;
  m.tx = -0.9; m.ty = -0.85; m.dx = -0.9; m.dy = -0.85;
  var d = document.getElementById('dial');
  d.style.setProperty('--mx', '-0.9');
  d.style.setProperty('--my', '-0.85');
  return true;
})()`);
await sleep(1200);
await shot('dial-tilt-opposite');
console.log('shot dial-tilt-opposite');
ws.close(); chrome.kill(); process.exit(0);
