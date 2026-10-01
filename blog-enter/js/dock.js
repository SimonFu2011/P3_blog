/* ============================================================
   菜单栏左侧的同心圆时钟 + 黑胶（第六项）
   ------------------------------------------------------------
   · 外圈：I–XII 罗马数字 + 时针 / 分针，按现实时间走
     （只在"分钟"变化时改写 aria-label，避免读屏每秒刷屏）
   · 内圈：黑胶唱片持续旋转；中央是圆形裁切的专辑封面；歌名溢出省略
   · 折叠：≤900px 默认收成小钟按钮，点击展开 / 收起；桌面端恒定展开
   · 音频：项目当前没有音源（data.js 的 music.src 为空），所以只渲染占位
     信息。reset() 负责第四项要求的"暂停并归零音频"与"黑胶旋转归零"——
     一旦填入 music.src，重置逻辑无需改动即可生效。
   ============================================================ */
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ROMAN = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
  const CX = 120, CY = 120;      // 表盘圆心（viewBox 240×240）
  const NUM_R = 75;              // 罗马数字所在半径（分段色环内缘 92 之内）
  const COLLAPSE_MAX = 900;      // 窄于此宽度默认折叠

  const pad2 = (n) => (n < 10 ? '0' + n : String(n));

  const Dock = {
    active: false,
    collapsed: false,
    userExpanded: false,
    lastMinute: -1,
    timer: 0,
    audio: null,

    init() {
      this.el = document.getElementById('dock');
      if (!this.el) return false;
      this.dial = document.getElementById('dial');
      this.numerals = document.getElementById('dialNumerals');
      this.hourHand = document.getElementById('dialHour');
      this.minHand = document.getElementById('dialMin');
      this.vinyl = document.getElementById('vinyl');
      this.disc = this.el.querySelector('.vinyl-disc');
      this.cover = document.getElementById('vinylCover');
      this.titleEl = document.getElementById('vinylTitle');
      this.subEl = document.getElementById('vinylSub');
      this.toggle = document.getElementById('dockToggle');

      this.buildNumerals();
      this.applyMusic();
      this.bindToggle();
      this.syncCollapsed();
      this.resetVinyl();                 // 从一开始就转
      this.tick();
      this.timer = window.setInterval(() => this.tick(), 1000);
      window.addEventListener('resize', () => this.syncCollapsed());
      this.setActive(false);             // 入场白场上没有它
      return true;
    },

    /* 罗马数字按真实角度摆一圈：i = 0 在正上方，之后顺时针 */
    buildNumerals() {
      if (!this.numerals) return;
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 12; i++) {
        const t = document.createElementNS(SVG_NS, 'text');
        const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
        t.setAttribute('class', 'dial-numeral');
        t.setAttribute('x', (CX + Math.cos(a) * NUM_R).toFixed(2));
        t.setAttribute('y', (CY + Math.sin(a) * NUM_R).toFixed(2));
        t.textContent = ROMAN[i];
        frag.appendChild(t);
      }
      this.numerals.appendChild(frag);
    },

    /* 时钟：始终取现实时间；重置时也不清零时间本身（第四项第 5 条） */
    tick() {
      const d = new Date();
      const h = d.getHours();
      const m = d.getMinutes();
      const sec = d.getSeconds();
      const hourDeg = ((h % 12) + m / 60) * 30;
      const minDeg = (m + sec / 60) * 6;
      if (this.hourHand) {
        this.hourHand.setAttribute('transform', 'rotate(' + hourDeg.toFixed(2) + ' ' + CX + ' ' + CY + ')');
      }
      if (this.minHand) {
        this.minHand.setAttribute('transform', 'rotate(' + minDeg.toFixed(2) + ' ' + CX + ' ' + CY + ')');
      }
      if (this.dial && m !== this.lastMinute) {
        this.lastMinute = m;
        this.dial.setAttribute('aria-label', '时钟：当前时间 ' + pad2(h) + ':' + pad2(m));
      }
    },

    /* 音乐信息：没有音源时走占位（第六项第 8 条） */
    applyMusic() {
      const cfg = (window.SITE && window.SITE.music) || {};
      const title = cfg.title || '暂无播放';
      const artist = cfg.artist || 'NO TRACK';
      if (this.titleEl) this.titleEl.textContent = title;
      if (this.subEl) this.subEl.textContent = artist;
      if (this.vinyl) {
        this.vinyl.setAttribute('aria-label', '播放信息：' + title + ' / ' + artist);
      }
      if (this.cover && cfg.cover) {
        const img = document.createElement('img');
        img.src = cfg.cover;
        img.alt = '';
        this.cover.textContent = '';
        this.cover.appendChild(img);
      }
      if (cfg.src) {
        /* 只建元素不播放：自动播放需要用户手势，见 playIfConfigured() */
        this.audio = document.createElement('audio');
        this.audio.preload = 'none';
        this.audio.src = cfg.src;
        this.el.appendChild(this.audio);
      }
    },

    /* 首次用户手势（入水）时才播放，浏览器策略与体验都要求如此 */
    playIfConfigured() {
      if (!this.audio) return;
      const p = this.audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => { /* 无音源或被策略拦下都无所谓 */ });
      }
    },

    /* ---- 折叠：窄屏默认收成小钟，用户手动展开后就记住 ---- */
    syncCollapsed() {
      const narrow = (window.innerWidth || 0) <= COLLAPSE_MAX;
      if (!narrow) {
        this.userExpanded = false;
        this.setCollapsed(false);
        return;
      }
      this.setCollapsed(!this.userExpanded);
    },

    setCollapsed(on) {
      this.collapsed = !!on;
      if (this.el) this.el.classList.toggle('is-collapsed', this.collapsed);
      if (this.toggle) {
        this.toggle.setAttribute('aria-expanded', this.collapsed ? 'false' : 'true');
        this.toggle.setAttribute('aria-label', this.collapsed ? '展开时钟与播放信息' : '收起时钟与播放信息');
      }
    },

    bindToggle() {
      if (!this.toggle) return;
      this.toggle.addEventListener('click', () => {
        this.userExpanded = this.collapsed;
        this.setCollapsed(!this.collapsed);
      });
    },

    /* ---- 可见性：入场 / 坠落时隐藏，入水完成后点亮 ---- */
    setActive(on) {
      this.active = !!on;
      if (!this.el) return;
      /* 先让焦点离开，再改 aria-hidden —— 否则会触发"隐藏了含焦点的子树"告警 */
      if (!this.active && this.el.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      this.el.classList.toggle('is-on', this.active);
      this.el.inert = !this.active;
      this.el.setAttribute('aria-hidden', this.active ? 'false' : 'true');
    },

    /* ---- 第四项：暂停并归零音频 ---- */
    resetAudio() {
      /* 页面上出现过的任何音源都暂停并回到起点；没有音源时是空操作 */
      document.querySelectorAll('audio, video').forEach((el) => {
        try {
          el.pause();
          el.currentTime = 0;
        } catch (err) {
          /* 某些浏览器在未加载元数据时给 currentTime 赋值会抛错，忽略 */
        }
      });
    },

    /* ---- 第四项：黑胶旋转归零 ---- */
    resetVinyl() {
      if (!this.disc) return;
      this.disc.classList.remove('is-spinning');
      void this.disc.offsetWidth;        // 强制回流，让动画从 0 度重新开始
      this.disc.classList.add('is-spinning');
    },

    reset() {
      this.resetAudio();
      this.resetVinyl();
      this.userExpanded = false;
      this.syncCollapsed();
      this.lastMinute = -1;              // 下一次 tick 重写 aria-label
      this.tick();                       // 现实时间照常，不重置时间本身
    }
  };

  window.Dock = Dock;
})();
