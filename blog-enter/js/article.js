/* ============================================================
   文章详情
   ------------------------------------------------------------
   一篇文章一个 URL：article.html?slug=xxx

   为什么用查询串而不是 /posts/xxx.html 这样的静态路径：
   纯静态托管下，前者只需要一个模板文件，加文章时不用重新生成 HTML；
   代价是分享出去的长尾是查询串。如果更看重"每篇一个真实路径"，
   把这里换成读 <html data-slug> 即可，渲染逻辑不用动。

   两种"找不到"的处理是分开的：
     · slug 缺失或对不上任何文章 → 就地渲染空状态（页面框架还在，
       底部评论区等公共信息不会丢），而不是整页跳走
     · 路径本身不存在 → 由托管平台交给 404.html
   ============================================================ */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const POSTS = () => window.POSTS || [];

  /* file:// 下 URLSearchParams 读不到 location.search（部分浏览器会抛），
     所以直接手动解析 location.href 的查询串，两种协议行为一致。 */
  const query = (key) => {
    const href = window.location.href;
    const i = href.indexOf('?');
    if (i < 0) return '';
    const raw = href.slice(i + 1).split('#')[0];
    const parts = raw.split('&');
    for (let k = 0; k < parts.length; k++) {
      const eq = parts[k].indexOf('=');
      const name = eq < 0 ? parts[k] : parts[k].slice(0, eq);
      if (name !== key) continue;
      const value = eq < 0 ? '' : parts[k].slice(eq + 1);
      try { return decodeURIComponent(value.replace(/\+/g, ' ')); }
      catch (err) { return value; }
    }
    return '';
  };

  const sorted = () => POSTS().slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  /* 中文按字数估读速（400 字/分钟），英文单词按 200 词/分钟；
     只用于给一个量级感，不追求精确。 */
  const readingTime = (post) => {
    const html = post.body || '';
    const text = html.replace(/<[^>]*>/g, ' ');
    const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const words = (text.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9_$]+/g) || []).length;
    const minutes = Math.max(1, Math.round(cjk / 400 + words / 200));
    return minutes + ' 分钟';
  };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };

  const archiveHref = (params) => {
    const q = new URLSearchParams();
    Object.keys(params).forEach((k) => q.set(k, params[k]));
    return 'archive.html?' + q.toString();
  };

  /* ------------------------------------------------------------
     404（软）：文章不存在
     ------------------------------------------------------------ */
  const showNotFound = (slug) => {
    const shell = $('#articleShell');
    if (shell) shell.hidden = true;

    /* 评论区是 #articleShell 之外的兄弟节点，必须一起藏 —— 否则访问一个
       不存在的 slug，会在"这篇文章不存在"下面留一个空评论区；接上 Waline
       之后更糟：它还会真的去拉评论、甚至能发。 */
    const comments = $('#comments');
    if (comments) comments.hidden = true;

    const box = $('#notFound');
    if (!box) return;
    box.hidden = false;

    const text = $('#notFoundText');
    if (text) {
      text.textContent = '';
      if (slug) {
        text.appendChild(document.createTextNode('链接里的 slug 是 '));
        const code = el('code', '', slug);
        text.appendChild(code);
        text.appendChild(document.createTextNode('，没有对应的文章 —— 可能已经被改名或删除。'));
      } else {
        text.appendChild(document.createTextNode('这个地址缺少 slug 参数，不知道你想看哪一篇。'));
      }
    }

    /* 顺手给几条最近的，别让这个页面变成死胡同 */
    const posts = sorted();
    if (posts.length) {
      const recent = el('div', 'post-list');
      recent.style.marginTop = '10px';
      posts.slice(0, 3).forEach((p) => {
        const a = el('a', 'post-card');
        a.href = 'article.html?slug=' + encodeURIComponent(p.slug);
        a.appendChild(el('h3', 'pc-title', p.title));
        const t = el('time', 'pc-date', p.date);
        t.dateTime = p.date;
        a.appendChild(t);
        a.appendChild(el('p', 'pc-excerpt', p.excerpt || ''));
        recent.appendChild(a);
      });
      box.appendChild(el('h2', 'section-title', '最近的文章'));
      box.appendChild(recent);
    }

    document.title = '文章不存在 — ' + ((window.SITE && window.SITE.name) || 'YOUR NAME');
  };

  /* ------------------------------------------------------------
     渲染
     ------------------------------------------------------------ */
  const renderHead = (post) => {
    document.title = post.title + ' — ' + ((window.SITE && window.SITE.name) || 'YOUR NAME');
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', post.excerpt || post.title);

    if ($('#articleTitle')) $('#articleTitle').textContent = post.title;

    const date = $('#articleDate');
    if (date) {
      date.textContent = post.date;
      date.dateTime = post.date;
    }

    const cat = $('#articleCat');
    if (cat) {
      cat.textContent = post.category;
      cat.href = archiveHref({ cat: post.category });
    }
    if ($('#crumbCat')) $('#crumbCat').textContent = post.category;
    if ($('#articleRead')) $('#articleRead').textContent = '约 ' + readingTime(post);

    const tags = $('#articleTags');
    if (tags) {
      tags.textContent = '';
      (post.tags || []).forEach((t) => {
        const a = el('a', 'tag', t);
        a.href = archiveHref({ tag: t });
        tags.appendChild(a);
      });
    }
  };

  /* 上下篇：按时间倒序里相邻的两条 */
  const renderNav = (post) => {
    const host = $('#postNav');
    if (!host) return;
    host.textContent = '';

    const list = sorted();
    const i = list.findIndex((p) => p.slug === post.slug);
    const newer = i > 0 ? list[i - 1] : null;          /* 更新的一篇 */
    const older = i >= 0 && i < list.length - 1 ? list[i + 1] : null;

    const mk = (p, dir, label, isNext) => {
      if (!p) return el('span', 'is-empty');
      const a = el('a', isNext ? 'is-next' : 'is-prev');
      a.href = 'article.html?slug=' + encodeURIComponent(p.slug);
      a.appendChild(el('span', 'pn-dir', label));
      a.appendChild(el('span', 'pn-title', p.title));
      return a;
    };

    host.appendChild(mk(older, 'prev', '← 更早', false));
    host.appendChild(mk(newer, 'next', '更新 →', true));
  };

  /* ------------------------------------------------------------
     启动
     ------------------------------------------------------------ */
  const boot = () => {
    const posts = POSTS();
    if (!posts.length) {
      console.error('[article] window.POSTS 为空 —— 检查 js/posts.js 是否加载成功');
      showNotFound('');
      return;
    }

    const slug = query('slug');
    /* 预览口子：草稿只有在 ?preview=<它自己的 slug> 时才可见 */
    const preview = query('preview');

    /* 先按 slug 找，再按"旧地址别名"找 —— 管理页改过 slug 的文章，
       旧链接靠 aliases 兜住，不然外链全断。 */
    let post = slug ? posts.find((p) => p.slug === slug) : null;
    let viaAlias = false;
    if (!post && slug) {
      post = posts.find((p) => (p.aliases || []).indexOf(slug) >= 0) || null;
      viaAlias = !!post;
    }

    /* 草稿：没有被显式预览就当它不存在（软 404，页面框架还在） */
    if (post && post.isDraft && preview !== post.slug) {
      showNotFound(slug);
      return;
    }

    if (!post) { showNotFound(slug); return; }

    /* 通过旧地址进来：把地址栏换成新地址，但不产生一次跳转/历史记录 */
    if (viaAlias && window.history && window.history.replaceState) {
      const q = '?slug=' + encodeURIComponent(post.slug) +
        (post.isDraft ? '&preview=' + encodeURIComponent(post.slug) : '');
      try { window.history.replaceState(null, '', 'article.html' + q); } catch (err) { /* file:// 下忽略 */ }
    }

    renderHead(post);

    const body = $('#articleBody');
    if (body) body.innerHTML = post.body || '<p>这篇还没有正文。</p>';

    renderNav(post);

    /* 草稿给个显眼但克制的提示：本地预览时你才知道这篇还没上线 */
    if (post.isDraft) {
      const shellHead = document.querySelector('.article-head');
      if (shellHead) {
        const note = el('p', 'section-note', '草稿预览 —— 归档页不会列出这一篇');
        note.style.marginTop = '8px';
        shellHead.appendChild(note);
      }
    }

    const shell = $('#articleShell');
    if (shell) shell.hidden = false;

    /* 正文渲染成功才放开评论区，并且**只在这里**触发初始化：
       评论客户端不自己判断文章是否存在（见 article.html 底部那段说明）。
       window.initComments 由 article.html 的模块脚本准备，可能还没到位 ——
       那种情况下它会自己回头读 window.Article 补一次，所以这里不用等。 */
    const comments = $('#comments');
    if (comments) {
      comments.hidden = false;
      if (window.initComments) window.initComments(post.slug);
    }

    /* 代码高亮 / 复制按钮由 pages.js 负责：它在本文件之后执行（同为 defer，
       顺序按标签先后），会扫 .prose pre > code 并逐个套上外壳。
       本文件只负责把正文写进 DOM，两件事不交叉、不会重复装饰。 */

    /* 给自动化验证与外部脚本留一个读取点 */
    window.Article = { slug: post.slug, viaAlias: viaAlias, post: post };
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
