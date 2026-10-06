/* ============================================================
   自建评论组件（前端）
   ------------------------------------------------------------
   替换掉原来挂在这儿的第三方评论客户端（自托管的那三个资源仍在磁盘上，
   但已经不再被引用 —— 原因与回滚办法见 comments-assets/README.md）。

   数据源：/api 下的公开服务（MySQL 存储，见 server/CONTRACT-public-api.md）
     GET    /api/comments?slug=<slug>
            → { ok, comments: [{ id, parent_id, content, created_at,
                                 author: { id, username, avatar? } }] }
     POST   /api/comments   ← { slug, content, parent_id? }
     DELETE /api/comments/:id
     GET    /api/auth/me    → 当前会话（登录状态由右侧角标 / 评论框体现）

   四条纪律：
     1. **不用 innerHTML 写任何数据**：作者名、正文、时间、错误信息一律
        createElement + textContent。换行交给 CSS 的 white-space: pre-wrap，
        所以"多行内容"也不需要拼 <br>。
     2. 未登录**能读、不能写**：发表与回复都会打开右上角那个同一个模态框
        （window.SiteAuth.open），页面不跳转、不离开正文。
     3. 只渲染一级回复：更深的关系在渲染时上浮到所在线程的顶层，不会无限缩进。
     4. 零外部依赖：头像只在"同源地址或 data: 图片"时才真正加载，
        其它情况退回首字母方块 —— 不让页面产生任何站外请求。

   时序：article.js 渲染成功后才调 window.initComments(slug)（它已经处理过
   文章不存在 / 别名跳转等一堆情况，这里不重复判断）。为了让两条路径都能兜住，
   本文件同时提供 window.initComments 并在加载完自己回头看一眼 window.Article。
   ============================================================ */
(() => {
  'use strict';

  const API = '/api';
  const MAX_LEN = 2000;
  const PAGE_OK = /^https?:$/.test(window.location.protocol);

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };

  const auth = () => window.SiteAuth || null;
  const me = () => {
    const s = auth();
    return s && typeof s.user === 'function' ? s.user() : null;
  };
  const isAdmin = () => {
    const s = auth();
    return !!(s && typeof s.isAdmin === 'function' && s.isAdmin());
  };

  /* 时间：统一走 auth-ui.js 暴露的那一份（它按 MySQL 的 'YYYY-MM-DD HH:MM:SS'
     当本地时间读，避免差 8 小时）；万一那个文件没加载，这里有一份最小兜底。 */
  const timeText = (v) => {
    const s = auth();
    if (s && s.time && typeof s.time.text === 'function') return s.time.text(v);
    const d = new Date(String(v || '').replace(' ', 'T'));
    return isNaN(d.getTime()) ? String(v || '') : d.toISOString().slice(0, 16).replace('T', ' ');
  };
  const timeISO = (v) => {
    const s = auth();
    if (s && s.time && typeof s.time.iso === 'function') return s.time.iso(v);
    const d = new Date(String(v || '').replace(' ', 'T'));
    return isNaN(d.getTime()) ? '' : d.toISOString();
  };

  /* HTTP：优先复用 auth-ui.js 那一份（错误语义一致：{code,message,retryAfter}），
     没有就自己来一份最小版 —— 两份都按契约 §0.1 把
     { ok:false, error:{code,message} } 摊平成字符串 + code。 */
  const api = (path, options) => {
    const s = auth();
    if (s && typeof s.api === 'function') return s.api(path, options);
    const opts = options || {};
    const method = opts.method || 'GET';
    const init = {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    };
    /* 与 auth-ui.js 同一份规矩：写接口（含无 body 的 DELETE）必须带
       Content-Type: application/json，否则服务端 415（契约 §0.3）。 */
    if (method !== 'GET' && method !== 'HEAD') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body === undefined ? {} : opts.body);
    } else if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(API + path, init).then(async (res) => {
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (err) { data = null; }
      const ok = res.ok && !(data && data.ok === false);
      if (ok) return { ok: true, status: res.status, data, code: '', retryAfter: 0, error: '' };
      const e = data && data.error;
      const info = (e && typeof e === 'object')
        ? { code: String(e.code || ''), message: String(e.message || '') }
        : { code: String((data && data.code) || ''), message: String((typeof e === 'string' && e) || (data && data.message) || ('请求失败（HTTP ' + res.status + '）')) };
      let retryAfter = 0;
      try {
        const h = res.headers.get('Retry-After');
        if (h) retryAfter = Math.max(0, Math.min(3600, parseInt(h, 10) || 0));
      } catch (err) { retryAfter = 0; }
      return {
        ok: false, status: res.status, data,
        code: info.code, retryAfter,
        error: info.message || ('请求失败（HTTP ' + res.status + '）')
      };
    }, (err) => ({
      ok: false, status: 0, data: null, code: 'NETWORK', retryAfter: 0,
      error: '连不上评论服务（' + ((err && err.message) || '网络错误') + '）'
    }));
  };

  /* 契约 §0.6：429 带 Retry-After（秒）。照它停手，倒计时结束再放开按钮 */
  const cooldown = (btn, seconds, label) => {
    const total = Math.ceil(Number(seconds) || 0);
    if (!(total > 0)) return;
    let left = total;
    btn.disabled = true;
    btn.textContent = left + ' 秒后可重试';
    const timer = window.setInterval(() => {
      left -= 1;
      if (left <= 0) {
        window.clearInterval(timer);
        btn.disabled = false;
        btn.textContent = label;
        return;
      }
      btn.textContent = left + ' 秒后可重试';
    }, 1000);
  };

  /* 失败提示：401 一律引导登录（同一个模态框），429 走倒计时，其余照实说 */
  const reportFail = (node, r, btn, label, afterSignIn) => {
    if (r.status === 401 || r.code === 'UNAUTHENTICATED') {
      note(node, '登录状态已失效，请重新登录。');
      askSignIn(afterSignIn);
      return;
    }
    note(node, r.error || '操作失败。');
    if (r.code === 'RATE_LIMITED' && btn) cooldown(btn, r.retryAfter || 60, label);
  };

  /* ------------------------------------------------------------
     状态与 DOM
     ------------------------------------------------------------ */
  const state = { slug: '', list: [], loaded: false, error: '' };
  let refs = null;
  let mounted = false;
  let byIdMap = new Map();    // id → 评论，渲染时建一次，供"回复给谁"这类引用使用
  const replyBoxes = new WeakMap();   // 顶级评论节点 → 它的一级回复容器
  const replyOpeners = new Map();     // 评论 id → 展开它那条回复框的函数（每次渲染重建）

  const showState = (text, isError) => {
    if (!refs) return;
    refs.state.textContent = text || '';
    refs.state.hidden = !text;
    refs.state.classList.toggle('is-error', !!isError);
  };

  const note = (node, text) => {
    if (node) node.textContent = text || '';
  };

  const build = () => {
    const mount = document.getElementById('commentsMount');
    if (!mount) {
      console.error('[comments] 页面里找不到 #commentsMount');
      return false;
    }
    mount.textContent = '';
    refs = {
      composer: el('div', 'cm-composer'),
      state: el('p', 'cm-state'),
      list: el('div', 'cm-list')
    };
    refs.state.hidden = true;
    const wrap = el('div', 'cm');
    wrap.appendChild(refs.composer);
    wrap.appendChild(refs.state);
    wrap.appendChild(refs.list);
    mount.appendChild(wrap);

    const loading = document.getElementById('commentsLoading');
    if (loading) loading.hidden = true;      /* 静态占位交还给脚本 */
    return true;
  };

  /* ------------------------------------------------------------
     权限 / 头像
     ------------------------------------------------------------ */
  const canDelete = (c) => {
    const user = me();
    if (!user) return false;
    if (isAdmin()) return true;
    const mine = user.id === undefined || user.id === null ? '' : String(user.id);
    const owner = c && c.author && c.author.id !== undefined && c.author.id !== null ? String(c.author.id) : '';
    return mine !== '' && mine === owner;
  };

  const isAdminAuthor = (author) => {
    if (!author) return false;
    const role = String(author.role || '').toLowerCase();
    return role === 'admin' || role === 'administrator' || author.is_admin === true;
  };

  /* 头像：只认同源地址与 data: 图片。第三方头像服务一律不加载 ——
     本站的定位是"零外部运行时依赖"，硬拉一张外链图就破了。 */
  const safeAvatar = (url) => {
    if (!url) return '';
    const s = String(url);
    if (/^data:image\//i.test(s)) return s;
    try {
      const u = new URL(s, window.location.href);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === window.location.origin) return u.href;
    } catch (err) { /* 忽略 */ }
    return '';
  };

  const avatar = (author) => {
    const box = el('span', 'cm-ava');
    const name = (author && author.username) || '匿名';
    const initial = () => {
      box.textContent = '';
      box.appendChild(el('span', 'cm-ava-init', name.slice(0, 1)));
    };
    const url = safeAvatar(author && author.avatar);
    if (!url) { initial(); return box; }
    const img = el('img');
    img.src = url;
    img.alt = '';
    img.width = 40;
    img.height = 40;
    img.loading = 'lazy';
    img.addEventListener('error', initial);
    box.appendChild(img);
    return box;
  };

  /* ------------------------------------------------------------
     渲染
     ------------------------------------------------------------ */
  const parentIdOf = (c) => {
    const v = c ? c.parent_id : null;
    if (v === null || v === undefined || v === '' || Number(v) === 0) return null;
    return String(v);
  };

  const ts = (v) => {
    const d = new Date(String(v || '').replace(' ', 'T'));
    return isNaN(d.getTime()) ? 0 : d.getTime();
  };

  const renderList = () => {
    if (!refs) return;
    refs.list.textContent = '';
    replyOpeners.clear();

    const list = state.list.slice().sort((a, b) => ts(a.created_at) - ts(b.created_at));
    const byId = new Map();
    list.forEach((c) => byId.set(String(c.id), c));
    byIdMap = byId;

    /* 顶级评论 = 自己就是自己所在线程的根；更深的关系上浮到根上，
       保证界面上只有一层回复（服务端允许的层级由它自己把关）。 */
    const rootOf = (c) => {
      let cur = c;
      let guard = 0;
      while (cur && guard++ < 64) {
        const pid = parentIdOf(cur);
        if (!pid || !byId.has(pid)) return String(cur.id);
        cur = byId.get(pid);
      }
      return String(c.id);
    };

    const tops = [];
    const children = new Map();
    list.forEach((c) => {
      const self = String(c.id);
      const root = rootOf(c);
      if (root === self) tops.push(c);
      else {
        if (!children.has(root)) children.set(root, []);
        children.get(root).push(c);
      }
    });

    tops.forEach((c) => {
      const node = itemNode(c, 0);
      const kids = children.get(String(c.id));
      const box = replyBoxes.get(node);
      if (kids && kids.length && box) {
        kids.forEach((k) => box.appendChild(itemNode(k, 1)));
      }
      refs.list.appendChild(node);
    });
  };

  const itemNode = (c, level) => {
    const item = el('article', 'cm-item');
    item.setAttribute('data-cm-id', c.id === undefined ? '' : String(c.id));
    item.appendChild(avatar(c.author));

    const main = el('div', 'cm-main');
    const head = el('div', 'cm-head');
    head.appendChild(el('span', 'cm-name', (c.author && c.author.username) || '匿名'));

    const time = el('time', 'cm-time', timeText(c.created_at));
    const iso = timeISO(c.created_at);
    if (iso) time.dateTime = iso;
    head.appendChild(time);

    if (level > 0) {
      const parent = parentIdOf(c) ? byIdMap.get(parentIdOf(c)) : null;
      if (parent && parent.author && parent.author.username) {
        head.appendChild(el('span', 'cm-reply-to', '回复 ' + parent.author.username));
      }
    }
    if (isAdminAuthor(c.author)) head.appendChild(el('span', 'cm-badge', 'ADMIN'));
    main.appendChild(head);

    main.appendChild(el('div', 'cm-text', c.content || ''));

    const acts = el('div', 'cm-acts');

    const replyBtn = el('button', 'cm-act', '回复');
    replyBtn.type = 'button';
    acts.appendChild(replyBtn);

    let delBtn = null;
    if (canDelete(c)) {
      delBtn = el('button', 'cm-act is-danger', '删除');
      delBtn.type = 'button';
      acts.appendChild(delBtn);
    }
    main.appendChild(acts);

    /* 一级回复挂在这里（空容器也留在原位：回复表单要在它下面） */
    const replies = el('div', 'cm-replies');
    main.appendChild(replies);
    /* 用 WeakMap 而不是给元素挂一个 __replies 属性：元素是宿主对象，
       某些 DOM 实现（Proxy 包装的）不保证能记住自定义属性。 */
    replyBoxes.set(item, replies);

    /* 内联回复表单：**只在已登录时才建**（未登录连一个隐藏的输入框都不留）；
       默认收起，点「回复」才展开。 */
    const replyForm = el('form', 'cm-reply-form');
    let ta = null;
    let replyNote = null;
    let send = null;
    let counter = null;
    if (me()) {
      replyForm.setAttribute('novalidate', '');
      replyForm.hidden = true;
      ta = el('textarea', 'cm-input');
      ta.placeholder = '回复 ' + ((c.author && c.author.username) || '这条评论') + '……';
      replyNote = el('p', 'cm-note');
      const replyBar = el('div', 'cm-bar');
      send = el('button', 'cm-btn', '发表回复');
      send.type = 'submit';
      const cancel = el('button', 'cm-btn is-ghost', '取消');
      cancel.type = 'button';
      counter = el('span', 'cm-count', '0 / ' + MAX_LEN);
      replyBar.appendChild(send);
      replyBar.appendChild(cancel);
      replyBar.appendChild(counter);
      replyForm.appendChild(ta);
      replyForm.appendChild(replyNote);
      replyForm.appendChild(replyBar);
      main.appendChild(replyForm);

      ta.addEventListener('input', () => { counter.textContent = ta.value.length + ' / ' + MAX_LEN; });
      cancel.addEventListener('click', () => {
        replyForm.hidden = true;
        replyNote.textContent = '';
        replyBtn.textContent = '回复';
      });

      /* 一级回复：回复"回复"时挂到同一条线程的顶层评论上，界面不会继续缩进 */
      replyForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = ta.value.trim();
        if (!text) { note(replyNote, '内容不能为空。'); return; }
        if (text.length > MAX_LEN) { note(replyNote, '最多 ' + MAX_LEN + ' 个字。'); return; }
        send.disabled = true;
        send.textContent = '发表中…';
        const body = { slug: state.slug, content: text };
        const target = level === 0 ? String(c.id) : (parentIdOf(c) || String(c.id));
        if (target) body.parent_id = target;
        const r = await api('/comments', { method: 'POST', body });
        send.disabled = false;
        send.textContent = '发表回复';
        if (!r.ok) {
          reportFail(replyNote, r, send, '发表回复', () => openReply());
          return;
        }
        ta.value = '';
        counter.textContent = '0 / ' + MAX_LEN;
        await load();
      });
    }

    const openReply = () => {
      if (!ta) return;
      replyForm.hidden = false;
      replyBtn.textContent = '收起回复';
      try { ta.focus(); } catch (err) { /* 忽略 */ }
    };
    /* 登录成功后重新渲染一次列表，旧节点的闭包已经作废 —— 所以记一份
       "按 id 展开"的入口，登录回调里用它拿新节点。 */
    if (me()) replyOpeners.set(String(c.id), openReply);

    replyBtn.addEventListener('click', () => {
      if (!me()) { askSignIn(() => openReplyForId(c.id)); return; }
      openReply();
    });

    if (delBtn) delBtn.addEventListener('click', () => armDelete(c, delBtn, main));

    /* 头像在左、其余全在右（.cm-item 是两列网格）—— 别漏了这一步：
       漏掉的话每一条评论都只剩一个孤零零的头像方块。 */
    item.appendChild(main);

    return item;
  };

  /* ------------------------------------------------------------
     删除：点一次变「确认删除」（4 秒内再点才真的删）
     ------------------------------------------------------------ */
  const armDelete = (c, btn, scope) => {
    if (btn.dataset.armed === '1') {
      btn.dataset.armed = '';
      doDelete(c, btn, scope);
      return;
    }
    btn.dataset.armed = '1';
    btn.textContent = '确认删除';
    btn.classList.add('is-armed');
    window.setTimeout(() => {
      if (btn.dataset.armed !== '1') return;
      btn.dataset.armed = '';
      btn.textContent = '删除';
      btn.classList.remove('is-armed');
    }, 4000);
  };

  const doDelete = async (c, btn, scope) => {
    btn.disabled = true;
    btn.textContent = '删除中…';
    const r = await api('/comments/' + encodeURIComponent(c.id), { method: 'DELETE' });
    if (!r.ok) {
      btn.disabled = false;
      btn.textContent = '删除';
      btn.classList.remove('is-armed');
      /* 契约 §1.7：删别人的评论服务端一定回 403（前端隐藏按钮只是体验）。
         429 照 Retry-After 停手；其余照实说。 */
      showState(
        r.code === 'RATE_LIMITED'
          ? (r.error + (r.retryAfter ? '（' + r.retryAfter + ' 秒后可再试）' : ''))
          : ('删除失败：' + (r.error || '未知错误')),
        true
      );
      if (r.code === 'RATE_LIMITED' && r.retryAfter) cooldown(btn, r.retryAfter, '删除');
      return;
    }
    showState('');
    await load();
    if (scope && scope.isConnected) scope.scrollIntoView({ block: 'nearest' });
  };

  /* ------------------------------------------------------------
     未登录：开右上角那个模态框（同一个），登录成功后接着做原来想做的事
     ------------------------------------------------------------ */
  /* 登录后列表会重渲染，旧闭包作废 —— 按 id 找当前那次渲染的展开函数 */
  const openReplyForId = (id) => {
    const key = String(id).replace(/[^0-9]/g, '');
    if (!key) return;
    const fn = replyOpeners.get(key);
    if (fn) fn();
  };

  const askSignIn = (then) => {
    const s = auth();
    if (!s || typeof s.open !== 'function') {
      showState('登录入口没有加载成功 —— 刷新一次再试。', true);
      return;
    }
    s.open('login', { onSuccess: () => { if (typeof then === 'function') then(); } });
  };

  /* ------------------------------------------------------------
     表达框（顶部）
     ------------------------------------------------------------ */
  const renderComposer = () => {
    if (!refs) return;
    refs.composer.textContent = '';
    const user = me();

    if (!user) {
      const box = el('div', 'cm-signin');
      box.appendChild(el('p', '', '登录后可以发表评论，也支持回复别人的评论。'));
      const btn = el('button', 'cm-btn', '登录 / 注册');
      btn.type = 'button';
      btn.addEventListener('click', () => askSignIn(() => renderComposer()));
      box.appendChild(btn);
      refs.composer.appendChild(box);
      return;
    }

    const who = el('div', 'cm-who');
    who.appendChild(el('span', '', '以 ' + (user.username || '当前账号') + ' 的身份发表'));
    if (isAdmin()) who.appendChild(el('span', 'cm-badge', 'ADMIN'));
    refs.composer.appendChild(who);

    const form = el('form', 'cm-form');
    form.setAttribute('novalidate', '');
    const ta = el('textarea', 'cm-input');
    ta.placeholder = '说点什么……（支持换行，' + MAX_LEN + ' 字以内）';
    const errNode = el('p', 'cm-note');
    const bar = el('div', 'cm-bar');
    const send = el('button', 'cm-btn', '发表');
    send.type = 'submit';
    const counter = el('span', 'cm-count', '0 / ' + MAX_LEN);
    bar.appendChild(send);
    bar.appendChild(counter);
    form.appendChild(ta);
    form.appendChild(errNode);
    form.appendChild(bar);
    refs.composer.appendChild(form);

    ta.addEventListener('input', () => { counter.textContent = ta.value.length + ' / ' + MAX_LEN; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) { note(errNode, '内容不能为空。'); return; }
      if (text.length > MAX_LEN) { note(errNode, '最多 ' + MAX_LEN + ' 个字。'); return; }
      send.disabled = true;
      send.textContent = '发表中…';
      const r = await api('/comments', { method: 'POST', body: { slug: state.slug, content: text } });
      send.disabled = false;
      send.textContent = '发表';
      if (!r.ok) {
        reportFail(errNode, r, send, '发表', () => renderComposer());
        return;
      }
      ta.value = '';
      counter.textContent = '0 / ' + MAX_LEN;
      note(errNode, '');
      await load();
    });
  };

  /* ------------------------------------------------------------
     拉取
     ------------------------------------------------------------ */
  const updateNote = () => {
    const node = document.getElementById('commentsNote');
    if (node) node.textContent = state.loaded ? '共 ' + state.list.length + ' 条评论' : '自建评论 · 登录后可发表';
  };

  const load = async () => {
    showState('评论加载中……');
    const r = await api('/comments?slug=' + encodeURIComponent(state.slug));
    if (!r.ok) {
      state.error = r.error || '未知错误';
      showState('评论加载失败：' + state.error, true);
      updateNote();
      return;
    }
    state.list = (r.data && r.data.comments) || [];
    state.loaded = true;
    state.error = '';
    renderList();
    showState(state.list.length ? '' : '还没有人评论 —— 来说第一句。');
    updateNote();
  };

  /* ------------------------------------------------------------
     入口
     ------------------------------------------------------------ */
  window.initComments = (slug) => {
    if (mounted) return;
    mounted = true;
    state.slug = String(slug || '');
    if (!build()) { mounted = false; return; }

    const s = auth();
    if (s && typeof s.onChange === 'function') {
      s.onChange(() => { renderComposer(); renderList(); });
    }

    renderComposer();

    if (!PAGE_OK) {
      /* file:// 下 /api 必然不可达：给一句人话，不发请求（双击打开也能看正文） */
      showState('当前是直接打开本地文件，评论区需要站点服务才能加载。', true);
      return;
    }
    if (!state.slug) {
      showState('地址里没有 slug，不知道要加载哪一篇的评论。', true);
      return;
    }
    load();
  };

  /* 慢路径：本文件跑完时 article.js 可能早就渲染完了（时序说明见文件头） */
  const ready = () => {
    const a = window.Article;
    if (a && a.slug) window.initComments(a.slug);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready, { once: true });
  } else {
    ready();
  }
})();
