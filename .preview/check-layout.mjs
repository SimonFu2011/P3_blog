/* 布局体检：常见窗口尺寸下，时钟面板与扇形菜单 / 命令条 / 视口边界是否冲突 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9340;
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage', '--hide-scrollbars', '--window-size=1440,900',
  '--user-data-dir=D:\\DS\\.preview\\cp-layout', 'about:blank'
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

const sizes = [
  [1920, 1080], [1600, 900], [1440, 900], [1366, 768], [1280, 800],
  [1280, 720], [1152, 700], [1024, 768], [960, 600], [900, 640],
  [820, 1180], [768, 1024], [430, 932], [390, 844], [360, 640]
];

await S('Page.navigate', { url: 'http://127.0.0.1:8848/index.html' });
await sleep(2500);
await js(`document.getElementById('enterArrow').click(); true`);
await sleep(3200);

let bad = 0;
for (const [w, h] of sizes) {
  await S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(450);
  const r = await js(`(function(){
    var dock = document.getElementById('dock');
    var dial = document.getElementById('dial');
    var body = document.querySelector('.dock-body');
    var fan = document.getElementById('fan');
    var cmd = document.getElementById('cmdbar');
    var link = document.querySelector('.fan-item.is-out .fan-link') ||
               document.querySelector('.fan-link');
    var cs = getComputedStyle(dock);
    var collapsed = dock.classList.contains('is-collapsed');
    var R = function (el) { var b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
    var d = R(dock);
    var out = {
      collapsed: collapsed,
      dialVar: cs.getPropertyValue('--dial').trim(),
      dial: Math.round(d.w) - 26,   // 展开时 .dock 宽 = --dial + 26px
      dock: [Math.round(d.l), Math.round(d.t), Math.round(d.r), Math.round(d.b)],
      dockOverflow: d.l < -1 || d.t < -1 || d.r > innerWidth + 1 || d.b > innerHeight + 1,
      bodyHidden: getComputedStyle(body).display === 'none',
      fanVisible: getComputedStyle(fan).pointerEvents !== 'none',
      overlapFan: 0,
      overlapCmd: 0,
      overlapDialText: 0
    };
    // 时钟展开时：与扇形菜单条目、命令条的矩形是否相交
    if (!collapsed) {
      var dRects = [];
      ['.dial-clock', '.dial-rings', '.dial-parallax'].forEach(function (s) {
        var el = document.querySelector(s);
        if (el) dRects.push(R(el));
      });
      var fanItems = document.querySelectorAll('.fan-item');
      var maxOv = 0;
      for (var i = 0; i < fanItems.length; i++) {
        var fb = fanItems[i].getBoundingClientRect();
        if (fb.width === 0) continue;
        dRects.forEach(function (dr) {
          var ox = Math.min(dr.r, fb.right) - Math.max(dr.l, fb.left);
          var oy = Math.min(dr.b, fb.bottom) - Math.max(dr.t, fb.top);
          if (ox > 0 && oy > 0) maxOv = Math.max(maxOv, ox * oy);
        });
      }
      out.overlapFan = Math.round(maxOv);
      var cb = cmd.getBoundingClientRect();
      var maxC = 0;
      dRects.forEach(function (dr) {
        var ox = Math.min(dr.r, cb.right) - Math.max(dr.l, cb.left);
        var oy = Math.min(dr.b, cb.bottom) - Math.max(dr.t, cb.top);
        if (ox > 0 && oy > 0) maxC = Math.max(maxC, ox * oy);
      });
      out.overlapCmd = Math.round(maxC);
    }
    return out;
  })()`);
  const flag = (r.dockOverflow && !r.collapsed) ? '  <-- 溢出视口' : '';
  if (r.dockOverflow && !r.collapsed) bad++;
  if (r.dial === undefined || r.dial === null) console.log('    RAW:', JSON.stringify(r));
  const dialPx = (typeof r.dial === 'number' ? r.dial.toFixed(0) : String(r.dial));
  console.log(`${String(w).padStart(4)}x${String(h).padEnd(4)} dial=${dialPx.padStart(3)}px  dock=[${r.dock.join(',')}]` +
              `  collapsed=${r.collapsed ? 'Y' : 'n'} fanOverlap=${r.overlapFan} cmdOverlap=${r.overlapCmd}${flag}`);
}
console.log(bad ? `\n✗ ${bad} 个尺寸溢出` : '\n✓ 所有尺寸都不溢出视口');
ws.close(); chrome.kill(); process.exit(0);
