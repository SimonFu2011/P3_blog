/* ============================================================
   文章归档
   ------------------------------------------------------------
   两个筛选维度：
     · 分类（单选）—— 一篇文章只有一个 category
     · 标签（多选，可叠加）—— 同一维度内部是"与"
   维度之间是"与"。结果同时驱动列表视图与时间线视图，
   两个视图共用同一份筛选结果，所以切换视图不会丢筛选条件。

   状态放在 URL 查询串（?cat=..&tag=..&tag=..&view=timeline）：
   刷新、分享、从文章详情页返回都能回到同一个视图。
   ============================================================ */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const POSTS = () => window.POSTS || [];

  /* ------------------------------------------------------------
     草稿可见性
     ------------------------------------------------------------
     管理页可以把一篇标成 isDraft。草稿不出现在归档页，也不进任何计数，
     除非地址上带了 ?preview=<slug> —— 那个口子是给本地管理页自己看的，
     不是权限控制（本站是纯静态站，没有服务端权限这一说），
     只是别让草稿被顺手列出来。

     visibility 在脚本加载时算一次即可：它是地址属性，中途不会变。
     ------------------------------------------------------------ */
  const previewSlug = (() => {
    const href = window.location.href;
    const i = href.indexOf('?');
    if (i < 0) return '';
    const m = /(?:^|&)preview=([^&#]*)/.exec(href.slice(i + 1));
    if (!m) return '';
    try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (err) { return m[1]; }
  })();

  /* 可见的文章：非草稿，或者正好是正在被预览的那一篇 */
  const VISIBLE = () => POSTS().filter((p) => !p.isDraft || p.slug === previewSlug);

  /* 全部 = 不筛选。用 null 而不是 '' —— '' 会和"标题为空"混淆 */
  const ALL = null;

  const State = {
    cat: ALL,
    tags: [],
    view: 'list'
  };

  /* ------------------------------------------------------------
     数据派生：分类列表与标签列表都从文章里现算，不写死在 HTML 里，
     加一篇新文章不需要同步改任何清单。
     ------------------------------------------------------------ */
  const derive = () => {
    const posts = VISIBLE();
    const cats = new Map();
    const tags = new Map();
    posts.forEach((p) => {
      cats.set(p.category, (cats.get(p.category) || 0) + 1);
      (p.tags || []).forEach((t) => tags.set(t, (tags.get(t) || 0) + 1));
    });
    /* 分类按篇数降序，标签按字母序 —— 数量多的更可能是主要话题 */
    const catList = Array.from(cats, ([name, n]) => ({ name: name, n: n }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'zh'));
    const tagList = Array.from(tags, ([name, n]) => ({ name: name, n: n }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'zh'));
    return { catList: catList, tagList: tagList };
  };

  const match = (post) => {
    if (State.cat !== ALL && post.category !== State.cat) return false;
    if (State.tags.length) {
      const own = post.tags || [];
      /* 标签是"与"：必须同时命中所有已选标签 */
      return State.tags.every((t) => own.indexOf(t) >= 0);
    }
    return true;
  };

  const filtered = () => VISIBLE().filter(match)
    .slice()
    /* 倒序：新的在前。date 是 YYYY-MM-DD，字符串比较即时间序 */
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  /* ------------------------------------------------------------
     URL 同步
     ------------------------------------------------------------ */
  const readUrl = () => {
    let q;
    try { q = new URLSearchParams(window.location.search); } catch (err) { return; }
    const cat = q.get('cat');
    State.cat = cat && VISIBLE().some((p) => p.category === cat) ? cat : ALL;
    State.tags = q.getAll('tag').filter((t) => VISIBLE().some((p) => (p.tags || []).indexOf(t) >= 0));
    State.view = q.get('view') === 'timeline' ? 'timeline' : 'list';
  };

  const writeUrl = () => {
    if (!window.history || !window.history.replaceState) return;
    const q = new URLSearchParams();
    if (State.cat !== ALL) q.set('cat', State.cat);
    State.tags.forEach((t) => q.append('tag', t));
    if (State.view !== 'list') q.set('view', State.view);
    /* preview 是"看草稿"的口子，切换筛选时不能把它弄丢 */
    if (previewSlug) q.set('preview', previewSlug);
    const s = q.toString();
    try {
      window.history.replaceState(null, '', s ? '?' + s : window.location.pathname);
    } catch (err) {
      /* file:// 下部分浏览器禁止 replaceState，忽略即可 —— 筛选本身照常工作 */
    }
  };

  /* ------------------------------------------------------------
     渲染
     ------------------------------------------------------------ */
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };

  const postHref = (post) => {
    const base = 'article.html?slug=' + encodeURIComponent(post.slug);
    /* 只有草稿的详情页需要带上同一个 preview 口子，
       否则点进去会被自己的"草稿不可见"规则挡成"文章不存在"。
       正式文章的链接保持干净 —— 别把本地预览参数散播到正常链接里。 */
    return (previewSlug && post.isDraft)
      ? base + '&preview=' + encodeURIComponent(previewSlug)
      : base;
  };

  /* 列表视图：一张卡片一篇 */
  const renderList = (posts) => {
    const host = $('#postList');
    if (!host) return;
    host.textContent = '';

    if (!posts.length) {
      host.appendChild(emptyState());
      return;
    }

    const frag = document.createDocumentFragment();
    const n = posts.length;
    posts.forEach((p, i) => {
      const a = el('a', 'post-card');
      a.href = postHref(p);

      /* 序号是"寄存器"版式的骨架：倒序显示（最新的一篇编号最大），
         所以从 n 往下数，而不是用循环下标。列表本身不排序号。 */
      const num = el('span', 'pc-num', String(n - i).padStart(2, '0'));
      num.setAttribute('aria-hidden', 'true');
      const title = el('h3', 'pc-title', p.title);
      const date = el('time', 'pc-date', p.date);
      date.dateTime = p.date;
      const excerpt = el('p', 'pc-excerpt', p.excerpt || '');

      const meta = el('div', 'pc-meta');
      const cat = el('span', 'pc-cat', p.category);
      meta.appendChild(cat);
      (p.tags || []).forEach((t) => meta.appendChild(el('span', 'pc-tag', t)));
      if (p.isDraft) meta.appendChild(el('span', 'pc-tag', '草稿'));

      a.appendChild(num);
      a.appendChild(title);
      a.appendChild(date);
      a.appendChild(excerpt);
      a.appendChild(meta);
      frag.appendChild(a);
    });
    host.appendChild(frag);
  };

  /* 时间线视图：年 → 月 → 篇。月份和年份都从 date 字符串切，
     不走 Date 解析，避免时区把跨月的那几条推到上一个月。 */
  const renderTimeline = (posts) => {
    const host = $('#timeline');
    if (!host) return;
    host.textContent = '';

    if (!posts.length) {
      host.appendChild(emptyState('这段时间线是空的'));
      return;
    }

    const years = new Map();
    posts.forEach((p) => {
      const y = p.date.slice(0, 4);
      const m = p.date.slice(5, 7);
      if (!years.has(y)) years.set(y, new Map());
      const months = years.get(y);
      if (!months.has(m)) months.set(m, []);
      months.get(m).push(p);
    });

    const frag = document.createDocumentFragment();
    years.forEach((months, y) => {
      const yearBox = el('section', 'tl-year-box');
      const yearHead = el('h3', 'tl-year');
      yearHead.appendChild(document.createTextNode(y));
      yearHead.appendChild(el('span', '', '年'));
      yearBox.appendChild(yearHead);

      const list = el('div', 'tl-months');
      months.forEach((items, m) => {
        const monthBox = el('section', 'tl-month');
        const head = el('div', 'tl-month-head');
        head.appendChild(el('span', 'tl-month-name', y + ' / ' + m));
        head.appendChild(el('span', 'tl-month-n', items.length + ' 篇'));
        monthBox.appendChild(head);

        const ul = el('div', 'tl-items');
        items.forEach((p) => {
          const a = el('a', 'tl-item');
          a.href = postHref(p);
          a.appendChild(el('span', 'tl-day', p.date.slice(8, 10)));
          a.appendChild(el('span', 'tl-title', p.title));
          a.appendChild(el('span', 'tl-cat', p.category));
          ul.appendChild(a);
        });
        monthBox.appendChild(ul);
        list.appendChild(monthBox);
      });

      yearBox.appendChild(list);
      frag.appendChild(yearBox);
    });
    host.appendChild(frag);
  };

  const emptyState = (text) => {
    const box = el('div', 'empty');
    box.appendChild(el('div', 'empty-mark', 'EMPTY'));
    box.appendChild(el('p', '', text || '这个组合下还没有文章。换个分类，或者少选几个标签。'));
    const reset = el('button', 'filter-reset is-block', '清空筛选');
    reset.type = 'button';
    reset.addEventListener('click', clearAll);
    box.appendChild(reset);
    return box;
  };

  /* 筛选胶囊：aria-pressed 表达选中态（读屏能读到），
     视觉上由 CSS 的 [aria-pressed="true"] 负责 */
  const renderChips = (host, items, isOn, onPick, allLabel, allCount) => {
    if (!host) return;
    host.textContent = '';

    const all = el('button', 'chip');
    all.type = 'button';
    all.setAttribute('aria-pressed', isOn(ALL) ? 'true' : 'false');
    all.appendChild(document.createTextNode(allLabel));
    all.appendChild(el('span', 'chip-n', String(allCount)));
    all.addEventListener('click', () => onPick(ALL));
    host.appendChild(all);

    items.forEach((it) => {
      const b = el('button', 'chip');
      b.type = 'button';
      b.setAttribute('aria-pressed', isOn(it.name) ? 'true' : 'false');
      b.appendChild(document.createTextNode(it.name));
      b.appendChild(el('span', 'chip-n', String(it.n)));
      b.addEventListener('click', () => onPick(it.name));
      host.appendChild(b);
    });
  };

  /* ------------------------------------------------------------
     状态变更
     ------------------------------------------------------------ */
  const toggleTag = (t) => {
    if (t === ALL) { State.tags = []; return; }
    const i = State.tags.indexOf(t);
    if (i >= 0) State.tags.splice(i, 1);
    else State.tags.push(t);
  };

  const clearAll = () => {
    State.cat = ALL;
    State.tags = [];
    render();
  };

  const total = () => VISIBLE().length;

  /* ------------------------------------------------------------
     总渲染
     ------------------------------------------------------------ */
  let derived = { catList: [], tagList: [] };

  const render = () => {
    const posts = filtered();

    renderChips($('#catChips'), derived.catList,
      (name) => State.cat === name,
      (name) => { State.cat = name; render(); },
      '全部', total());

    renderChips($('#tagChips'), derived.tagList,
      (name) => name === ALL ? State.tags.length === 0 : State.tags.indexOf(name) >= 0,
      (name) => { toggleTag(name); render(); },
      '不限', total());

    /* 计数与"清空"的可用性 */
    const count = $('#filterCount');
    if (count) {
      const active = State.cat !== ALL || State.tags.length > 0;
      const bits = [];
      if (State.cat !== ALL) bits.push('分类「' + State.cat + '」');
      if (State.tags.length) bits.push('标签 ' + State.tags.map((t) => '#' + t).join(' + '));
      count.innerHTML = active
        ? '命中 <b>' + posts.length + '</b> / ' + total() + ' 篇 · ' + bits.join(' · ')
        : '共 <b>' + total() + '</b> 篇';
    }
    const reset = $('#filterReset');
    if (reset) reset.disabled = !(State.cat !== ALL || State.tags.length > 0);

    /* 视图切换 */
    const isTl = State.view === 'timeline';
    const listBox = $('#listSection');
    const tlBox = $('#timelineSection');
    if (listBox) listBox.hidden = isTl;
    if (tlBox) tlBox.hidden = !isTl;
    const bList = $('#viewList');
    const bTl = $('#viewTimeline');
    if (bList) bList.setAttribute('aria-pressed', isTl ? 'false' : 'true');
    if (bTl) bTl.setAttribute('aria-pressed', isTl ? 'true' : 'false');

    if (isTl) renderTimeline(posts);
    else renderList(posts);

    writeUrl();
  };

  /* ------------------------------------------------------------
     启动
     ------------------------------------------------------------ */
  const boot = () => {
    const posts = VISIBLE();
    if (!posts.length) {
      console.error('[archive] window.POSTS 为空 —— 检查 js/posts.js 是否加载成功');
      const host = $('#postList');
      if (host) {
        host.textContent = '';
        const box = el('div', 'empty');
        box.appendChild(el('div', 'empty-mark', 'NO DATA'));
        box.appendChild(el('p', '', '文章数据没有加载成功（js/posts.js）。'));
        host.appendChild(box);
      }
      return;
    }

    derived = derive();
    const totalEl = $('#totalCount');
    if (totalEl) totalEl.textContent = String(posts.length);

    readUrl();

    $('#filterReset').addEventListener('click', clearAll);
    $('#viewList').addEventListener('click', () => { State.view = 'list'; render(); });
    $('#viewTimeline').addEventListener('click', () => { State.view = 'timeline'; render(); });

    render();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  /* 暴露给自动化验证用 */
  window.Archive = {
    state: State,
    filtered: filtered,
    render: render,
    totals: () => ({ total: total(), shown: filtered().length })
  };
})();
