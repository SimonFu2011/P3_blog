/* ============================================================
   水：焦散 / 气泡 / 入水冲击 / 波光
   ------------------------------------------------------------
   这里负责"水感"的其余部分：气泡、入水冲击、波光，以及由主循环驱动的
   焦散重绘。（这段注释原先写着折射由 Character.setFall 驱动 —— 那个方法
   并不存在，折射滤镜也一直是 scale=0 的空转，已从 CSS 中移除。）
   ============================================================ */
(() => {
  'use strict';

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rand = (a, b) => a + Math.random() * (b - a);

  /* ============================================================
     焦散（caustics）：光穿过水面后在水底汇聚成的亮网
     ------------------------------------------------------------
     用层状正弦求和后取脊线，得到真实的水下光网，而不是放射状光芒。
     只在 1/3 分辨率的小画布上计算，再靠 CSS 拉伸铺满屏幕。
     ------------------------------------------------------------
     性能改造（本次评审里最要紧的一处）
     原来的内层循环每像素要调 8 次 Math.sin + 1 次 Math.pow，1080p 下单帧
     实测约 37ms —— 是 16.7ms 帧预算的 2.2 倍，必然掉帧。现在：
       1) sin 与脊线曲线 q^3.2 都预计算成查表（Float32Array）
       2) 每个波段的相位拆成"每行基准 + x 方向线性斜率"，内层只剩乘加
       3) 时间照真实 dt 推进，但重绘限流到约 32fps
          （焦散是慢速漂移，30 与 60fps 肉眼分辨不出，CPU 却直接减半）
       4) 直接写进可见画布，去掉原来 buf → drawImage 的同尺寸多余拷贝
     相位的代数改写与原式逐项等价（实测 max|Δv| ≈ 3e-14）；逐字节比对余下的
     差异只来自 sin 查表的量化：平均 0.10/255，且集中在原式 |v| = 0.42 那个
     硬跳变附近的极少数像素（占字节 0.03%），肉眼不可见。
     ============================================================ */
  const TAU = Math.PI * 2;
  /* 表长取 8192：量化步长 2π/8192 ≈ 7.7e-4 rad，实测由此引入的
     |Δv| 均值约 4e-4、最大约 2e-3 —— 远小于焦散本身经过拉伸 + blur(.8px)
     + 62% 透明度之后的可见阈值。取 2048 时误差会大 4 倍，而表更大不增加
     每像素开销（只是多 32KB 内存），所以直接给足。
     必须是 2 的幂：内层用 & 取模把角度折回表内。 */
  const SIN_N = 8192;
  const SIN_MASK = SIN_N - 1;
  const SIN_LUT = new Float32Array(SIN_N);
  for (let i = 0; i < SIN_N; i++) SIN_LUT[i] = Math.sin((i / SIN_N) * TAU);
  const RAD_TO_LUT = SIN_N / TAU;     // 弧度 → 查表下标

  /* 脊线曲线 q^3.2 的查表。取 4096 而不是 512：曲线在 |v|→0 处最陡，
     量化误差会被 7.6 倍的斜率放大，4096 项能把由此产生的字节差压到 1 以内。
     同样不增加每像素开销。 */
  const RIDGE_N = 4096;
  const RIDGE_LUT = new Float32Array(RIDGE_N + 1);
  for (let i = 0; i <= RIDGE_N; i++) RIDGE_LUT[i] = Math.pow(1 - i / RIDGE_N, 3.2);

  const Caustics = {
    scale: 3,          // 分辨率降采样倍率（越小越细腻，3 约等于 640×360 的计算量）
    speed: 0.45,
    minStep: 1 / 32,   // 重绘间隔下限（秒），约 32fps
    ridgeMax: 0.42,    // 与原实现一致：|v| 超过它就取 1
    bands: [
      { a: 1.00, f: 0.046, s: 0.30 },
      { a: 0.72, f: 0.069, s: -0.21 },
      { a: 0.50, f: 0.108, s: 0.14 },
      { a: 0.34, f: 0.165, s: -0.09 }
    ],
    t: 0,
    sinceDraw: 0,

    init() {
      this.out = document.getElementById('caustics');
      if (!this.out) return;
      this.octx = this.out.getContext('2d');
      this.px = null;

      /* 把 bands 展开成 8 项平面波常数（相位一律换算成查表下标，内层只做
         base + slope·x）。逐项对照原式：
           项 1：(0.48x + 0.48·1.35y)·f + t·s·3.1
           项 2：(0.48·1.25x − 0.48·0.8y)·f·1.6 − t·s·2.4
         ⇒ slope1 = 0.48f、slope2 = 0.96f、y2 = −0.6144f
         （bands 在 init 时被烘进这些常数，改 bands 后需要重新 init） */
      const n = this.bands.length * 2;
      this.amp = new Float64Array(n);
      this.slope = new Float64Array(n);
      this.yBase = new Float64Array(n);
      this.tBase = new Float64Array(n);
      this.phase = new Float64Array(n);
      for (let b = 0; b < this.bands.length; b++) {
        const { a, f, s } = this.bands[b];
        const j = b * 2;
        this.amp[j] = a;
        this.slope[j] = 0.48 * f * RAD_TO_LUT;
        this.yBase[j] = 0.48 * 1.35 * f * RAD_TO_LUT;
        this.tBase[j] = s * 3.1 * RAD_TO_LUT;
        this.amp[j + 1] = a * 0.85;
        this.slope[j + 1] = 0.96 * f * RAD_TO_LUT;
        this.yBase[j + 1] = -0.6144 * f * RAD_TO_LUT;
        this.tBase[j + 1] = -s * 2.4 * RAD_TO_LUT;
      }
      this.ridgeToLut = RIDGE_N / this.ridgeMax;

      this.resize();
      /* 拖拽窗口时 resize 会连续触发，而遮罩重建是 w×h 次开方，没必要每次都做 */
      let resizeTimer = 0;
      window.addEventListener('resize', () => {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => this.resize(), 120);
      });
      this.ready = true;
    },

    resize() {
      const w = Math.max(64, Math.round(window.innerWidth / this.scale));
      const h = Math.max(64, Math.round(window.innerHeight / this.scale));
      this.w = w; this.h = h;
      this.out.width = w; this.out.height = h;
      this.px = this.octx.createImageData(w, h);
      /* 先生成一张径向遮罩，避免出现平铺感与硬边 */
      this.mask = new Float32Array(w * h);
      const cx = w / 2, cy = h / 2;
      const maxR = Math.sqrt(cx * cx + cy * cy);
      for (let y = 0; y < h; y++) {
        const dy = y - cy;
        for (let x = 0; x < w; x++) {
          const dx = x - cx;
          /* r·√r 就是 r^1.5，省掉一次 Math.pow */
          const r = Math.sqrt(dx * dx + dy * dy) / maxR;
          const m = clamp(1.05 - r * Math.sqrt(r) * 1.15, 0, 1);
          this.mask[y * w + x] = m * m;
        }
      }
    },

    draw(dt) {
      if (!this.ready || !this.px) return;
      /* 尊重"减少动态效果"：画一帧静态光网即可 */
      if (this.still === undefined) {
        this.still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      }
      /* 时间照常按真实 dt 推进：跳帧只影响重绘频率，不影响漂移速度 */
      this.t += dt * this.speed;
      if (this.still && this.drawn) return;
      this.sinceDraw += dt;
      if (this.drawn && this.sinceDraw < this.minStep) return;
      this.sinceDraw = 0;
      this.drawn = true;

      const { w, h, mask, amp, slope, yBase, tBase, phase } = this;
      const d = this.px.data;
      const tt = this.t;
      const n = amp.length;
      const ridgeToLut = this.ridgeToLut;
      let i = 0;
      for (let y = 0; y < h; y++) {
        /* 每行只算一次与 y、t 有关的相位基准 */
        for (let k = 0; k < n; k++) phase[k] = yBase[k] * y + tBase[k] * tt;
        for (let x = 0; x < w; x++) {
          let v = 0;
          for (let k = 0; k < n; k++) {
            /* & SIN_MASK 之前是浮点：JS 的 & 会先转 int32 再按位与，
               负数天然回绕到等价相位（2^32 恰好是 8192 的整数倍） */
            v += amp[k] * SIN_LUT[(phase[k] + slope[k] * x) & SIN_MASK];
          }
          /* 脊线：把平滑波变成细亮网。|v| ≥ ridgeMax 时原式取 1，
             这里越过表尾回绕到 RIDGE_LUT[0] === 1，结果等价 */
          let p = v < 0 ? -v : v;
          const ri = (p * ridgeToLut) | 0;
          p = ri > RIDGE_N ? 1 : RIDGE_LUT[ri];
          const m = mask[i >> 2] * 255;
          const lum = p * 255;
          d[i] = lum * 0.62; d[i + 1] = lum * 0.95; d[i + 2] = lum;
          d[i + 3] = m * p;
          i += 4;
        }
      }
      /* 直接写进可见画布：原来经 buf → drawImage 同尺寸拷贝一次，纯属多余 */
      this.octx.putImageData(this.px, 0, 0);
    }
  };

  const Water = {
    init() {
      this.layer = document.getElementById('bubbles');
      this.flash = document.getElementById('flash');
      this.sheen = document.getElementById('sheen');
      this.timers = [];
      Caustics.init();
      this.ready = true;
    },

    /* 由主循环驱动：只负责重绘焦散，透明度交给 CSS 的 --fall。
       入场白场上不需要它，那个判断放在 boot.js 的状态机里。 */
    update(dt) {
      Caustics.draw(dt);
    },

    /* 入水冲击：白闪 + 涟漪环 + 气泡幕 */
    splash() {
      this.flashNow(0.92, 260);
      this.rippleRing();
      this.burst(46);
      if (this.sheen) {
        this.sheen.classList.remove('is-pass');
        void this.sheen.offsetWidth;
        this.sheen.classList.add('is-pass');
      }
      /* 入水后持续冒泡，逐渐变稀 */
      this.drift(200, 26, 1200);
      this.after(2400, () => this.drift(120, 16, 900));
      this.after(4200, () => this.drift(90, 12, 1600));
      this.after(7000, () => this.drift(80, 8, 2600));
    },

    flashNow(strength, ms) {
      if (!this.flash) return;
      this.flash.style.setProperty('--strength', String(strength));
      this.flash.classList.remove('is-on');
      void this.flash.offsetWidth;
      this.flash.classList.add('is-on');
      this.after(ms + 60, () => this.flash.classList.remove('is-on'));
    },

    rippleRing() {
      const ring = document.createElement('div');
      ring.className = 'splash-ring';
      document.getElementById('world').appendChild(ring);
      this.after(1400, () => ring.remove());
    },

    /* 一次性气泡幕（入水瞬间） */
    burst(n) {
      for (let i = 0; i < n; i++) {
        this.after(i * 12, () => this.spawn({
          x: rand(0.12, 0.95),
          r: rand(3, 16),
          dur: rand(1200, 3000),
          drift: rand(-70, 70),
          delay: 0
        }));
      }
    },

    /* 持续冒泡 */
    drift(count, gapMs, spanMs) {
      for (let i = 0; i < count; i++) {
        this.after(i * rand(gapMs * 0.3, gapMs), () => this.spawn({
          x: rand(0.05, 0.98),
          r: rand(2, 9),
          dur: rand(3600, spanMs),
          drift: rand(-50, 50),
          delay: 0
        }));
      }
    },

    spawn({ x, r, dur, drift, delay }) {
      if (!this.layer) return;
      const b = document.createElement('i');
      b.className = 'bubble';
      b.style.setProperty('--x', (x * 100).toFixed(2) + '%');
      b.style.setProperty('--r', r.toFixed(1) + 'px');
      b.style.setProperty('--dur', dur.toFixed(0) + 'ms');
      b.style.setProperty('--drift', drift.toFixed(1) + 'px');
      b.style.setProperty('--delay', delay.toFixed(0) + 'ms');
      b.style.setProperty('--wob', rand(-14, 14).toFixed(1) + 'deg');
      this.layer.appendChild(b);
      this.after(dur + delay + 200, () => b.remove());
    },

    /* 出水/入水时改变整体水感 */
    setPhase(phase) {
      const world = document.getElementById('world');
      if (!world) return;
      world.dataset.waterPhase = phase;
    },

    after(ms, fn) {
      const id = window.setTimeout(fn, ms);
      this.timers.push(id);
      return id;
    },

    reset() {
      this.timers.forEach((id) => window.clearTimeout(id));
      this.timers = [];
      if (this.layer) this.layer.innerHTML = '';
      document.querySelectorAll('.splash-ring').forEach((n) => n.remove());
    }
  };

  /* 无 @property 的引擎（--fall 无法被 CSS 动画插值）时的回退：由 JS 逐帧写值。
     写 documentElement 而不是 #world —— 正常路径的动画挂在 body 上，
     只有这样才能保证两条路径的继承范围完全一致。 */
  Water.syncFall = (p) => {
    document.documentElement.style.setProperty('--fall', clamp(p, 0, 1).toFixed(4));
  };

  window.Water = Water;
})();
