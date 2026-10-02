/* 移动端展开 + 触屏降级 + prefers-reduced-motion 三项体检 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9341;
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage', '--hide-scrollbars', '--window-size=430,932',
  '--user-data-dir=D:\\DS\\.preview\\cp-mobile', 'about:blank'
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
const js = async (x) => {
  const r = await S('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (n) => {
  const r = await S('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  fs.writeFileSync(`D:\\DS\\.preview\\${n}.png`, Buffer.from(r.data, 'base64'));
};

const fail = [];
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fail.push(m); };

await S('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 1, mobile: true });
await S('Page.navigate', { url: 'http://127.0.0.1:8848/index.html' });
await sleep(2500);
await js(`document.getElementById('enterArrow').click(); true`);
await sleep(3200);

console.log('\n[A] 移动端（430×932）：默认折叠 → 点击展开');
const c1 = await js(`document.getElementById('dock').classList.contains('is-collapsed')`);
ok(c1, '默认收成小钟按钮');
await js(`document.getElementById('dockToggle').click(); true`);
await sleep(800);
const mobile = await js(`(function(){
  var dock = document.getElementById('dock');
  var dial = document.getElementById('dial').getBoundingClientRect();
  var dr = dock.getBoundingClientRect();
  return {
    collapsed: dock.classList.contains('is-collapsed'),
    aria: document.getElementById('dockToggle').getAttribute('aria-expanded'),
    dial: Math.round(dial.width),
    dock: [Math.round(dr.left), Math.round(dr.top), Math.round(dr.right), Math.round(dr.bottom)],
    vw: innerWidth, vh: innerHeight,
    overflow: dr.left < -1 || dr.top < -1 || dr.right > innerWidth + 1 || dr.bottom > innerHeight + 1,
    rings: document.querySelectorAll('.dial-rings i').length,
    dropPE: getComputedStyle(document.getElementById('dialDrop')).pointerEvents
  };
})()`);
console.log('   ', JSON.stringify(mobile));
ok(!mobile.collapsed && mobile.aria === 'true', '点击后展开');
ok(mobile.dial >= 200 && mobile.dial <= 380, `展开后时钟 ${mobile.dial}px（窄屏档位）`);
ok(!mobile.overflow, '展开后不溢出 430×932 视口');
ok(mobile.rings === 4, '移动端同样有光圈');
await shot('dock-mobile-open');

console.log('\n[B] prefers-reduced-motion：倾斜 / 视差 / 光圈全停');
await S('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
});
await sleep(600);
const rm = await js(`(function(){
  var d = document.getElementById('dial');
  d.style.setProperty('--mx', '0.7');
  d.style.setProperty('--my', '0.5');
  var cs = function (s) { return getComputedStyle(document.querySelector(s)); };
  return {
    clock: cs('#dialClock').transform,
    vinyl: cs('#dialVinyl').transform,
    par: cs('#dialParallax').transform,
    ringAnim: cs('.dial-rings i').animationName,
    ringOpacity: cs('.dial-rings i').opacity,
    haloAnim: cs('.dial-halo').animationName
  };
})()`);
console.log('   ', JSON.stringify(rm));
ok(rm.clock === 'none' && rm.vinyl === 'none' && rm.par === 'none',
   '减少动态效果时不倾斜、不视差');
ok(rm.ringAnim === 'none' && parseFloat(rm.ringOpacity) === 0, '光圈动画停用且不可见');
await S('Emulation.setEmulatedMedia', { features: [] });
await sleep(400);

console.log('\n[C] ESC 后重新入水，功能仍正常（二次入水回归）');
await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
await sleep(1000);
const back = await js(`(function(){
  return { state: window.Boot.state,
           entryVisible: !document.getElementById('entry').classList.contains('is-hidden') };
})()`);
console.log('   ', JSON.stringify(back));
ok(back.state === 'entry' && back.entryVisible, 'ESC 回到入场页');
await js(`document.getElementById('enterArrow').click(); true`);
await sleep(3400);
const again = await js(`(function(){
  var dock = document.getElementById('dock');
  var collapsed = dock.classList.contains('is-collapsed');
  return {
    state: window.Boot.state,
    dockOn: dock.classList.contains('is-on'),
    collapsed: collapsed,
    dialW: Math.round(document.getElementById('dial').getBoundingClientRect().width),
    mx: document.getElementById('dial').style.getPropertyValue('--mx') || '0'
  };
})()`);
console.log('   ', JSON.stringify(again));
ok(again.state === 'settled' && again.dockOn, '再次入水后时钟重新点亮');
ok(again.collapsed ? again.dialW === 0 : again.dialW > 0,
   again.collapsed ? '窄屏下重新收起为小钟按钮（.dock-body 隐藏，尺寸为 0 属正常）'
                   : `时钟尺寸正常（${again.dialW}px）`);

console.log(fail.length ? `\n✗ ${fail.length} 项失败` : '\n✓ 全部通过');
ws.close(); chrome.kill();
process.exit(fail.length ? 1 : 0);
