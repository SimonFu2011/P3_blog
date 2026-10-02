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

        /* label 是主标签（中文），jp 只作为旧配置的兼容回退 */
        const label = item.label || item.jp || '';
        /* 占位项（href 是 # 或空）：跳转前先说明一句，避免看起来"点了没反应" */
        if (!item.href || item.href === '#') item.placeholder = true;

        const a = document.createElement('a');
        a.className = 'fan-link';
        a.href = item.href || '#';
        a.dataset.i = String(i);
        a.setAttribute('aria-label', label + ' / ' + item.en);
        a.innerHTML =
          '<span class="fi-jp">' + label + '</span>' +
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
      /* 初始选中项取"内容入口"（博客文章），不是第一项：
         落水后菜单是沿弧线依次旋出的，中间那条停在最稳的位置上。 */
      this.setIndex(this.defaultIndex());
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

    /* 初始选中项：优先找"博客文章"这条内容入口，找不到就取正中一条。
       写死索引在条目数变化时会指错，这里按语义定位。 */
    defaultIndex() {
      if (!this.items.length) return 0;
      const hit = this.items.findIndex(({ data }) => data.href && /archive\.html/.test(data.href));
      if (hit >= 0) return hit;
      return Math.floor((this.items.length - 1) / 2);
    },

    /* 依据视口算扇形半径与张角。
       原点在 .fan 中心（无角色模型时 42%，见下面的 originRatio），
       所以"塞得下"的条件是：
       原点 + 半径*cos(θ) + 条目自身宽度 ≤ 视口右边界 − 安全边距。

       注意是逐条解、取最小，而不是拿"全部条目里最宽的那条"一把套：
       条目越靠右，右边的余量越小，而扇形里一定有一条落在 0°（正右方）。
       用 max(width) 套任意角度，会把"角度大、其实更靠中间"的那条
       当成"最靠右"的那条，于是半径被压得过小 —— 之前就是这样：
       1440 下最右只剩 18px 余量，1600 以上直接溢出视口。 */
    layout() {
      const cfg = window.SITE.tuning;
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (!this.items.length) return;

      /* 选中项带 scale(1.06) 与 -0.1em 左移，两者都会把右边缘往外推，
         算半径时必须算进去 —— 贴边的往往正是选中项。
         宽度一律取 offsetWidth（布局盒，不含 transform），
         这样结果与"此刻有没有加 .is-active"无关，init 与 resize 两条
         路径量到的是同一组数。 */
      const ACTIVE_SCALE = 1.06;
      const layoutWidth = (el, link) => {
        const w0 = link.offsetWidth || link.getBoundingClientRect().width;
        return w0 * (el.classList.contains('is-active') ? ACTIVE_SCALE : 1);
      };

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
         若接入了 Cubism 模型则右移，给角色让出位置。
         0.34 → 0.40（窄屏再往右一点）：菜单从 7 项收到 3 项、字号又放大了
         1.4 倍之后，原来那个原点会把整块甩到画面右侧，
         左移之后视觉重心才回到画面中部、右边界也有安全距离。
         注意这里写的是 inline 变量，会盖掉 CSS 媒体查询 —— 所以断点必须
         在这里复现一份，CSS 里那两个值只是"脚本没跑"时的兜底。 */
      const hasModel = !!(window.Character && window.Character.mounted);
      const baseOrigin = w <= 900 ? 0.46 : (w <= 1100 ? 0.44 : 0.42);
      const originRatio = hasModel ? baseOrigin + 0.12 : baseOrigin;
      const originX = w * originRatio;
      if (this.nav) this.nav.style.setProperty('--fan-origin-x', (originRatio * 100).toFixed(1) + '%');
      const safety = 26;
      const rightRoom = w - originX - safety;

      /* 反推半径上限：对每一条分别解出"它自己能用的最大半径"，取最小值。
         第 i 条的右边缘 ≈ r*cos(θi) + 自己的宽度。
         角度直接读配置里的 data.angle，不要从 DOM 的 inline 变量反解析。 */
      let roomForRadius = Infinity;
      let widest = 0;
      this.items.forEach(({ el, link, data }) => {
        const own = layoutWidth(el, link);
        if (own > widest) widest = own;
        const a = Math.abs(Number(data.angle) || 0) * Math.PI / 180;
        const limit = (rightRoom - own) / Math.max(0.2, Math.cos(a));
        if (limit < roomForRadius) roomForRadius = limit;
      });
      if (!isFinite(roomForRadius)) roomForRadius = rightRoom;
      if (!widest) widest = w * 0.34;

      /* 纵向留白：最外侧条目落在 50% ± 0.29h 以内
         （半径 × sin(角度) = 纵向偏移，所以半径上限 = 0.29h / sin） */
      const verticalRoom = (h * 0.29) / Math.max(0.14, Math.sin(maxAngle));

      /* 宽屏会把扇形整体推远一点（--spread），而实际落的半径是
         base * spread —— 上面解出来的上限是"实际半径"的上限，
         所以换回 base 时要除掉 spread，否则宽屏上会算出超界的位置
         （1920 那版就是漏了这一步，最右一条溢出视口 4px）。 */
      this.spread = clamp((w / 1440) * (cfg.fanSpread || 1), 0.62, 1.2);

      const base = clamp(
        Math.min(cfg.fanRadius * (w / 1440) / this.spread, roomForRadius / this.spread, verticalRoom / this.spread),
        w * 0.12,
        w * 0.44
      );
      const rot = '0deg';

      this.items.forEach(({ el, data }) => {
        el.style.setProperty('--fan-radius', (base * (data.radius || 1)).toFixed(1) + 'px');
        el.style.setProperty('--rot', rot);
        /* 沿弧线微倾，做出"放射"的跟随感，同时保持可读 */
        el.style.setProperty('--arc', (data.angle * 0.4).toFixed(2) + 'deg');
      });
      if (this.nav) this.nav.style.setProperty('--spread', this.spread.toFixed(3));

      /* 窄屏时整体缩小字号，避免横向溢出（最后一次兜底：
         上面已经按条目宽度解过半径，这里只是给"极端字体回退"留保险） */
      let fontScale = 1;
      const after = this.items.reduce((mx, { el, link }) => Math.max(mx, layoutWidth(el, link)), 0);
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

    /* 第四项：ESC 重置时的硬收起。
       此刻画面已经淡出，不需要反向动画 —— 直接清干净回到"一条都没旋出"
       的初始态，下次入水时 fanOut 才能从头播一遍。 */
    reset() {
      window.clearTimeout(this.retractTimer);
      this.retractTimer = 0;
      this.fanned = false;
      this.items.forEach(({ el }) => {
        el.classList.remove('is-out', 'is-in');
        el.style.animationDelay = '';
      });
      this.setInteractive(false);
      this.setIndex(this.defaultIndex(), { silent: true });   // 回到初始选中项
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
      /* 占位锚点（#xxx / 空）：不跳转，只派发事件让外层决定做什么。
         真实页面（about.html 等）交给浏览器正常导航。 */
      if (href === '' || href.startsWith('#')) {
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
