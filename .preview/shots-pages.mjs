/* 细节截图：代码块 / 引用 / 配图 / 联系方式 / 时间线 / 移动端 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.env.PREVIEW_OUT || 'D:\\DS\\.preview';
const BASE = process.env.SERVE_URL || 'http://127.0.0.1:8848';
const PORT = 9421;
mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900',
  '--user-data-dir=' + OUT + '\\cp-detail', 'about:blank'
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
const setSize = (w, h, mobile) => S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile });
const js = async (x) => {
  const r = await S('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const goto = async (url, ms = 1100) => { await S('Page.navigate', { url: BASE + url }); await sleep(ms); };
const shot = async (name) => {
  const r = await S('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}\\${name}.png`, Buffer.from(r.data, 'base64'));
  console.log('  saved ' + name);
};
/* 滚到某个选择器处并截图 */
const shotAt = async (sel, name, offset) => {
  const ok = await js(`(function(){
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    const y = el.getBoundingClientRect().top + window.scrollY - ${offset || 120};
    window.scrollTo(0, Math.max(0, y));
    return true;
  })()`);
  if (!ok) { console.log('  SKIP ' + name + ' (' + sel + ' 不存在)'); return; }
  await sleep(320);
  await shot(name);
};

await setSize(1440, 900, false);

console.log('article 细节:');
await goto('/article.html?slug=water-entry');
await shotAt('#articleBody pre', 'detail-code', 180);
await shotAt('#articleBody figure', 'detail-figure', 200);
await shotAt('#articleBody blockquote', 'detail-quote', 260);
await shotAt('.comments-box', 'detail-comments', 180);
await shotAt('#postNav', 'detail-postnav', 260);

console.log('about 细节:');
await goto('/about.html');
await shotAt('.contact-list', 'detail-contact', 200);
await shotAt('.mini-timeline', 'detail-path', 240);

console.log('archive 未筛选 + 时间线:');
await goto('/archive.html');
await shot('detail-archive-clean');
await goto('/archive.html?view=timeline');
await shot('detail-archive-timeline');
await js(`window.scrollTo(0, 420); true`);
await sleep(300);
await shot('detail-archive-timeline-2');

console.log('文章不存在（软 404）:');
await goto('/article.html?slug=nope');
await shot('detail-article-404');

console.log('移动端细节:');
await setSize(390, 844, true);
await goto('/archive.html');
await shot('detail-m-archive');
await goto('/article.html?slug=water-entry');
await shotAt('#articleBody pre', 'detail-m-code', 120);
await goto('/about.html');
await shotAt('.contact-list', 'detail-m-contact', 160);
await js(`document.querySelector('.nav-toggle').click(); true`);
await sleep(300);
await shot('detail-m-drawer');
await goto('/404.html');
await shot('detail-m-404');

console.log('窄屏主界面:');
await goto('/index.html', 1500);
await js(`document.getElementById('enterArrow').click(); true`);
await sleep(2600);
await shot('detail-m-index');

ws.close(); chrome.kill(); process.exit(0);
