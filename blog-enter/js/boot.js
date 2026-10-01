/* ============================================================
   入场时序 + 主循环
   ------------------------------------------------------------
   入场：纯白 + 细微波纹
   ↓ ENTER / 滚轮下滑
   坠落：波纹扩散 → 水位上升（--fall 0→1 由 CSS 时间轴推进）
         → 入水冲击 → 扇形展开
   ------------------------------------------------------------
   角色小人已移除。坠落本身现在是纯屏幕级效果：
   --fall 用 @property 注册成数值，CSS animation 直接把它从 0 推到 1，
   这样即使 JS 被节流，水位也一定会落到终值。
   ============================================================ */
(() => {
  'use strict';

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

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

  const Boot = {
    state: 'entry',          // entry | falling | settled
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
      const safe = (name, fn) => {
        try { fn(); } catch (err) { console.error('[boot] ' + name + ' 初始化失败:', err); }
      };
      safe('Water', () => Water.init());
      safe('Menu', () => Menu.init());
      safe('Character', () => Character.init());

      this.body = document.body;
      safe('input', () => this.bindInput());
      this.last = performance.now();
      this.loop();

      /* 入场时让水面有一层缓慢的横向光带 */
      window.setTimeout(() => this.body.classList.add('is-idle'), 900);
    },

    applyStaticCopy() {
      const cfg = window.SITE;
      const $ = (s) => document.querySelector(s);
      const nameEl = $('.entry-name');
      if (nameEl) nameEl.textContent = cfg.name;
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
        if (this.state === 'entry') {
          if (k === 'Enter' || k === ' ' || k === 'ArrowDown') {
            e.preventDefault();
            this.dive();
          }
          return;
        }
        if (this.state === 'falling') return;
        if (k === 'Escape') { this.resurface(); return; }
        Menu.handleKey(k, e);
      });

      const btn = document.getElementById('rippleBtn');
      if (btn) {
        /* 只用 click：键盘的 Enter/Space 已由全局 keydown 处理，
           这里再监听 keydown 会导致一次按键触发两次 dive() */
        btn.addEventListener('click', () => this.dive());
      }

      document.addEventListener('site:navigate', (e) => {
        /* 占位：接真实页面时把这里换成路由跳转 */
        console.log('[navigate]', e.detail.en, e.detail.href);
      });
    },

    /* ---------------- 入水 ---------------- */
    dive() {
      if (this.state !== 'entry') return;
      this.state = 'falling';
      this.body.classList.add('is-falling');
      this.body.classList.remove('is-entry', 'is-idle');

      /* 白闪 → 收束 */
      Water.flashNow(0.55, 180);

      const entry = document.getElementById('entry');
      if (entry) {
        entry.classList.add('is-diving');
        window.setTimeout(() => entry.remove(), 1200);
      }

      /* 波纹扩散：从落点把整页"染"成水 */
      const ripple = document.createElement('div');
      ripple.className = 'dive-ripple';
      document.getElementById('world').appendChild(ripple);
      window.setTimeout(() => ripple.remove(), 2000);

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
      if (this.state === 'settled') return;
      this.state = 'settled';
      this.body.classList.remove('is-falling');
      this.body.classList.add('is-underwater', 'is-settled');
      Water.setPhase('under');
      Menu.fanOut();
      const entry = document.getElementById('entry');
      if (entry) entry.remove();
    },

    /* 回到水面 */
    resurface() {
      if (this.state !== 'settled') return;
      this.state = 'resurfacing';
      this.body.classList.remove('is-underwater', 'is-settled');
      this.body.classList.add('is-surfacing');
      Water.reset();
      Water.setPhase('surface');
      Menu.retract();
      const surfaceMs = this.reduced ? 80 : 900;
      window.setTimeout(() => {
        this.body.classList.remove('is-surfacing');
        this.body.classList.add('is-underwater', 'is-settled');
        this.state = 'settled';
        Menu.fanOut();
      }, surfaceMs);
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
      /* 焦散重绘由水位驱动（CSS 变量会同步更新，这里直接读状态） */
      Water.update(dt, this.state === 'entry' ? 0 : 1);
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
