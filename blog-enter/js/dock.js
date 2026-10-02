/* ============================================================
   菜单栏左侧的同心圆时钟 + 黑胶（第六项）
   ------------------------------------------------------------
   · 外圈：I–XII 罗马数字 + 时针 / 分针 / 秒针，按现实时间走
     （只在"分钟"变化时改写 aria-label，避免读屏每秒刷屏）
   · 指针造型照附图重画（.preview/handpath.py 量出的剖面 → index.html 的 d），
     角度写进 --rot-h / --rot-m / --rot-s，rotate 由 CSS 算 —— 直接写 SVG 的
     transform 属性会被 CSS 的 transform 盖掉，指针就不动了
   · 内圈：黑胶唱片持续旋转；中央是圆形裁切的专辑封面；歌名溢出省略
   · 2 倍尺寸：只由 CSS 的 --dial 决定，这里不写死任何像素
   · 3D：鼠标在时钟上移动时，表壳（#dialClock）正倾、黑胶（#dialVinyl）反倾、
     指针（#dialHands）取中间值 —— 三者是 .dial-scene 的同级子元素，
     共用同一份鼠标坐标与 perspective，所以同步且互不干扰。
     背景视差（--mx/--my 取负）方向与鼠标相反、幅度更小。
     所有写入都合并到一帧 rAF 里，只改 CSS 变量，不触发布局。
   · 拖拽播放：把本地音频拖到黑胶上即读取并播放；非音频给出提示且不播放；
     整块默认 pointer-events: none，只在拖拽期间打开落点。
   · 折叠：≤900px 默认收成小钟按钮，点击展开 / 收起；桌面端恒定展开。
   ============================================================ */
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ROMAN = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
  const CX = 120, CY = 120;      // 表盘圆心（viewBox 240×240）
  const NUM_R = 76;              // 罗马数字所在半径（色环内缘 79 之内）
  const RAIL_R0 = 53, RAIL_R1 = 90, RAIL_STEP = 3;   // 放射状阴影线：r 53~90，每 3 度一根
  const KNURL_R0 = 106, KNURL_R1 = 118, KNURL_STEP = 2;  // 表圈滚花细齿：r 112~118，每 2 度
  const COLLAPSE_MAX = 900;      // 窄于此宽度默认折叠

  /* 常见音频容器（含浏览器能解但不能解码的，交给 audio 元素自己判定） */
  const AUDIO_MIME = /^audio\//i;
  const AUDIO_EXT = /\.(mp3|wav|ogg|oga|opus|m4a|m4b|mp4a|aac|flac|weba|webm|aiff?|aif|mid|midi|wma|amr|3gp)$/i;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const pad2 = (n) => (n < 10 ? '0' + n : String(n));

  /* 指针角度 → CSS 变量（真正的 rotate 在 style.css 里算）。
     必须走变量而不是 SVG 的 transform 属性：CSS 的 transform 会整体盖掉
     属性，旧版就是这么把三根针钉在 12 点的。 */
  const setRot = (el, name, deg) => {
    if (el) el.style.setProperty(name, deg.toFixed(2) + 'deg');
  };

  /* 文件是不是音频：优先看 MIME，再退回扩展名（拖拽时 type 有时为空） */
  const isAudioFile = (file) => {
    if (!file) return false;
    const type = String(file.type || '');
    if (AUDIO_MIME.test(type)) return true;
    if (type && type !== 'application/octet-stream') return false;
    return AUDIO_EXT.test(file.name || '');
  };

  const formatBytes = (n) => {
    if (!n || n < 1024) return (n || 0) + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  };

  const stripExt = (name) => String(name || '').replace(/\.[^.]+$/, '') || '本地音频';

  /* ------------------------------------------------------------
     悬停 3D 倾斜 + 背景视差
     坐标只写到 .dial 上的 --mx / --my（-1..1），实际角度由 CSS 计算：
       .dial-clock → rotateX(--mx*7deg)   rotateY(--my*-7deg)
       .dial-vinyl → rotateX(--mx*-3.5deg) rotateY(--my*3.5deg)
     反号即"反向"，一半幅度避免混乱。拖动期间挂 .is-idle 让复位更缓。

     注意：.dock / .dial 是 pointer-events: none（只有黑胶与折叠按钮可命中），
     所以 pointermove 不能只挂在 .dial 上 —— 那样悬停在盘面空白处收不到事件。
     改成：window 上跟踪鼠标位置，再和 scene 的 rect 比对 —— 落在矩形内就
     按相对位置算倾斜（这才是真正的"进入"），落在矩形外就是"离开"并复位。
     额外再挂 scene 的 pointerleave 与 document 的 mouseleave 兜底。
     ------------------------------------------------------------ */
  const Motion = {
    dial: null,
    scene: null,
    raf: 0,
    dx: 0, dy: 0, tx: 0, ty: 0,
    hover: false,

    init(dial, scene) {
      this.dial = dial;
      this.scene = scene || dial;
      this.bind();
    },

    bind() {
      const scene = this.scene;
      if (!scene) return;

      const enter = () => {
        if (this.hover) return;
        this.hover = true;
        this.dial.classList.remove('is-idle');
        this.dial.classList.add('is-hover');
      };
      const leave = () => {
        this.hover = false;
        this.tx = 0; this.ty = 0;
        if (!this.dial) return;
        this.dial.classList.add('is-idle');
        this.dial.classList.remove('is-hover');
        this.schedule();
      };

      if (window.PointerEvent) {
        scene.addEventListener('pointerenter', (e) => {
          if (e.pointerType && e.pointerType !== 'mouse') return;
          enter();
        });
        /* 触屏 / 笔：不做倾斜与视差（第六项第 6 条的降级） */
        window.addEventListener('pointermove', (e) => {
          if (e.pointerType && e.pointerType !== 'mouse') return;
          this.track(e.clientX, e.clientY, enter);
        }, { passive: true });
      } else {
        scene.addEventListener('mouseenter', enter);
        window.addEventListener('mousemove', (e) => {
          this.track(e.clientX, e.clientY, enter);
        }, { passive: true });
      }

      scene.addEventListener('pointerleave', leave);
      document.addEventListener('mouseleave', leave);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) leave();
      });
    },

    /* 鼠标位置 → 归一化坐标；离开 scene 的矩形就复位 */
    track(x, y, enter) {
      const r = this.scene.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const nx = (x - r.left) / r.width - 0.5;
      const ny = (y - r.top) / r.height - 0.5;
      if (Math.abs(nx) > 0.5 || Math.abs(ny) > 0.5) {
        leave();
        return;
      }
      enter();
      this.tx = clamp(nx * 2, -1, 1);
      this.ty = clamp(ny * 2, -1, 1);
      this.schedule();
    },

    reset() {
      this.hover = false;
      this.tx = 0; this.ty = 0;
      this.dx = 0; this.dy = 0;
      if (this.dial) {
        this.dial.classList.add('is-idle');
        this.dial.classList.remove('is-hover');
      }
      this.schedule();
    },

    /* 供自动化验证读取内部状态（真实使用中不需要） */
    state() {
      return { hover: this.hover, dx: this.dx, dy: this.dy, tx: this.tx, ty: this.ty };
    },

    schedule() {
      if (!this.dial) return;
      /* 目标与当前都已经在原点 → 直接同步落定。
         rAF 在后台标签页 / 无头渲染里会被节流甚至暂停：如果连"复位"都只靠
         rAF，鼠标移开后可能长时间留在倾斜态。这里同步写一次，既保证一定
         复位，也少一帧延迟（CSS 的 transition 仍负责把视觉平滑收回去）。 */
      if (!this.hover && this.tx === 0 && this.ty === 0) {
        this.dx = 0;
        this.dy = 0;
        this.dial.style.setProperty('--mx', '0');
        this.dial.style.setProperty('--my', '0');
        return;
      }
      if (this.raf) return;
      this.raf = window.requestAnimationFrame(() => {
        this.raf = 0;
        /* 缓动：不是 1:1 跟手，才有重量感；离开时同样走这条曲线 */
        const k = this.hover ? 0.16 : 0.12;
        this.dx += (this.tx - this.dx) * k;
        this.dy += (this.ty - this.dy) * k;
        if (!this.hover && Math.abs(this.dx) < 0.0015 && Math.abs(this.dy) < 0.0015) {
          this.dx = 0; this.dy = 0;
        }
        const s = this.dial.style;
        s.setProperty('--mx', this.dx.toFixed(4));
        s.setProperty('--my', this.dy.toFixed(4));
      });
    }
  };

  /* ------------------------------------------------------------
     拖拽本地音频 → 黑胶播放
     默认 pointer-events: none（不与扇形菜单抢点击），
     只有 .dial.is-dragging 期间落点才接受 drop。
     dragenter/dragleave 会成对冒泡，用计数器避免闪断。
     ------------------------------------------------------------ */
  const DropZone = {
    dial: null,
    disc: null,
    depth: 0,
    onDrop: null,

    init(dial, disc, onDrop) {
      this.dial = dial;
      this.disc = disc;
      this.onDrop = onDrop;
      if (!dial) return;

      const hasFiles = (e) => {
        const t = e.dataTransfer && e.dataTransfer.types;
        return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0;
      };
      const stop = (e) => { e.preventDefault(); };

      const enter = (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        this.depth++;
        this.dial.classList.add('is-dragging');
      };
      const over = (e) => {
        if (!hasFiles(e)) return;
        /* 不 preventDefault 就不会触发 drop */
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      };
      const leave = () => {
        if (this.depth > 0) this.depth--;
        if (this.depth <= 0) this.clear();
      };

      /* 拽着文件停在唱片上：可能触发 dblclick，屏蔽掉避免误触播放 / 暂停 */
      const swallow = (e) => { if (this.depth > 0) e.preventDefault(); };

      window.addEventListener('dragenter', enter);
      window.addEventListener('dragover', over);
      window.addEventListener('dragleave', leave);
      window.addEventListener('dblclick', swallow);
      window.addEventListener('drop', (e) => {
        stop(e);                       // 阻止浏览器直接打开这个文件
        const wasDragging = this.depth > 0;
        const files = (e.dataTransfer && e.dataTransfer.files) || [];
        this.clear();
        /* 只有从唱片上拖进来的才处理：整页其它地方的 drop 保持原样 */
        if (!wasDragging || !this.onDrop) return;
        this.onDrop(files);
      });
    },

    clear() {
      this.depth = 0;
      if (this.dial) this.dial.classList.remove('is-dragging');
    },

    /* 非音频：抖一下唱片 + 红光，然后自动收掉 */
    reject() {
      if (!this.dial) return;
      this.dial.classList.remove('is-reject');
      void this.dial.offsetWidth;      // 强制回流，让动画能重播
      this.dial.classList.add('is-reject');
      window.setTimeout(() => this.dial.classList.remove('is-reject'), 620);
    }
  };

  const Dock = {
    active: false,
    collapsed: false,
    userExpanded: false,
    firstIntroDone: false,
    lastMinute: -1,
    timer: 0,
    warnTimer: 0,
    objectUrl: '',
    audio: null,
    track: { title: '暂无播放', artist: 'NO TRACK' },

    init() {
      this.el = document.getElementById('dock');
      if (!this.el) return false;
      this.dial = document.getElementById('dial');
      this.scene = document.getElementById('dialScene');
      this.clockLayer = document.getElementById('dialClock');
      this.vinylLayer = document.getElementById('dialVinyl');
      this.numerals = document.getElementById('dialNumerals');
      this.hourHand = document.getElementById('dialHour');
      this.minHand = document.getElementById('dialMin');
      this.secHand = document.getElementById('dialSec');
      this.vinyl = document.getElementById('vinyl');
      this.disc = this.el.querySelector('.vinyl-disc');
      this.cover = document.getElementById('vinylCover');
      this.titleEl = document.getElementById('vinylTitle');
      this.subEl = document.getElementById('vinylSub');
      this.toggle = document.getElementById('dockToggle');

      this.buildNumerals();
      this.buildRails();
      this.buildKnurl();
      this.applyMusic();
      this.bindToggle();
      this.bindPointer();
      this.bindDragAndDrop();
      this.syncCollapsed();
      this.resetVinyl();                 // 从一开始就转
      this.tick();
      this.loop();
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

    /* 放射状阴影线：3 度一根，只落在 r 54~90 的盘面区间。
       数量固定（120 根，静态 DOM），只压一道极淡的机械表盘质感。 */
    buildRails() {
      const g = this.dial && this.dial.querySelector('.dial-rails');
      if (!g) return;
      const frag = document.createDocumentFragment();
      for (let deg = 0; deg < 360; deg += RAIL_STEP) {
        const a = (deg - 90) * Math.PI / 180;
        const cos = Math.cos(a), sin = Math.sin(a);
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('class', 'dial-rail');
        line.setAttribute('x1', (CX + cos * RAIL_R0).toFixed(2));
        line.setAttribute('y1', (CY + sin * RAIL_R0).toFixed(2));
        line.setAttribute('x2', (CX + cos * RAIL_R1).toFixed(2));
        line.setAttribute('y2', (CY + sin * RAIL_R1).toFixed(2));
        frag.appendChild(line);
      }
      g.appendChild(frag);
    },

    /* 金属表圈的滚花细齿：2 度一根，明暗交替（一白一暗）做出机械倒角。
       180 根静态 DOM，画完就不再改。 */
    buildKnurl() {
      const g = this.dial && this.dial.querySelector('.dial-knurl');
      if (!g) return;
      const frag = document.createDocumentFragment();
      for (let deg = 0, i = 0; deg < 360; deg += KNURL_STEP, i++) {
        const a = (deg - 90) * Math.PI / 180;
        const cos = Math.cos(a), sin = Math.sin(a);
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('class', 'dial-knurl-line' + (i % 2 ? ' is-dark' : ''));
        line.setAttribute('x1', (CX + cos * KNURL_R0).toFixed(2));
        line.setAttribute('y1', (CY + sin * KNURL_R0).toFixed(2));
        line.setAttribute('x2', (CX + cos * KNURL_R1).toFixed(2));
        line.setAttribute('y2', (CY + sin * KNURL_R1).toFixed(2));
        frag.appendChild(line);
      }
      g.appendChild(frag);
    },

    /* 时钟：始终取现实时间；三根针的角度按真实角度算
       （时针含分钟的零头、分针含秒的零头、秒针含毫秒的零头），
       重置时也不清零时间本身（第四项第 5 条） */
    tick() {
      const d = new Date();
      const h = d.getHours();
      const m = d.getMinutes();
      const sec = d.getSeconds();
      const hourDeg = ((h % 12) + m / 60) * 30;
      const minDeg = (m + sec / 60) * 6;
      /* 含毫秒：秒针的 CSS 过渡因此每秒"跳"一格并带一点回弹 */
      const secDeg = (sec + d.getMilliseconds() / 1000) * 6;
      setRot(this.hourHand, '--rot-h', hourDeg);
      setRot(this.minHand, '--rot-m', minDeg);
      setRot(this.secHand, '--rot-s', secDeg);
      if (this.dial && m !== this.lastMinute) {
        this.lastMinute = m;
        this.dial.setAttribute('aria-label', '时钟：当前时间 ' + pad2(h) + ':' + pad2(m));
      }
    },

    /* 每一秒对齐到整秒再 tick（setInterval 会漂，秒针会偶尔跳两格） */
    loop() {
      this.timer = window.setTimeout(() => {
        this.tick();
        this.loop();
      }, 1000 - (Date.now() % 1000) + 4);
    },
    /* ---- 音乐信息：没有音源时走占位（第六项第 8 条） ---- */
    applyMusic() {
      const cfg = (window.SITE && window.SITE.music) || {};
      this.track = {
        title: cfg.title || '暂无播放',
        artist: cfg.artist || 'NO TRACK'
      };
      this.renderTrack();
      if (this.cover && cfg.cover) {
        const img = document.createElement('img');
        img.src = cfg.cover;
        img.alt = '';
        img.addEventListener('error', () => { img.remove(); });
        this.cover.textContent = '';
        this.cover.appendChild(img);
      }
      if (cfg.src) {
        /* 只建元素不播放：自动播放需要用户手势，见 playIfConfigured() */
        const audio = document.createElement('audio');
        audio.preload = 'none';
        audio.loop = true;
        audio.src = cfg.src;
        this.el.appendChild(audio);
        this.bindAudio(audio);
      }
      this.syncPlayingState();
    },

    renderTrack() {
      if (this.titleEl) this.titleEl.textContent = this.track.title;
      if (this.subEl) {
        this.clearWarn();
        this.subEl.textContent = this.track.artist;
      }
      if (this.vinyl) {
        this.vinyl.setAttribute('aria-label', '播放信息：' + this.track.title + ' / ' + this.track.artist);
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

    /* ---- 黑胶点击：播放 / 暂停（有音源时才有意义） ---- */
    togglePlay() {
      if (!this.audio) {
        this.notifyWarn('拖入音频文件即可播放');
        return;
      }
      if (this.audio.paused) {
        const p = this.audio.play();
        if (p && typeof p.catch === 'function') p.catch(() => this.notifyWarn('无法播放该文件'));
      } else {
        this.audio.pause();
      }
    },

    /* ---- 黑胶的旋转 / 发光跟着音频状态走 ---- */
    syncPlayingState() {
      const playing = !!(this.audio && !this.audio.paused && !this.audio.ended);
      if (this.disc) {
        this.disc.classList.toggle('is-playing', playing);
        this.disc.classList.toggle('is-spinning', playing);
      }
      if (this.vinyl) this.vinyl.setAttribute('data-playing', playing ? 'true' : 'false');
    },

    bindAudio(audio) {
      const onPlay = () => this.syncPlayingState();
      const onStop = () => this.syncPlayingState();
      const onError = () => this.notifyWarn('无法解码该音频');
      audio.addEventListener('play', onPlay);
      audio.addEventListener('playing', onPlay);
      audio.addEventListener('pause', onStop);
      audio.addEventListener('ended', onStop);
      audio.addEventListener('error', onError);
      audio.addEventListener('loadedmetadata', onStop);
      this.audio = audio;
    },

    /* ---- 拖拽：读取本地音频并播放 ---- */
    bindDragAndDrop() {
      DropZone.init(this.dial, this.disc, (files) => this.handleFiles(files));
    },

    handleFiles(files) {
      const list = Array.prototype.slice.call(files || []);
      if (!list.length) return;

      const audioFile = list.find ? list.find(isAudioFile) : null;
      if (!audioFile) {
        /* 非音频：不播放，给出明确提示 + 唱片抖一下 */
        const name = list[0] && list[0].name ? list[0].name : '该文件';
        this.notifyWarn('仅支持音频：' + this.truncate(name, 16));
        DropZone.reject();
        return;
      }
      this.loadFile(audioFile);
    },

    loadFile(file) {
      /* 上一次拖进来的临时 URL 记得回收（先停掉，免得已挂的源失效触发 error） */
      if (this.objectUrl) {
        if (this.audio) this.audio.pause();
        try { URL.revokeObjectURL(this.objectUrl); } catch (err) { /* 忽略 */ }
        this.objectUrl = '';
      }
      this.objectUrl = URL.createObjectURL(file);

      /* 已存在（配置里的）音源时直接换源：pause + 换 src 比换元素稳 */
      if (!this.audio) {
        const audio = document.createElement('audio');
        audio.preload = 'auto';
        audio.loop = true;
        this.el.appendChild(audio);
        this.bindAudio(audio);
      }
      this.audio.src = this.objectUrl;
      try { this.audio.currentTime = 0; } catch (err) { /* 未加载元数据时忽略 */ }

      this.track = {
        title: stripExt(file.name),
        /* 副标题走"格式 · 体积"，和旁边的等宽英文风格一致 */
        artist: (String(file.type || '').split('/')[1] || 'AUDIO').toUpperCase()
                + ' · ' + formatBytes(file.size)
      };
      this.renderTrack();

      const p = this.audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => this.notifyWarn('无法播放该文件'));
      }
      this.syncPlayingState();
    },

    /* ---- 提示：写在副标题位置（不新增浮层，不改变布局） ---- */
    notifyWarn(text) {
      if (!this.subEl) return;
      if (this.warnTimer) window.clearTimeout(this.warnTimer);
      this.subEl.textContent = text;
      this.subEl.classList.add('is-warn');
      this.warnTimer = window.setTimeout(() => {
        this.warnTimer = 0;
        this.subEl.classList.remove('is-warn');
        this.subEl.textContent = this.track.artist;
      }, 2600);
    },

    clearWarn() {
      if (this.warnTimer) {
        window.clearTimeout(this.warnTimer);
        this.warnTimer = 0;
      }
      if (this.subEl) this.subEl.classList.remove('is-warn');
    },

    truncate(s, n) {
      const str = String(s);
      return str.length > n ? str.slice(0, n - 1) + '…' : str;
    },

    /* ---- 鼠标：3D 倾斜 + 背景视差（触屏在 Motion 里被挡掉） ---- */
    bindPointer() {
      Motion.init(this.dial, this.scene);
      if (!this.disc) return;
      this.disc.addEventListener('click', () => this.togglePlay());
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
      if (this.collapsed) Motion.reset();      // 收起来就别留着倾斜
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
      if (this.active) {
        this.playIntro();
      } else {
        Motion.reset();
        DropZone.clear();
      }
    },

    /* ---- 夸张的首次入场：整套动画只在第一次入水播一次 ----
       再入水（ESC 重置后）只点亮，不重播，避免每次重置都被甩一下。
       动画结束就摘掉 .is-first —— 之后 .dial-sweep / .dialFlash 都不再命中。 */
    playIntro() {
      if (this.firstIntroDone) return;
      this.firstIntroDone = true;
      this.el.classList.add('is-first');
      const sweep = this.el.querySelector('.dial-sweep');
      const done = () => this.el.classList.remove('is-first');
      const target = sweep || this.el;
      target.addEventListener('animationend', done, { once: true });
      /* 兜底：万一动画被 prefers-reduced-motion 之类压成 0 时长 */
      window.setTimeout(done, 2600);
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
      this.syncPlayingState();
    },

    /* ---- 第四项：黑胶旋转归零（未播放时不转，播放中从头开始转） ---- */
    resetVinyl() {
      if (!this.disc) return;
      const wasSpinning = this.disc.classList.contains('is-spinning');
      if (!wasSpinning && !(this.audio && !this.audio.paused)) return;
      /* 唱片与中央封面标签同步转：标签是"贴"在唱片上的，各自跑 12s 线性的
         同一组关键帧就是同一角速度，不需要额外对齐 */
      [this.disc, this.cover].forEach((el) => {
        if (!el) return;
        el.classList.remove('is-spinning');
        void el.offsetWidth;             // 强制回流，让动画从 0 度重新开始
        el.classList.add('is-spinning');
      });
    },

    reset() {
      this.resetAudio();
      this.clearWarn();
      if (this.subEl) this.subEl.textContent = this.track.artist;
      if (this.disc) this.disc.classList.remove('is-playing');
      this.resetVinyl();
      this.userExpanded = false;
      Motion.reset();
      DropZone.clear();
      this.syncCollapsed();
      this.firstIntroDone = true;        // 夸张入场只给第一次入水
      this.lastMinute = -1;              // 下一次 tick 重写 aria-label
      this.tick();                       // 现实时间照常，不重置时间本身
    }
  };

  window.Dock = Dock;
  /* 倾斜 / 视差的内部状态，便于自动化验证读取（不参与界面逻辑） */
  window.Dock._motion = Motion;
})();
