/* ============================================================
   水：焦散 / 气泡 / 入水冲击 / 波光
   ------------------------------------------------------------
   折射本身由 index.html 里的 #waterRefract 滤镜完成（Character.setFall 驱动
   它的 scale），这里负责其余的"水感"元素。
   ============================================================ */
(() => {
  'use strict';

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rand = (a, b) => a + Math.random() * (b - a);

  /* ============================================================
     焦散（caustics）：光穿过水面后在水底汇聚成的亮网
     ------------------------------------------------------------
     用层状正弦求和后取脊线，得到真实的水下光网，而不是放射状光芒。
     为了几乎不耗性能，只在 1/6 分辨率的小画布上计算，再拉伸铺满屏幕。
     ============================================================ */
  const Caustics = {
    scale: 3,          // 分辨率降采样倍率（越小越细腻，3 约等于 530×270 的计算量）
    speed: 0.45,
    bands: [
      { a: 1.00, f: 0.046, s: 0.30 },
      { a: 0.72, f: 0.069, s: -0.21 },
      { a: 0.50, f: 0.108, s: 0.14 },
      { a: 0.34, f: 0.165, s: -0.09 }
    ],
    t: 0,

    init() {
      this.out = document.getElementById('caustics');
      if (!this.out) return;
      this.buf = document.createElement('canvas');
      this.bctx = this.buf.getContext('2d', { willReadFrequently: true });
      this.octx = this.out.getContext('2d');
      this.px = null;
      this.resize();
      window.addEventListener('resize', () => this.resize());
      this.ready = true;
    },

    resize() {
      const w = Math.max(64, Math.round(window.innerWidth / this.scale));
      const h = Math.max(64, Math.round(window.innerHeight / this.scale));
      this.w = w; this.h = h;
      this.buf.width = w; this.buf.height = h;
      this.out.width = w; this.out.height = h;
      this.px = this.bctx.createImageData(w, h);
      const d = this.px.data;
      /* 先生成一张径向遮罩，避免出现平铺感与硬边 */
      this.mask = new Float32Array(w * h);
      const cx = w / 2, cy = h / 2;
      const maxR = Math.hypot(cx, cy);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const r = Math.hypot(x - cx, y - cy) / maxR;
          const m = clamp(1.05 - Math.pow(r, 1.5) * 1.15, 0, 1);
          this.mask[y * w + x] = m * m;
        }
      }
    },

    draw(dt) {
      if (!this.ready || !this.px) return;
      /* 尊重"减少动态效果"：画一帧静态光网即可 */
      if (!this.still) {
        this.still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      }
      if (this.still && this.drawn) return;
      this.drawn = true;
      this.t += dt * this.speed;
      const { w, h, bands, mask } = this;
      const d = this.px.data;
      const tt = this.t;
      let i = 0;
      for (let y = 0; y < h; y++) {
        const fy = y * 0.48;
        for (let x = 0; x < w; x++) {
          const fx = x * 0.48;
          let v = 0;
          for (let b = 0; b < 4; b++) {
            const bd = bands[b];
            v += bd.a * Math.sin((fx + fy * 1.35) * bd.f + tt * bd.s * 3.1);
            v += bd.a * 0.85 * Math.sin((fx * 1.25 - fy * 0.8) * bd.f * 1.6 - tt * bd.s * 2.4);
          }
          /* 脊线：把平滑波变成细亮网 */
          let p = Math.abs(v);
          p = p > 0.42 ? 1 : Math.pow(clamp(1 - p / 0.42, 0, 1), 3.2);
          const m = mask[i >> 2] * 255;
          const lum = p * 255;
          d[i] = lum * 0.62; d[i + 1] = lum * 0.95; d[i + 2] = lum;
          d[i + 3] = m * p;
          i += 4;
        }
      }
      this.bctx.putImageData(this.px, 0, 0);
      /* 拉伸到整屏：天然得到柔和的水下光网 */
      const o = this.octx;
      o.clearRect(0, 0, w, h);
      o.drawImage(this.buf, 0, 0, w, h);
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

    /* 由主循环驱动：只负责重绘焦散，透明度交给 CSS 的 --fall */
    update(dt, fall) {
      if (fall > 0.002) Caustics.draw(dt);
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

  /* 把 --fall（0→1）映射成背景从纯白到水下的过渡，交给 CSS 变量即可 */
  Water.syncFall = (p) => {
    const world = document.getElementById('world');
    if (world) world.style.setProperty('--fall', clamp(p, 0, 1).toFixed(4));
  };

  window.Water = Water;
})();
