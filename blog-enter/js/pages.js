/* ============================================================
   内页公共脚本（about / archive / article / 404 共用）
   ------------------------------------------------------------
   这里只做四件事，全部只增强、不依赖：
     1) 移动端抽屉导航（桌面端按钮根本不显示）
     2) 正文里的代码块：套外壳 + 极简高亮 + 复制按钮
     3) 占位栏目（"待定"）的提示条
     4) 页脚年份、ESC 回主界面
   即使这个文件加载失败，页面内容也应该是完整的可读状态。
   ============================================================ */
(() => {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  /* ------------------------------------------------------------
     0. 站点文案同步
     ------------------------------------------------------------
     子页面的侧边栏是手写的静态标记（脚本挂了也能导航），
     但"名字 / 三条栏目的文案与链接"必须只有 js/data.js 一个出处，
     否则改个名字要动五个文件。这里做的是"索引对齐"式的覆盖：
     第 i 条导航 ↔ SITE.menu[i]，数量对不上就整块跳过并告警，
     绝不半覆盖 —— 半覆盖比不同步更难查。
     ------------------------------------------------------------ */
  const applySite = () => {
    const cfg = window.SITE;
    if (!cfg) return;

    $$('[data-site-name]').forEach((el) => { el.textContent = cfg.name || ''; });
    /* 侧边栏那行短标语用 brandSub（不是 tagline）：tagline 是首屏的大副标题，
       塞进 292px 的侧边栏会被压成两行 */
    $$('[data-site-sub]').forEach((el) => { el.textContent = cfg.brandSub || ''; });
    if (cfg.footNote) $$('[data-foot-note]').forEach((el) => { el.textContent = cfg.footNote; });
    /* 关于我页的抬头（简介标题 / 职责） */
    const prof = cfg.profile;
    if (prof) {
      if (prof.name) $$('[data-profile-name]').forEach((el) => { el.textContent = prof.name; });
      if (prof.role) $$('[data-profile-role]').forEach((el) => { el.textContent = prof.role; });
    }
    if (cfg.name) {
      const t = document.title.split(' — ');
      /* 只替换" — "后面的站点名，保留前面的页面名 */
      if (t.length > 1) document.title = t.slice(0, -1).join(' — ') + ' — ' + cfg.name;
    }

    const links = $$('.nav-list .nav-link');
    const menu = cfg.menu || [];
    if (!links.length || !menu.length) return;
    if (links.length !== menu.length) {
      console.warn('[pages] 侧边栏条目数(' + links.length + ')与 SITE.menu(' + menu.length +
        ') 不一致，跳过文案同步');
      return;
    }
    links.forEach((a, i) => {
      const item = menu[i];
      const en = a.querySelector('.nl-en');
      const cn = a.querySelector('.nl-cn');
      if (en) en.textContent = item.en || '';
      if (cn) cn.textContent = item.label || item.jp || '';
      /* 占位栏目保持原样：它的 href 是当前页，"跳转"没有意义 */
      if (!a.classList.contains('is-todo') && item.href) a.href = item.href;
      a.setAttribute('aria-label', (item.label || item.jp || '') + ' / ' + (item.en || ''));
    });
  };

  /* ------------------------------------------------------------
     1. 抽屉导航
     ------------------------------------------------------------ */
  const Nav = {
    init() {
      this.toggle = $('.nav-toggle');
      this.nav = $('.nav');
      if (!this.toggle || !this.nav) return;
      this.toggle.addEventListener('click', () => this.set(!document.body.classList.contains('is-nav-open')));
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (document.body.classList.contains('is-nav-open')) {
          this.set(false);
          this.toggle.focus();
        }
      });
      const scrim = $('.nav-scrim');
      if (scrim) scrim.addEventListener('click', () => this.set(false));
    },
    set(on) {
      document.body.classList.toggle('is-nav-open', on);
      this.toggle.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
  };

  /* ------------------------------------------------------------
     2. 代码块外壳 / 高亮 / 复制
     ------------------------------------------------------------ */

  /* 高亮器只认 6 类 token。刻意不引第三方库：
     站点零依赖，而这里的代码样本只有 js / css / html 三种。 */
  const escapeHtml = (s) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const TOKEN = new RegExp([
    '(?<com>\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*|&lt;!--[\\s\\S]*?--&gt;)',
    '(?<str>"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\')',
    '(?<tag>&lt;\\/?[A-Za-z][\\w-]*)',
    '(?<att>\\s[A-Za-z-]+(?==))',
    '(?<kw>\\b(?:const|let|var|function|return|if|else|for|while|new|class|extends|import|export|from|default|try|catch|finally|throw|typeof|instanceof|async|await|of|in|this|null|undefined|true|false|switch|case|break|continue|delete|void|do|yield|static|get|set)\\b)',
    '(?<num>\\b\\d+(?:\\.\\d+)?(?:px|em|rem|s|ms|vw|vh|%)?\\b|--[\\w-]+)',
    '(?<fn>[A-Za-z_$][\\w$]*(?=\\())'
  ].join('|'), 'g');

  const highlight = (code) => escapeHtml(code).replace(TOKEN, (m, ...rest) => {
    /* 命名捕获组在 rest 里，最后一个元素之前是 groups 对象 */
    const groups = rest[rest.length - 1];
    if (!groups || typeof groups !== 'object') return m;
    const kind = Object.keys(groups).find((k) => groups[k] !== undefined);
    return kind ? '<span class="tok-' + kind + '">' + m + '</span>' : m;
  });

  const Code = {
    init() {
      $$('.prose pre > code, .article pre > code, pre > code[class]').forEach((code) => this.decorate(code));
    },
    decorate(code) {
      const pre = code.parentNode;
      if (!pre || pre.dataset.decorated === '1') return;
      pre.dataset.decorated = '1';

      const lang = (code.className.match(/lang-([\w-]+)/) || [, 'code'])[1];
      code.innerHTML = highlight(code.textContent.replace(/\s+$/, ''));

      const box = document.createElement('div');
      box.className = 'code-block';
      const head = document.createElement('div');
      head.className = 'code-head';

      const label = document.createElement('span');
      label.className = 'code-lang';
      label.textContent = lang.toUpperCase();

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'code-copy';
      copy.textContent = '复制';
      copy.setAttribute('aria-label', '复制这段 ' + lang + ' 代码');
      copy.addEventListener('click', () => this.copy(code, copy));

      head.appendChild(label);
      head.appendChild(copy);

      pre.parentNode.insertBefore(box, pre);
      box.appendChild(head);
      box.appendChild(pre);
    },
    async copy(code, btn) {
      const text = code.textContent;
      let ok = false;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          ok = true;
        }
      } catch (err) { ok = false; }
      if (!ok) {
        /* http:// 局域网地址与部分浏览器没有 clipboard API，退回选区方案 */
        try {
          const range = document.createRange();
          range.selectNodeContents(code);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          ok = document.execCommand('copy');
          sel.removeAllRanges();
        } catch (err) { ok = false; }
      }
      btn.textContent = ok ? '已复制' : '请手动选中';
      btn.classList.toggle('is-done', ok);
      window.setTimeout(() => {
        btn.textContent = '复制';
        btn.classList.remove('is-done');
      }, 1600);
    }
  };

  /* ------------------------------------------------------------
     3. 占位栏目提示条
     ------------------------------------------------------------ */
  const Toast = {
    el: null,
    show(html, ms) {
      if (!this.el) {
        this.el = document.createElement('div');
        this.el.className = 'toast';
        this.el.setAttribute('role', 'status');
        document.body.appendChild(this.el);
      }
      this.el.innerHTML = html;
      this.el.classList.add('is-on');
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.el.classList.remove('is-on'), ms || 2600);
    }
  };
  window.SiteToast = Toast;

  const Todo = {
    init() {
      $$('[data-todo]').forEach((el) => {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          Toast.show('「' + (el.dataset.todo || '待定') + '」栏目还没做 —— 先把 <b>关于我</b> 和 <b>博客文章</b> 填满。');
        });
      });
    }
  };

  /* ------------------------------------------------------------
     4. 杂项：年份 / ESC 回主界面
     ------------------------------------------------------------ */
  const Misc = {
    init() {
      /* 年份：HTML 里写的是静态兜底（例如 "© 2025 YOUR NAME"），
         脚本用 SITE.footer 的 {year} 占位重写一遍 —— 这样"改站点名"
         仍然只动 js/data.js 一个文件，与主界面保持一致。 */
      const cfg = window.SITE || {};
      const year = String(new Date().getFullYear());
      $$('[data-year]').forEach((el) => {
        el.textContent = cfg.footer ? String(cfg.footer).replace('{year}', year) : year;
      });
      /* ESC 回主界面。抽屉打开时 ESC 已经被导航消费掉了（见 Nav.init），
         这里再判断一次，避免同时"关抽屉"又"跳走"。 */
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (document.body.classList.contains('is-nav-open')) return;
        if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
        window.location.href = 'index.html';
      });
    }
  };

  const boot = () => {
    try { applySite(); } catch (err) { console.error('[pages] 站点文案同步失败:', err); }
    try { Nav.init(); } catch (err) { console.error('[pages] 导航初始化失败:', err); }
    try { Code.init(); } catch (err) { console.error('[pages] 代码高亮失败:', err); }
    try { Todo.init(); } catch (err) { console.error('[pages] 占位提示失败:', err); }
    try { Misc.init(); } catch (err) { console.error('[pages] 初始化失败:', err); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  window.SitePages = { highlight: highlight, Toast: Toast };
})();
