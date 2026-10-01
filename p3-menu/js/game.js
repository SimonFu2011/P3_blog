/* ============================================================
   PERSONA 3 STYLE MENU UI — 交互逻辑
   ------------------------------------------------------------
   键盘：↑ ↓ 选择 / Enter 决定 / Esc 返回 / 1-7 直跳 / M 音效
   鼠标：悬停即选中（P3 手感）/ 点击决定
   ============================================================ */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const clamp01 = (v) => clamp(v, 0, 1);
  const pad2 = (n) => String(n).padStart(2, '0');

  /* ==========================================================
     1. 音效（Web Audio 实时合成，无需音频文件）
     ========================================================== */
  const Sfx = (() => {
    let ctx = null;
    let master = null;
    let enabled = false;

    const ensure = () => {
      if (!enabled) return null;
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.16;
        master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    };

    /** 一个带包络的振荡器音符 */
    const tone = (freq, dur, type = 'triangle', gain = 1, delay = 0, glideTo = null) => {
      const c = ensure();
      if (!c) return;
      const t0 = c.currentTime + delay;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    };

    /** 短促噪声，用来做「沙」的切换质感 */
    const noise = (dur, gain = 0.4, delay = 0, freq = 1800) => {
      const c = ensure();
      if (!c) return;
      const t0 = c.currentTime + delay;
      const len = Math.max(1, Math.floor(c.sampleRate * dur));
      const buf = c.createBuffer(1, len, c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = c.createBufferSource();
      src.buffer = buf;
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = 0.9;
      const g = c.createGain();
      g.gain.value = gain;
      src.connect(bp).connect(g).connect(master);
      src.start(t0);
    };

    return {
      get enabled() { return enabled; },
      toggle() {
        enabled = !enabled;
        if (enabled) { ensure(); this.confirm(); }
        return enabled;
      },
      /** 光标移动 */
      move() {
        tone(760, 0.075, 'square', 0.5);
        noise(0.05, 0.22, 0, 2600);
      },
      /** 决定 */
      confirm() {
        tone(523.25, 0.09, 'square', 0.55);
        tone(783.99, 0.16, 'triangle', 0.6, 0.06);
        tone(1046.5, 0.26, 'triangle', 0.35, 0.12);
      },
      /** 返回 / 取消 */
      cancel() {
        tone(392, 0.1, 'sawtooth', 0.4);
        tone(261.63, 0.22, 'triangle', 0.45, 0.07);
      },
      /** 界面切换 */
      swipe() {
        noise(0.34, 0.5, 0, 1200);
        tone(180, 0.3, 'sine', 0.5, 0, 70);
      },
      /** 启动 */
      boot() {
        [329.63, 415.3, 493.88, 659.25].forEach((f, i) => tone(f, 0.9, 'triangle', 0.35, i * 0.14));
        tone(82.41, 1.8, 'sine', 0.5, 0);
        noise(0.7, 0.3, 0.2, 900);
      },
      /** 明暗 / 边缘提示 */
      deny() {
        tone(150, 0.22, 'square', 0.4);
      }
    };
  })();

  /* ==========================================================
     2. 数据
     ========================================================== */
  const NAV = [
    { id: 'status', jp: 'ステータス', en: 'STATUS', desc: '確認身體能力與裝備。檢查你的戰鬥準備。', impl: true },
    { id: 'persona', jp: 'ペルソナ', en: 'PERSONA', desc: '召喚並培養你的另一面。查閱屬性耐性與技能。', impl: true },
    { id: 'items', jp: 'アイテム', en: 'ITEMS', desc: '整理隨身道具與回復藥。影時間的必需品。', impl: false },
    { id: 'equip', jp: 'そうび', en: 'EQUIPMENT', desc: '更換武器、防具與飾品。提升生存能力。', impl: false },
    { id: 'quest', jp: 'クエスト', en: 'QUESTS', desc: '查看委託與依賴。完成後可獲得報酬。', impl: false },
    { id: 'social', jp: 'コミュ', en: 'SOCIAL LINK', desc: '與他人建立羈絆。羈絆將化為力量。', impl: false },
    { id: 'system', jp: 'システム', en: 'SYSTEM', desc: '保存、設定與回到標題畫面。', impl: false }
  ];

  const AFF_KEYS = ['物', '火', '冰', '電', '風', '光', '闇'];
  const AFF_CLASS = { '弱': 'weak', '耐': 'resist', '無': 'null', '—': 'neutral' };
  const STAT_KEYS = ['力', '魔', '耐', '速', '運'];
  const STAT_EN = { '力': 'STR', '魔': 'MAG', '耐': 'END', '速': 'AGI', '運': 'LUK' };

  const PERSONAS = [
    {
      no: 0, jp: 'オルフェウス', en: 'ORPHEUS', arcana: '愚者 · FOOL', lv: 3,
      stats: { '力': 8, '魔': 14, '耐': 7, '速': 11, '運': 6 },
      aff: { '物': '—', '火': '弱', '冰': '—', '電': '—', '風': '—', '光': '—', '闇': '弱' },
      moves: [
        { name: 'アギ', cost: 'SP 3', note: '火炎属性・小ダメージ' },
        { name: 'バッシュ', cost: 'HP 7%', note: '物理属性・小ダメージ' }
      ]
    },
    {
      no: 1, jp: 'ピクシー', en: 'PIXIE', arcana: '恋愛 · LOVERS', lv: 2,
      stats: { '力': 3, '魔': 9, '耐': 4, '速': 12, '運': 10 },
      aff: { '物': '—', '火': '—', '冰': '—', '電': '弱', '風': '耐', '光': '—', '闇': '—' },
      moves: [
        { name: 'ジオ', cost: 'SP 4', note: '電撃属性・小ダメージ' },
        { name: 'ディア', cost: 'SP 4', note: 'HP を小幅回復' }
      ]
    },
    {
      no: 2, jp: 'ジャックフロスト', en: 'JACK FROST', arcana: '魔術師 · MAGICIAN', lv: 8,
      stats: { '力': 6, '魔': 18, '耐': 9, '速': 8, '運': 7 },
      aff: { '物': '—', '火': '弱', '冰': '無', '電': '—', '風': '—', '光': '—', '闇': '—' },
      moves: [
        { name: 'ブフ', cost: 'SP 5', note: '氷結属性・小ダメージ' },
        { name: 'マハブフ', cost: 'SP 10', note: '敵全体に氷結・小' },
        { name: 'ラクカジャ', cost: 'SP 8', note: '味方全体の防御力上昇' }
      ]
    },
    {
      no: 3, jp: 'フォルネウス', en: 'FORNEUS', arcana: '皇帝 · EMPEROR', lv: 12,
      stats: { '力': 13, '魔': 15, '耐': 14, '速': 9, '運': 8 },
      aff: { '物': '耐', '火': '—', '冰': '耐', '電': '弱', '風': '—', '光': '—', '闇': '—' },
      moves: [
        { name: 'アギラオ', cost: 'SP 8', note: '火炎属性・中ダメージ' },
        { name: 'メディア', cost: 'SP 12', note: '味方全体を小幅回復' }
      ]
    },
    {
      no: 4, jp: 'アラミタマ', en: 'ARAMITAMA', arcana: '隠者 · HERMIT', lv: 15,
      stats: { '力': 17, '魔': 10, '耐': 16, '速': 12, '運': 13 },
      aff: { '物': '耐', '火': '—', '冰': '—', '電': '—', '風': '弱', '光': '—', '闇': '—' },
      moves: [
        { name: 'クラック', cost: 'HP 9%', note: '物理属性・中ダメージ' },
        { name: 'スクカジャ', cost: 'SP 8', note: '味方全体の命中回避上昇' }
      ]
    },
    {
      no: 5, jp: 'ヴァルキリー', en: 'VALKYRIE', arcana: '女教皇 · PRIESTESS', lv: 21,
      stats: { '力': 22, '魔': 17, '耐': 19, '速': 20, '運': 12 },
      aff: { '物': '耐', '火': '—', '冰': '—', '電': '耐', '風': '弱', '光': '—', '闇': '—' },
      moves: [
        { name: 'アサルトダイブ', cost: 'HP 12%', note: '物理属性・大ダメージ' },
        { name: 'マハジオ', cost: 'SP 12', note: '敵全体に電撃・小' },
        { name: 'タルカジャ', cost: 'SP 8', note: '味方全体の攻撃力上昇' }
      ]
    }
  ];

  /* ==========================================================
     3. DOM 引用
     ========================================================== */
  const bootEl = $('#boot');
  const bootPct = $('#bootPct');
  const bootKana = $('#bootKana');
  const veil = $('#veil');

  const screens = {
    title: $('#screen-title'),
    menu: $('#screen-menu'),
    status: $('#screen-status'),
    persona: $('#screen-persona'),
    placeholder: $('#screen-placeholder')
  };

  const navEl = $('#mainNav');
  const navItems = $$('.nav-item', navEl);
  const navInfo = $('#navInfo');
  const infoKana = $('#infoKana');
  const infoTitle = $('#infoTitle');
  const infoDesc = $('#infoDesc');

  const soundToggle = $('#soundToggle');
  const personaList = $('#personaList');
  const clockEls = $$('.js-clock');
  const titleClock = $('#titleClock');

  /* ==========================================================
     4. 状态
     ========================================================== */
  let currentScreen = 'title';
  let navIndex = 0;
  let personaIndex = 0;
  let busy = false;
  let statusPlayed = false;
  const numberTimers = new WeakMap();

  /* ==========================================================
     5. 视觉反馈
     ========================================================== */
  const flash = () => {
    veil.classList.remove('is-flash');
    void veil.offsetWidth;
    veil.classList.add('is-flash');
  };

  const swapInfo = (i) => {
    const item = NAV[i];
    infoKana.textContent = item.jp;
    infoTitle.textContent = item.en;
    infoDesc.textContent = item.desc;
    navInfo.classList.remove('is-swap');
    void navInfo.offsetWidth;
    navInfo.classList.add('is-swap');
  };

  const setNavIndex = (i, { silent = false, animate = true } = {}) => {
    const next = (i + navItems.length) % navItems.length;
    if (next === navIndex && navItems[navIndex].classList.contains('is-selected')) return;
    navIndex = next;
    navItems.forEach((el, idx) => el.classList.toggle('is-selected', idx === navIndex));
    if (animate) swapInfo(navIndex);
    else {
      const item = NAV[navIndex];
      infoKana.textContent = item.jp;
      infoTitle.textContent = item.en;
      infoDesc.textContent = item.desc;
    }
    if (!silent) Sfx.move();
  };

  /* ==========================================================
     6. 数字滚动
     ========================================================== */
  const countTo = (el, target, { duration = 900, suffix = '' } = {}) => {
    const prev = numberTimers.get(el);
    if (prev) cancelAnimationFrame(prev);
    const start = performance.now();
    const step = (now) => {
      const p = clamp01((now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      if (p >= 1) {
        // 终值兜底：无论 rAF 是否被节流，最终都落到正确数字
        el.textContent = suffix + target;
        numberTimers.delete(el);
        return;
      }
      el.textContent = suffix + Math.round(target * eased);
      numberTimers.set(el, requestAnimationFrame(step));
    };
    el.textContent = suffix + 0;
    numberTimers.set(el, requestAnimationFrame(step));
    // 后台标签页里 rAF 可能完全不触发，补一个超时兜底
    window.setTimeout(() => {
      if (numberTimers.has(el)) {
        cancelAnimationFrame(numberTimers.get(el));
        numberTimers.delete(el);
        el.textContent = suffix + target;
      }
    }, duration + 260);
  };

  const animateBars = () => {
    $$('[data-bar]').forEach((row) => {
      const fill = $('.bar-fill', row);
      const valEl = $('[data-val]', row);
      const value = Number(fill.dataset.w);
      const max = Number(fill.dataset.max);
      const pct = (clamp01(value / max) * 100).toFixed(1) + '%';
      // 先归零，再在下一帧设为目标值，触发 width 过渡
      fill.style.setProperty('--pct', '0%');
      const apply = () => fill.style.setProperty('--pct', pct);
      requestAnimationFrame(() => requestAnimationFrame(apply));
      // rAF 被节流（后台标签页 / 无头虚拟时钟）时也要落到正确宽度
      window.setTimeout(apply, 160);
      if (valEl) countTo(valEl, value, { duration: 1150 });
    });
  };

  const animateStats = () => {
    const stats = $$('#statList .stat');
    stats.forEach((el, i) => {
      const num = $('.st-num', el);
      const target = Number(el.dataset.val);
      num.textContent = '0';
      setTimeout(() => {
        countTo(num, target, { duration: 620 });
        el.classList.add('is-hot');
        setTimeout(() => el.classList.remove('is-hot'), 700);
      }, 120 + i * 90);
    });
  };

  /* ==========================================================
     7. 界面切换
     ========================================================== */
  const showScreen = (name, { boot: isBoot = false } = {}) => {
    if (!screens[name] || busy || name === currentScreen) return;
    busy = true;
    swapInfo(navIndex) // 保持信息面板同步
    flash();
    Sfx.swipe();

    const from = screens[currentScreen];
    const to = screens[name];
    if (from) {
      from.classList.remove('is-active');
      from.classList.add('is-leaving');
      from.setAttribute('aria-hidden', 'true');
    }

    window.setTimeout(() => {
      if (from) from.classList.remove('is-leaving');
      to.classList.add('is-active');
      to.removeAttribute('aria-hidden');
      currentScreen = name;

      if (name === 'status') {
        if (!statusPlayed) {
          statusPlayed = true;
          animateBars();
          animateStats();
        } else {
          animateBars();
        }
      }
      if (name === 'persona') renderPersona(personaIndex, { silent: true });
      if (name === 'placeholder') Sfx.move();
      busy = false;
    }, isBoot ? 0 : 220);
  };

  /* ==========================================================
     8. 主菜单交互
     ========================================================== */
  const activateNav = () => {
    const item = NAV[navIndex];
    if (!item) return;
    Sfx.confirm();
    if (item.impl) {
      showScreen(item.id);
      return;
    }
    // 未实装界面 → 占位页
    $('#phLabel').textContent = item.en;
    $('#phJp').textContent = item.jp;
    $('#phEn').textContent = item.en;
    $('#phDesc').textContent = '「' + item.en + '」画面はまだ実装されていません。';
    showScreen('placeholder');
  };

  navItems.forEach((el, i) => {
    el.addEventListener('mouseenter', () => {
      if (currentScreen !== 'menu') return;
      setNavIndex(i);
    });
    el.addEventListener('mousedown', () => {
      // 点击前先同步光标，保证鼠标与键盘一致
      if (currentScreen === 'menu' && i !== navIndex) setNavIndex(i);
    });
    el.addEventListener('click', () => {
      if (currentScreen !== 'menu') return;
      if (i !== navIndex) setNavIndex(i);
      activateNav();
    });
  });

  /* ==========================================================
     9. 人格面具界面
     ========================================================== */
  const buildPersonaList = () => {
    const frag = document.createDocumentFragment();
    PERSONAS.forEach((p, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pcard';
      btn.setAttribute('role', 'tab');
      btn.dataset.index = String(i);
      btn.style.animationDelay = (i * 60) + 'ms';
      btn.innerHTML =
        '<span class="pcard-arcana-num">' + pad2(p.no) + '</span>' +
        '<span class="pcard-name">' +
        '<span class="pcard-jp">' + p.jp + '</span>' +
        '<span class="pcard-en">' + p.en + '</span>' +
        '</span>' +
        '<span class="pcard-lv">LV ' + p.lv + '</span>';
      btn.addEventListener('mouseenter', () => {
        if (currentScreen !== 'persona') return;
        renderPersona(i);
      });
      btn.addEventListener('click', () => {
        if (currentScreen !== 'persona') return;
        renderPersona(i);
        Sfx.confirm();
      });
      li.appendChild(btn);
      frag.appendChild(li);
    });
    personaList.appendChild(frag);
  };

  const renderPersona = (index, { silent = false } = {}) => {
    const p = PERSONAS[(index + PERSONAS.length) % PERSONAS.length];
    personaIndex = PERSONAS.indexOf(p);

    const cards = $$('.pcard', personaList);
    const changed = cards[personaIndex] && !cards[personaIndex].classList.contains('is-selected');
    cards.forEach((c, i) => {
      c.classList.toggle('is-selected', i === personaIndex);
      c.setAttribute('aria-selected', i === personaIndex ? 'true' : 'false');
    });
    if (changed && !silent) Sfx.move();

    $('#pdNo').textContent = pad2(p.no);
    $('#pdNameJp').textContent = p.jp;
    $('#pdNameEn').textContent = p.en;
    $('#pdArcana').textContent = p.arcana;
    $('#pdLevel').textContent = String(p.lv);

    // 参数条
    const statsHost = $('#pdStats');
    statsHost.innerHTML = STAT_KEYS.map((k) => {
      const v = p.stats[k];
      return '<div class="pd-stat">' +
        '<span class="pd-stat-name">' + STAT_EN[k] + '</span>' +
        '<span class="pd-stat-bar"><i style="--pct:' + clamp01(v / 30) * 100 + '%"></i></span>' +
        '<span class="pd-stat-num">' + v + '</span>' +
        '</div>';
    }).join('');

    // 属性耐性
    $('#pdAffinity').innerHTML = AFF_KEYS.map((k) => {
      const v = p.aff[k];
      return '<div class="aff ' + (AFF_CLASS[v] || 'neutral') + '">' +
        '<span class="aff-e">' + k + '</span><span class="aff-v">' + v + '</span>' +
        '</div>';
    }).join('');

    // 技能
    $('#pdMoves').innerHTML = p.moves.map((m, i) =>
      '<li style="animation-delay:' + (i * 70) + 'ms">' +
      '<span class="mv-name">' + m.name + '</span>' +
      '<span class="mv-note">' + m.note + '</span>' +
      '<span class="mv-cost">' + m.cost + '</span>' +
      '</li>'
    ).join('');

    // 图形颜色随属性变化
    const shape = $('#pdFigureShape');
    if (shape) {
      const hue = { 0: '#4de8ff', 1: '#8bf07a', 2: '#9df3ff', 3: '#ff9a5c', 4: '#ffc247', 5: '#ff6ea8' }[p.no] || '#4de8ff';
      shape.querySelectorAll('[stroke]').forEach((n, i) => {
        if (i === 0) n.setAttribute('stroke', hue);
      });
      const dot = shape.querySelector('circle');
      if (dot) dot.setAttribute('stroke', hue);
    }
  };

  /* ==========================================================
     10. 键盘
     ========================================================== */
  const back = () => {
    if (currentScreen === 'title') return;
    Sfx.cancel();
    showScreen('menu');
  };

  window.addEventListener('keydown', (e) => {
    const key = e.key;

    if (key === 'm' || key === 'M') {
      const on = Sfx.toggle();
      soundToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      return;
    }

    if (currentScreen === 'title') {
      if (key === 'Enter' || key === ' ' || key === 'ArrowRight') {
        e.preventDefault();
        Sfx.confirm();
        showScreen('menu');
      }
      return;
    }

    if (busy) return;

    switch (key) {
      case 'ArrowDown':
      case 'ArrowRight':
      case 's':
        e.preventDefault();
        if (currentScreen === 'menu') setNavIndex(navIndex + 1);
        else if (currentScreen === 'persona') renderPersona(personaIndex + 1);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
      case 'w':
        e.preventDefault();
        if (currentScreen === 'menu') setNavIndex(navIndex - 1);
        else if (currentScreen === 'persona') renderPersona(personaIndex - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (currentScreen === 'menu') activateNav();
        else if (currentScreen === 'persona') { renderPersona(personaIndex); Sfx.confirm(); }
        break;
      case 'Escape':
      case 'Backspace':
        e.preventDefault();
        back();
        break;
      default:
        // 1-7 直跳菜单
        if (currentScreen === 'menu' && /^[1-7]$/.test(key)) {
          setNavIndex(Number(key) - 1);
          activateNav();
        }
    }
  });

  /* ==========================================================
     11. 顶部按钮 / 时钟
     ========================================================== */
  soundToggle.addEventListener('click', () => {
    const on = Sfx.toggle();
    soundToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
  });

  $('#phBack').addEventListener('click', back);
  $('#screen-placeholder').addEventListener('click', (e) => {
    if (e.target.id === 'screen-placeholder') back();
  });

  const tick = () => {
    const d = new Date();
    const t = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    if (titleClock) titleClock.textContent = t;
    clockEls.forEach((el) => { el.textContent = t; });
  };
  tick();
  window.setInterval(tick, 1000);

  /* ==========================================================
     12. 启动流程
     ========================================================== */
  const runBoot = () => {
    const KANA = ['ペルソナ', 'ペルソナ スリー'];
    let pct = 0;
    let kanaStep = 0;
    soundToggle.setAttribute('aria-pressed', 'false');

    const timer = window.setInterval(() => {
      pct = Math.min(100, pct + 2 + Math.random() * 7);
      bootPct.textContent = pad2(Math.floor(pct));
      if (pct > 48 && kanaStep === 0) { kanaStep = 1; bootKana.textContent = KANA[1]; }
      if (pct >= 100) {
        window.clearInterval(timer);
        window.setTimeout(() => {
          bootEl.classList.add('is-done');
          document.body.classList.remove('is-booting');
        }, 320);
      }
    }, 70);
  };

  buildPersonaList();
  setNavIndex(0, { silent: true, animate: false });
  renderPersona(0, { silent: true });
  runBoot();

  // 提前预热音频（首次用户手势时解锁）
  const unlock = () => {
    if (Sfx.enabled) Sfx.move();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
})();
