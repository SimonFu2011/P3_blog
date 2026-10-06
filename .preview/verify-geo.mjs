/* ============================================================
   极简几何页的视觉体检（关于我 / 博客文章）
   ------------------------------------------------------------
   功能断言在 verify-pages.mjs 里；这里只管"看起来对不对"：
     · 白底页上不该残留深水底版本的深色底板 / 卡片壳 / 投影
     · 悬停不该有旧版遗留的位移
     · 首屏标题确实够大、几何 SVG 确实渲染
     · 浅底上的文字色对比度（用真实渲染像素算）
     · 4 种宽度下的横向溢出
   用法：node .preview/serve.mjs  然后  node .preview/verify-geo.mjs
   ============================================================ */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.env.PREVIEW_OUT || 'D:\\DS\\.preview';
const BASE = process.env.SERVE_URL || 'http://127.0.0.1:8848';
const PORT = 9481;
mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900',
  '--user-data-dir=' + OUT + '\\cp-geo', 'about:blank'
], { stdio: 'ignore' });
let ws, seq = 0; const pending = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify(s ? { id, method: m, params: p, sessionId: s } : { id, method: m, params: p }));
});
let v = null;
for (let i = 0; i < 60 && !v; i++) { await sleep(250); try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {} }
if (!v) { console.error('chrome 没起来'); process.exit(1); }
ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') events.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') events.push('[console.error] ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    /* /api/auth/me 与 /api/stats/hit 的 404 是**预期内**的：前者是右上角登录
       入口探一次会话，后者是访问统计计数，而静态预览（.preview/serve.mjs）
       根本没有 /api —— 真机上由 p3-public 应答。
       只允许这两条（且必须带 404），别的 4xx/5xx 仍然算错
       （verify-shell.mjs 里有同规则的完整版，并且会把 4xx 的 URL 打出来）。
       注意：日志文本里没有地址，要判 entry.url 这个字段。 */
    const url = m.params.entry.url || '';
    if (!(/\/api\/(auth\/me|stats\/hit)\b/.test(url) && /404/.test(m.params.entry.text))) {
      events.push('[log] ' + m.params.entry.text + (url ? ' @ ' + url : ''));
    }
  }
};
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable');
const setSize = (w, h, mobile) => S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile });
await setSize(1440, 900, false);
const js = async (x) => {
  const r = await S('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const goto = async (url, ms = 1200) => { events.length = 0; await S('Page.navigate', { url: BASE + url }); await sleep(ms); };
const shot = async (name) => {
  const r = await S('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}\\${name}.png`, Buffer.from(r.data, 'base64'));
};

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

/* 深色底板 / 卡片壳 / 投影审计 */
const AUDIT = `(function(){
  /* 放行三类"看着像但其实是设计"的情况：
     1) 白名单里的组件（细胶囊 / 标记方块 / 圆形图标框 / 行悬停的极浅纸色）
     2) 底色正好等于调色板中的某个设计令牌 —— 红色斜条、青色圆环、mark 方块
     3) 面积很小的元素（< 200px²）—— 细线、方点、斜条都不构成"底板" */
  const ALLOW = ['chip', 'view-switch', 'view-btn', 'filter-reset', 'post-card', 'contact',
                 'skill-mark', 'skill-legend', 'contact-icon', 'avatar-frame', 'toast',
                 'mini-timeline', 'nav-toggle', 'empty', 'tl-month', 'nt-bars',
                 'is-sub', 'is-core', 'is-know'];
  const PALETTE = ['rgb(255, 31, 61)', 'rgb(2, 132, 199)', 'rgb(56, 189, 248)',
                   'rgb(7, 21, 35)', 'rgb(11, 52, 70)', 'rgb(200, 16, 46)', 'rgb(11, 106, 151)',
                   'rgb(247, 251, 254)', 'rgb(238, 247, 252)', 'rgb(255, 255, 255)'];
  const isAllowed = (el) => String(el.className || '').split(/\\s+/).some((c) => ALLOW.indexOf(c) >= 0);
  const bad = [];
  document.querySelectorAll('.main *, .foot *, .nav *').forEach(function (el) {
    if (el.tagName === 'BODY' || el.tagName === 'HTML') return;
    if (isAllowed(el)) return;
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const alpha = bg.startsWith('rgba') ? parseFloat(bg.split(',')[3]) : 1;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (alpha > 0.02 && PALETTE.indexOf(bg) < 0) {
      const m = bg.match(/rgba?\\((\\d+), (\\d+), (\\d+)/);
      const dark = m && (Number(m[1]) + Number(m[2]) + Number(m[3])) < 240;
      /* "底板"= 有实际面积 + 非令牌色 + 深色或半透明 */
      if (area >= 200 && (dark || alpha < 0.98)) {
        bad.push('BG ' + el.tagName + '.' + el.className + ' → ' + bg + ' (' + Math.round(area) + 'px²)');
      }
    }
    const br = parseFloat(cs.borderTopLeftRadius) || 0;
    if (br > 6 && parseFloat(cs.borderTopWidth) > 0 && area >= 2000) bad.push('CARD ' + el.tagName + '.' + el.className);
    if (cs.boxShadow !== 'none' && cs.boxShadow.indexOf('inset') < 0 && area >= 2000) bad.push('SHADOW ' + el.tagName + '.' + el.className);
  });
  return bad;
})()`;

/* ------------------------------------------------------------
   1. 页面底色与标题
   ------------------------------------------------------------ */
for (const [url, name] of [['/about.html', '关于我'], ['/archive.html', '博客文章']]) {
  console.log('\n== ' + name + ' ' + url + ' ==');
  await goto(url);
  ok('无脚本错误', events.length === 0, events);

  const r = await js(`(function(){
    const title = document.querySelector('.page-title');
    const k = document.querySelector('.page-kicker');
    const h1 = document.querySelector('.hero h1') || document.querySelector('h1');
    const svg = document.querySelector('.hero-geo svg');
    const geoShapes = svg ? svg.querySelectorAll('circle, rect, line, path').length : 0;
    const cs = getComputedStyle(document.body);
    return {
      bodyBg: cs.backgroundColor,
      titleSize: Math.round(parseFloat(getComputedStyle(title).fontSize)),
      /* 计算值形如 "rgba(...) -2px -2px 0px, rgba(...) 3px 3px 0px" —— 按 "px," 数层，
         不能按 ")," 切（那是 getComputedStyle 的括号写法，不是分隔符） */
      titleShadow: (getComputedStyle(title).textShadow.match(/px,/g) || []).length + 1,
      titleColor: getComputedStyle(title).color,
      kickerColor: getComputedStyle(k).color,
      h1Count: document.querySelectorAll('h1').length,
      svgBox: svg ? Math.round(svg.getBoundingClientRect().width) : 0,
      geoShapes: geoShapes,
      leadColor: getComputedStyle(document.querySelector('.page-lead')).color,
      leadBg: getComputedStyle(document.querySelector('.page-lead')).backgroundColor
    };
  })()`);
  ok('页面是白底', r.bodyBg === 'rgb(255, 255, 255)', r);
  ok('整页只有一个 h1', r.h1Count === 1, r);
  ok('首屏标题够大（>90px @1440）', r.titleSize > 90, r);
  ok('标题带红/青两层叠印', r.titleShadow >= 2, r);
  ok('几何 SVG 已渲染且图形 ≥ 10 个', r.svgBox > 200 && r.geoShapes >= 10, r);
  ok('导语没有底色块', r.leadBg === 'rgba(0, 0, 0, 0)', r);

  const bad = await js(AUDIT);
  ok('无深色底板 / 卡片壳 / 投影残留', bad.length === 0, bad.slice(0, 8));

  const o = await js(`({ vw: document.documentElement.clientWidth, scrollW: document.documentElement.scrollWidth,
                        de: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 })`);
  ok('1440 无横向滚动', o.de === false, o);

  /* 悬停态：只看"最后生效的那条 transform"，而不是"有没有声明"。
     pages.css 里还躺着 .post-card:hover{translateX(5px)} 这类声明 ——
     geo.css 以同优先级 + 后加载覆盖成 none，那些声明已经无效；
     所以要按 CSSOM 顺序取最后一条命中该元素的 :hover transform 再判值。
     ::before 上的 scaleY 属于本语言（红竖线长出来），不计入。 */
  const hov = await js(`(function(){
    const targets = ['.post-card', '.contact', '.tl-item', '.chip', '.filter-reset', '.view-btn', '.nav-link'];
    const out = [];
    targets.forEach(function (sel) {
      const el = document.querySelector(sel);
      if (!el) return;
      let winner = null;
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
        for (const rule of rules) {
          const s = rule.selectorText;
          if (!s || s.indexOf(':hover') < 0 || s.indexOf('::') >= 0 || !rule.style) continue;
          const base = s.replace(/:hover/g, '');
          let hit = false;
          try { hit = base.split(',').some((part) => part.trim() && el.matches(part.trim())); } catch (e) { hit = false; }
          if (!hit) continue;
          const t = rule.style.transform;
          if (t) winner = { sel: s, transform: t };
        }
      }
      if (winner && winner.transform !== 'none') {
        /* .nav-link:hover 的 translateX(.06em) 是本次语言里的"轻微右移"，
           不是遗留 —— 真正要拦的是 px 级的横向位移（旧卡片那套 4~5px）。 */
        const em = /translateX\\(\\s*-?[\\d.]+em\\s*\\)/.test(winner.transform);
        const px = /translateX\\(\\s*-?[\\d.]+px\\s*\\)/.test(winner.transform);
        if (!em || px) out.push(winner.sel + ' → ' + winner.transform);
      }
    });
    return out;
  })()`);
  ok('没有遗留的悬停位移', hov.length === 0, hov);
}

/* ------------------------------------------------------------
   2. 浅底文字对比度（用真实渲染像素算背景）
   ------------------------------------------------------------ */
console.log('\n== 对比度（真实像素） ==');
await goto('/about.html');
await js(`(function(){
  const s = document.createElement('style');
  s.textContent = '.main *, .foot *, .nav * { visibility: hidden !important; }';
  document.head.appendChild(s);
  return true;
})()`);
await sleep(240);
{
  const cap = await S('Page.captureScreenshot', { format: 'png' });
  const b64 = cap.data;
  const res = await js(`(async function(){
    const bin = atob(${JSON.stringify(b64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([arr], { type: 'image/png' }));
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    /* 采样正文区域（避开装饰 SVG 与网格线的交点也问题不大：只取最亮的那批） */
    const d = ctx.getImageData(440, 100, 700, 700).data;
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const lums = [];
    for (let i = 0; i < d.length; i += 4) lums.push(0.2126 * f(d[i]) + 0.7152 * f(d[i+1]) + 0.0722 * f(d[i+2]));
    lums.sort((a, b) => a - b);
    const pick = (q) => lums[Math.min(lums.length - 1, Math.floor(lums.length * q))];
    return { p50: pick(.5), p90: pick(.9), p99: pick(.99), n: lums.length };
  })()`);
  const ratio = (fg, L) => {
    const srgb = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const n = parseInt(fg.slice(1), 16);
    const l = 0.2126 * srgb(n >> 16 & 255) + 0.7152 * srgb(n >> 8 & 255) + 0.0722 * srgb(n & 255);
    return (Math.max(l, L) + 0.05) / (Math.min(l, L) + 0.05);
  };
  console.log('  正文区背景亮度：中位 ' + res.p50.toFixed(4) + ' / 90% ' + res.p90.toFixed(4) + ' / 99% ' + res.p99.toFixed(4));
  const worst = Math.max(res.p50, 0);
  const checks = [
    ['--g-ink #071523 正文', '#071523', 4.5],
    ['--g-teal #0b3446 次要正文', '#0b3446', 4.5],
    ['--g-teal-2 #14536b 三级文字', '#14536b', 4.5],
    ['--g-cyan-dk #0b6a97 小标签', '#0b6a97', 4.5],
    ['--g-red-dk #c8102e 红色文字', '#c8102e', 4.5],
    ['--g-mute #5b7284 注释小字', '#5b7284', 4.5]
  ];
  for (const [label, color, need] of checks) {
    const rr = ratio(color, worst);
    ok(label + ' ≥ ' + need + ':1（实测 ' + rr.toFixed(2) + ':1）', rr >= need, { bg: worst });
  }
  await shot('geo-contrast-stripped');
}
await goto('/about.html');
await shot('geo-about-desktop');
await goto('/archive.html');
await shot('geo-archive-desktop');

/* ------------------------------------------------------------
   3. 多宽度溢出体检
   ------------------------------------------------------------ */
console.log('\n== 多宽度 ==');
for (const [w, h, mobile, tag] of [[1920, 1080, false, '1920'], [1440, 900, false, '1440'],
                                   [1180, 820, false, '1180'], [1024, 800, false, '1024'],
                                   [820, 900, true, '820'], [390, 844, true, '390'], [360, 780, true, '360']]) {
  await setSize(w, h, mobile);
  for (const url of ['/about.html', '/archive.html', '/archive.html?view=timeline']) {
    await goto(url, 1000);
    const o = await js(`(function(){
      const vw = document.documentElement.clientWidth;
      const inScroller = function (el) {
        let p = el.parentElement;
        while (p && p !== document.body) {
          const cs = getComputedStyle(p);
          if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') return true;
          p = p.parentElement;
        }
        return false;
      };
      const bad = [];
      document.querySelectorAll('body *').forEach(function (el) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if ((r.right > vw + 1.5 || r.left < -1.5) && !inScroller(el)) {
          bad.push(el.tagName + '.' + el.className + ' L' + Math.round(r.left) + ' R' + Math.round(r.right));
        }
      });
      return { vw: vw, scrollW: document.documentElement.scrollWidth, bad: bad.slice(0, 6) };
    })()`);
    const short = url.replace('.html', '').replace('/archive?view=timeline', 'archive-timeline');
    ok(tag + ' ' + short + ' 无横向溢出', o.scrollW <= o.vw + 1 && o.bad.length === 0, o);
  }
  /* 小屏补两张图 */
  if (w === 390 || w === 820) {
    await goto('/about.html', 1000); await shot('geo-about-' + w);
    await goto('/archive.html', 1000); await shot('geo-archive-' + w);
  }
}
await setSize(1440, 900, false);
await goto('/archive.html?view=timeline');
await shot('geo-archive-timeline');

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
ws.close(); chrome.kill();
process.exit(fail ? 1 : 0);
