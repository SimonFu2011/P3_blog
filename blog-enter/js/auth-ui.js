/* ============================================================
   站点用户入口（右上角）＋ 自建登录/注册模态框
   ------------------------------------------------------------
   这个文件只干三件事：
     1) 把 HTML 里那枚**静态**的「登录」按钮接上后端：查会话 →
        未登录显示「登录」，已登录显示用户名 + 下拉（我的评论 / 退出登录）
     2) 提供自建模态框：登录 / 注册 / 我的评论 三个视图，错误信息就地显示
     3) 对外暴露 window.SiteAuth，让 js/comments.js 复用**同一个**模态框 ——
        未登录时点「回复 / 发表评论」走的就是这里，不跳转离开页面

   三条纪律：
     · 不拼 innerHTML：所有文本（用户名、错误信息、评论内容）一律
       createElement + textContent 写入
     · 请求一律 credentials:'same-origin'（会话是同源 Cookie）
     · 本脚本挂了页面也不缺东西：HTML 里那枚「登录」按钮仍然在（点了没反应），
       正文与导航完全不受影响

   接口形状见 blog-enter/server/CONTRACT-public-api.md（冻结）：
     GET  /api/auth/me        → { ok, user: {id, username, email, avatar, role} | null, db: 'up'|'down' }
     POST /api/auth/login     ← { user, password }        // user = 用户名或邮箱
     POST /api/auth/register  ← { username, email, password }
     POST /api/auth/logout
     GET  /api/comments/mine  → { ok, comments: [{ id, slug, parent_id, content, created_at, author }] }
   失败形状恒为 { ok:false, error:{ code, message } }：message 可直接展示，
   code 用来做分支（USERNAME_TAKEN / EMAIL_TAKEN / RATE_LIMITED / UNAUTHENTICATED…）。
   ============================================================ */
(() => {
  'use strict';

  const API = '/api';

  /* ------------------------------------------------------------
     0. 小工具
     ------------------------------------------------------------ */
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };

  const pad2 = (n) => (n < 10 ? '0' : '') + n;

  /* 时间：'YYYY-MM-DD HH:MM:SS' 是 MySQL DATETIME 的原样输出，不带时区。
     把它当**本地时间**读（replace 成 ISO 的 T 形式），否则浏览器按 UTC
     解释会差 8 小时。带 Z / 带偏移的 ISO 交给 Date 自己解析。 */
  const asDate = (value) => {
    if (!value) return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    const s = String(value).trim();
    const d = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)
      ? new Date(s.replace(' ', 'T'))
      : new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };

  const timeText = (value) => {
    const d = asDate(value);
    if (!d) return value ? String(value) : '';
    const diff = Date.now() - d.getTime();
    if (diff >= 0 && diff < 60e3) return '刚刚';
    if (diff >= 0 && diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    if (diff >= 0 && diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
    if (diff >= 0 && diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  };

  const timeISO = (value) => {
    const d = asDate(value);
    if (!d) return '';
    try { return d.toISOString(); } catch (err) { return ''; }
  };

  /* ------------------------------------------------------------
     1. HTTP
     ------------------------------------------------------------ */
  /* 契约 §0.1：失败恒为 { ok:false, error:{ code, message } }。
     这里把它摊平成 { code, message }，调用方只需要看 code。
     兼容三种历史写法（error 是对象 / 是字符串 / 老式 message 字段），
     免得服务端哪天少写一层就把 "[object Object]" 显示给用户。 */
  const errInfo = (data, status) => {
    const e = data && data.error;
    if (e && typeof e === 'object') {
      return { code: String(e.code || ''), message: String(e.message || '') };
    }
    if (typeof e === 'string' && e) {
      return { code: String((data && data.code) || ''), message: e };
    }
    return {
      code: String((data && data.code) || ''),
      message: String((data && data.message) || ('请求失败（HTTP ' + status + '）'))
    };
  };

  const api = async (path, options) => {
    const opts = options || {};
    const method = opts.method || 'GET';
    const init = {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    };
    /* 契约 §0.3：**所有**写接口（POST / DELETE）都必须带
       Content-Type: application/json，否则服务端回 415。
       注意这里的"写接口"包含没有请求体的那两个（logout / DELETE 评论）——
       少了这个头它们会被直接拒掉，所以不能只在有 body 时才设。
       没有 body 时补一对空对象：服务端两种写法都收（§1.4「空 {} 或省略」）。 */
    if (method !== 'GET' && method !== 'HEAD') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body === undefined ? {} : opts.body);
    } else if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    let res = null;
    let data = null;
    try {
      res = await fetch(API + path, init);
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch (err) {
      /* 网络失败 / 非 JSON 响应 / file:// 打开：都落到这里。
         统一给一句人话，调用方不需要区分。 */
      return {
        ok: false,
        status: 0,
        data: null,
        code: 'NETWORK',
        retryAfter: 0,
        error: '连不上站点的用户服务（' + ((err && err.message) || '网络错误') + '）'
      };
    }

    const ok = res.ok && !(data && data.ok === false);
    if (ok) return { ok: true, status: res.status, data, code: '', retryAfter: 0, error: '' };

    const info = errInfo(data, res.status);
    /* 契约 §0.6：429 必须带 Retry-After（秒），前端要照它停手 */
    let retryAfter = 0;
    try {
      const h = res.headers.get('Retry-After');
      if (h) retryAfter = Math.max(0, Math.min(3600, parseInt(h, 10) || 0));
    } catch (err) { retryAfter = 0; }
    return {
      ok: false,
      status: res.status,
      data,
      code: info.code,
      retryAfter,
      error: info.message || ('请求失败（HTTP ' + res.status + '）')
    };
  };

  /* ------------------------------------------------------------
     2. 状态
     ------------------------------------------------------------ */
  const state = {
    user: null,        // {id, username, email, avatar, role} | null
    ready: false,      // /auth/me 是否已经问过一次
    offline: false,    // 拿不到用户服务（未部署 / 离线 / file://）
    db: 'up',          // 契约 §1.1 的 db 字段：'up' = 评论库可用，'down' = 库挂了
    listeners: []
  };

  const entry = document.querySelector('[data-auth-entry]');

  const current = () => state.user;

  const isAdmin = (u) => {
    const me = u || state.user;
    if (!me) return false;
    const role = String(me.role || me.user_role || '').toLowerCase();
    return role === 'admin' || role === 'administrator' || me.is_admin === true || me.isAdmin === true;
  };

  const onChange = (fn) => {
    if (typeof fn !== 'function') return () => {};
    state.listeners.push(fn);
    return () => {
      const i = state.listeners.indexOf(fn);
      if (i >= 0) state.listeners.splice(i, 1);
    };
  };

  const notify = () => {
    state.listeners.slice().forEach((fn) => {
      try { fn(state.user); } catch (err) { console.error('[auth] 监听器出错:', err); }
    });
  };

  const fetchMe = async () => {
    const r = await api('/auth/me');
    if (r.ok && r.data) {
      state.offline = false;
      /* 契约 §1.1：库不可用时也是 200 + user:null，差别在 db 字段 */
      state.db = r.data.db === 'down' ? 'down' : 'up';
      return r.data.user || null;
    }
    /* 契约保证未登录是 200 + user:null，所以走到这里基本只有两种情况：
       真的有 401（代理/网关插了一手）或 status 0（连不上）。 */
    state.offline = r.status === 0;
    return null;
  };

  const refresh = async () => {
    const before = state.user ? String(state.user.id) : '';
    state.user = await fetchMe();
    state.ready = true;
    render();
    /* 会话从"无"变成"有"（或反过来）时必须**广播**一次：
       js/comments.js 的表达框是照当前会话渲染的，不广播的话，已登录的人
       打开文章页会一直看到"登录后可以发表"。同一状态重复刷新不广播，
       免得白白重渲染一遍列表。 */
    if ((state.user ? String(state.user.id) : '') !== before) notify();
    return state.user;
  };

  /* ------------------------------------------------------------
     3. 右上角入口
     ------------------------------------------------------------ */
  let chipMenu = null;   // 已登录时的下拉层

  const closeChipMenu = () => {
    if (!chipMenu) return;
    chipMenu.hidden = true;
    const b = chipMenu.__btn;
    if (b) b.setAttribute('aria-expanded', 'false');
  };

  /* 点别处收起下拉。只挂一次（每次都挂会在重复渲染后留下一堆死监听），
     ESC 由下面那个捕获监听统一吃掉。 */
  document.addEventListener('click', (e) => {
    if (!chipMenu || chipMenu.hidden) return;
    const wrap = chipMenu.parentNode;
    if (wrap && wrap.contains(e.target)) return;
    closeChipMenu();
  });

  const loginEntry = () => {
    const btn = el('button', 'auth-btn', '登录');
    btn.type = 'button';
    btn.setAttribute('data-auth-open', '');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', () => open('login'));
    return btn;
  };

  const userEntry = (user) => {
    const wrap = el('div', 'auth-wrap');

    const btn = el('button', 'auth-btn is-user');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', '账号菜单：' + (user.username || ''));
    btn.appendChild(el('span', 'auth-user-name', user.username || '已登录'));
    const caret = el('i', 'auth-caret');
    caret.setAttribute('aria-hidden', 'true');
    btn.appendChild(caret);

    const menu = el('div', 'auth-menu');
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    menu.__btn = btn;

    const mine = el('button', 'auth-item', '我的评论');
    mine.type = 'button';
    mine.setAttribute('role', 'menuitem');
    mine.addEventListener('click', () => { closeChipMenu(); open('mine'); });

    const out = el('button', 'auth-item is-quiet', '退出登录');
    out.type = 'button';
    out.setAttribute('role', 'menuitem');
    out.addEventListener('click', async () => {
      closeChipMenu();
      out.disabled = true;
      await api('/auth/logout', { method: 'POST' });
      state.user = await fetchMe();
      render();
      notify();
    });

    menu.appendChild(mine);
    menu.appendChild(out);

    btn.addEventListener('click', () => {
      const on = menu.hidden;
      menu.hidden = !on;
      btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    chipMenu = menu;
    return wrap;
  };

  const render = () => {
    if (!entry) return;
    closeChipMenu();
    chipMenu = null;
    entry.textContent = '';
    entry.appendChild(state.user ? userEntry(state.user) : loginEntry());
  };

  /* ------------------------------------------------------------
     4. 模态框
     ------------------------------------------------------------ */
  let modal = null;
  let modalPanel = null;
  let titleEl = null;
  let tabs = {};
  let views = {};
  let errs = {};
  let pending = null;       // 登录成功后要接着做的事（例如"继续回复"）
  let lastFocus = null;
  let lockedScroll = '';

  const setErr = (view, text) => {
    const node = errs[view];
    if (node) node.textContent = text || '';
  };

  const setView = (name) => {
    Object.keys(views).forEach((k) => { views[k].hidden = k !== name; });
    Object.keys(tabs).forEach((k) => {
      const on = k === name;
      tabs[k].classList.toggle('is-on', on);
      tabs[k].setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (titleEl) {
      titleEl.textContent = name === 'register' ? '注册'
        : (name === 'mine' ? '我的评论' : '登录');
    }
    /* 焦点：进哪个视图就落在这个视图的第一个输入框/按钮上 */
    const root = views[name];
    if (!root) return;
    const first = root.querySelector('input, textarea, button:not([disabled])');
    if (first) {
      try { first.focus(); } catch (err) { /* 忽略 */ }
    }
  };

  const focusables = () => {
    if (!modalPanel) return [];
    return Array.prototype.slice
      .call(modalPanel.querySelectorAll('button, input, textarea, a[href], [tabindex]:not([tabindex="-1"])'))
      .filter((n) => !n.disabled && n.offsetParent !== null);
  };

  const openModal = (name, opts) => {
    if (!modal) buildModal();
    lastFocus = document.activeElement;
    pending = (opts && typeof opts.onSuccess === 'function') ? opts.onSuccess : null;
    modal.hidden = false;
    /* 内页是可滚动的：模态框打开时锁住背景滚动 */
    lockedScroll = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (name === 'mine') loadMine();
    setView(views[name] ? name : 'login');
    setErr('login', '');
    setErr('register', '');
    if (state.offline) {
      setErr(views[name] ? name : 'login', '拿不到用户服务：登录/注册需要站点跑在 http(s) 上、且后端已启动。');
    }
  };

  const close = () => {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    closeChipMenu();
    pending = null;
    document.body.style.overflow = lockedScroll;
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (err) { /* 忽略 */ }
    }
    lastFocus = null;
  };

  const afterAuth = async (user) => {
    state.user = user || await fetchMe();
    state.ready = true;
    state.offline = false;
    render();
    const then = pending;
    pending = null;
    close();
    notify();
    if (typeof then === 'function') {
      try { then(state.user); } catch (err) { console.error('[auth] 登录后的后续动作失败:', err); }
    }
  };

  const field = (labelText, input) => {
    const wrap = el('label', 'auth-field');
    wrap.appendChild(el('span', 'auth-label', labelText));
    wrap.appendChild(input);
    return wrap;
  };

  const mkInput = (name, type, autocomplete, placeholder) => {
    const input = el('input', 'auth-input');
    input.type = type;
    input.name = name;
    input.autocomplete = autocomplete;
    if (placeholder) input.placeholder = placeholder;
    /* 不给 required：让浏览器的原生校验气泡闭嘴，错误一律就地显示 */
    return input;
  };

  const focusOn = (node) => {
    if (!node) return;
    try { node.focus(); } catch (err) { /* 忽略 */ }
  };

  /* 契约 §0.6：429 带 Retry-After。照它停手，倒计时结束再放开按钮 ——
     不然用户只能"一直点一直被拒"。 */
  const cooldown = (submit, seconds, label) => {
    const total = Math.ceil(Number(seconds) || 0);
    if (!(total > 0)) return;
    let left = total;
    submit.disabled = true;
    submit.textContent = left + ' 秒后可重试';
    const timer = window.setInterval(() => {
      left -= 1;
      if (left <= 0) {
        window.clearInterval(timer);
        submit.disabled = false;
        submit.textContent = label;
        return;
      }
      submit.textContent = left + ' 秒后可重试';
    }, 1000);
  };

  /* ---- 登录视图 ---- */
  const buildLogin = () => {
    const view = el('div', 'auth-view');
    view.setAttribute('data-auth-view', 'login');
    const form = el('form', 'auth-form');
    form.setAttribute('novalidate', '');

    /* 契约 §1.3：字段名是 user —— 用户名或邮箱都收 */
    const userInput = mkInput('user', 'text', 'username', '用户名或邮箱');
    const password = mkInput('password', 'password', 'current-password', '密码');
    const err = el('p', 'auth-err');
    err.setAttribute('role', 'alert');
    const submit = el('button', 'auth-submit', '登录');
    submit.type = 'submit';

    form.appendChild(field('USERNAME / 用户名或邮箱', userInput));
    form.appendChild(field('PASSWORD / 密码', password));
    form.appendChild(err);
    form.appendChild(submit);
    view.appendChild(form);
    view.appendChild(el('p', 'auth-note', '登录状态只用于评论：会话 Cookie 是 HttpOnly，脚本读不到。'));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const u = userInput.value.trim();
      const p = password.value;
      if (!u || !p) { setErr('login', '用户名（或邮箱）和密码都要填。'); return; }
      setErr('login', '');
      submit.disabled = true;
      submit.textContent = '登录中…';
      const r = await api('/auth/login', { method: 'POST', body: { user: u, password: p } });
      submit.disabled = false;
      submit.textContent = '登录';
      if (!r.ok) {
        setErr('login', r.error || '登录失败。');
        if (r.code === 'RATE_LIMITED') cooldown(submit, r.retryAfter || 60, '登录');
        return;
      }
      password.value = '';
      await afterAuth(r.data && r.data.user);
    });

    errs.login = err;
    views.login = view;
    return view;
  };

  /* ---- 注册视图 ---- */
  const buildRegister = () => {
    const view = el('div', 'auth-view');
    view.setAttribute('data-auth-view', 'register');
    const form = el('form', 'auth-form');
    form.setAttribute('novalidate', '');

    /* 契约 §1.2：username + email + password 三个字段，email 必填 */
    const username = mkInput('username', 'text', 'username', '3–20 位字母、数字或下划线');
    const email = mkInput('email', 'email', 'email', '用于找回密码');
    const password = mkInput('password', 'password', 'new-password', '至少 8 位');
    const confirm = mkInput('confirm', 'password', 'new-password', '再输一次密码');
    const err = el('p', 'auth-err');
    err.setAttribute('role', 'alert');
    const submit = el('button', 'auth-submit', '注册');
    submit.type = 'submit';

    form.appendChild(field('USERNAME / 用户名', username));
    form.appendChild(field('EMAIL / 邮箱', email));
    form.appendChild(field('PASSWORD / 密码', password));
    form.appendChild(field('CONFIRM / 确认密码', confirm));
    form.appendChild(err);
    form.appendChild(submit);
    view.appendChild(form);
    view.appendChild(el('p', 'auth-note', '邮箱本轮不发验证邮件（SMTP 未配置），但注册就要填：以后加验证码与找回密码时，老账号不会缺这一列。'));

    /* 前端先按契约的规则过一遍，把明显的错指到具体的输入框上；
       真正的判定仍在服务端（消息以服务端返回为准）。 */
    const localCheck = () => {
      const u = username.value.trim();
      const m = email.value.trim();
      const p = password.value;
      if (!u) return { input: username, msg: '请填写用户名。' };
      if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) return { input: username, msg: '用户名必须是 3-20 位字母、数字或下划线。' };
      if (!m) return { input: email, msg: '请填写邮箱。' };
      if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(m)) return { input: email, msg: '邮箱格式不正确。' };
      if (!p) return { input: password, msg: '请填写密码。' };
      if (p.length < 8) return { input: password, msg: '密码至少 8 个字符。' };
      if (p !== confirm.value) return { input: confirm, msg: '两次输入的密码不一致。' };
      return null;
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const bad = localCheck();
      if (bad) { setErr('register', bad.msg); focusOn(bad.input); return; }
      setErr('register', '');
      submit.disabled = true;
      submit.textContent = '注册中…';
      const r = await api('/auth/register', {
        method: 'POST',
        body: {
          username: username.value.trim(),
          email: email.value.trim(),
          password: password.value
        }
      });
      submit.disabled = false;
      submit.textContent = '注册';
      if (!r.ok) {
        setErr('register', r.error || '注册失败。');
        if (r.code === 'RATE_LIMITED') cooldown(submit, r.retryAfter || 60, '注册');
        else if (r.code === 'USERNAME_TAKEN' || r.code === 'INVALID_USERNAME') focusOn(username);
        else if (r.code === 'EMAIL_TAKEN' || r.code === 'INVALID_EMAIL') focusOn(email);
        else if (r.code === 'INVALID_PASSWORD') focusOn(password);
        return;
      }
      password.value = '';
      confirm.value = '';
      await afterAuth(r.data && r.data.user);
    });

    errs.register = err;
    views.register = view;
    return view;
  };

  /* ---- 我的评论 ---- */
  const loadMine = async () => {
    const box = views.mine.__list;
    if (!box) return;
    box.textContent = '';
    box.appendChild(el('p', 'auth-note', '正在读取……'));

    const r = await api('/comments/mine');
    box.textContent = '';
    if (!r.ok) {
      const msg = r.status === 401
        ? '登录状态已失效，请重新登录。'
        : '暂时拿不到你的评论（' + (r.error || '接口不可用') + '）。';
      box.appendChild(el('p', 'auth-note', msg));
      return;
    }
    const list = (r.data && r.data.comments) || [];
    if (!list.length) {
      box.appendChild(el('p', 'auth-note', '还没有发过评论。'));
      return;
    }
    const wrap = el('div', 'auth-mine-list');
    list.forEach((c) => {
      const item = el('article', 'auth-mine');
      item.appendChild(el('p', 'auth-mine-text', c.content || ''));
      const meta = el('p', 'auth-mine-meta');
      if (c.slug) {
        const a = el('a', 'auth-mine-link', '打开文章');
        a.href = 'article.html?slug=' + encodeURIComponent(c.slug) + '#comments';
        meta.appendChild(a);
      }
      const t = el('time', '', timeText(c.created_at));
      if (timeISO(c.created_at)) t.dateTime = timeISO(c.created_at);
      meta.appendChild(t);
      item.appendChild(meta);
      wrap.appendChild(item);
    });
    box.appendChild(wrap);
  };

  const buildMine = () => {
    const view = el('div', 'auth-view');
    view.setAttribute('data-auth-view', 'mine');
    const bar = el('div', 'cm-bar');
    const back = el('button', 'cm-btn is-ghost', '返回登录');
    back.type = 'button';
    back.addEventListener('click', () => setView('login'));
    bar.appendChild(back);
    view.appendChild(bar);
    const list = el('div', 'auth-mine-box');
    list.style.marginTop = '14px';
    view.appendChild(list);
    view.__list = list;
    views.mine = view;
    return view;
  };

  const buildModal = () => {
    modal = el('div', 'auth-modal');
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'authTitle');

    const back = el('div', 'auth-backdrop');
    back.setAttribute('data-auth-close', '');

    modalPanel = el('div', 'auth-panel');
    modalPanel.setAttribute('role', 'document');

    const bar = el('div', 'auth-tabs');
    const mkTab = (name, label) => {
      const b = el('button', 'auth-tab', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', 'false');
      b.setAttribute('aria-controls', 'authView-' + name);
      b.addEventListener('click', () => { setErr(name, ''); setView(name); });
      tabs[name] = b;
      return b;
    };
    bar.appendChild(mkTab('login', '登录'));
    bar.appendChild(mkTab('register', '注册'));

    const x = el('button', 'auth-x', '×');
    x.type = 'button';
    x.setAttribute('data-auth-close', '');
    x.setAttribute('aria-label', '关闭');
    bar.appendChild(x);

    titleEl = el('h2', 'auth-title', '登录');
    titleEl.id = 'authTitle';

    modalPanel.appendChild(bar);
    modalPanel.appendChild(titleEl);
    const loginView = buildLogin();
    const registerView = buildRegister();
    const mineView = buildMine();
    loginView.id = 'authView-login';
    registerView.id = 'authView-register';
    modalPanel.appendChild(loginView);
    modalPanel.appendChild(registerView);
    modalPanel.appendChild(mineView);

    modal.appendChild(back);
    modal.appendChild(modalPanel);
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
      const node = e.target && e.target.closest ? e.target.closest('[data-auth-close]') : null;
      if (node) { e.preventDefault(); close(); }
    });

    /* Tab 焦点不出模态框 */
    modal.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    views.login.hidden = false;
    views.register.hidden = true;
    views.mine.hidden = true;
  };

  /* 模态框开着时，把键盘完全接管：
     · index.html 的 boot.js 在 window 上听 Enter / 空格 / 方向键 / w / s，
       不拦的话"在用户名里按空格"会直接触发扇形菜单的 ENTER 跳转；
     · 内页的 pages.js 在 window 上听 ESC（回主界面），不拦的话 ESC 会跳走。
     捕获阶段 stopPropagation 只掐掉**传播**，不影响输入框自身的默认行为
     （打字、隐式提交表单），所以这里是安全的。 */
  document.addEventListener('keydown', (e) => {
    if (!modal || modal.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab') return;          // 焦点循环交给 modalPanel 上的处理
    e.stopPropagation();
  }, true);

  /* ------------------------------------------------------------
     5. 对外接口
     ------------------------------------------------------------ */
  const open = (name, opts) => {
    openModal(name || 'login', opts);
    return modal;
  };

  window.SiteAuth = {
    api,
    user: current,
    isAdmin,
    ready: () => state.ready,
    offline: () => state.offline,
    db: () => state.db,
    refresh,
    open,
    close,
    onChange,
    time: { text: timeText, iso: timeISO }
  };

  /* ------------------------------------------------------------
     6. 启动：先按"未登录"渲染（HTML 里本来就是这么写的，不会闪），
        再问一次会话。问不到就保持原样 —— 页面照常可用。
     ------------------------------------------------------------ */
  const boot = () => {
    render();
    refresh().catch((err) => console.error('[auth] 会话检查失败:', err));
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
