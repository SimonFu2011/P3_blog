/* 抓入场动画序列：点亮后每 150ms 一张，肉眼确认"夸张"程度 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = 'D:\\DS\\.preview\\intro';
const PORT = 9369;
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900',
  '--user-data-dir=' + OUT + '\\cp', 'about:blank'], { stdio: 'ignore' });
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

const clip = await js(`(function(){
  var r = document.getElementById('dock').getBoundingClientRect();
  return { x: Math.max(0, Math.round(r.left) - 60), y: Math.max(0, Math.round(r.top) - 60),
           width: Math.round(r.width) + 120, height: Math.round(r.height) + 120 };
})()`);
console.log('clip', JSON.stringify(clip));

await js(`document.getElementById('enterArrow').click(); true`);
// 坠落 2400ms + 点亮延迟 200ms
await sleep(2620);
for (let i = 0; i < 10; i++) {
  const r = await S('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
  writeFileSync(`${OUT}\\f${i}.png`, Buffer.from(r.data, 'base64'));
  const state = await js(`(function(){
    var d = document.getElementById('dock');
    var cs = getComputedStyle(d);
    return { first: d.classList.contains('is-first'), scale: cs.scale, rotate: cs.rotate,
             clockFilter: getComputedStyle(document.getElementById('dialClock')).filter.slice(0, 40) };
  })()`);
  console.log(`f${i}:`, JSON.stringify(state));
  await sleep(90);
}
ws.close(); chrome.kill(); process.exit(0);
