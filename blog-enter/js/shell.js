/* ============================================================
   站点外壳脚本 —— 侧边栏收起/展开 + 访问统计
   ------------------------------------------------------------
   一、为什么**不能**用 defer
     收起偏好要在首屏绘制之前写进 <html data-nav>，否则每次刷新都会看到
     侧边栏"先展开、再收起"地抽一下。所以这个文件在 <head> 里同步加载，
     开头只做一次 localStorage 读取（同步、微秒级），其余全部延后到
     DOMContentLoaded —— 它不碰 DOM，也不阻塞首屏内容。

   二、它做什么
     1) 顶部同步应用收起偏好；DOMContentLoaded 后绑定收起按钮与快捷键
     2) 注入访问统计条并写数字（本机记录；配了后端就换成后端数字）
     3) 把导航文案镜像成收起态的悬停气泡（data-tip）与品牌缩写

   三、访问数据从哪来（"实际能力"）
     本站是静态站，页面本身没有写库的地方。所以默认走**本机记录**：
     localStorage 里累计 PV 与每日 PV，标签上会写明来源。
     想显示真实的全站数字，把 js/data.js 的 SITE.stats.endpoint 指到一个
     返回 { "total": 1234, "today": 56, "visitors": 789 } 的同源接口即可；
     请求失败/超时会自动退回本机记录，页面永远不会因此空掉或报错。
   ============================================================ */
(() => {
  'use strict';

  if (window.__p3Shell) return;
  window.__p3Shell = true;

  const NAV_KEY = 'p3.shell.nav';        // 'collapsed' | 'open'
  const VISITS_KEY = 'p3.shell.visits';  // { total, days: {'YYYY-MM-DD': n}, vid, seen }
  const doc = document;
  const root = doc.documentElement;

  /* ------------------------------------------------------------
     0. 存储（一律 try/catch：无痕模式 / 禁用存储会直接抛）
     ------------------------------------------------------------ */
  const readStr = (k) => { try { return window.localStorage.getItem(k); } catch (err) { return null; } };
  const writeStr = (k, v) => { try { window.localStorage.setItem(k, v); } catch (err) { /* 忽略 */ } };
  const readJSON = (k) => {
    const raw = readStr(k);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (err) { return null; }
  };
  const writeJSON = (k, v) => writeStr(k, JSON.stringify(v));

  /* ------------------------------------------------------------
     1. 收起偏好：绘制之前就应用
     ------------------------------------------------------------ */
  if (readStr(NAV_KEY) === 'collapsed') root.dataset.nav = 'collapsed';

  /* ------------------------------------------------------------
     2. 访问统计
     ------------------------------------------------------------ */
  const ymd = (d) => d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');

  const randomId = () => {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID().slice(0, 12);
    } catch (err) { /* 退到下面的伪随机 */ }
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  };

  const fmt = (n) => (typeof n === 'number' && isFinite(n))
    ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : '—';

  /* 三个槽位按数据来源换第三个：后端能给真 UV，本机只能给自己数得出来的东西 */
  const SLOTS = {
    remote: [['total', '总访问量'], ['today', '今日访问量'], ['visitors', '访客数']],
    local: [['total', '总访问量'], ['today', '今日访问量'], ['days', '已记录天数']]
  };
  const SRC_TEXT = { remote: '数据来自站点后端', local: '本机记录 · 未接后端' };

  /* 本机记一次 PV。keepDays 只留最近若干天，避免 localStorage 无限长大。 */
  const bumpLocal = (keepDays) => {
    const s = readJSON(VISITS_KEY);
    const log = (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
    if (!log.days || typeof log.days !== 'object') log.days = {};
    if (!Array.isArray(log.seen)) log.seen = [];

    const today = ymd(new Date());
    log.total = (Number(log.total) || 0) + 1;
    log.days[today] = (Number(log.days[today]) || 0) + 1;
    /* 本机访客标识：只用于"同一台机器的不同浏览器算不同访客"这一件事，
       它不是站点 UV —— 界面上也据此把第三个槽位换掉。 */
    if (!log.vid) log.vid = randomId();
    if (log.seen.indexOf(log.vid) < 0) log.seen.push(log.vid);

    const keys = Object.keys(log.days).sort();
    if (keepDays > 0 && keys.length > keepDays) {
      keys.slice(0, keys.length - keepDays).forEach((k) => { delete log.days[k]; });
    }
    writeJSON(VISITS_KEY, log);
    return log;
  };

  const localNums = (log) => ({
    total: Number(log.total) || 0,
    today: Number(log.days[ymd(new Date())]) || 0,
    days: Object.keys(log.days).length
  });

  /* 后端数字：把响应归一成 {total,today,visitors}。
     契约是 { ok:true, stats:{ total, today, visitors, day } }；
     也接受"平铺三个字段"的旧形状，这样自建 endpoint 不必严格对齐我们的嵌套。
     三个都必须是非负数字，缺一个就当没拿到（宁可退回本机记录，
     也不要显示一个半真半假的数字）。 */
  const pickNums = (j) => {
    if (!j || typeof j !== 'object') return null;
    const src = (j.stats && typeof j.stats === 'object') ? j.stats : j;
    const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : null);
    const total = num(src.total); const today = num(src.today); const visitors = num(src.visitors);
    if (total === null || today === null || visitors === null) return null;
    return { total: total, today: today, visitors: visitors };
  };

  /* 一次 POST 完成"计数 + 取数"：POST /api/stats/hit 会记这次访问，
     并把记完之后的汇总一起返回。
     为什么不是 GET：GET 会被预取/缓存/爬虫重放，统计出来的就不是"人看过"。
     为什么 credentials:'omit'：这条接口不需要任何 cookie（后端 auth:'none'），
     少发一个凭据就少一条泄露路径。
     失败/超时一律 resolve(null)：统计条退回本机记录，页面绝不因此报错。 */
  const loadRemote = (url, timeout) => new Promise((resolve) => {
    let settled = false;
    let ctrl = null;
    try { ctrl = new AbortController(); } catch (err) { ctrl = null; }
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = window.setTimeout(() => {
      if (ctrl) { try { ctrl.abort(); } catch (err) { /* 忽略 */ } }
      done(null);
    }, timeout);
    const opts = {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}'
    };
    if (ctrl) opts.signal = ctrl.signal;
    fetch(url, opts)
      .then((r) => (r && r.ok ? r.json() : null))
      .then((j) => { window.clearTimeout(timer); done(pickNums(j)); })
      .catch(() => { window.clearTimeout(timer); done(null); });
  });

  const buildStats = () => {    const box = doc.createElement('section');
    box.className = 'stats';
    box.id = 'stats';
    box.setAttribute('data-stats', '');
    box.setAttribute('aria-label', '站点访问统计');
    box.hidden = true;
    /* 结构是静态字符串（不含任何用户数据）；数字一律走 textContent */
    box.innerHTML =
      '<span class="stats-kicker" aria-hidden="true">VISITS</span>' +
      '<dl class="stats-list"></dl>' +
      '<span class="stats-src" data-stat-src></span>';
    return box;
  };

  /* 当前**实际显示**的数字来自哪里：'local'（本机记录）或 'remote'（站点后端）。
     与"配没配 endpoint"是两件事 —— 配了但请求失败时仍然是 local，
     界面上的来源标注必须跟着它走，不能跟着配置走。 */
  let statsSource = 'local';

  const paint = (box, mode, nums) => {
    statsSource = mode;
    const slots = SLOTS[mode] || SLOTS.local;
    const list = box.querySelector('.stats-list');
    list.textContent = '';
    slots.forEach((slot) => {
      const cell = doc.createElement('div');
      cell.className = 'stat';
      const k = doc.createElement('dt');
      k.className = 'stat-k';
      k.textContent = slot[1];
      const v = doc.createElement('dd');
      v.className = 'stat-v';
      v.setAttribute('data-stat', slot[0]);
      v.textContent = fmt(nums[slot[0]]);
      cell.appendChild(k);
      cell.appendChild(v);
      list.appendChild(cell);
    });
    const src = box.querySelector('[data-stat-src]');
    if (src) src.textContent = SRC_TEXT[mode] || '';
    box.hidden = false;
  };

  const mountStats = () => {
    const cfg = (window.SITE && window.SITE.stats) || {};
    if (cfg.enabled === false) return;
    if (doc.querySelector('[data-stats]')) return;

    const box = buildStats();
    /* 首屏：挂进 .world 的左下角（入场那一屏由 CSS 保持不可见）；
       内页：插在页脚之前，是文档流里的一行，不压任何东西 */
    const world = doc.getElementById('world');
    if (world) {
      world.appendChild(box);
    } else {
      const page = doc.querySelector('.page') || doc.body;
      const foot = page.querySelector('.foot');
      if (foot && foot.parentNode === page) page.insertBefore(box, foot);
      else page.appendChild(box);
    }

    const keepDays = Number(cfg.keepDays) > 0 ? Number(cfg.keepDays) : 60;
    paint(box, 'local', localNums(bumpLocal(keepDays)));

    if (typeof cfg.endpoint === 'string' && cfg.endpoint) {
      const timeout = Number(cfg.timeout) > 0 ? Number(cfg.timeout) : 4000;
      loadRemote(cfg.endpoint, timeout).then((nums) => {
        if (nums) paint(box, 'remote', nums);
      });
    }
    return box;
  };

  /* ------------------------------------------------------------
     3. 收起 / 展开
     ------------------------------------------------------------ */
  const navLabel = (collapsed) => (collapsed ? '展开侧边栏' : '收起侧边栏');

  const applyNav = (collapsed, persist) => {
    root.dataset.nav = collapsed ? 'collapsed' : 'open';
    const btn = doc.querySelector('[data-nav-collapse]');
    if (btn) {
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.setAttribute('aria-label', navLabel(collapsed));
      btn.setAttribute('title', navLabel(collapsed));
    }
    if (persist) writeStr(NAV_KEY, collapsed ? 'collapsed' : 'open');
  };

  const toggleNav = (persist) => {
    applyNav(root.dataset.nav !== 'collapsed', persist !== false);
  };

  /* 幂等设置：自动化验证与"希望明确指定状态"的调用方用它，
     免得依赖"当前是什么状态"再翻转 */
  const setNav = (collapsed) => applyNav(!!collapsed, true);

  const initNav = () => {
    const btn = doc.querySelector('[data-nav-collapse]');
    if (!btn) return;
    /* 把偏好（或默认的展开态）反映到按钮的可访问属性上 */
    applyNav(root.dataset.nav === 'collapsed', false);
    btn.addEventListener('click', () => toggleNav(true));
    /* 键盘：'[' 收起/展开。与站内既有键位不冲突（ENTER/ESC 归入场与抽屉），
       输入框里打字、以及移动端抽屉展开时都不接管 */
    doc.addEventListener('keydown', (e) => {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (doc.body.classList.contains('is-nav-open')) return;
      const t = e.target;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      e.preventDefault();
      toggleNav(true);
    });
  };

  /* ------------------------------------------------------------
     4. 收起态的文字来源：品牌缩写 + 悬停气泡
     ------------------------------------------------------------ */
  const initLabels = () => {
    const mark = doc.querySelector('.nav-brand-mark');
    const name = doc.querySelector('.nav-brand-name');
    if (mark && name) {
      const t = (name.textContent || '').trim();
      if (t) mark.textContent = t.slice(0, 1).toUpperCase();
    }
    Array.prototype.forEach.call(doc.querySelectorAll('.nav-list .nav-link'), (a) => {
      const cn = a.querySelector('.nl-cn');
      const en = a.querySelector('.nl-en');
      const tip = (cn && cn.textContent.trim()) || (en && en.textContent.trim()) || '';
      if (!tip) return;
      a.setAttribute('data-tip', tip);
      /* pages.js 也会写 aria-label；这里只是"脚本顺序变化时仍有兜底" */
      if (!a.getAttribute('aria-label')) a.setAttribute('aria-label', tip);
    });
  };

  /* ------------------------------------------------------------
     5. 启动
     ------------------------------------------------------------ */
  const boot = () => {
    try { initNav(); } catch (err) { console.error('[shell] 侧边栏收起失败:', err); }
    try { mountStats(); } catch (err) { console.error('[shell] 访问统计失败:', err); }
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  /* 文案镜像要等 pages.js 同步完 SITE 文案（它在 DOMContentLoaded 里做），
     所以挂到 load；此时读到的才是"真源"里的字。 */
  if (doc.readyState === 'complete') initLabels();
  else window.addEventListener('load', initLabels, { once: true });

  /* 暴露给自动化验证（与 window.Archive / window.SitePages 同一约定） */
  window.SiteShell = {
    nav: { toggle: toggleNav, set: setNav, state: () => root.dataset.nav || 'open' },
    stats: {
      /* 实际显示的数字来自哪里（'local' 本机记录 / 'remote' 站点后端） */
      source: () => statsSource,
      endpoint: () => (window.SITE && window.SITE.stats && window.SITE.stats.endpoint) || '',
      read: () => readJSON(VISITS_KEY),
      clear: () => writeStr(VISITS_KEY, '')
    }
  };
})();
