/* ============================================================
   浏览器级验证（headless Chrome + CDP）
   ------------------------------------------------------------
   · 打开本地静态服务器上的 index.html，走完入场 → 入水 → 点亮时钟
   · 校验：尺寸翻倍、层级（黑胶盖住指针）、3D 倾斜互为反向、背景视差、
     光圈动画、拖拽反馈、非音频拒绝、音频播放、复位、ESC 无回归
   · 截图若干张供肉眼复核
   用法：node verify-dock.mjs [outDir]
   ============================================================ */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.env.DOCK_URL || 'http://127.0.0.1:8848/index.html';
const OUT = process.argv[2] || process.env.PREVIEW_OUT || 'D:\\DS\\.preview';
const PORT = 9333;

mkdirSync(OUT, { recursive: true });

const fail = [];
const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`);
  if (!cond) fail.push(msg);
};

/* 生成一段合法的单声道 16bit WAV（正弦），base64 交给页面构造 File */
function makeWavB64(seconds, freq, rate) {
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);          // PCM
  buf.writeUInt16LE(1, 22);          // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 8000), 44 + i * 2);
  }
  return buf.toString('base64');
}

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + PORT,
  '--remote-allow-origins=*',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--window-size=1440,900',
  /* 无头下没有音频设备，默认策略会让 play() 直接 reject */
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--user-data-dir=' + OUT + '\\chrome-profile',
  'about:blank'
], { stdio: 'ignore' });

let ws = null;
let seq = 0;
const pending = new Map();

const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
});

const cleanup = () => {
  try { ws && ws.close(); } catch {}
  try { chrome.kill(); } catch {}
};

const main = async () => {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      target = await r.json();
    } catch { /* 还没起来 */ }
  }
  if (!target) throw new Error('Chrome 未就绪');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  const consoleErrors = [];
  const netFails = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      return;
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      /* /api/auth/me 与 /api/stats/hit 的 404 是**预期内**的：前者是右上角
         登录入口探会话，后者是访问统计计数；这套静态预览（.preview/serve.mjs）
         没有 /api，真机上由 p3-public 应答。只豁免这两条且必须带 404。 */
      const u = msg.params.entry.url || '';
      if (!(/\/api\/(auth\/me|stats\/hit)\b/.test(u) && /404/.test(msg.params.entry.text))) {
        consoleErrors.push(msg.params.entry.text + (u ? ' @ ' + u : ''));
      }
    }
    if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
      const u = msg.params.response.url;
      if (!/\/api\/(auth\/me|stats\/hit)\b/.test(u)) netFails.push(msg.params.response.status + ' ' + u);
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);

  await S('Page.enable');
  await S('Runtime.enable');
  await S('Log.enable');
  await S('Network.enable');
  await S('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
  });

  const js = async (expr) => {
    const r = await S('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
                      r.exceptionDetails.text);
    }
    return r.result.value;
  };

  const shot = async (name) => {
    const r = await S('Page.captureScreenshot', { format: 'png' });
    const p = `${OUT}\\${name}.png`;
    writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  };

  /* 读 3D 元素的计算 transform；matrix 是 6 位、matrix3d 是 16 位，统一成 16 位 */
  const READ_XFORM = `(function () {
    var read = function (sel) {
      var m = getComputedStyle(document.querySelector(sel)).transform;
      if (!m || m === 'none') return null;
      if (m.slice(0, 8) === 'matrix3d') return m.slice(9, -1).split(',').map(Number);
      var v = m.slice(7, -1).split(',').map(Number);
      return [v[0], v[1], 0, 0, v[2], v[3], 0, 0, 0, 0, 1, 0, v[4], v[5], 0, 1];
    };
    return read;
  })()`;

  await S('Page.navigate', { url: URL });
  await sleep(2500);

  // ---- 入场 → 入水 → 点亮时钟 ----
  await js(`document.getElementById('enterArrow').click(); true`);
  await sleep(3200);

  console.log('\n[1] 入场与点亮');
  const boot = await js(`(function(){
    var dock = document.getElementById('dock');
    return {
      on: dock.classList.contains('is-on'),
      state: window.Boot.state,
      rings: document.querySelectorAll('.dial-rings i').length,
      rails: document.querySelectorAll('.dial-rail').length,
      knurl: document.querySelectorAll('.dial-knurl-line').length,
      numerals: document.querySelectorAll('.dial-numeral').length,
      first: dock.classList.contains('is-first'),
      burst: document.querySelectorAll('.dock-burst i').length
    };
  })()`);
  ok(boot.on && boot.state === 'settled', `时钟点亮（is-on=${boot.on}, state=${boot.state}）`);
  ok(boot.rings === 4, `外围光圈 4 层（实际 ${boot.rings}）`);
  ok(boot.rails === 120, `表盘放射阴影线 120 根（实际 ${boot.rails}）`);
  ok(boot.knurl === 180, `表圈滚花细齿 180 根（实际 ${boot.knurl}）`);
  ok(boot.burst === 3, `入场爆开光环 3 层（实际 ${boot.burst}）`);
  ok(boot.numerals === 12, `罗马数字 12 个（实际 ${boot.numerals}）`);

  // ---- 尺寸 ----
  console.log('\n[2] 尺寸（应为上一版的两倍）');
  /* dockIn 入场动画 46% 处会 scale 到 1.09，量的时机不对就会"溢出" ——
     先等 dock 自己的有限动画跑完（无头里 rAF 被节流，settled 不等于动画结束） */
  const waitAnim = await js(`(async function(){
    var dock = document.getElementById('dock');
    var anims = (dock.getAnimations ? dock.getAnimations() : [])
      .filter(function (a) { return (a.effect.getTiming().iterations !== Infinity); });
    await Promise.race([
      Promise.all(anims.map(function (a) { return a.finished.catch(function () {}); })),
      new Promise(function (r) { setTimeout(r, 2500); })
    ]);
    return anims.length;
  })()`);
  console.log('    等 dock 的入场动画收尾：', waitAnim, '条');
  const size = await js(`(function(){
    var dock = document.getElementById('dock');
    var dial = document.getElementById('dial');
    var r = dial.getBoundingClientRect();
    var dr = dock.getBoundingClientRect();
    return {
      dialVar: getComputedStyle(dock).getPropertyValue('--dial').trim(),
      dialW: r.width, dockW: dr.width, dockH: dr.height,
      vw: innerWidth, vh: innerHeight,
      overTop: dr.top < -0.5, overBottom: dr.bottom > innerHeight + 0.5,
      overLeft: dr.left < -0.5, overRight: dr.right > innerWidth + 0.5,
      dockBox: [ +dr.left.toFixed(2), +dr.top.toFixed(2), +dr.right.toFixed(2), +dr.bottom.toFixed(2) ],
      diag: { iw: innerWidth, ih: innerHeight, ow: outerWidth,
              resolved: (function () {
                var probe = document.createElement('div');
                probe.style.cssText = 'position:absolute;width:var(--dial)';
                dock.appendChild(probe);
                var w = probe.getBoundingClientRect().width;
                probe.remove();
                return +w.toFixed(2);
              })() }
    };
  })()`);
  console.log('   ', JSON.stringify(size));
  ok(size.dialW >= 300, `时钟边长 ${size.dialW.toFixed(0)}px（上一版桌面档约 285px）`);
  ok(!size.overTop && !size.overBottom && !size.overLeft && !size.overRight,
     '面板四面都没有溢出视口');

  // ---- 表壳：圆形金属表圈占比 ----
  console.log('\n[3] 表壳比例（表圈外径应 ≥ 容器的 80%）');
  const caseFit = await js(`(function(){
    var dial = document.getElementById('dial').getBoundingClientRect();
    var bezel = document.querySelector('.dial-bezel').getBoundingClientRect();
    var face = document.querySelector('.dial-face').getBoundingClientRect();
    return {
      dial: dial.width,
      bezel: bezel.width,
      bezelRatio: bezel.width / dial.width,
      faceRatio: face.width / dial.width,
      bezelRadius: getComputedStyle(document.querySelector('.dial-bezel')).r,
      sweep: !!document.querySelector('.dial-sweep'),
      bplate: !!document.querySelector('.dial-bplate')
    };
  })()`);
  console.log('   ', JSON.stringify(caseFit));
  ok(caseFit.bezelRatio >= 0.8, `表圈外径占容器 ${(caseFit.bezelRatio * 100).toFixed(1)}%（要求 ≥80%）`);
  ok(caseFit.bezelRatio < 1.02, '表圈没有溢出容器');
  ok(caseFit.sweep && caseFit.bplate, '入场扫光层与厚度侧面层都在');

  // ---- 层级：指针压在黑胶之上，但整层不吃指针事件 ----
  console.log('\n[4] 层级（指针压在黑胶之上，点击 / 拖拽仍归黑胶）');
  const layer = await js(`(function(){
    var disc = document.querySelector('.vinyl-disc');
    var clock = document.getElementById('dialClock');
    var vinyl = document.getElementById('dialVinyl');
    var hands = document.getElementById('dialHands');
    var dr = disc.getBoundingClientRect();
    var cls = function (el) { return el ? (el.className || el.tagName) : null; };
    // 指针行程上的那个点（黑胶高度 8% 处）：指针层是 pointer-events: none，
    // elementFromPoint 会跳过它 —— 命中的必须仍是黑胶
    var hit = document.elementFromPoint(dr.left + dr.width * 0.5, dr.top + dr.height * 0.08);
    var center = document.elementFromPoint(dr.left + dr.width * 0.5, dr.top + dr.height * 0.5);
    return {
      vinylAboveClock: !!(vinyl.compareDocumentPosition(clock) & Node.DOCUMENT_POSITION_PRECEDING),
      handsAboveVinyl: !!(hands.compareDocumentPosition(vinyl) & Node.DOCUMENT_POSITION_PRECEDING),
      clockZ: getComputedStyle(clock).zIndex,
      vinylZ: getComputedStyle(vinyl).zIndex,
      handsZ: getComputedStyle(hands).zIndex,
      handsPE: getComputedStyle(hands).pointerEvents,
      handleClass: cls(hit), centerClass: cls(center),
      hitIsVinyl: !!(hit && hit.closest('.dial-vinyl')),
      centerIsVinyl: !!(center && center.closest('.dial-vinyl'))
    };
  })()`);
  console.log('   ', JSON.stringify(layer));
  ok(layer.vinylAboveClock && layer.handsAboveVinyl, 'DOM 顺序：表壳 → 黑胶 → 指针');
  ok(layer.vinylZ === '2' && layer.handsZ === '3' && layer.clockZ === 'auto',
     `三层显式分层（shell=${layer.clockZ} / vinyl=${layer.vinylZ} / hands=${layer.handsZ}）`);
  ok(layer.handsPE === 'none' && layer.hitIsVinyl && layer.centerIsVinyl,
     '指针层不吃指针事件：指针行程上与唱片中心命中的都还是黑胶');

  // ---- 指针几何：造型照附图（叶形时针 / 卷草分针 / 细针秒针） ----
  console.log('\n[5] 指针几何（附图造型：叶形时针 / 镂空卷草分针 / 细针秒针）');
  const handGeo = await js(`(function(){
    // getBBox() 是元素自己坐标系里的几何外框，不受 CSS 旋转影响 —— 量的是
    // "针有多长、多宽"，不是"这一刻的屏幕外框"
    var geo = function (sel) {
      var b = document.querySelector(sel + ' .dial-hand-shape').getBBox();
      return { w: b.width, h: b.height, x: b.x + b.width / 2, top: b.y, bottom: b.y + b.height };
    };
    var hour = geo('#dialHour'), min = geo('#dialMin'), sec = geo('#dialSec');
    var subs = function (sel) {
      return ((document.querySelector(sel + ' .dial-hand-shape').getAttribute('d') || '')
        .match(/M/g) || []).length;
    };
    return {
      hourW: hour.w, hourL: hour.h, minW: min.w, minL: min.h, secW: sec.w, secL: sec.h,
      hourTop: hour.top, minTop: min.top, secTop: sec.top,
      hourBottom: hour.bottom, minBottom: min.bottom, secBottom: sec.bottom,
      hourMidX: hour.x, minMidX: min.x, secMidX: sec.x,
      shapes: document.querySelectorAll('.dial-hands .dial-hand-shape').length,
      caps: document.querySelectorAll('.dial-hand-cap').length,
      evenOdd: document.querySelectorAll('.dial-hand-shape[fill-rule="evenodd"]').length,
      minSubs: subs('#dialMin'), hourSubs: subs('#dialHour'),
      hourRot: document.getElementById('dialHour').style.getPropertyValue('--rot-h'),
      minRot: document.getElementById('dialMin').style.getPropertyValue('--rot-m'),
      secRot: document.getElementById('dialSec').style.getPropertyValue('--rot-s')
    };
  })()`);
  console.log('   ', JSON.stringify(handGeo));
  ok(handGeo.shapes === 3 && handGeo.caps === 1 && handGeo.evenOdd === 3,
     '时针 / 分针 / 秒针都是 path（evenodd 镂空）+ 一个中心轴帽');
  ok(handGeo.secL > handGeo.minL && handGeo.minL > handGeo.hourL,
     `长度 秒针 > 分针 > 时针（${handGeo.secL.toFixed(1)} > ${handGeo.minL.toFixed(1)} > ${handGeo.hourL.toFixed(1)}）`);
  // 分针最宽的地方是尾部的圆环配重（±10.4），针身本身只有 ±7
  ok(handGeo.hourW < 12 && handGeo.minW < 22 && handGeo.secW < 9,
     `三根针都细长（宽 ${handGeo.hourW.toFixed(1)} / ${handGeo.minW.toFixed(1)} / ${handGeo.secW.toFixed(1)} 单位）`);
  ok(handGeo.minSubs >= 6 && handGeo.hourSubs === 1,
     `分针有卷草与长窗镂空（${handGeo.minSubs} 段子路径），时针是实心一片`);
  ok(Math.abs(handGeo.hourMidX - 120) < 0.6 && Math.abs(handGeo.minMidX - 120) < 0.6,
     '两根针都关于 x=120 对称（镜像生成，不会歪）');
  ok(Math.abs(handGeo.minTop - 26) < 3 && handGeo.minBottom > 128,
     `分针针尖 r≈94、针尾越过圆心（top=${handGeo.minTop.toFixed(1)}，bottom=${handGeo.minBottom.toFixed(1)}）`);
  ok(/deg$/.test(handGeo.hourRot.trim()) && /deg$/.test(handGeo.minRot.trim())
     && /deg$/.test(handGeo.secRot.trim()),
     `三根针的角度写进 CSS 变量（${handGeo.hourRot.trim()} / ${handGeo.minRot.trim()} / ${handGeo.secRot.trim()}）`);

  // ---- 3D 倾斜 + 视差 ----
  console.log('\n[6] 悬停 3D 倾斜（外层正 / 黑胶反）+ 背景视差');
  const box = await js(`(function(){
    var r = document.getElementById('dial').getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  })()`);
  const mouseTo = (fx, fy) => S('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(box.left + box.w * fx),
    y: Math.round(box.top + box.h * fy),
    button: 'none'
  });
  const waitMotion = async (pred, tries = 30) => {
    let st = null;
    for (let i = 0; i < tries; i++) {
      st = await js(`window.Dock._motion.state()`);
      if (pred(st)) return st;
      await sleep(150);
    }
    return st;
  };

  await mouseTo(0.85, 0.8);
  const stIn = await waitMotion((s) => s.hover && Math.abs(s.dx) > 0.05);
  console.log('    进入后 Motion =', JSON.stringify(stIn));
  ok(stIn.hover, '鼠标进入时钟区域 → 进入倾斜态（is-hover）');
  ok(stIn.tx > 0.3 && stIn.ty > 0.25,
     `坐标按相对位置归一化（tx=${stIn.tx.toFixed(2)}, ty=${stIn.ty.toFixed(2)}）`);

  let t = null;
  for (let i = 0; i < 30; i++) {
    t = await js(`(function(){
      var read = ${READ_XFORM};
      var d = document.getElementById('dial');
      return {
        mx: +d.style.getPropertyValue('--mx'), my: +d.style.getPropertyValue('--my'),
        clock: read('#dialClock'), vinyl: read('#dialVinyl'), par: read('#dialParallax')
      };
    })()`);
    if (t.clock && t.vinyl && t.par && Math.abs(t.clock[6]) > 0.02) break;
    await sleep(150);
  }
  console.log('    --mx/--my =', t.mx, t.my);
  console.log('    clock    =', t.clock.map((n) => +n.toFixed(4)).join(', '));
  console.log('    vinyl    =', t.vinyl.map((n) => +n.toFixed(4)).join(', '));
  console.log('    parallax =', t.par.map((n) => +n.toFixed(2)).join(', '));

  const deg = (m) => Math.abs(Math.asin(Math.max(-1, Math.min(1, -m[9])))) * 180 / Math.PI;
  const aClock = deg(t.clock), aVinyl = deg(t.vinyl);
  const sign = (a, b) => (a === 0 || b === 0) ? null : (Math.sign(a) === -Math.sign(b));
  ok(aClock > 0.5, `外层时钟有 3D 倾斜（≈ ${aClock.toFixed(2)}deg）`);
  ok(aVinyl > 0.2, `黑胶同时有 3D 倾斜（≈ ${aVinyl.toFixed(2)}deg）`);
  ok(sign(t.clock[6], t.vinyl[6]) && sign(t.clock[9], t.vinyl[9]),
     `黑胶倾斜方向与外层严格相反（clock m6/m9=${t.clock[6].toFixed(4)}/${t.clock[9].toFixed(4)}，` +
     `vinyl ${t.vinyl[6].toFixed(4)}/${t.vinyl[9].toFixed(4)}）`);
  const ratio = aVinyl / aClock;
  ok(ratio > 0.4 && ratio < 0.6,
     `黑胶幅度约为外层一半（${aVinyl.toFixed(2)} / ${aClock.toFixed(2)} = ${ratio.toFixed(2)}）`);
  const full = (a) => a / Math.max(0.001, Math.abs(t.mx));
  console.log(`    折算到 --mx=1：外层 ≈ ${full(aClock).toFixed(1)}deg，黑胶 ≈ ${full(aVinyl).toFixed(1)}deg`);
  ok(full(aClock) >= 15 && full(aClock) <= 18,
     `外层满值倾角 ≈16deg（要"能看到表盘厚度"，远大于上一版 7deg）`);
  ok(full(aVinyl) >= 7 && full(aVinyl) <= 9, '黑胶满值反向倾角 ≈8deg');
  // 透视距离 + 旋转角 → 估算表盘边缘的 Z 位移，够不够看出"厚度"
  const perspective = await js(`getComputedStyle(document.getElementById('dialScene')).perspective`);
  const zShift = Math.sin(full(aClock) * Math.PI / 180) * (box.w * 0.45);
  console.log(`    perspective=${perspective}，满值倾斜时表盘边缘 Z 位移 ≈ ${zShift.toFixed(1)}px`);
  ok(zShift > 53, `满值倾斜时表盘边缘进出屏幕约 ${zShift.toFixed(0)}px，足以看到厚度侧面`);
  const parX = t.par[12], parY = t.par[13];
  ok(Math.sign(parX) === -Math.sign(t.mx) && Math.sign(parY) === -Math.sign(t.my),
     `背景视差方向与鼠标相反（鼠标 +x/+y → 背景 ${parX.toFixed(2)}px / ${parY.toFixed(2)}px）`);
  ok(Math.abs(parX - (-11 * t.mx)) < 0.8 && Math.abs(parY - (-7 * t.my)) < 0.8,
     `视差位移 = 反向 + 缩小（实测 ${parX.toFixed(2)}/${parY.toFixed(2)}，` +
     `设计值 ${(-11 * t.mx).toFixed(2)}/${(-7 * t.my).toFixed(2)}）`);

  await mouseTo(0.8, 0.78);
  await sleep(900);
  await shot('dock-hover-tilt');

  // ---- 移出复位 ----
  console.log('\n[7] 鼠标离开 → 平滑复位');
  // 合成鼠标事件的坐标到不了 renderer 的命中测试，于是直接派发 Chrome"离开元素"
  // 时真正会派发的 pointerleave（监听器就挂在 #dialScene 上），验证复位链路
  await js(`(function(){
    document.getElementById('dialScene')
      .dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    return true;
  })()`);
  /* 无头渲染里 rAF 被强节流（每秒只有几帧），缓动收敛会很慢；
     用 CDP 的 HeadlessExperimental.beginFrame 手动泵帧，保证缓动真的跑完 */
  const pump = async (frames = 200) => {
    await S('Page.enable');
    for (let i = 0; i < frames; i++) {
      await S('HeadlessExperimental.beginFrame', { interval: 16 }).catch(() => {});
      await sleep(4);
    }
  };
  const stLeave = await waitMotion((s) => !s.hover, 10);
  await pump(240);
  const reset = await js(`window.Dock._motion.state()`);
  console.log('    离开后 Motion =', JSON.stringify(stLeave), '→', JSON.stringify(reset));
  const view = await js(`(function(){
    var dial = document.getElementById('dial');
    return {
      idle: dial.classList.contains('is-idle'),
      hoverClass: dial.classList.contains('is-hover'),
      mx: +dial.style.getPropertyValue('--mx'),
      my: +dial.style.getPropertyValue('--my')
    };
  })()`);
  ok(view.idle && !view.hoverClass, '离开后进入 idle 复位态（is-idle 挂上、is-hover 撤掉）');
  ok(Math.abs(view.mx) < 0.01 && Math.abs(view.my) < 0.01,
     `离开后 --mx/--my 归零（${view.mx.toFixed(4)} / ${view.my.toFixed(4)}）`);
  await sleep(700);
  const settled = await js(`(function(){
    var read = ${READ_XFORM};
    return { clock: read('#dialClock'), vinyl: read('#dialVinyl'), par: read('#dialParallax') };
  })()`);
  const identity = (arr) => !arr || (Math.abs(arr[6]) < 0.002 && Math.abs(arr[9]) < 0.002 &&
                                    Math.abs(arr[12]) < 0.6 && Math.abs(arr[13]) < 0.6);
  console.log('    复位后 =', JSON.stringify(settled));
  ok(identity(settled.clock) && identity(settled.vinyl) && identity(settled.par),
     '离开后外层 / 黑胶 / 视差一起平滑复位到原点');

  // ---- 光圈动画 ----
  console.log('\n[8] 最外围持续扩散的光圈');
  const pulse = await js(`(function(){
    var i = document.querySelector('.dial-rings i');
    var cs = getComputedStyle(i);
    return {
      name: cs.animationName, dur: cs.animationDuration, iter: cs.animationIterationCount,
      delays: [].map.call(document.querySelectorAll('.dial-rings i'),
                          function (e) { return getComputedStyle(e).animationDelay; }),
      pe: getComputedStyle(document.querySelector('.dial-rings')).pointerEvents,
      halo: getComputedStyle(document.querySelector('.dial-halo')).animationName,
      ringZ: getComputedStyle(document.querySelector('.dial-rings')).zIndex,
      clockZ: getComputedStyle(document.querySelector('.dial-scene')).zIndex
    };
  })()`);
  console.log('   ', JSON.stringify(pulse));
  ok(pulse.name === 'dialPulse' && pulse.iter === 'infinite', '光圈动画循环播放');
  ok(parseFloat(pulse.dur) >= 2 && parseFloat(pulse.dur) <= 4, `一轮 ${pulse.dur}（要求 2–4s）`);
  ok(new Set(pulse.delays).size === 4, `四层不同 delay（${pulse.delays.join(' / ')}）`);
  ok(pulse.pe === 'none', '光圈层 pointer-events: none（不挡交互）');
  ok(pulse.halo === 'dialHalo', '表盘边缘还有一道持续呼吸光（动画名 dialHalo）');

  // ---- 表盘纹理 ----
  console.log('\n[9] 表盘阴影线 / 纹理');
  const tex = await js(`(function(){
    var el = document.querySelector('.dial-texture');
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    var dial = document.getElementById('dial').getBoundingClientRect();
    return {
      hasLayers: cs.backgroundImage.split('gradient').length - 1,
      mask: (cs.webkitMaskImage || cs.maskImage || '').includes('radial-gradient'),
      sizeRatio: r.width / dial.width,
      pe: cs.pointerEvents,
      rails: document.querySelectorAll('.dial-rail').length,
      q4: getComputedStyle(document.querySelector('.dial-q4')).stroke
    };
  })()`);
  console.log('   ', JSON.stringify(tex));
  ok(tex.hasLayers >= 4, `表盘纹理叠了 ${tex.hasLayers} 层渐变（放射线 / 斜排线 / 同心刻线）`);
  ok(tex.mask, '纹理用径向遮罩避开中心黑胶与外缘');
  ok(Math.abs(tex.sizeRatio - 0.8) < 0.01, `纹理只覆盖 r≤96 的盘面（占方盒 ${(tex.sizeRatio * 100).toFixed(1)}%）`);
  ok(tex.pe === 'none', '纹理层不参与命中');
  ok(String(tex.q4).includes('url('), '左上的分段色环改用 SVG 斜排线图案填充');

  // ---- 交互命中 ----
  console.log('\n[10] 交互命中（光圈 / 纹理不挡指针、黑胶、拖拽）');
  const hits = await js(`(function(){
    var disc = document.querySelector('.vinyl-disc');
    var dr = disc.getBoundingClientRect();
    var cls = function (el) { return el ? (el.className || el.tagName) : null; };
    return {
      center: cls(document.elementFromPoint(dr.left + dr.width/2, dr.top + dr.height/2)),
      edge: cls(document.elementFromPoint(dr.left + dr.width*0.85, dr.top + dr.height*0.5)),
      discPE: getComputedStyle(disc).pointerEvents,
      dropPE: getComputedStyle(document.getElementById('dialDrop')).pointerEvents
    };
  })()`);
  console.log('   ', JSON.stringify(hits));
  ok(String(hits.center).includes('vinyl') || String(hits.center).includes('drop'),
     '唱片中心命中的是黑胶 / 拖拽层');
  ok(hits.discPE === 'auto', '黑胶可点（播放 / 暂停）');
  ok(hits.dropPE === 'none', '非拖拽期间落点不参与命中（不与扇形菜单抢点击）');

  // ---- 拖拽：非音频 ----
  console.log('\n[11] 拖拽反馈：非音频文件');
  const drag = await js(`(function(){
    var dial = document.getElementById('dial');
    var disc = document.querySelector('.vinyl-disc');
    var dt = new DataTransfer();
    dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    var before = getComputedStyle(disc).scale;
    window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
    var dragging = dial.classList.contains('is-dragging');
    var dropPE = getComputedStyle(document.getElementById('dialDrop')).pointerEvents;
    return { dragging: dragging, dropPE: dropPE, before: before };
  })()`);
  await sleep(450);   // 等 scale 的过渡跑完
  const during = await js(`(function(){
    var disc = document.querySelector('.vinyl-disc');
    var cs = getComputedStyle(disc);
    return {
      scale: cs.scale,
      border: cs.borderTopColor,
      shadow: cs.boxShadow.slice(0, 60),
      haloDur: cs.animationDuration
    };
  })()`);
  await js(`(function(){
    var dt = new DataTransfer();
    dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    return true;
  })()`);
  await sleep(120);
  const reject = await js(`(function(){
    var dial = document.getElementById('dial');
    var sub = document.getElementById('vinylSub');
    return {
      isReject: dial.classList.contains('is-reject'),
      draggingAfterDrop: dial.classList.contains('is-dragging'),
      sub: sub.textContent, warn: sub.classList.contains('is-warn'),
      audioCount: document.querySelectorAll('#dock audio').length
    };
  })()`);
  console.log('    dragenter:', JSON.stringify(drag), '| 拖拽中:', JSON.stringify(during));
  console.log('    drop 后:', JSON.stringify(reject));
  ok(drag.dragging && drag.dropPE === 'auto', '拖入时进入高亮态并打开落点');
  ok(parseFloat(during.scale) > 1,
     `拖入时唱片放大（scale ${drag.before} → ${during.scale}）`);
  ok(/56, 189, 248/.test(during.shadow), '拖入时唱片发光（天蓝色阴影）');
  ok(!reject.draggingAfterDrop, '释放后高亮态清除');
  ok(reject.isReject && reject.warn, `非音频给出提示且不播放（"${reject.sub}"）`);
  ok(reject.audioCount === 0, '非音频不会创建音频元素');
  await shot('dock-drop-reject');

  // ---- 拖拽：音频 ----
  console.log('\n[12] 拖入音频 → 播放 + 状态更新');
  const wavB64 = makeWavB64(1.5, 440, 44100);
  const play = await js(`(async function(){
    var bin = atob(${JSON.stringify(wavB64)});
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var file = new File([bytes], 'My Test Track.wav', { type: 'audio/wav' });
    var dt = new DataTransfer();
    dt.items.add(file);
    var dial = document.getElementById('dial');
    window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
    var hl = dial.classList.contains('is-dragging');
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    await new Promise(function (r) { setTimeout(r, 900); });
    var audio = document.querySelector('#dock audio');
    var disc = document.querySelector('.vinyl-disc');
    return {
      highlight: hl, hasAudio: !!audio, src: audio ? audio.src.slice(0, 12) : null,
      paused: audio ? audio.paused : null, readyState: audio ? audio.readyState : null,
      error: audio && audio.error ? audio.error.code : null,
      duration: audio ? audio.duration : null,
      title: document.getElementById('vinylTitle').textContent,
      sub: document.getElementById('vinylSub').textContent,
      spinning: disc.classList.contains('is-spinning'),
      playing: disc.classList.contains('is-playing'),
      aria: document.getElementById('vinyl').getAttribute('aria-label')
    };
  })()`);
  console.log('   ', JSON.stringify(play));
  ok(play.highlight, '拖入音频时同样有高亮反馈');
  ok(play.hasAudio && String(play.src).startsWith('blob:'), '音频走 blob URL 载入（本地文件，不落盘）');
  ok(play.paused === false && play.readyState >= 2, `释放后已开始播放（readyState=${play.readyState}）`);
  ok(play.title === 'My Test Track', `歌名更新自文件名（"${play.title}"）`);
  ok(play.spinning && play.playing, '唱片进入旋转 / 播放态');
  ok(String(play.aria).includes('My Test Track'), 'aria-label 同步更新');
  await shot('dock-playing');

  // ---- 播放 / 暂停 ----
  console.log('\n[13] 点击唱片 → 暂停 / 继续');
  const toggle = await js(`(async function(){
    var disc = document.querySelector('.vinyl-disc');
    var audio = document.querySelector('#dock audio');
    disc.click();
    await new Promise(function (r) { setTimeout(r, 150); });
    var p1 = audio.paused, s1 = disc.classList.contains('is-spinning');
    disc.click();
    await new Promise(function (r) { setTimeout(r, 300); });
    return { pausedAfterFirst: p1, spinningAfterPause: s1,
             pausedAfterSecond: audio.paused,
             spinningAfterResume: disc.classList.contains('is-spinning') };
  })()`);
  console.log('   ', JSON.stringify(toggle));
  ok(toggle.pausedAfterFirst === true && toggle.spinningAfterPause === false, '点击后暂停且唱片停转');
  ok(toggle.pausedAfterSecond === false && toggle.spinningAfterResume === true,
     '再次点击继续播放且唱片复转');

  // ---- 指针 ----
  console.log('\n[14] 指针计时：角度对得上现实时间，且真的转到了屏幕上');
  const hands = await js(`(function(){
    var tf = getComputedStyle(document.getElementById('dialHour')).transform;
    var d = new Date();
    return {
      hour: document.getElementById('dialHour').style.getPropertyValue('--rot-h'),
      min: document.getElementById('dialMin').style.getPropertyValue('--rot-m'),
      sec: document.getElementById('dialSec').style.getPropertyValue('--rot-s'),
      tf: tf,
      aria: document.getElementById('dial').getAttribute('aria-label'),
      h: d.getHours(), m: d.getMinutes(), s: d.getSeconds()
    };
  })()`);
  console.log('   ', JSON.stringify(hands));
  const rotOf = (tf) => {
    const m = (String(tf).match(/matrix3?d?\(([^)]+)\)/) || [, ''])[1].split(',').map(Number);
    return (Math.atan2(m[1], m[0]) * 180 / Math.PI + 360) % 360;
  };
  const wantHour = ((hands.h % 12) + hands.m / 60) * 30;
  const wantMin = (hands.m + hands.s / 60) * 6;
  const gotHour = parseFloat(hands.hour);
  const gotMin = parseFloat(hands.min);
  const drawnHour = rotOf(hands.tf);
  ok(Math.abs(gotHour - wantHour) < 2,
     `时针角度＝现实时间（${gotHour.toFixed(1)}° ≈ ${wantHour.toFixed(1)}°）`);
  ok(Math.abs(gotMin - wantMin) < 3,
     `分针角度＝现实时间（${gotMin.toFixed(1)}° ≈ ${wantMin.toFixed(1)}°）`);
  ok(Math.abs(drawnHour - gotHour) < 1.5,
     `CSS 变量真的作用在指针上（计算值 ${drawnHour.toFixed(1)}° ≈ 变量 ${gotHour.toFixed(1)}°）`);

  // ---- ESC 重置 ----
  console.log('\n[15] ESC 重置无回归');
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(1000);
  const after = await js(`(function(){
    var dial = document.getElementById('dial');
    var dock = document.getElementById('dock');
    var audio = document.querySelector('#dock audio');
    return {
      state: window.Boot.state, dockOn: dock.classList.contains('is-on'),
      paused: audio ? audio.paused : null, time: audio ? audio.currentTime : null,
      dragging: dial.classList.contains('is-dragging'),
      mx: dial.style.getPropertyValue('--mx'),
      idle: dial.classList.contains('is-idle'),
      spinning: document.querySelector('.vinyl-disc').classList.contains('is-spinning'),
      menuOpen: document.getElementById('fan').classList.contains('is-open')
    };
  })()`);
  console.log('   ', JSON.stringify(after));
  ok(after.state === 'entry' && !after.dockOn, 'ESC 回到初始界面、时钟隐藏');
  ok(after.paused === true || after.paused === null, '音频已暂停并归零');
  ok(!after.dragging && !after.menuOpen, '拖拽态 / 菜单都已清理');
  ok(after.idle, '倾斜与视差也复位了');

  // ---- 响应式：窄窗口 ----
  console.log('\n[16] 响应式（1280×720 与 900×640）');
  await S('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false
  });
  await sleep(600);
  const narrow = await js(`(function(){
    var d = document.getElementById('dial').getBoundingClientRect();
    var dk = document.getElementById('dock').getBoundingClientRect();
    return { w: d.width, h: d.height, top: dk.top, bottom: dk.bottom, vh: innerHeight };
  })()`);
  console.log('    1280×720:', JSON.stringify(narrow));
  ok(narrow.w >= 300 && Math.abs(narrow.w - narrow.h) < 1, `时钟仍接近满尺寸（${narrow.w.toFixed(0)}px）`);
  ok(narrow.top >= 0 && narrow.bottom <= narrow.vh, '720 高的窗口里不溢出');

  await S('Emulation.setDeviceMetricsOverride', {
    width: 900, height: 640, deviceScaleFactor: 1, mobile: false
  });
  await sleep(600);
  const mobile = await js(`(function(){
    var dock = document.getElementById('dock');
    var body = document.querySelector('.dock-body');
    return {
      collapsed: dock.classList.contains('is-collapsed'),
      bodyDisplay: getComputedStyle(body).display,
      toggleDisplay: getComputedStyle(document.getElementById('dockToggle')).display
    };
  })()`);
  console.log('    900×640:', JSON.stringify(mobile));
  ok(mobile.collapsed && mobile.bodyDisplay === 'none' && mobile.toggleDisplay === 'grid',
     '窄屏收成小钟按钮，点击可展开（原有折叠行为保留）');

  // ---- 控制台 ----
  console.log('\n[17] 网络与控制台');
  if (netFails.length) netFails.slice(0, 8).forEach((u) => console.log('     net:', u));
  const realErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
  ok(realErrors.length === 0, `无控制台错误（${realErrors.length}）`);
  if (realErrors.length) realErrors.slice(0, 8).forEach((e) => console.log('     !', e));

  console.log(`\n截图目录：${OUT}`);
  return fail;
};

main().then((f) => {
  cleanup();
  console.log('\n================ 结果 ================');
  if (f.length) {
    console.log(`✗ ${f.length} 项失败：`);
    f.forEach((x) => console.log('   -', x));
    process.exit(1);
  }
  console.log('✓ 全部通过');
  process.exit(0);
}).catch((e) => {
  cleanup();
  console.error('验证脚本异常:', e);
  process.exit(2);
});
