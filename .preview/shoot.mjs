/* 干净截图：静止态 + 定点悬停态，用于肉眼定位合成问题 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = 'D:\\DS\\.preview';
const PORT = 9361;
mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900',
  '--user-data-dir=' + OUT + '\\cp-shot', 'about:blank'
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
const shot = async (name, clip) => {
  const r = await S('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
  writeFileSync(`${OUT}\\${name}.png`, Buffer.from(r.data, 'base64'));
};
await js(`document.getElementById('enterArrow').click(); true`);
await sleep(3400);

// 静止态（等入场动画彻底结束）
await sleep(1200);
const box = await js(`(function(){
  var r = document.getElementById('dial').getBoundingClientRect();
  return { x: Math.round(r.left) - 30, y: Math.round(r.top) - 30,
           width: Math.round(r.width) + 60, height: Math.round(r.height) + 60 };
})()`);
await shot('dial-rest', { ...box, scale: 1 });
console.log('rest box', JSON.stringify(box));

// 入场动画期间的抓拍：重置后再入水，在 400ms 处截
await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
await sleep(1200);
await js(`document.getElementById('enterArrow').click(); true`);
await sleep(3200 + 420);
await shot('dial-intro', { ...box, scale: 1 });
console.log('intro frame captured');

// 悬停到左下角（看倾斜时的厚度侧面）
const b = await js(`(function(){
  var r = document.getElementById('dial').getBoundingClientRect();
  return { left: r.left, top: r.top, w: r.width, h: r.height };
})()`);
await S('Input.dispatchMouseEvent', {
  type: 'mouseMoved', x: Math.round(b.left + b.w * 0.15), y: Math.round(b.top + b.h * 0.85), button: 'none'
});
await sleep(4200);
await shot('dial-tilt', { ...box, scale: 1 });
console.log('tilt frame captured');
ws.close(); chrome.kill(); process.exit(0);
