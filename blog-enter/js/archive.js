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
     标签云：同一个维度的"热度视图"
     ------------------------------------------------------------
     与上面的标签胶囊是同一份状态（State.tags）的两种画法：
       · 胶囊 = 精确开关（点一下叠加 / 取消一个标签）
       · 云   = 按热度浏览（字号与颜色由该标签下的文章数决定）
     两者共用 toggleTag()，所以任何一边点完，另一边的高亮都会跟着变。

     字号连续：--heat（0~1）× CSS 里的 --tc-range + 基准；
     颜色三档：CSS 没办法对变量做区间判断，而"三档色 + 连续字号"已经
     足够表达热度，也更好控制对比度（越热越接近正文色，越冷越淡）。

     "全部"与胶囊里的"不限"含义不同：这里的"全部"= 清空**所有**筛选
     （含分类），也就是需求里的"恢复完整列表"，所以它调 clearAll()。
     ------------------------------------------------------------ */
  const renderCloud = () => {
    const host = $('#tagCloud');
    if (!host) return;
    const row = host.closest('.filter-row');
    const tags = derived.tagList;

    host.textContent = '';
    if (!tags.length) {
      if (row) row.hidden = true;
      return;
    }
    if (row) row.hidden = false;

    const counts = tags.map((t) => t.n);
    const max = Math.max.apply(null, counts);
    const min = Math.min.apply(null, counts);
    /* span 为 0 = 所有标签篇数相同（或只有一个标签）：热度统一按满档，
       否则会除零，每一枚都变成 0.5 的怪样子 */
    const span = (max - min) || 1;
    const same = max === min;

    const push = (cls, label, n, heat, band, pressed, aria, pick) => {
      const b = el('button', 'tc-tag' + (cls ? ' ' + cls : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      b.setAttribute('aria-label', aria);
      b.style.setProperty('--heat', heat.toFixed(3));
      if (band) b.dataset.heat = band;
      b.appendChild(el('span', 'tc-name', label));
      b.appendChild(el('span', 'tc-n', String(n)));
      b.addEventListener('click', () => {
        /* 点一下就把整块云重画了：记下位置，重画后把焦点还给同一枚，
           否则键盘用户按一次回车，焦点就掉回 <body> 了 */
        const idx = Array.prototype.indexOf.call(host.children, b);
        pick();
        render();
        const again = host.children[idx];
        if (again && again.focus) again.focus({ preventScroll: true });
      });
      host.appendChild(b);
    };

    push('tc-all', '全部', total(), 1, null,
      State.cat === ALL && State.tags.length === 0,
      '全部文章：清空分类与标签筛选，共 ' + total() + ' 篇', clearAll);

    tags.forEach((t) => {
      const heat = same ? 1 : (t.n - min) / span;
      const on = State.tags.indexOf(t.name) >= 0;
      push('', t.name, t.n, heat, heat >= 0.66 ? 'hot' : heat >= 0.33 ? 'warm' : 'cool', on,
        '标签 ' + t.name + '：' + t.n + ' 篇' + (on ? '（已选）' : ''),
        () => toggleTag(t.name));
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

    /* 标签云与胶囊共用 State.tags，每次 render 一起重画（顺序即状态） */
    renderCloud();

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
