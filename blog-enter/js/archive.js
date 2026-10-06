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
     词云：同一个维度的"热度视图"
     ------------------------------------------------------------
     与左边的标签胶囊是同一份状态（State.tags）的两种画法：
       · 胶囊 = 精确开关（点一下叠加 / 取消一个标签）
       · 词云 = 按热度浏览（字号与颜色由该标签下的文章数决定）
     两者共用 toggleTag()，所以任何一边点完，另一边的高亮都会跟着变。

     字号连续：--heat（0~1）× CSS 里的 --tc-range + 基准，再乘一个
     排布时的缩放档位 --tc-scale（放不下才缩，见 packCloud）；
     颜色三档：CSS 没法对变量做区间判断，而"三档色 + 连续字号"已经
     足够表达热度，也更好控制对比度。

     "全部"在抬头行（#cloudAll），不混进云里：它不参与热度缩放，
     也不该占掉碰撞布局里的位置。它清空**所有**筛选（含分类），
     也就是需求里的"恢复完整列表"。

     【为什么"只在标签集合变化时才重建"】
     筛选（点词/点胶囊/切分类）不改各标签的篇数，所以词的集合、字号、
     位置都不该变。如果每次 render 都重建，点一下就会让整片云重新排布、
     所有词跳一次位 —— 那是很糟的观感。所以：集合变了才重建，否则只
     同步选中态（syncCloud）。
     ------------------------------------------------------------ */
  let cloudSig = '';

  const cloudSignature = () => derived.tagList.map((t) => t.name + ':' + t.n).join('|');

  const syncCloud = () => {
    const allBtn = $('#cloudAll');
    const allN = $('#cloudAllN');
    const none = State.cat === ALL && State.tags.length === 0;
    if (allBtn) {
      allBtn.setAttribute('aria-pressed', none ? 'true' : 'false');
      allBtn.setAttribute('aria-label', '全部文章：清空分类与标签筛选，共 ' + total() + ' 篇');
    }
    if (allN) allN.textContent = String(total());
    Array.prototype.forEach.call(document.querySelectorAll('#tagCloud .tc-tag'), (b) => {
      const on = State.tags.indexOf(b.dataset.tag) >= 0;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.setAttribute('aria-label', '标签 ' + b.dataset.tag + '：' + b.dataset.count + ' 篇' + (on ? '（已选）' : ''));
    });
  };

  const renderCloud = () => {
    const host = $('#tagCloud');
    const box = $('#cloudBox');
    if (!host) return;
    const tags = derived.tagList;
    if (box) box.hidden = !tags.length;

    const sig = cloudSignature();
    if (sig === cloudSig && host.children.length) { syncCloud(); return; }
    cloudSig = sig;

    host.textContent = '';
    const restBox = $('#cloudRest');
    if (restBox) { restBox.textContent = ''; restBox.hidden = true; }
    if (!tags.length) return;
    /* 词都挂在 .cloud-inner 上：整层最后会被等比缩放铺满容器（见 packCloud） */
    const inner = cloudInner(host);

    const counts = tags.map((t) => t.n);
    const max = Math.max.apply(null, counts);
    const min = Math.min.apply(null, counts);
    /* span 为 0 = 所有标签篇数相同（或只有一个标签）：热度统一按满档，
       否则会除零，每一枚都变成 0.5 的怪样子 */
    const span = (max - min) || 1;
    const same = max === min;

    /* DOM 顺序 = 篇数降序 = 排布顺序（packCloud 依赖它：先摆大的） */
    tags.forEach((t) => {
      const heat = same ? 1 : (t.n - min) / span;
      const b = el('button', 'tc-tag');
      b.type = 'button';
      b.dataset.tag = t.name;
      b.dataset.count = String(t.n);
      b.dataset.heat = heat >= 0.66 ? 'hot' : heat >= 0.33 ? 'warm' : 'cool';
      b.style.setProperty('--heat', heat.toFixed(3));
      b.appendChild(el('span', 'tc-name', t.name));
      b.appendChild(el('span', 'tc-n', String(t.n)));
      b.addEventListener('click', () => {
        toggleTag(t.name);
        render();
      });
      inner.appendChild(b);
    });

    syncCloud();
    packCloud();
  };

  /* ------------------------------------------------------------
     词云排布：中心螺旋 + 矩形碰撞
     ------------------------------------------------------------
     仿的是经典词云（word cloud）的排法，不是 flex 换行 ——
     换行会在每行末尾留下大块空白，那是"标签行"，不是词云。
       1) 按篇数从大到小（= DOM 顺序）逐个摆；
       2) 每个词从容器中心出发，沿螺旋线由内向外找一个不与已摆矩形相交、
          且完全落在容器内的位置；
       3) 螺旋走完仍找不到 → 整体缩一档字号重来（CLOUD_SIZE_STEPS）；
       4) 缩到最小还是放不下 → 退到下面的 .cloud-rest 行（仍然可点，
          不会被藏起来）。
     为什么不用第三方库：本站零依赖，而这里只有"测量 + 碰撞"两件事，
     二十来个词的开销是亚毫秒级。

     重排时机：重建（renderCloud 末尾）与容器尺寸变化（ResizeObserver ——
     窗口缩放、侧边栏收起/展开都会改变内容区宽度）。字体就绪后再排一次，
     避免量到 fallback 字体的宽度。
     ------------------------------------------------------------ */
  const CLOUD_GAP = 4;                                     // 词与词之间的缝（px）
  const CLOUD_SIZE_STEPS = [1, 0.9, 0.8, 0.7, 0.6, 0.52];  // 放不下时依次缩小
  const CLOUD_FILL = 0.96;                                 // 整朵云最后铺到容器的多少
  const CLOUD_ZOOM_MAX = 2.2;                              // 放大上限（别把小簇撑成怪样子）

  /* 词都放进这一层里：位置是"自然坐标"，最后整层做一次等比缩放 + 居中，
     于是不管容器多大，云都能铺满（参考图里最大的词几乎顶到上下边缘，
     就是这个效果）。放在内层也是为了不和词自己的悬停位移打架 ——
     词上的 transform 属于词，整块的缩放属于这一层。 */
  const cloudInner = (host) => {
    let inner = host.querySelector('.cloud-inner');
    if (!inner) {
      inner = el('div', 'cloud-inner');
      host.appendChild(inner);
    }
    return inner;
  };

  const packCloud = () => {
    const host = $('#tagCloud');
    const restBox = $('#cloudRest');
    if (!host) return;
    const inner = cloudInner(host);
    /* 重排前先清掉悬停分散留下的位移：位置要以 left/top 为唯一真相 */
    clearScatter(host);
    if (restBox) clearScatter(restBox);

    /* 先把上一轮退到兜底行里的词收回来：不收回的话，下一次重建会把它们
       连同兜底行一起清掉，那些标签就彻底消失了 */
    if (restBox) {
      Array.prototype.slice.call(restBox.querySelectorAll('.tc-tag')).forEach((w) => {
        w.classList.remove('is-rest');
        w.style.left = '';
        w.style.top = '';
        w.style.transform = '';
        inner.appendChild(w);
      });
      restBox.textContent = '';
      restBox.hidden = true;
    }

    const words = Array.prototype.slice.call(inner.querySelectorAll('.tc-tag'));
    if (!words.length) return;
    const W = host.clientWidth;
    const H = host.clientHeight;
    if (!W || !H) {                       // 容器还没量到尺寸（隐藏 / 首帧之前）
      words.forEach((w) => { w.style.left = '0px'; w.style.top = '0px'; });
      inner.style.transform = 'none';
      return;
    }

    const placed = [];
    const hits = (x, y, w, h) => {
      if (x < 0 || y < 0 || x + w > W || y + h > H) return true;
      for (let i = 0; i < placed.length; i += 1) {
        const p = placed[i];
        if (x < p.x + p.w + CLOUD_GAP && x + w + CLOUD_GAP > p.x
          && y < p.y + p.h + CLOUD_GAP && y + h + CLOUD_GAP > p.y) return true;
      }
      return false;
    };

    const unplaced = [];
    words.forEach((word) => {
      let done = false;
      for (let si = 0; si < CLOUD_SIZE_STEPS.length && !done; si += 1) {
        word.style.setProperty('--tc-scale', String(CLOUD_SIZE_STEPS[si]));
        const w = word.offsetWidth;
        const h = word.offsetHeight;
        const cx = (W - w) / 2;
        const cy = (H - h) / 2;
        /* 步长要足够小，否则会"跳过"窄缝；椭圆系数让螺旋在宽扁容器里
           更快铺开（这朵云通常接近 2:1） */
        for (let step = 0; step < 900; step += 1) {
          const t = step * 0.28;
          const r = 2.4 * t;
          if (r > Math.max(W, H)) break;
          const x = cx + r * Math.cos(t) * 1.18;
          const y = cy + r * Math.sin(t) * 0.72;
          if (!hits(x, y, w, h)) {
            word.style.left = Math.round(x) + 'px';
            word.style.top = Math.round(y) + 'px';
            placed.push({ x, y, w, h });
            done = true;
            break;
          }
        }
      }
      if (!done) {
        word.style.setProperty('--tc-scale', String(CLOUD_SIZE_STEPS[CLOUD_SIZE_STEPS.length - 1]));
        unplaced.push(word);
      }
    });

    if (unplaced.length && restBox) {
      restBox.hidden = false;
      unplaced.forEach((w) => {
        w.classList.add('is-rest');
        w.style.left = '';
        w.style.top = '';
        restBox.appendChild(w);
      });
    }

    /* 铺满：量出这一簇的实际外接矩形，等比放大并居中。
       只放大不缩小（scale ≥ 1）：缩下去会让字号跌破可读下限，
       而"摆不下"的情况已经由 CLOUD_SIZE_STEPS 与兜底行处理掉了。 */
    if (!placed.length) { inner.style.transform = 'none'; return; }
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    placed.forEach((p) => {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x + p.w > maxX) maxX = p.x + p.w;
      if (p.y + p.h > maxY) maxY = p.y + p.h;
    });
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const s = Math.min(CLOUD_ZOOM_MAX, Math.min((W * CLOUD_FILL) / bw, (H * CLOUD_FILL) / bh));
    const tx = (W - bw * s) / 2 - minX * s;
    const ty = (H - bh * s) / 2 - minY * s;
    inner.style.transform = 'translate(' + tx.toFixed(2) + 'px, ' + ty.toFixed(2) + 'px) scale(' + s.toFixed(4) + ')';
  };

  /* ------------------------------------------------------------
     悬停分散：鼠标停在一个词上时，其余词沿"远离它"的方向让开
     ------------------------------------------------------------
     三条硬约束（都是需求点名的）：
       1) **不越界**：每个词的位移都夹在容器内（x ∈ [0, W-w]、y ∈ [0, H-h]）；
       2) **不重叠**：被推开的词之间可能因此撞上，所以推完做几轮松弛 ——
          沿"穿透更浅"的那个轴把它们分开，再夹一次边界；
       3) **只动显示**：改的是 transform，不动 left/top —— 所以鼠标移开、
          点词筛选、重新排布都不会留下"被推歪"的状态。
     推力随距离衰减（越近让得越多），超出影响半径的词保持不动。
     prefers-reduced-motion 下整个效果关闭。
     ------------------------------------------------------------ */
  const SCATTER_RADIUS = 96;    // 影响半径（还要加上悬停词自身尺寸的一半）
  const SCATTER_MAX = 26;       // 最大推力（布局单位）
  const SCATTER_ITER = 3;       // 松弛轮数

  const clearScatter = (host) => {
    const box = host || $('#tagCloud');
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('.tc-tag'), (w) => { w.style.transform = ''; });
  };

  const scatterCloud = (hovered) => {
    const host = $('#tagCloud');
    if (!host || !hovered) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const inner = host.querySelector('.cloud-inner');
    if (!inner) return;
    const words = Array.prototype.slice.call(inner.querySelectorAll('.tc-tag'));
    if (words.length < 2) return;
    const W = host.clientWidth;
    const H = host.clientHeight;
    if (!W || !H) return;

    /* 基准位置取 left/top（排布算出来的），**不取** getBoundingClientRect：
       后者把整层缩放与上一次的位移一起算进去，效果会逐次累积漂移。 */
    const base = [];
    for (let i = 0; i < words.length; i += 1) {
      const w = words[i];
      const x = parseFloat(w.style.left);
      const y = parseFloat(w.style.top);
      if (!isFinite(x) || !isFinite(y)) return;   // 还没排布过：不做效果
      base.push({ el: w, x: x, y: y, w: w.offsetWidth, h: w.offsetHeight });
    }
    const hi = words.indexOf(hovered);
    if (hi < 0) return;

    const hw = base[hi];
    const hcx = hw.x + hw.w / 2;
    const hcy = hw.y + hw.h / 2;
    const R = SCATTER_RADIUS + Math.max(hw.w, hw.h) / 2;

    const off = base.map(() => ({ dx: 0, dy: 0 }));
    base.forEach((b, i) => {
      if (i === hi) return;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      let vx = cx - hcx;
      let vy = cy - hcy;
      let d = Math.sqrt(vx * vx + vy * vy);
      if (d > R) return;                          // 太远：不动
      if (d < 1) { vx = 1; vy = 0; d = 1; }       // 中心重合时给个确定方向
      const push = SCATTER_MAX * (1 - d / R);
      off[i].dx = (vx / d) * push;
      off[i].dy = (vy / d) * push;
    });

    /* 边界要按**视觉**坐标算：整层还有一次等比放大 + 居中位移
       （.cloud-inner 的 transform），布局坐标里的 [0, W] 并不等于眼睛看到的
       [0, W]。不换算的话，放大后的词会被推到容器外面再被 overflow 裁掉 ——
       那正是"不得超出范围"要避免的情况。
       matrix(a, b, c, d, e, f)：a = scaleX、e/f = translateX/Y。 */
    let zoom = 1;
    let zoomTx = 0;
    let zoomTy = 0;
    const mt = /matrix\(([^)]+)\)/.exec(window.getComputedStyle(inner).transform);
    if (mt) {
      const parts = mt[1].split(',').map((v) => parseFloat(v));
      zoom = parts[0] || 1;
      zoomTx = parts[4] || 0;
      zoomTy = parts[5] || 0;
    }
    const limitX = (0 - zoomTx) / zoom;             // 视觉左边 → 布局坐标
    const limitY = (0 - zoomTy) / zoom;
    const limitX2 = (W - zoomTx) / zoom;            // 视觉右边 → 布局坐标
    const limitY2 = (H - zoomTy) / zoom;

    const clampAll = () => {
      base.forEach((b, i) => {
        const mx = Math.max(limitX, limitX2 - b.w);
        const my = Math.max(limitY, limitY2 - b.h);
        const nx = Math.min(Math.max(b.x + off[i].dx, limitX), mx);
        const ny = Math.min(Math.max(b.y + off[i].dy, limitY), my);
        off[i].dx = nx - b.x;
        off[i].dy = ny - b.y;
      });
    };
    clampAll();

    for (let it = 0; it < SCATTER_ITER; it += 1) {
      for (let i = 0; i < base.length; i += 1) {
        if (i === hi) continue;
        for (let j = i + 1; j < base.length; j += 1) {
          if (j === hi) continue;
          const a = base[i];
          const c = base[j];
          const ax = a.x + off[i].dx;
          const ay = a.y + off[i].dy;
          const cx = c.x + off[j].dx;
          const cy = c.y + off[j].dy;
          /* 两个轴上的间隙：都小于 CLOUD_GAP 才算"撞上了" */
          const gx = Math.max(ax - (cx + c.w), cx - (ax + a.w));
          const gy = Math.max(ay - (cy + c.h), cy - (ay + a.h));
          if (gx >= CLOUD_GAP || gy >= CLOUD_GAP) continue;
          if (gx > gy) {
            const d = (CLOUD_GAP - gx) / 2 + 0.5;
            const s = (ax + a.w / 2) <= (cx + c.w / 2) ? -1 : 1;
            off[i].dx += s * d;
            off[j].dx -= s * d;
          } else {
            const d = (CLOUD_GAP - gy) / 2 + 0.5;
            const s = (ay + a.h / 2) <= (cy + c.h / 2) ? -1 : 1;
            off[i].dy += s * d;
            off[j].dy -= s * d;
          }
        }
      }
      clampAll();
    }

    base.forEach((b, i) => {
      if (i === hi) { b.el.style.transform = ''; return; }   // 悬停词本身交给 CSS 的 :hover
      const dx = Math.round(off[i].dx * 10) / 10;
      const dy = Math.round(off[i].dy * 10) / 10;
      b.el.style.transform = (dx || dy) ? 'translate(' + dx + 'px, ' + dy + 'px)' : '';
    });
  };

  const watchCloudHover = () => {
    const host = $('#tagCloud');
    if (!host) return;
    let current = null;
    const pick = (e) => (e.target && e.target.closest ? e.target.closest('.tc-tag') : null);
    /* 用 mouseover 而不是 mouseenter：后者不冒泡，绑在容器上收不到子元素的事件 */
    host.addEventListener('mouseover', (e) => {
      const t = pick(e);
      if (!t || t === current) return;
      current = t;
      scatterCloud(t);
    });
    host.addEventListener('mouseleave', () => { current = null; clearScatter(host); });
    /* 键盘 Tab 到某个词上也给同样的反馈 */
    host.addEventListener('focusin', (e) => {
      const t = pick(e);
      if (!t || t === current) return;
      current = t;
      scatterCloud(t);
    });
    host.addEventListener('focusout', () => { current = null; clearScatter(host); });
  };

  /* 容器尺寸变化后重排（防抖：侧边栏收起/展开的过渡会连打十几次 resize） */
  let packTimer = null;
  let packedW = 0;
  let packedH = 0;
  const schedulePack = () => {
    if (packTimer) window.clearTimeout(packTimer);
    packTimer = window.setTimeout(() => {
      packTimer = null;
      const host = $('#tagCloud');
      if (!host) return;
      if (host.clientWidth === packedW && host.clientHeight === packedH) return;
      packCloud();
    }, 130);
  };

  const watchCloud = () => {
    const host = $('#tagCloud');
    if (!host) return;
    packedW = host.clientWidth;
    packedH = host.clientHeight;
    if (typeof window.ResizeObserver === 'function') {
      try {
        new window.ResizeObserver(() => schedulePack()).observe(host);
      } catch (err) {
        window.addEventListener('resize', schedulePack);
      }
    } else {
      window.addEventListener('resize', schedulePack);
    }
    /* 字体就绪后再排一次：量到 fallback 字体的宽度会让大词偏窄 */
    if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
      document.fonts.ready.then(() => { packedW = 0; packedH = 0; schedulePack(); }).catch(() => {});
    }
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
    /* 词云抬头那个"全部"：清空所有筛选（含分类），即恢复完整列表 */
    const allBtn = $('#cloudAll');
    if (allBtn) allBtn.addEventListener('click', clearAll);
    $('#viewList').addEventListener('click', () => { State.view = 'list'; render(); });
    $('#viewTimeline').addEventListener('click', () => { State.view = 'timeline'; render(); });

    render();
    /* 排布依赖容器尺寸，所以要等真正布局完成后再接管尺寸变化 */
    watchCloud();
    /* 悬停分散是纯显示效果，绑在容器上即可 */
    watchCloudHover();
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
