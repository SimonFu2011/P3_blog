/* ============================================================
   扇形放射菜单
   ------------------------------------------------------------
   每项用外层 .fan-item 负责"极坐标定位 + 沿弧线旋出"，
   内层 .fan-link 负责悬停/选中的缩放与位移，两层互不干扰。
   ============================================================ */
(() => {
  'use strict';

  const Menu = {
    index: 0,
    items: [],
    fanned: false,
    spread: 1,
    retractTimer: 0,

    init() {
      this.list = document.getElementById('fanList');
      this.nav = document.getElementById('fan');
      this.cmdJp = document.getElementById('cmdJp');
      this.cmdEn = document.getElementById('cmdEn');
      const cfg = window.SITE;
      if (!this.list) return;

      const frag = document.createDocumentFragment();
      cfg.menu.forEach((item, i) => {
        const li = document.createElement('li');
        li.className = 'fan-item';
        li.style.setProperty('--angle', item.angle + 'deg');
        li.dataset.i = String(i);

        const a = document.createElement('a');
        a.className = 'fan-link';
        a.href = item.href || '#';
        a.dataset.i = String(i);
        a.setAttribute('aria-label', item.jp + ' / ' + item.en);
        a.innerHTML =
          '<span class="fi-jp">' + item.jp + '</span>' +
          '<span class="fi-en" aria-hidden="true">' + item.en + '</span>';

        a.addEventListener('mouseenter', () => this.setIndex(i, { silent: true }));
        a.addEventListener('focus', () => this.setIndex(i, { silent: true }));
        a.addEventListener('click', (e) => this.activate(i, e));

        li.appendChild(a);
        frag.appendChild(li);
        this.items.push({ el: li, link: a, data: item });
      });
      this.list.appendChild(frag);

      this.layout();
      /* 尺寸稳定后再算一次，避免字体加载/回流导致测量偏差 */
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.layout());
      window.addEventListener('resize', () => this.layout());
      this.setIndex(3);
      /* 入场态：菜单还没旋出，先把它整块关掉（Tab 顺序 + 命中测试） */
      this.setInteractive(false);
    },

    /* 菜单是否可操作。
       收起时 .fan-item 只是 opacity:0：它仍然在 Tab 顺序里、仍然能被命中，
       白场上就会冒出一批"看不见但按得动"的链接。
       inert 负责现代引擎（连读屏一起屏蔽），tabindex / pointer-events 兜底。 */
    setInteractive(on) {
      if (this.nav) {
        this.nav.inert = !on;
        this.nav.classList.toggle('is-open', on);
      }
      this.items.forEach(({ link }) => {
        if (on) link.removeAttribute('tabindex');
        else link.setAttribute('tabindex', '-1');
      });
    },

    /* 依据视口算扇形半径与张角。
       原点在 .fan 中心（left:40%），所以"塞得下"的条件是：
       半径 + 最长条目宽度 ≈ 屏幕右侧剩余空间 */
    layout() {
      const cfg = window.SITE.tuning;
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (!this.items.length) return;

      /* 窄屏改用纵向堆叠（弧线错位），硬挤扇形会把半径压成一小团 */
      const stacked = w < 820;
      if (this.nav) this.nav.classList.toggle('is-stacked', stacked);
      if (stacked) {
        this.spread = 1;
        this.metrics = { mode: 'stacked', w: w, h: h };
        return;
      }
      if (this.nav) this.nav.classList.remove('is-stacked');

      /* 用已建好的条目取角度，不要依赖外部配置对象 */
      const angles = this.items.map(({ data }) => Math.abs(Number(data.angle) || 0));
      const maxAngle = Math.max.apply(null, angles) * Math.PI / 180;

      /* 扇形原点：没有角色模型时整体左移，让菜单居中承压；
         若接入了 Cubism 模型则右移，给角色让出位置 */
      const hasModel = !!(window.Character && window.Character.mounted);
      const originRatio = hasModel ? 0.46 : 0.34;
      const originX = w * originRatio;
      if (this.nav) this.nav.style.setProperty('--fan-origin-x', (originRatio * 100).toFixed(1) + '%');
      const rightRoom = w - originX - 26;

      /* 先量最宽的一条，反推可用半径 */
      let widest = 0;
      this.items.forEach(({ link }) => {
        const r = link.getBoundingClientRect();
        if (r.width > widest) widest = r.width;
      });
      if (!widest) widest = w * 0.34;

      const roomForRadius = (rightRoom - widest) / Math.max(0.2, Math.cos(maxAngle));
      /* 纵向留白：最外侧条目落在 50% ± 0.29h 以内
         （半径 × sin(角度) = 纵向偏移，所以半径上限 = 0.29h / sin） */
      const verticalRoom = (h * 0.29) / Math.max(0.14, Math.sin(maxAngle));

      const base = clamp(
        Math.min(cfg.fanRadius * (w / 1440), roomForRadius, verticalRoom),
        w * 0.12,
        w * 0.44
      );
      this.spread = clamp((w / 1440) * (cfg.fanSpread || 1), 0.62, 1.2);
      const rot = '0deg';

      this.items.forEach(({ el, data }) => {
        el.style.setProperty('--fan-radius', (base * (data.radius || 1)).toFixed(1) + 'px');
        el.style.setProperty('--rot', rot);
        /* 沿弧线微倾，做出"放射"的跟随感，同时保持可读 */
        el.style.setProperty('--arc', (data.angle * 0.4).toFixed(2) + 'deg');
      });
      if (this.nav) this.nav.style.setProperty('--spread', this.spread.toFixed(3));

      /* 窄屏时整体缩小字号，避免横向溢出 */
      let fontScale = 1;
      const after = this.items.reduce((mx, { link }) => Math.max(mx, link.getBoundingClientRect().width), 0);
      const outermost = base * Math.cos(maxAngle) + after;
      if (outermost > rightRoom) fontScale = clamp(rightRoom / outermost, 0.5, 1);
      if (this.nav) this.nav.style.setProperty('--font-scale', fontScale.toFixed(3));
      this.metrics = { base: Math.round(base), widest: Math.round(widest), outermost: Math.round(outermost), rightRoom: Math.round(rightRoom), fontScale: Number(fontScale.toFixed(3)) };
    },

    /* 旋出：每条按序延迟，从"收在原点"到"落到弧线上" */
    fanOut() {
      if (this.fanned) return;
      this.fanned = true;
      window.clearTimeout(this.retractTimer);
      this.retractTimer = 0;
      this.items.forEach(({ el }, i) => {
        el.classList.remove('is-in');     // 上一次的收起动画可能还在跑
        el.style.animationDelay = (220 + i * 105) + 'ms';
        el.classList.add('is-out');
      });
      this.setInteractive(true);
    },

    /* 收起：走 fanIn 反向动画。
       原来只是把 is-out 摘掉，而 .fan-item 自己没有 transition ——
       菜单会在出水过程里"瞬移消失"，和 1.05s 的展开完全不对称。 */
    retract() {
      if (!this.fanned) return;
      this.fanned = false;
      this.setInteractive(false);
      window.clearTimeout(this.retractTimer);

      const n = this.items.length;
      this.items.forEach(({ el }, i) => {
        el.classList.remove('is-out');
        /* 错峰方向与展开相反：最先旋出的最后收回 */
        el.style.animationDelay = ((n - 1 - i) * 45) + 'ms';
        el.classList.add('is-in');
      });
      /* 动画结束后摘掉 is-in，让元素回到基态（opacity: 0）。
         不能留着：is-in 与 is-out 同优先级、靠后者胜，留着会让下一次
         fanOut 的 is-out 整个失效。 */
      this.retractTimer = window.setTimeout(() => {
        this.retractTimer = 0;
        this.items.forEach(({ el }) => {
          el.classList.remove('is-in');
          el.style.animationDelay = '';
        });
      }, 520 + n * 45);
    },

    setIndex(i, { silent = false } = {}) {
      if (!this.items.length) return;
      const n = this.items.length;
      this.index = ((i % n) + n) % n;
      this.items.forEach(({ el, link }, idx) => {
        const on = idx === this.index;
        el.classList.toggle('is-active', on);
        link.setAttribute('aria-current', on ? 'true' : 'false');
      });
      const d = this.items[this.index].data;
      if (this.cmdJp) this.cmdJp.textContent = d.desc || d.jp;
      if (this.cmdEn) this.cmdEn.textContent = d.en;
      if (!silent) this.pulse();
    },

    move(step) {
      this.setIndex(this.index + step);
    },

    pulse() {
      const el = this.items[this.index];
      if (!el) return;
      const link = el.link;
      link.classList.remove('is-pulse');
      void link.offsetWidth;
      link.classList.add('is-pulse');
    },

    activate(i, event) {
      const item = this.items[i];
      if (!item) return;
      this.setIndex(i);
      this.pulse();
      const href = item.data.href || '';
      /* 占位锚点（#xxx）不跳转，其余交给浏览器；接真实页面时无需改动 */
      if (href.startsWith('#')) {
        if (event) event.preventDefault();
        document.dispatchEvent(new CustomEvent('site:navigate', { detail: item.data }));
      }
    },

    /* 键盘 */
    handleKey(key, event) {
      /* 菜单收起/正在收起时不响应：否则出水过程中方向键会改动选中项，
         但画面上没有任何东西跟着动 */
      if (!this.fanned) return false;
      switch (key) {
        case 'ArrowDown': case 'ArrowRight': case 's':
          event.preventDefault(); this.move(1); return true;
        case 'ArrowUp': case 'ArrowLeft': case 'w':
          event.preventDefault(); this.move(-1); return true;
        case 'Enter': case ' ':
          event.preventDefault(); this.activate(this.index, event); return true;
        case 'Home':
          event.preventDefault(); this.setIndex(0); return true;
        case 'End':
          event.preventDefault(); this.setIndex(this.items.length - 1); return true;
        default: return false;
      }
    }
  };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  window.Menu = Menu;
})();
