/* ============================================================
   入场时序 + 主循环 + ESC 全局重置
   ------------------------------------------------------------
   入场：纯白 + 细微波纹
   ↓ ENTER / 空格 / 滚轮下滑 / 点箭头
   坠落：波纹扩散 → 水位上升（--fall 0→1 由 CSS 时间轴推进）
         → 入水冲击 → 扇形展开 + 左侧时钟点亮
   ↓ ESC
   淡出 250ms → 完整重置（菜单 / 滚动 / 首屏动画 / 音频 / 水波 / 黑胶）
         → 回到"刚打开网页"的初始界面

   角色小人已移除。坠落本身现在是纯屏幕级效果：
   --fall 用 @property 注册成数值，CSS animation 直接把它从 0 推到 1，
   这样即使 JS 被节流，水位也一定会落到终值。
   ============================================================ */
(() => {
  'use strict';

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* 单个模块初始化失败不该让整页失去交互 */
  const safe = (name, fn) => {
    try {
      fn();
    } catch (err) {
      console.error('[boot] ' + name + ' 失败:', err);
    }
  };

  /* 浏览器是否支持把自定义属性注册成可动画的数值类型 */
  const supportsAnimatableProperty = () => {
    if (typeof CSS === 'undefined' || typeof CSS.registerProperty !== 'function') return false;
    try {
      CSS.registerProperty({
        name: '--fall-probe',
        syntax: '<number>',
        inherits: true,
        initialValue: 0
      });
      return true;
    } catch (err) {
      /* 重复注册也会抛错，说明支持 */
      return true;
    }
  };

  const RESET_FADE = 250;   // 第四项：ESC 淡出时长（200–300ms，默认 250）

  const Boot = {
    state: 'entry',          // entry | falling | settled | resetting
    fallStart: 0,
    fallDur: 2400,
    splashAt: 0,
    raf: 0,
    last: 0,
    reduced: false,

    start() {
      const cfg = window.SITE;
      this.fallDur = cfg.tuning.fallDuration;
      this.splashAt = this.fallDur * 0.56;
      this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      /* 把坠落时长交给 CSS（它负责把 --fall 从 0 推到 1） */
      document.documentElement.style.setProperty('--fall-dur', this.fallDur + 'ms');

      this.applyStaticCopy();

      /* 逐个模块启动并各自兜底：任何一个出问题都不该让整页失去交互 */
      safe('Water', () => Water.init());
      safe('Menu', () => Menu.init());
      safe('Character', () => Character.init());
      safe('Dock', () => Dock.init());

      this.body = document.body;
      safe('input', () => this.bindInput());
      safe('visibility', () => this.bindVisibility());
      this.last = performance.now();
      this.loop();

      /* 入场时让水面有一层缓慢的横向光带 */
      window.setTimeout(() => this.body.classList.add('is-idle'), 900);
    },

    applyStaticCopy() {
      const cfg = window.SITE;
      const $ = (s) => document.querySelector(s);
      const nameEl = $('.entry-name');
      if (nameEl) {
        nameEl.textContent = cfg.name;
        /* ::after 用 attr(data-text) 复制同一段文字做字形遮罩，必须同步，
           否则标题上的波线会错位 */
        nameEl.setAttribute('data-text', cfg.name);
      }
      const tagEl = $('.entry-tag');
      if (tagEl) tagEl.textContent = cfg.tagline;
      if ($('#cmdJp')) $('#cmdJp').textContent = cfg.command.jp;
      if ($('#cmdEn')) $('#cmdEn').textContent = cfg.command.en;

      const keys = $('#cmdbar .cmd-keys');
      if (keys && cfg.hints) {
        keys.innerHTML = cfg.hints.map((h) =>
          '<span class="ck"><b>' + h.key + '</b>' + h.text + '</span>').join('');
      }
      const credit = $('.credit');
      if (credit) credit.textContent = cfg.footer;
    },

    /* ---------------- 输入 ---------------- */
    bindInput() {
      const onWheel = (e) => {
        if (this.state === 'entry' && e.deltaY > 2) {
          e.preventDefault();
          this.dive();
        }
      };
      window.addEventListener('wheel', onWheel, { passive: false });

      window.addEventListener('keydown', (e) => {
        const k = e.key;
        /* 重置过程中不接受任何输入：防止重复触发（第四项第 5 条） */
        if (this.state === 'resetting') return;

        if (this.state === 'entry') {
          if (k === 'Enter' || k === ' ' || k === 'ArrowDown') {
            e.preventDefault();
            this.dive();
          }
          return;
        }

        /* 全局 ESC：任何非初始状态都能一键回到初始界面 */
        if (k === 'Escape') {
          this.exitToEntry();
          return;
        }
        if (this.state === 'falling') return;
        Menu.handleKey(k, e);
      });

      const btn = document.getElementById('enterArrow');
      if (btn) {
        /* 只用 click：键盘的 Enter/Space 已由全局 keydown 处理。
           dive() 自带 state 守卫，所以两者同时触发也只入水一次。 */
        btn.addEventListener('click', () => this.dive());
      }

      document.addEventListener('site:navigate', (e) => {
        /* 占位：接真实页面时把这里换成路由跳转 */
        console.log('[navigate]', e.detail.en, e.detail.href);
      });
    },

    /* 二.6 / 五.6：页面隐藏时暂停"持续波动"的动画与水波，回来再继续 */
    bindVisibility() {
      const apply = () => {
        const hidden = document.hidden;
        this.body.classList.toggle('is-page-hidden', hidden);
        Water.setPaused(hidden);
      };
      document.addEventListener('visibilitychange', apply);
      apply();
    },

    /* ---------------- 入水 ---------------- */
    dive() {
      if (this.state !== 'entry') return;
      this.state = 'falling';
      this.body.classList.add('is-falling');
      this.body.classList.remove('is-entry', 'is-idle');

      /* 白闪 → 收束 */
      Water.flashNow(0.55, 180);
      this.hideEntry();

      /* 波纹扩散：从落点把整页"染"成水 */
      const world = document.getElementById('world');
      if (world) {
        const ripple = document.createElement('div');
        ripple.className = 'dive-ripple';
        world.appendChild(ripple);
        window.setTimeout(() => ripple.remove(), 2000);
      }

      /* 首次用户手势：配置了音源的话在这里开始播放（浏览器策略要求） */
      safe('Dock.play', () => Dock.playIfConfigured());

      this.fallStart = performance.now();
      this.splashed = false;

      /* 水位靠 CSS 时间轴推进；JS 只负责不可视的时序（气泡、终态） */
      if (this.reduced) {
        this.finish();
        return;
      }
      /* 兜底：若浏览器不支持 @property（如旧版 Firefox），
         --fall 无法被 CSS 动画插值，这里用轮询直接写值 */
      if (!supportsAnimatableProperty()) this.driveFallByPolling();
      window.setTimeout(() => {
        if (this.state === 'falling') this.finish();
      }, this.fallDur + 60);
    },

    /* 入场层不删除、只隐藏 —— ESC 重置要把它原样恢复。
       用 visibility（is-hidden）而不是 display:none：按 CSS 规范
       display:none 会终止并重启元素上的动画，那样重置回来首屏动画就会
       重播，违反第一项第 7 条"仅首次载入播放"。 */
    hideEntry() {
      const entry = document.getElementById('entry');
      if (!entry) return;
      entry.classList.add('is-diving');
      entry.inert = true;
      window.setTimeout(() => entry.classList.add('is-hidden'), 620);
    },

    showEntry() {
      const entry = document.getElementById('entry');
      if (!entry) return;
      entry.classList.remove('is-diving', 'is-hidden');
      entry.inert = false;
      /* 首屏动画只在载入时播过一次，这里显式把三段文案钉在终态 */
      entry.classList.add('is-intro-done');
    },

    driveFallByPolling() {
      const started = performance.now();
      const timer = window.setInterval(() => {
        if (this.state !== 'falling') { window.clearInterval(timer); return; }
        const t = clamp((performance.now() - started) / this.fallDur, 0, 1);
        /* 与 CSS 的缓动保持一致 */
        const eased = t * t * (3 - 2 * t);
        Water.syncFall(eased);
        if (t >= 1) window.clearInterval(timer);
      }, 40);
    },

    finish() {
      if (this.state === 'settled' || this.state === 'resetting') return;
      this.state = 'settled';
      this.body.classList.remove('is-falling');
      this.body.classList.add('is-underwater', 'is-settled');
      Water.setPhase('under');
      Menu.fanOut();
      this.hideEntry();
      safe('Dock.show', () => Dock.setActive(true));
    },

    /* ---------------- ESC：淡出 → 完整重置 → 回到初始界面 ----------------
       第四项。防重复：state 守卫 + resetting 状态期间忽略一切输入。 */
    exitToEntry() {
      if (this.state === 'entry' || this.state === 'resetting') return;
      this.state = 'resetting';
      this.body.classList.add('is-resetting');
      window.setTimeout(() => this.resetAll(), this.reduced ? 0 : RESET_FADE);
    },

    resetAll() {
      const b = this.body;

      /* 1) 关掉菜单（硬收：此刻画面已经淡出，不需要收起动画） */
      safe('Menu.reset', () => Menu.reset());
      /* 2) 暂停并归零音频 + 黑胶旋转归零 */
      safe('Dock.reset', () => Dock.reset());
      safe('Dock.hide', () => Dock.setActive(false));
      /* 3) 水：定时器 / 气泡 / 涟漪环 / 水波场 / 画布全部归位 */
      safe('Water.reset', () => Water.reset());
      /* 4) 回到初始视觉状态（水体靠 --fall 回到 0 的过渡淡出） */
      b.classList.remove('is-underwater', 'is-settled', 'is-falling', 'is-idle');
      b.classList.add('is-entry');
      safe('Water.phase', () => Water.setPhase('surface'));
      /* 5) 滚动回顶部 */
      if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
      /* 6) 首屏元素复位到动画终态（不重播，见 showEntry 的说明） */
      safe('Entry.show', () => this.showEntry());
      /* 7) 菜单回到不可交互的初始态 */
      safe('Menu.interactive', () => Menu.setInteractive(false));

      this.splashed = false;
      this.fallStart = 0;
      /* 时间和时钟不重置：Dock 的 tick 一直用的是现实时间 */
      safe('Dock.tick', () => Dock.tick());

      /* 重置完成，撤掉淡出遮罩 → 初始界面淡回来 */
      b.classList.remove('is-resetting');
      this.state = 'entry';
    },

    /* ---------------- 主循环 ---------------- */
    loop() {
      const now = performance.now();
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.step(dt, now);
      this.raf = requestAnimationFrame(() => this.loop());
    },

    /* 单步推进。拆出来是为了在 rAF 不触发时也能手动驱动（自动化验证） */
    step(dt, now) {
      if (this.state === 'falling') {
        const p = clamp((now - this.fallStart) / this.fallDur, 0, 1);
        if (!this.splashed && (now - this.fallStart) >= this.splashAt) {
          this.splashed = true;
          Water.splash();
        }
        if (p >= 1) this.finish();
      }
      /* 水波推进：入场白场上不需要它 */
      if (this.state !== 'entry') Water.update(dt);
    },

    /* 仅供自动化验证使用：用虚拟时钟推进，避免依赖 rAF 与真实时间 */
    loopForTest(ms) {
      const dt = 16 / 1000;
      if (this.vnow === undefined) this.vnow = this.fallStart;
      for (let elapsed = 0; elapsed < ms; elapsed += 16) {
        this.vnow += 16;
        this.step(dt, this.vnow);
      }
    }
  };

  const boot = () => Boot.start();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  window.Boot = Boot;
})();
