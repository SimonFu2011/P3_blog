/* ============================================================
   管理页逻辑
   ------------------------------------------------------------
   和站点其余脚本一样，这里不引任何依赖：预览用 iframe 的 sandbox，
   校验只有几条正则（真正的把关在服务端，前端只是让你少跑一趟往返）。

   三条与安全有关的做法，都在下面有对应注释：
     · 预览 iframe 的 sandbox 里**没有** allow-scripts，且样式是取来内联的
       （不能同时给 allow-same-origin，那等于没沙箱）
     · 所有写进 DOM 的字符串一律用 textContent / value / setAttribute，
       管理页自己从不拼 HTML —— 这样即使某篇文章正文里带了奇怪标记，
       也不会在管理页里执行
     · 令牌只来自 /_admin/token.js，不写进 localStorage、不拼进 URL
   ============================================================ */
(() => {
  'use strict';

  /* ------------------------------------------------------------
     基础
     ------------------------------------------------------------ */
  const $ = (sel) => document.querySelector(sel);

  /* 令牌：优先用页面里注入的那份（/_admin/token.js），但**每次写操作前**
     会再向 /api/session 取一次。原因：令牌是随服务进程生成的，
     服务一重启旧的就作废，而管理页可能一直开着 —— 只靠页面加载时注入的
     那一份，重启后所有写操作都会 403，看起来像"莫名其妙坏了"。 */
  let token = typeof window.__ADMIN_TOKEN__ === 'string' ? window.__ADMIN_TOKEN__ : '';

  const ensureToken = async () => {
    if (token) return token;
    const res = await fetch('/api/session');
    const data = await res.json();
    if (data.unlocked && data.token) { token = data.token; return token; }
    const err = new Error(data.auth === 'passphrase' ? '会话未解锁' : '没有拿到会话令牌');
    err.status = res.status;
    throw err;
  };

  const State = {
    posts: [],          // 服务端返回的文章（干净对象）
    version: '',        // posts.js 的哈希，用作乐观锁
    limits: {},
    current: null,      // 当前编辑对象的浅拷贝
    originalSlug: null, // 编辑前 slug（判改名用）
    dirty: false,
    slugEdited: false,
    busy: false,
    gitRepo: false,
    previewCss: ''
  };

  const PREVIEW_CSS_FILES = ['/css/pages.css', '/css/geo.css'];

  /* ------------------------------------------------------------
     HTTP
     ------------------------------------------------------------ */
  const api = async (path, opts) => {
    const o = Object.assign({ method: 'GET', headers: {} }, opts || {});
    if (o.json !== undefined) {
      o.method = o.method === 'GET' ? 'POST' : o.method;
      o.headers['content-type'] = 'application/json';
      o.body = JSON.stringify(o.json);
      delete o.json;
    }
    if (o.method !== 'GET') {
      o.headers['x-admin-token'] = await ensureToken();
    }
    const res = await fetch(path, o);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!res.ok) {
      /* 401/403 说明令牌过期或未解锁：清掉缓存的令牌，下一次调用会重新取 */
      if (res.status === 401 || res.status === 403) token = '';
      const err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.status = res.status;
      err.errors = (data && data.errors) || null;
      throw err;
    }
    return data;
  };

  /* ------------------------------------------------------------
     提示
     ------------------------------------------------------------ */
  let toastTimer = null;
  const toast = (msg, kind) => {
    const el = $('#toast');
    el.textContent = msg;
    el.dataset.kind = kind || '';
    el.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { el.hidden = true; }, 3600);
  };

  const showErrors = (list) => {
    const box = $('#errors');
    box.textContent = '';
    if (!list || !list.length) { box.hidden = true; return; }
    const strong = document.createElement('strong');
    strong.textContent = '没有保存，先修这几处：';
    box.appendChild(strong);
    const ul = document.createElement('ul');
    list.forEach((e) => {
      const li = document.createElement('li');
      li.textContent = e;
      ul.appendChild(li);
    });
    box.appendChild(ul);
    box.hidden = false;
  };

  /* ------------------------------------------------------------
     预览
     ------------------------------------------------------------ */
  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* 危险标签整段（含内容）删掉；事件属性去掉；脚本协议置空。
     这是**预览**用的净化，只为了让"预期外的标记"在预览里也不执行。
     真正决定线上安全的是服务端 validate.mjs 的检查。 */
  const FORBIDDEN = 'script,iframe,object,embed,form,input,button,select,textarea,link,meta,base,style,svg,math';
  const sanitizeForPreview = (html) => {
    const doc = new DOMParser().parseFromString('<div id="r">' + String(html || '') + '</div>', 'text/html');
    const root = doc.getElementById('r');
    if (!root) return '';
    root.querySelectorAll(FORBIDDEN).forEach((n) => n.remove());
    root.querySelectorAll('*').forEach((el) => {
      Array.prototype.slice.call(el.attributes).forEach((a) => {
        const n = a.name.toLowerCase();
        if (n.startsWith('on') || n === 'srcdoc') { el.removeAttribute(a.name); return; }
        if (n === 'style') { el.removeAttribute(a.name); return; }
        if ((n === 'href' || n === 'src' || n === 'xlink:href') &&
            /^\s*(?:javascript|vbscript|data)\s*:/i.test(a.value)) {
          el.removeAttribute(a.name);
        }
      });
    });
    return root.innerHTML;
  };

  /* 预览文档：样式取来内联（sandbox 无 allow-same-origin，<link> 加载不到），
     代码块高亮复用站点自己的高亮器，保证"预览 = 详情页"。 */
  const loadPreviewCss = async () => {
    if (State.previewCss) return State.previewCss;
    const parts = [];
    for (const file of PREVIEW_CSS_FILES) {
      try {
        const res = await fetch(file);
        if (res.ok) parts.push('/* ' + file + ' */\n' + await res.text());
      } catch { /* 取不到就退化成无样式预览 */ }
    }
    State.previewCss = parts.join('\n');
    return State.previewCss;
  };

  const renderPreview = async () => {
    const frame = $('#preview');
    const doc = frame.contentDocument;
    if (!doc) return;
    const css = await loadPreviewCss();
    const html = sanitizeForPreview(State.current ? State.current.body : '');
    let body = html;
    if (window.SitePages && typeof window.SitePages.highlight === 'function') {
      const doc2 = new DOMParser().parseFromString('<div id="h">' + html + '</div>', 'text/html');
      const host = doc2.getElementById('h');
      host.querySelectorAll('pre > code').forEach((code) => {
        code.innerHTML = window.SitePages.highlight(code.textContent.replace(/\s+$/, ''));
      });
      body = host.innerHTML;
    }
    /* 预览外壳的底色跟随站点的纯白皮肤（geo.css 的 --g-* 值写死在这里，
       因为预览 iframe 是独立文档，拿不到父页面的 CSS 变量）。
       内联的 pages.css / geo.css 已经把正文排版带过来了，这里只补外壳。 */
    doc.open();
    doc.write('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<style>' + css + '</style>' +
      '<style>html,body{margin:0;padding:16px 18px;background:#ffffff;color:#071523;}' +
      'body{font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;font-size:15px;line-height:1.85;}' +
      'a{color:#0b6a97;}' +
      'pre{overflow:auto;}' +
      '.preview-empty{color:#5b7284;font-size:13px;}</style>' +
      '</head><body>' + (body.trim() ? body : '<p class="preview-empty">（正文为空）</p>') + '</body></html>');
    doc.close();
  };

  let previewTimer = null;
  const schedulePreview = () => {
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(renderPreview, 220);
  };

  /* ------------------------------------------------------------
     列表
     ------------------------------------------------------------ */
  const derivedLists = () => {
    const cats = new Map();
    const tags = new Map();
    State.posts.forEach((p) => {
      if (p.category) cats.set(p.category, (cats.get(p.category) || 0) + 1);
      (p.tags || []).forEach((t) => tags.set(t, (tags.get(t) || 0) + 1));
    });
    const put = (host, values) => {
      host.textContent = '';
      values.forEach((v) => {
        const o = document.createElement('option');
        o.value = v;
        host.appendChild(o);
      });
    };
    put($('#catList'), Array.from(cats.keys()));
    put($('#tagList'), Array.from(tags.keys()));
  };

  const visiblePosts = () => {
    const q = $('#search').value.trim().toLowerCase();
    const showDrafts = $('#showDrafts').checked;
    return State.posts.filter((p) => {
      if (!showDrafts && p.isDraft) return false;
      if (!q) return true;
      const hay = [p.title, p.slug, p.category, (p.tags || []).join(' ')].join(' ').toLowerCase();
      return hay.includes(q);
    });
  };

  const renderList = () => {
    const host = $('#postList');
    host.textContent = '';
    const items = visiblePosts();
    $('#listCount').textContent = items.length + ' / ' + State.posts.length + ' 篇';

    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'ad-dim';
      li.textContent = State.posts.length ? '没有匹配的文章' : '还没有文章';
      host.appendChild(li);
      return;
    }

    items.forEach((p) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ad-post';
      btn.setAttribute('aria-current', State.current && State.current.slug === p.slug ? 'true' : 'false');

      const top = document.createElement('div');
      top.className = 'ad-post-top';
      const title = document.createElement('span');
      title.className = 'ad-post-title';
      title.textContent = p.title || '(无标题)';
      const date = document.createElement('span');
      date.className = 'ad-post-date';
      date.textContent = p.date || '';
      top.appendChild(title);
      top.appendChild(date);

      const meta = document.createElement('div');
      meta.className = 'ad-post-meta';
      const slug = document.createElement('span');
      slug.className = 'ad-post-slug';
      slug.textContent = p.slug;
      meta.appendChild(slug);
      if (p.isDraft) {
        const b = document.createElement('span');
        b.className = 'ad-badge';
        b.textContent = '草稿';
        meta.appendChild(b);
      }
      if (p.category) {
        const c = document.createElement('span');
        c.textContent = p.category;
        meta.appendChild(c);
      }

      btn.appendChild(top);
      btn.appendChild(meta);
      btn.addEventListener('click', () => selectPost(p.slug));
      li.appendChild(btn);
      host.appendChild(li);
    });
  };

  /* ------------------------------------------------------------
     表单
     ------------------------------------------------------------ */
  const setDirty = (on) => {
    State.dirty = on;
    const box = $('#dirtyBox');
    box.hidden = !on;
    box.textContent = on ? '有未保存的改动（Ctrl+S 保存）' : '';
  };

  const readForm = () => ({
    slug: $('#fSlug').value.trim().toLowerCase(),
    title: $('#fTitle').value.trim(),
    date: $('#fDate').value.trim(),
    category: $('#fCategory').value.trim(),
    tags: $('#fTags').value.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
    excerpt: $('#fExcerpt').value.trim(),
    body: $('#fBody').value,
    isDraft: $('#fDraft').checked
  });

  const fillForm = (post) => {
    $('#fTitle').value = post.title || '';
    $('#fSlug').value = post.slug || '';
    $('#fDate').value = post.date || new Date().toISOString().slice(0, 10);
    $('#fCategory').value = post.category || '';
    $('#fTags').value = (post.tags || []).join(', ');
    $('#fExcerpt').value = post.excerpt || '';
    $('#fDraft').checked = post.isDraft === true;
    $('#fBody').value = post.body || '';
    $('#draftSlug').textContent = post.slug || 'slug';
    showErrors([]);
  };

  const selectPost = (slug) => {
    if (State.dirty && !window.confirm('当前这篇有未保存的改动，放弃它们吗？')) return;
    const raw = State.posts.find((p) => p.slug === slug);
    if (!raw) return;
    State.current = {
      slug: raw.slug, title: raw.title, date: raw.date, category: raw.category,
      tags: (raw.tags || []).slice(), excerpt: raw.excerpt || '',
      body: raw.body || '', isDraft: raw.isDraft === true
    };
    State.originalSlug = raw.slug;
    State.slugEdited = true;          // 已存在的文章不自动改 slug
    fillForm(State.current);
    $('#editorEmpty').hidden = true;
    $('#form').hidden = false;
    $('#formTitle').textContent = '编辑：' + (raw.title || raw.slug);
    $('#deleteBtn').hidden = false;
    setDirty(false);
    renderList();
    schedulePreview();
  };

  const startNew = () => {
    if (State.dirty && !window.confirm('当前这篇有未保存的改动，放弃它们吗？')) return;
    const today = new Date().toISOString().slice(0, 10);
    State.current = {
      slug: '', title: '', date: today, category: '', tags: [],
      excerpt: '', body: '<p></p>', isDraft: true
    };
    State.originalSlug = null;
    State.slugEdited = false;
    fillForm(State.current);
    $('#editorEmpty').hidden = true;
    $('#form').hidden = false;
    $('#formTitle').textContent = '新建文章';
    $('#deleteBtn').hidden = true;
    setDirty(true);
    renderList();
    schedulePreview();
    $('#fTitle').focus();
  };

  /* 标题 → slug 建议。汉字无法直接当 slug（服务端只收 ASCII），
     所以含汉字时给一个"日期占位"，并提示手填一个英文 slug。 */
  const suggestSlug = () => {
    const title = $('#fTitle').value;
    const field = $('#fSlug');
    if (State.slugEdited) return;
    const ascii = title.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ').trim()
      .replace(/\s+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
    if (ascii.length >= 2) {
      field.value = ascii.slice(0, 60);
      $('#slugHint').textContent = '由标题生成，可手改；改 slug 会自动记别名';
    } else if (/[\u4e00-\u9fa5]/.test(title)) {
      field.value = 'post-' + ($('#fDate').value || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
      $('#slugHint').textContent = '标题是中文，slug 得手填一个英文/拼音标识（例如 water-entry）';
    }
  };

  /* ------------------------------------------------------------
     校验（与服务端同一套规则的精简版）
     ------------------------------------------------------------ */
  const localErrors = (p) => {
    const errs = [];
    if (!p.title) errs.push('标题不能为空');
    if (!p.slug) errs.push('slug 不能为空');
    else if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(p.slug)) {
      errs.push('slug 只能是 2~64 位小写字母、数字、连字符（不能以连字符开头或结尾）');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) errs.push('日期要填成 YYYY-MM-DD');
    if (!p.category) errs.push('分类不能为空');
    if (!State.current || p.slug !== State.originalSlug) {
      if (State.posts.some((x) => x.slug === p.slug)) errs.push('slug「' + p.slug + '」已被另一篇文章占用');
    }
    return errs;
  };

  /* ------------------------------------------------------------
     保存 / 删除
     ------------------------------------------------------------ */
  const save = async () => {
    if (State.busy) return;
    const p = readForm();
    State.current = p;

    const local = localErrors(p);
    if (local.length) { showErrors(local); toast('有字段没填对', 'bad'); return; }

    State.busy = true;
    $('#saveBtn').disabled = true;
    $('#savedHint').textContent = '保存中…';
    try {
      let data;
      if (State.originalSlug) {
        data = await api('/api/posts', {
          method: 'PUT',
          json: Object.assign({}, p, { originalSlug: State.originalSlug, version: State.version })
        });
      } else {
        data = await api('/api/posts', { json: Object.assign({}, p, { version: State.version }) });
      }
      State.version = data.version;
      State.originalSlug = data.slug;
      State.slugEdited = true;
      setDirty(false);
      showErrors([]);
      $('#savedHint').textContent = '已保存 ' + new Date().toLocaleTimeString('zh-CN');
      toast((data.renamed ? '已保存并改名（旧地址成为别名）' : '已保存') +
        (data.backup ? '，备份：' + data.backup : ''), 'ok');
      await reload(false);
      selectPost(data.slug);
    } catch (err) {
      $('#savedHint').textContent = '';
      showErrors(err.errors && err.errors.length ? err.errors : [err.message]);
      if (err.status === 409) {
        toast('版本冲突：文件在别处被改过，已重新载入，请再保存一次', 'bad');
        await reload(false);
      } else {
        toast('保存失败：' + err.message, 'bad');
      }
    } finally {
      State.busy = false;
      $('#saveBtn').disabled = false;
    }
  };

  const remove = async () => {
    if (!State.originalSlug) return;
    if (!window.confirm('删除《' + ($('#fTitle').value || State.originalSlug) + '》？\n\n' +
      '内容会先被搬进 .admin/trash/，需要时可以手动恢复。')) return;
    try {
      const data = await api('/api/posts/delete', {
        json: { slug: State.originalSlug, version: State.version }
      });
      State.version = data.version;
      toast('已删除，回收站：' + data.trash, 'ok');
      State.originalSlug = null;
      State.current = null;
      $('#form').hidden = true;
      $('#editorEmpty').hidden = false;
      setDirty(false);
      await reload(false);
    } catch (err) {
      toast('删除失败：' + err.message, 'bad');
    }
  };

  /* ------------------------------------------------------------
     图片上传
     ------------------------------------------------------------ */
  const uploadFiles = async (files) => {
    const list = Array.prototype.slice.call(files || []).filter((f) => f && f.size);
    if (!list.length) return;
    for (const file of list) {
      try {
        const res = await fetch('/api/images', {
          method: 'POST',
          headers: {
            'x-admin-token': await ensureToken(),
            'x-file-name': encodeURIComponent(file.name || 'image')
          },
          body: file
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        insertFigure(data.src, file.name);
        toast('已上传 ' + data.src + (data.warnings && data.warnings.length ? '（' + data.warnings.join('；') + '）' : ''), 'ok');
      } catch (err) {
        toast('上传失败：' + err.message, 'bad');
      }
    }
  };

  /* 在光标处插入一段文本，并把光标放到 ^ 标记的位置 */
  const insertAtCursor = (snippet, caretMark) => {
    const ta = $('#fBody');
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const text = ta.value;
    const mark = caretMark || '';
    let insert = snippet;
    let caret = insert.length;
    if (mark && insert.includes(mark)) {
      caret = insert.indexOf(mark);
      insert = insert.replace(mark, '');
    }
    ta.value = text.slice(0, start) + insert + text.slice(end);
    ta.focus();
    ta.setSelectionRange(start + caret, start + caret);
    State.current = readForm();
    setDirty(true);
    schedulePreview();
  };

  const insertFigure = (src, alt) => {
    insertAtCursor(
      '\n<figure>\n  <img src="' + src + '" alt="^' + (alt || '') + '" width="720" height="380">\n' +
      '  <figcaption></figcaption>\n</figure>\n',
      '^'
    );
  };

  const TOOL_SNIPPETS = {
    p:          { text: '\n<p>^</p>\n', mark: '^', label: '段落' },
    h2:         { text: '\n<h2>^</h2>\n', mark: '^', label: '小标题' },
    ul:         { text: '\n<ul>\n  <li>^</li>\n  <li></li>\n</ul>\n', mark: '^', label: '列表' },
    blockquote: { text: '\n<blockquote>\n  <p>^</p>\n</blockquote>\n', mark: '^', label: '引用' },
    pre:        { text: '\n<pre><code class="lang-js">^\n</code></pre>\n', mark: '^', label: '代码块' },
    figure:     { text: '\n<figure>\n  <img src="img/uploads/^" alt="">\n  <figcaption></figcaption>\n</figure>\n', mark: '^', label: '配图' },
    a:          { text: '<a href="^">链接文字</a>', mark: '^', label: '链接' }
  };

  /* ------------------------------------------------------------
     git / 备份 / 图片 / 日志
     ------------------------------------------------------------ */
  const refreshStatus = async () => {
    try {
      const data = await api('/api/session');
      const git = data.git || {};
      State.gitRepo = git.available === true;
      const gp = $('#gitPill');
      if (!State.gitRepo) {
        gp.dataset.state = 'off';
        gp.textContent = 'git 不可用';
        $('#commitBtn').disabled = true;
        $('#commitBtn').title = git.reason || '当前环境用不了 git';
      } else {
        gp.dataset.state = git.clean ? 'ok' : 'warn';
        gp.textContent = (git.branch || 'git') + (git.clean ? ' · 干净' : ' · ' + git.dirtyCount + ' 处改动');
        $('#commitBtn').disabled = false;
      }
      $('#authPill').dataset.state = 'ok';
      $('#authPill').textContent = data.auth === 'passphrase' ? '已解锁（口令）' : '本机模式';
      $('#countPill').textContent = data.store.count + ' 篇';
      $('#postsFile').textContent = data.store.file;
      State.limits = data.store.limits || {};
      State.version = data.store.version;
    } catch (err) {
      $('#gitPill').dataset.state = 'bad';
      $('#gitPill').textContent = '状态读取失败';
    }
  };

  const openDrawer = async () => {
    $('#drawer').hidden = false;
    const fill = (host, rows, render) => {
      host.textContent = '';
      if (!rows.length) {
        const li = document.createElement('li');
        li.className = 'ad-dim';
        li.textContent = '（空）';
        host.appendChild(li);
        return;
      }
      rows.forEach((r) => host.appendChild(render(r)));
    };

    try {
      const data = await api('/api/backups');
      fill($('#backupList'), data.backups, (b) => {
        const li = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = b.name;
        const dim = document.createElement('span');
        dim.className = 'ad-dim';
        dim.textContent = (b.bytes / 1024).toFixed(1) + ' KB';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ad-btn is-quiet';
        btn.textContent = '恢复';
        btn.addEventListener('click', async () => {
          if (!window.confirm('用这份备份覆盖当前 js/posts.js？当前内容会先被备份一次。')) return;
          try {
            const r = await api('/api/backups/restore', { json: { name: b.name } });
            toast('已恢复 ' + r.restored + '（' + r.count + ' 篇）', 'ok');
            await reload(false);
            openDrawer();
          } catch (err) { toast('恢复失败：' + err.message, 'bad'); }
        });
        li.appendChild(code);
        li.appendChild(dim);
        li.appendChild(btn);
        return li;
      });
      fill($('#trashList'), data.trash, (t) => {
        const li = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = t.name;
        const dim = document.createElement('span');
        dim.className = 'ad-dim';
        dim.textContent = (t.bytes / 1024).toFixed(1) + ' KB';
        li.appendChild(code);
        li.appendChild(dim);
        return li;
      });
    } catch (err) { toast('读备份列表失败：' + err.message, 'bad'); }

    try {
      const imgs = await api('/api/images');
      fill($('#imageList'), imgs.images, (im) => {
        const li = document.createElement('li');
        const img = document.createElement('img');
        img.src = '/' + im.src;
        img.alt = im.name;
        img.loading = 'lazy';
        const code = document.createElement('code');
        code.textContent = im.src;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ad-btn is-quiet';
        btn.textContent = '插入正文';
        btn.addEventListener('click', () => {
          if (!State.current) { toast('先选一篇文章', 'bad'); return; }
          insertFigure(im.src, im.name);
          toast('已插入 ' + im.src, 'ok');
        });
        li.appendChild(img);
        li.appendChild(code);
        li.appendChild(btn);
        return li;
      });
    } catch (err) { toast('读图片列表失败：' + err.message, 'bad'); }

    try {
      const g = await api('/api/git');
      const rows = (g.log || []).slice(0, 8).map((c) => {
        const li = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = c.hash;
        const span = document.createElement('span');
        span.textContent = c.date + ' · ' + c.subject;
        li.appendChild(code);
        li.appendChild(span);
        return li;
      });
      fill($('#gitLog'), rows, (r) => r);
    } catch { /* git 不可用时上面的 gitPill 已经说明了 */ }
  };

  const commit = async () => {
    const msg = window.prompt('提交信息（留空用默认）', '') ;
    if (msg === null) return;
    try {
      const data = await api('/api/git', { json: { action: 'commit', message: msg } });
      if (!data.ok) { toast('没有需要提交的改动', 'bad'); return; }
      toast('已提交 ' + data.hash + '（' + data.files.length + ' 个文件），推送请在终端执行', 'ok');
      await refreshStatus();
    } catch (err) {
      toast('提交失败：' + err.message, 'bad');
      if (err.errors) showErrors(err.errors);
    }
  };

  /* ------------------------------------------------------------
     载入
     ------------------------------------------------------------ */
  const reload = async (selectCurrent) => {
    const data = await api('/api/posts');
    State.posts = data.posts;
    State.version = data.version;
    derivedLists();
    renderList();
    if (selectCurrent && State.originalSlug &&
        State.posts.some((p) => p.slug === State.originalSlug)) {
      selectPost(State.originalSlug);
    }
  };

  /* ------------------------------------------------------------
     事件绑定
     ------------------------------------------------------------ */
  const bind = () => {
    $('#form').addEventListener('submit', (e) => { e.preventDefault(); save(); });
    $('#newBtn').addEventListener('click', startNew);
    $('#reloadBtn').addEventListener('click', async () => {
      if (State.dirty && !window.confirm('放弃未保存的改动并重新载入？')) return;
      setDirty(false);
      await refreshStatus();
      await reload(false);
      toast('已从磁盘重新载入', 'ok');
    });
    $('#deleteBtn').addEventListener('click', remove);
    $('#commitBtn').addEventListener('click', commit);
    $('#moreBtn').addEventListener('click', openDrawer);
    $('#drawerClose').addEventListener('click', () => { $('#drawer').hidden = true; });
    $('#drawerScrim').addEventListener('click', () => { $('#drawer').hidden = true; });
    $('#search').addEventListener('input', renderList);
    $('#showDrafts').addEventListener('change', renderList);

    /* 表单改动 → 脏标记 + 预览 + slug 建议 */
    ['fTitle', 'fSlug', 'fDate', 'fCategory', 'fTags', 'fExcerpt', 'fBody'].forEach((id) => {
      $('#' + id).addEventListener('input', () => {
        State.current = readForm();
        setDirty(true);
        if (id === 'fTitle' || id === 'fDate') suggestSlug();
        if (id === 'fSlug') State.slugEdited = true;
        if (id === 'fBody') schedulePreview();
      });
    });
    $('#fDraft').addEventListener('change', () => { State.current = readForm(); setDirty(true); });

    /* 工具条 */
    $('#tools').addEventListener('click', (e) => {
      const btn = e.target.closest('.ad-tool');
      if (!btn || !btn.dataset.wrap) return;
      const s = TOOL_SNIPPETS[btn.dataset.wrap];
      if (s) insertAtCursor(s.text, s.mark);
    });

    /* 图片：选择 / 拖拽 / 粘贴 */
    $('#uploadBtn').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (e) => {
      uploadFiles(e.target.files);
      e.target.value = '';
    });

    const wrap = $('#bodyWrap');
    ['dragenter', 'dragover'].forEach((ev) => wrap.addEventListener(ev, (e) => {
      e.preventDefault();
      $('#dropHint').hidden = false;
    }));
    ['dragleave', 'drop'].forEach((ev) => wrap.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'dragleave' && wrap.contains(e.relatedTarget)) return;
      $('#dropHint').hidden = true;
    }));
    wrap.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) uploadFiles(files);
    });
    $('#fBody').addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (const it of items) {
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) { e.preventDefault(); uploadFiles(files); }
    });

    /* 快捷键：Ctrl/⌘+S 保存；Esc 关抽屉 */
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!$('#form').hidden) save();
        return;
      }
      if (e.key === 'Escape' && !$('#drawer').hidden) $('#drawer').hidden = true;
    });

    /* 离开提醒 */
    window.addEventListener('beforeunload', (e) => {
      if (!State.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });
  };

  /* ------------------------------------------------------------
     启动
     ------------------------------------------------------------ */
  const gate = async () => {
    /* 未设口令：/api/session 会给令牌，直接进。
       设了口令且尚未解锁：/api/session 不给令牌 → 显示口令门。
       这里顺便把令牌记下来，省掉后续一次往返。 */
    const res = await fetch('/api/session');
    const data = await res.json();
    if (data.unlocked && data.token) { token = data.token; return true; }
    if (data.auth === 'passphrase') return false;
    return true;
  };

  const unlock = async (pass) => {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: pass })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '口令不正确');

    /* 解锁成功：拿到令牌并把界面拉起来。
       令牌只放在内存里（不写 localStorage、不进 URL），刷新页面会重新取。 */
    if (data.token) token = data.token;
    $('#gate').hidden = true;
    $('#app').hidden = false;
    bind();

    /* 后面每一步单独兜住：界面已经能用了，某一项初始化失败不该表现成
       "口令对了却进不去管理页"（第一版就是被这个坑到的）。 */
    const step = async (label, fn) => {
      try { await fn(); }
      catch (err) { toast(label + '失败：' + err.message, 'bad'); }
    };
    await step('读取状态', refreshStatus);
    await step('载入文章列表', () => reload(true));
    await step('渲染预览', renderPreview);
    toast('已解锁', 'ok');
  };

  const boot = async () => {
    let ready = false;
    try { ready = await gate(); }
    catch (err) { toast('无法连接本地服务：' + err.message, 'bad'); return; }

    if (!ready) {
      $('#gate').hidden = false;
      $('#gateForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        $('#gateError').textContent = '';
        try { await unlock($('#gatePass').value); }
        catch (err) { $('#gateError').textContent = err.message; }
      });
      $('#gatePass').focus();
      return;
    }

    $('#gate').hidden = true;
    $('#app').hidden = false;
    bind();

    /* 同样逐步兜：主界面先出来，细节失败只提示不拦路 */
    const step = async (label, fn) => {
      try { await fn(); }
      catch (err) { toast(label + '失败：' + err.message, 'bad'); }
    };
    await step('读取状态', refreshStatus);
    await step('载入文章列表', () => reload(true));
    await step('渲染预览', renderPreview);

    /* 每 30 秒刷新一次 git 状态，方便看到"还有多少没提交" */
    window.setInterval(() => { refreshStatus().catch(() => {}); }, 30000);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
