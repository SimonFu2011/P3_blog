/* ============================================================
   水：水波场 / 焦散 / 气泡 / 入水冲击 / 波光
   ------------------------------------------------------------
   这里负责"水感"的全部：背景水波（Canvas 模拟 + 焦散着色）、气泡、
   入水冲击、波光，以及由主循环驱动的推进。
   ============================================================ */
(() => {
  'use strict';

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rand = (a, b) => a + Math.random() * (b - a);

  const TAU = Math.PI * 2;

  /* 涟漪环注入用的单位圆查表：环上每个采样点不必再调三角函数 */
  const RING_N = 256;
  const RING_COS = new Float32Array(RING_N);
  const RING_SIN = new Float32Array(RING_N);
  for (let i = 0; i < RING_N; i++) {
    const a = (i / RING_N) * TAU;
    RING_COS[i] = Math.cos(a);
    RING_SIN[i] = Math.sin(a);
  }

  /* ============================================================
     水波场（第五项）：真正的二维波方程模拟 + 焦散着色
     ------------------------------------------------------------
     模拟：
       · Float32Array 双缓冲 cur / prev，每步只交换引用，帧内零分配
       · 5 点拉普拉斯显式积分：u₊ = (2u − d·u₋) + c²∇²u，c² = 0.5 是稳定上限
       · 波源用预分配对象池（Drop），涟漪环用查表，帧内不 new 任何对象
       · 雨滴持续注入能量，否则波场会在阻尼下变成死水
       · 外圈清零做吸收边界，避免波从画布边缘反射回中心

     尺寸（第五项 2/3/4 条）：
       · Canvas 的 CSS 尺寸 = 视口（见 style.css 的 .caustics-canvas）
       · Canvas 像素尺寸 = CSS 尺寸 × min(devicePixelRatio, 1.5)
       · 模拟网格 = Canvas 像素 × simScale（默认 0.5，上限 0.75），
         再用 drawImage 放大到目标画布，双线性插值自带柔化

     性能（第五项 6/8/9/10 条）：
       · 固定 60 步/秒推进（与屏幕刷新率解耦：120Hz 屏上波速不会变成两倍）
       · visibilitychange 暂停（由 boot.js 调 setPaused）
       · resize 防抖 150ms 重建
       · 自适应画质：实测步进耗时超预算先降分辨率、再降步频；长期富余才升档

     着色：
       用高度场的拉普拉斯算子（曲率 ≈ 折射聚焦）映射成亮网，色值与原来
       保持一致（冷白偏青），所以观感仍是"水下光网"，而不是灰色水面。
       亮度增益按上一帧的曲率均值自归一化 —— 换分辨率、换机器都不用重调。
     ============================================================ */
  const Ripple = {
    /* ---------- 尺寸与画质 ---------- */
    maxDpr: 1.5,            // 五.3
    simScale: 0.5,          // 五.4：模拟缓冲相对目标画布的倍率
    minScale: 0.16,         // 五.10：降级下限
    maxScale: 0.75,         // 五.4：上限
    startCells: 300000,     // 首帧格数上限（按视口折算成起始倍率）
    hardCells: 1200000,     // 任何情况下都不超过的格数
    baseRate: 60,           // 五.9：模拟步频（步/秒）
    minRate: 30,
    /* ---------- 自适应画质 ---------- */
    budgetMs: 6,            // 单步耗时预算
    downFactor: 0.8,
    upFactor: 1.15,
    downCooldown: 1200,
    upCooldown: 6000,
    resizeDebounce: 150,    // 五.8
    /* ---------- 物理 ---------- */
    damp: 0.996,            // 速度阻尼
    k: 0.5,                 // c²（5 点拉普拉斯下的稳定上限就是 0.5）
    /* ---------- 着色 ---------- */
    gainTarget: 0.30,       // 曲率均值目标（唯一的亮度旋钮）
    /* ---------- 波源 ---------- */
    rainGap: 0.14,          // 秒 / 滴
    poolSize: 64,

    init() {
      this.out = document.getElementById('caustics');
      if (!this.out) return false;
      this.octx = this.out.getContext('2d');
      this.off = document.createElement('canvas');
      this.offctx = this.off.getContext('2d');

      this.still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.acc = 0;
      this.rain = 0;
      this.rate = this.baseRate;
      this.avgMs = 0;
      this.lastDown = 0;
      this.lastUp = 0;
      this.gain = 200;        // 随意初值，几十步内会被自归一化收敛
      this.drawn = false;

      this.initPool();
      this.pickInitialScale();
      this.syncCanvas(true);
      /* 先铺一层波源并跑几步，避免开场是一片死水 */
      if (this.cur) {
        this.warmupSteps(8);
        if (this.still) { this.simStep(1 / this.baseRate, true); this.drawn = true; }
      }

      let debounce = 0;
      window.addEventListener('resize', () => {
        window.clearTimeout(debounce);
        debounce = window.setTimeout(() => this.syncCanvas(false), this.resizeDebounce);
      });
      this.ready = true;
      this.metrics = this.snapshot();     // 便于启动后立刻自查档位/格数
      return true;
    },

    /* 依据视口把 startCells 折算成起始倍率：默认取五.4 的 0.5，
       若这样会超过格数上限（1080p/DPR1.5 下 0.5 是 117 万格）就压到上限 */
    pickInitialScale() {
      const cells = Math.max(1, (window.innerWidth || 1) * (window.innerHeight || 1) *
        Math.pow(Math.min(window.devicePixelRatio || 1, this.maxDpr), 2));
      const cap = Math.sqrt(this.startCells / cells);
      this.simScale = clamp(Math.min(0.5, cap), this.minScale, this.maxScale);
    },

    /* ---------- 对象池（五.7：帧内不 new） ---------- */
    initPool() {
      const pool = new Array(this.poolSize);
      for (let i = 0; i < this.poolSize; i++) {
        pool[i] = { active: false, x: 0, y: 0, radius: 0, growth: 0, strength: 0, life: 0, ttl: 0 };
      }
      this.pool = pool;
      this.poolCursor = 0;
    },

    /* 取一个波源。池满时覆盖游标处最老的那个（视觉上无差别） */
    spawn(x, y, radius, strength, ttl) {
      const pool = this.pool;
      if (!pool) return null;
      let d = null;
      for (let n = 0; n < pool.length; n++) {
        const i = (this.poolCursor + n) % pool.length;
        if (!pool[i].active) { d = pool[i]; this.poolCursor = (i + 1) % pool.length; break; }
      }
      if (!d) { d = pool[this.poolCursor]; this.poolCursor = (this.poolCursor + 1) % pool.length; }
      d.active = true;
      d.x = x; d.y = y;
      d.radius = radius;
      d.growth = 26 + Math.random() * 46;     // 涟漪环的扩张速度（格/秒）
      d.strength = strength;
      d.life = 0;
      d.ttl = ttl;
      return d;
    },

    /* 入水冲击：中心一记重击 + 几滴外围的，让波场"炸"开 */
    impact(x, y, strength) {
      if (!this.cur) return;
      this.spawn(x, y, 2, strength, 1.5);
      for (let i = 0; i < 6; i++) {
        this.spawn(clamp(x + rand(-0.18, 0.18), 0.02, 0.98),
                   clamp(y + rand(-0.14, 0.14), 0.02, 0.98),
                   2 + Math.random() * 8, strength * 0.35, 0.9 + Math.random() * 0.8);
      }
    },

    /* ---------- 尺寸 ---------- */
    /* 五.2 / 五.3：CSS 尺寸由样式表保证等于视口，这里按 DPR 上限定像素尺寸 */
    syncCanvas(force) {
      const cssW = Math.max(1, window.innerWidth || 1);
      const cssH = Math.max(1, window.innerHeight || 1);
      const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
      const pw = Math.max(2, Math.round(cssW * dpr));
      const ph = Math.max(2, Math.round(cssH * dpr));
      if (!force && pw === this.pw && ph === this.ph) return;
      this.pw = pw;
      this.ph = ph;
      this.out.width = pw;          // 设置尺寸会重置 2D 上下文状态，所以下面重设
      this.out.height = ph;
      this.configure();
      this.fitGrid();
    },

    configure() {
      /* copy：整屏替换，不必先 clearRect（源带 alpha，遮罩负责边缘淡出）
         imageSmoothingEnabled：模拟缓冲放大到目标画布时用双线性 */
      this.octx.globalCompositeOperation = 'copy';
      this.octx.imageSmoothingEnabled = true;
    },

    /* 计算模拟网格并（重）分配缓冲。尺寸变了就重采样旧波场，避免"闪一下重置" */
    fitGrid() {
      const cells = this.pw * this.ph;
      const hardCap = Math.sqrt(this.hardCells / cells);
      const scale = clamp(Math.min(this.simScale, hardCap), this.minScale, this.maxScale);
      const w = Math.max(64, Math.round(this.pw * scale));
      const h = Math.max(64, Math.round(this.ph * scale));
      this.scale = scale;
      if (w === this.w && h === this.h) return;

      const oldW = this.w, oldH = this.h, oldCur = this.cur, oldPrev = this.prev;

      this.w = w;
      this.h = h;
      this.cur = new Float32Array(w * h);
      this.prev = new Float32Array(w * h);
      this.mask = new Float32Array(w * h);
      this.imageData = this.offctx.createImageData(w, h);
      this.off.width = w;
      this.off.height = h;

      if (oldCur && oldW && oldH) {
        this.resample(oldW, oldH, oldCur, this.cur);
        this.resample(oldW, oldH, oldPrev, this.prev);
      }
      this.buildMask();
      if (!oldCur) this.seed();
    },

    /* 旧网格 → 新网格的最近邻重采样（只在画质档位或视口变化时跑一次） */
    resample(oldW, oldH, src, dst) {
      const w = this.w, h = this.h;
      for (let y = 0; y < h; y++) {
        const sy = Math.min(oldH - 1, ((y * oldH) / h) | 0) * oldW;
        const dy = y * w;
        for (let x = 0; x < w; x++) {
          dst[dy + x] = src[sy + Math.min(oldW - 1, ((x * oldW) / w) | 0)];
        }
      }
    },

    /* 径向遮罩：让焦散在靠近边缘处淡出，避免出现硬边与平铺感 */
    buildMask() {
      const { w, h, mask } = this;
      const cx = w / 2, cy = h / 2;
      const maxR = Math.sqrt(cx * cx + cy * cy);
      for (let y = 0; y < h; y++) {
        const dy = y - cy;
        for (let x = 0; x < w; x++) {
          const dx = x - cx;
          /* r·√r 就是 r^1.5，省掉一次 Math.pow */
          const r = Math.sqrt(dx * dx + dy * dy) / maxR;
          const m = clamp(1.05 - r * Math.sqrt(r) * 1.15, 0, 1);
          mask[y * w + x] = m * m;
        }
      }
    },

    /* 初次播种：撒一把波源 + 跑几步，让水面一上来就有结构 */
    seed() {
      this.cur.fill(0);
      this.prev.fill(0);
      for (let i = 0; i < this.pool.length; i++) this.pool[i].active = false;
      this.gain = 200;
      this.acc = 0;
      this.rain = 0;
      for (let i = 0; i < 14; i++) {
        this.spawn(0.08 + Math.random() * 0.84, 0.08 + Math.random() * 0.84,
                   6 + Math.random() * 26, 0.5 + Math.random() * 0.8,
                   1.2 + Math.random() * 1.6);
      }
    },

    warmupSteps(n) {
      const dt = 1 / this.baseRate;
      for (let i = 0; i < n; i++) this.simStep(dt, false);
    },

    /* ---------- 波源注入 ---------- */
    applyDrops(dt) {
      const pool = this.pool;
      if (!pool) return;
      const cur = this.cur, w = this.w, h = this.h;
      for (let i = 0; i < pool.length; i++) {
        const d = pool[i];
        if (!d.active) continue;
        d.life += dt;
        if (d.life >= d.ttl) { d.active = false; continue; }
        d.radius += d.growth * dt;
        const r = d.radius;
        if (r < 1) continue;
        const cx = d.x * w, cy = d.y * h;
        const steps = r < 8 ? 10 : Math.min(360, Math.round(r * 6.5));
        const idxStep = RING_N / steps;
        const amp = d.strength * (1 - d.life / d.ttl);
        for (let s = 0; s < steps; s++) {
          const ri = (s * idxStep) & (RING_N - 1);
          const xx = (cx + RING_COS[ri] * r) | 0;
          const yy = (cy + RING_SIN[ri] * r) | 0;
          if (xx < 1 || yy < 1 || xx > w - 2 || yy > h - 2) continue;
          const idx = yy * w + xx;
          cur[idx] += amp;
          /* 顺手把能量抹开一格：单点注入会产生大量高频毛刺，
             既不好看，也会让"着色依据"的曲率被毛刺主导 */
          const sm = amp * 0.55;
          cur[idx - 1] += sm;
          cur[idx + 1] += sm;
          cur[idx - w] += sm;
          cur[idx + w] += sm;
        }
      }
    },

    /* ---------- 单步推进（可选同时着色到 ImageData） ---------- */
    simStep(dt, blit) {
      /* 雨滴：持续注入能量，否则波场会在阻尼下变成死水 */
      this.rain += dt;
      let guard = 0;
      while (this.rain >= this.rainGap && guard < 4) {
        this.rain -= this.rainGap;
        guard++;
        this.spawn(Math.random(), Math.random(),
                   3 + Math.random() * 10, 0.35 + Math.random() * 0.5,
                   1.1 + Math.random() * 1.4);
      }
      if (guard >= 4) this.rain = 0;

      this.applyDrops(dt);

      const w = this.w, h = this.h, cur = this.cur, prev = this.prev;
      const mask = this.mask;
      const px = blit ? this.imageData.data : null;
      const g = this.gain, k = this.k, damp = this.damp;
      let sum = 0;

      for (let y = 1; y < h - 1; y++) {
        let i = y * w + 1;
        for (let x = 1; x < w - 1; x++, i++) {
          const c = cur[i];
          const a = cur[i - 1], b = cur[i + 1], u = cur[i - w], dn = cur[i + w];
          /* 拉普拉斯同时供两用：波的传播，以及焦散的曲率 */
          const lap = a + b + u + dn - 4 * c;
          /* 阻尼必须乘在整条式子上（含 u₋ 项）：
             u₊ = d·(2u − u₋ + c²∇²u)。若写成 (2u − d·u₋ + c²∇²u)，
             特征方程在 λ=0 处会出一个 |z| = 1.03 的根，整个场按 6%/步
             指数爆炸（实测 900 步后 |场| 达 1e24）；乘在外面则所有根的
             模都是 √d = 0.998，既稳定又让直流分量自然衰减。
             k = 0.5 正是 5 点格式的稳定上限（λ_max = 8 时 z = −1，临界）。 */
          prev[i] = damp * (2 * c - prev[i] + k * lap);
          if (px) {
            const la = lap < 0 ? -lap : lap;
            sum += la;
            let s = la * g;
            if (s > 1) s = 1;
            /* smootherstep：暗部更暗、脊线更锐，出来才是"细亮网" */
            const p = s * s * s * (s * (s * 6 - 15) + 10);
            const j = i << 2;
            const m = mask[i] * 255;
            const lum = p * 255;
            /* 色值与原焦散一致（冷白偏青）；饱和度直接烘进像素，
               这样 CSS 上可以去掉每帧一次的 filter，省一趟全屏滤镜 */
            px[j] = lum * 0.56; px[j + 1] = lum * 0.94; px[j + 2] = lum;
            px[j + 3] = m * p;
          }
        }
      }

      /* 吸收边界：外圈清零，避免波反射回中心形成驻波 */
      const last = (h - 1) * w;
      for (let x = 0; x < w; x++) { prev[x] = 0; prev[last + x] = 0; }
      for (let y = 0; y < h; y++) { prev[y * w] = 0; prev[y * w + w - 1] = 0; }

      /* 交换双缓冲：只换引用，不新建数组 */
      this.cur = prev;
      this.prev = cur;

      if (!px) return 0;

      /* 增益自归一化：曲率的绝对量级取决于网格分辨率与场能量，
         而人眼只认相对亮度，所以按上一帧的曲率均值反推增益。
         换分辨率、换机器都不需要手调；gainTarget 是唯一的亮度旋钮。 */
      const mean = sum / ((w - 2) * (h - 2));
      if (mean > 1e-7) {
        const target = this.gainTarget / mean;
        this.gain = clamp(g + (target - g) * 0.06, 1e-3, 1e5);
      }

      const t0 = performance.now();
      this.offctx.putImageData(this.imageData, 0, 0);
      /* 五.4：模拟缓冲放大到目标画布（双线性 + CSS 的 62% 透明度） */
      this.octx.drawImage(this.off, 0, 0, this.pw, this.ph);
      return performance.now() - t0;
    },

    /* ---------- 由主循环驱动 ---------- */
    update(dt) {
      if (!this.ready || !this.cur) return;
      /* 减少动态效果：只保留开场那一帧静态光网 */
      if (this.still || this.paused) return;
      /* 固定步频推进，与 rAF 频率解耦：120Hz 屏上波速不会变成两倍 */
      const fixed = 1 / this.rate;
      this.acc += dt;
      let steps = 0;
      while (this.acc >= fixed && steps < 3) {
        const ms = this.simStep(fixed, true);
        this.acc -= fixed;
        steps++;
        this.adapt(ms);
      }
      /* 掉帧太多就丢弃积压，避免"追赶"雪崩 */
      if (steps >= 3) this.acc = 0;
    },

    /* 五.9 / 五.10：按实测耗时在画质阶梯上自适应，先降分辨率再降步频 */
    adapt(ms) {
      this.avgMs = this.avgMs ? this.avgMs * 0.9 + ms * 0.1 : ms;
      const now = performance.now();
      if (this.avgMs > this.budgetMs) {
        if (now - this.lastDown < this.downCooldown) return;
        this.lastDown = now;
        if (this.simScale > this.minScale) {
          this.simScale = Math.max(this.minScale, this.simScale * this.downFactor);
          this.fitGrid();
        } else if (this.rate > this.minRate) {
          this.rate = this.rate > 45 ? 45 : this.minRate;
        }
        this.avgMs = 0;
        return;
      }
      /* 升档保守得多：只有长期远低于预算才升，避免来回抖 */
      if (this.avgMs < this.budgetMs * 0.45 && now - this.lastUp > this.upCooldown) {
        this.lastUp = now;
        if (this.rate < this.baseRate) this.rate = this.baseRate;
        else if (this.simScale < this.maxScale) {
          this.simScale = Math.min(this.maxScale, this.simScale * this.upFactor);
          this.fitGrid();
        }
        this.avgMs = 0;
      }
    },

    /* 五.6：页面隐藏时暂停，恢复时继续（由 boot.js 的 visibilitychange 调） */
    setPaused(v) {
      this.paused = !!v;
      if (!this.paused) { this.acc = 0; this.rain = 0; }
    },

    /* 第四项：水波 Canvas 重置 —— 场清零、波源回池、画布擦净后重新播种 */
    reset() {
      if (!this.cur) return;
      this.cur.fill(0);
      this.prev.fill(0);
      for (let i = 0; i < this.pool.length; i++) this.pool[i].active = false;
      this.acc = 0;
      this.rain = 0;
      this.avgMs = 0;
      this.gain = 200;
      this.drawn = false;
      this.octx.clearRect(0, 0, this.pw, this.ph);
      this.offctx.clearRect(0, 0, this.w, this.h);
      this.seed();
      if (this.still) { this.warmupSteps(8); this.simStep(1 / this.baseRate, true); this.drawn = true; }
      this.metrics = this.snapshot();
    },

    /* 运行指标：复用同一个对象、不做格式化，保证帧内零分配（五.7） */
    snapshot() {
      const m = this.metrics || (this.metrics = {});
      m.scale = this.scale;
      m.cells = this.w * this.h;
      m.rate = this.rate;
      m.avgMs = this.avgMs;
      m.gain = this.gain;
      m.dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
      return m;
    }
  };

  const Water = {
    init() {
      this.layer = document.getElementById('bubbles');
      this.flash = document.getElementById('flash');
      this.sheen = document.getElementById('sheen');
      this.timers = [];
      Ripple.init();
      this.ready = true;
    },

    /* 由主循环驱动：只负责推进水波，透明度交给 CSS 的 --fall。
       入场白场上不需要它，那个判断放在 boot.js 的状态机里。 */
    update(dt) {
      Ripple.update(dt);
      if (Ripple.cur) Ripple.metrics = Ripple.snapshot();
    },

    setPaused(v) {
      Ripple.setPaused(v);
    },

    /* 入水冲击：白闪 + 涟漪环 + 气泡幕 (+ 波场重击) */
    splash() {
      this.flashNow(0.92, 260);
      this.rippleRing();
      this.burst(46);
      if (this.sheen) {
        this.sheen.classList.remove('is-pass');
        void this.sheen.offsetWidth;
        this.sheen.classList.add('is-pass');
      }
      /* 与 .splash-ring 的落点（left 26% / top 52%）对齐，画面与波场一致 */
      Ripple.impact(0.28, 0.52, 2.4);
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

    /* 第四项：ESC 重置时调用 —— 定时器、气泡、涟漪环、水波场全部归位 */
    reset() {
      this.timers.forEach((id) => window.clearTimeout(id));
      this.timers = [];
      if (this.layer) this.layer.innerHTML = '';
      document.querySelectorAll('.splash-ring').forEach((n) => n.remove());
      Ripple.reset();
    }
  };

  /* 无 @property 的引擎（--fall 无法被 CSS 动画插值）时的回退：由 JS 逐帧写值。
     写 documentElement 而不是 #world —— 正常路径的动画挂在 body 上，
     只有这样才能保证两条路径的继承范围完全一致。 */
  Water.syncFall = (p) => {
    document.documentElement.style.setProperty('--fall', clamp(p, 0, 1).toFixed(4));
  };

  /* 供自动化验证使用 */
  Water.ripple = Ripple;
  window.Water = Water;
})();
