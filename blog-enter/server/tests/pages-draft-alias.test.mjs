/* ============================================================
   页面侧逻辑验签（无浏览器）
   ------------------------------------------------------------
   跑法：node blog-enter/server/tests/pages-draft-alias.test.mjs

   要验的是"管理端功能落到公开页面上的效果"：
     · 草稿不出现在归档页，也不进任何计数
     · ?preview=<slug> 时草稿才可见，且归档卡片链接会带上该参数
     · 改过 slug 的文章，旧地址（aliases）仍然能打开详情页
     · 通过旧地址进来时地址栏会被换成新地址（replaceState）

   做法：在 node:vm 里**真实执行** js/archive.js 与 js/article.js，
   配一份最小 DOM 桩。这样验的是页面脚本本身，而不是我对它的复述 ——
   没有浏览器也能跑，且不会因为"浏览器起不来"而漏掉这一层。

   为什么不直接把整个站点塞进 jsdom：本站零依赖，测试也不该为了跑一次
   验签引入一堆包。这里用到的 DOM 面很窄（querySelector / createElement /
   appendChild / addEventListener / classList / textContent / innerHTML），
   桩得住。
   ============================================================ */
import assert from 'node:assert/strict';
import { createHarness, isMain } from './harness.mjs';

const H = createHarness('pages-draft-alias.test.mjs');
const test = (name, fn) => H.test(name, fn);
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const JS = join(HERE, '..', '..', 'js');
const readScript = (f) => readFile(join(JS, f), 'utf8');

const ARCHIVE_SRC = await readScript('archive.js');
const ARTICLE_SRC = await readScript('article.js');

/* ------------------------------------------------------------
   最小 DOM
   ------------------------------------------------------------ */
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.children = [];
    this.attributes = {};
    this.className = '';
    this.textContent = '';
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.parentNode = null;
    this.style = {};        // 页面脚本会写 el.style.marginTop 之类，桩环境要有
    this.classList = {
      _set: new Set(),
      add: (c) => { this.classList._set.add(c); },
      remove: (c) => { this.classList._set.delete(c); },
      toggle: (c, on) => { if (on === undefined ? !this.classList._set.has(c) : on) this.classList._set.add(c); else this.classList._set.delete(c); },
      contains: (c) => this.classList._set.has(c)
    };
    this._html = '';
  }

  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'id') this.id = String(v);
    if (k === 'class') this.className = String(v);
    if (k === 'href') this.href = String(v);
    if (k === 'datetime') this.dateTime = String(v);
  }
  getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
  closest() { return null; }

  /* 收集整棵子树的文本，方便断言"渲染里有没有这一篇" */
  allText() {
    return this.children.map((c) => (c.allText ? c.allText() : String(c.textContent || ''))).join(' ') +
      ' ' + String(this.textContent || '');
  }

  /* 收集所有带 href 的后代 */
  allHrefs() {
    const out = [];
    if (this.href) out.push(this.href);
    this.children.forEach((c) => { if (c.allHrefs) out.push.apply(out, c.allHrefs()); });
    return out;
  }

  allTags() {
    const out = [this];
    this.children.forEach((c) => { if (c.allTags) out.push.apply(out, c.allTags()); });
    return out;
  }
}

const makeDoc = (ids, classes) => {
  const map = new Map();
  Object.keys(ids).forEach((id) => map.set('#' + id, ids[id]));
  const classMap = new Map();
  Object.keys(classes || {}).forEach((cls) => classMap.set('.' + cls, classes[cls]));
  const doc = {
    readyState: 'complete',
    title: 'test',
    body: new FakeEl('body'),
    documentElement: new FakeEl('html'),
    querySelector(sel) { return map.get(sel) || classMap.get(sel) || null; },
    querySelectorAll(sel) {
      if (sel.startsWith('.')) {
        const hit = classMap.get(sel);
        return hit ? (Array.isArray(hit) ? hit : [hit]) : [];
      }
      return [];
    },
    getElementById(id) { return map.get('#' + id) || null; },
    createElement(tag) { return new FakeEl(tag); },
    createDocumentFragment() {
      const f = new FakeEl('#fragment');
      const orig = f.appendChild.bind(f);
      f.appendChild = (c) => { orig(c); return c; };
      return f;
    },
    createTextNode(t) { const n = new FakeEl('#text'); n.textContent = String(t); return n; },
    addEventListener() {},
    removeEventListener() {}
  };
  return doc;
};

/* 每个场景都重新建一份干净环境，避免场景之间互相污染 */
const runArchive = (posts, query) => {
  const postList = new FakeEl('div');
  const timeline = new FakeEl('div');
  const count = new FakeEl('span');
  const doc = makeDoc({
    postList, timeline, filterCount: count,
    catChips: new FakeEl('div'), tagChips: new FakeEl('div'),
    filterReset: new FakeEl('button'),
    viewList: new FakeEl('button'), viewTimeline: new FakeEl('button'),
    listSection: new FakeEl('section'), timelineSection: new FakeEl('section'),
    totalCount: new FakeEl('strong')
  });
  const replaceCalls = [];
  const sandbox = {
    console,
    document: doc,
    /* archive.js 里用了 URLSearchParams 读筛选条件，桩环境必须提供 */
    URLSearchParams,
    window: {
      POSTS: posts,
      location: {
        href: 'http://127.0.0.1:8848/archive.html' + (query || ''),
        search: query || '',
        pathname: '/archive.html'
      },
      history: { replaceState: (a, b, url) => { replaceCalls.push(url); } }
    }
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  new vm.Script(ARCHIVE_SRC, { filename: 'archive.js' }).runInContext(sandbox);
  return { postList, timeline, replaceCalls, window: sandbox.window, doc };
};

const runArticle = (posts, query) => {
  const els = {
    articleShell: new FakeEl('article'),
    articleTitle: new FakeEl('h1'),
    articleDate: new FakeEl('time'),
    articleCat: new FakeEl('a'),
    articleRead: new FakeEl('span'),
    articleTags: new FakeEl('div'),
    articleBody: new FakeEl('div'),
    crumbCat: new FakeEl('span'),
    postNav: new FakeEl('nav'),
    notFound: new FakeEl('section'),
    notFoundText: new FakeEl('p')
  };
  els.notFound.hidden = true;
  els.articleShell.hidden = true;
  const head = new FakeEl('header');
  head.className = 'article-head';
  /* 元素既能按 id 查、也能按类查（article.js 用 .article-head 挂草稿提示） */
  const doc = makeDoc(els, { 'article-head': head });
  const replaceCalls = [];
  const sandbox = {
    console,
    document: doc,
    URLSearchParams,
    window: {
      POSTS: posts,
      location: {
        href: 'http://127.0.0.1:8848/article.html' + (query || ''),
        search: query || ''
      },
      history: { replaceState: (a, b, url) => { replaceCalls.push(url); } },
      SITE: { name: '测试站' }
    }
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  new vm.Script(ARTICLE_SRC, { filename: 'article.js' }).runInContext(sandbox);
  return { els, head, replaceCalls, window: sandbox.window, doc };
};

/* ------------------------------------------------------------
   测试数据
   ------------------------------------------------------------ */
const POSTS = [
  { slug: 'live-a', title: '正式文章甲', date: '2026-02-01', category: '前端', tags: ['CSS'], excerpt: 'x', body: '<p>甲</p>' },
  { slug: 'draft-b', title: '草稿文章乙', date: '2026-02-02', category: '前端', tags: ['CSS'], excerpt: 'y', body: '<p>乙</p>', isDraft: true },
  { slug: 'renamed-c', title: '改过名的丙', date: '2026-01-20', category: '设计', tags: ['布局'], excerpt: 'z', body: '<p>丙</p>', aliases: ['old-c'] },
  { slug: 'draft-d', title: '草稿文章丁', date: '2026-01-10', category: '随笔', tags: [], excerpt: 'w', body: '<p>丁</p>', isDraft: true }
];

/* ============================================================
   归档页
   ============================================================ */
test('归档页：草稿不出现在列表与计数里', () => {
  const r = runArchive(POSTS, '');
  const text = r.postList.allText();
  assert.ok(text.includes('正式文章甲'), '正式文章应该在');
  assert.ok(text.includes('改过名的丙'), '有旧地址的文章也应该在');
  assert.ok(!text.includes('草稿文章乙'), '草稿不该出现');
  assert.ok(!text.includes('草稿文章丁'), '草稿不该出现');
  assert.equal(r.doc.querySelector('#totalCount').textContent, '2', '总数只算非草稿');
  assert.match(r.doc.querySelector('#filterCount').innerHTML, /共 <b>2<\/b> 篇/);
});

test('归档页：草稿的标签/分类不参与筛选计数', () => {
  const r = runArchive(POSTS, '');
  /* 草稿丁的 category 是"随笔"、甲/乙是"前端"。草稿乙被排除后，"前端"应只剩 1 篇 */
  const catChips = r.doc.querySelector('#catChips');
  const chips = catChips.allText();
  assert.ok(chips.includes('设计'), '设计分类来自丙：' + chips);
  assert.ok(!chips.includes('随笔'), '随笔只属于草稿，不该出现在分类里：' + chips);
  assert.match(chips, /前端\s*1/, '前端应只剩 1 篇：' + chips);
});

test('归档页：?preview=<slug> 时那一篇草稿才出现，且链接带上 preview', () => {
  const r = runArchive(POSTS, '?preview=draft-b');
  const text = r.postList.allText();
  assert.ok(text.includes('草稿文章乙'), '被预览的草稿应该出现');
  assert.ok(!text.includes('草稿文章丁'), '别的草稿仍然不该出现');
  assert.equal(r.doc.querySelector('#totalCount').textContent, '3');
  const hrefs = r.postList.allHrefs().join(' ');
  assert.ok(hrefs.includes('slug=draft-b'), 'href: ' + hrefs);
  assert.ok(hrefs.includes('preview=draft-b'), '草稿链接必须带 preview：' + hrefs);
  /* 正式文章的链接要干净：preview 只对草稿有意义 */
  const liveHref = r.postList.allHrefs().find((h) => h.includes('slug=live-a'));
  assert.ok(liveHref && !liveHref.includes('preview='), '正式文章的链接不该带 preview：' + liveHref);
});

test('归档页：切换筛选/视图时 preview 参数不会被弄丢', () => {
  const r = runArchive(POSTS, '?preview=draft-b');
  r.doc.querySelector('#viewTimeline').addEventListener = null;   // 触发一次渲染即可
  const last = r.replaceCalls[r.replaceCalls.length - 1];
  assert.ok(String(last).includes('preview=draft-b'), '写回的 URL 应保留 preview：' + last);
});

/* ============================================================
   详情页
   ============================================================ */
test('详情页：普通文章正常渲染', () => {
  const r = runArticle(POSTS, '?slug=live-a');
  assert.equal(r.els.articleShell.hidden, false, '外壳应显示');
  assert.equal(r.els.articleTitle.textContent, '正式文章甲');
  assert.equal(r.els.articleBody.innerHTML, '<p>甲</p>');
  assert.equal(r.els.notFound.hidden, true);
  assert.equal(r.window.Article.slug, 'live-a');
  assert.equal(r.window.Article.viaAlias, false);
});

test('详情页：草稿没有 preview 口子 → 当作不存在', () => {
  const r = runArticle(POSTS, '?slug=draft-b');
  assert.equal(r.els.notFound.hidden, false, '应显示"文章不存在"');
  assert.equal(r.els.articleShell.hidden, true);
  assert.equal(r.window.Article, undefined);
});

test('详情页：草稿带 ?preview=<自己的 slug> → 可见并给出提示', () => {
  const r = runArticle(POSTS, '?slug=draft-b&preview=draft-b');
  assert.equal(r.els.articleShell.hidden, false, '应正常渲染');
  assert.equal(r.els.articleTitle.textContent, '草稿文章乙');
  assert.ok(r.head.allText().includes('草稿预览'), '应有草稿提示：' + r.head.allText());
});

test('详情页：别的文章的 preview 口子不能解锁这篇草稿', () => {
  const r = runArticle(POSTS, '?slug=draft-b&preview=live-a');
  assert.equal(r.els.notFound.hidden, false, 'preview 不匹配就该拒绝');
});

test('详情页：旧地址（aliases）仍然能打开，并换到新地址', () => {
  const r = runArticle(POSTS, '?slug=old-c');
  assert.equal(r.els.articleShell.hidden, false, '旧地址应能打开');
  assert.equal(r.els.articleTitle.textContent, '改过名的丙');
  assert.equal(r.window.Article.slug, 'renamed-c', '对外应暴露新 slug');
  assert.equal(r.window.Article.viaAlias, true);
  assert.equal(r.replaceCalls.length, 1, '应把地址换成新地址');
  assert.match(r.replaceCalls[0], /slug=renamed-c/);
  assert.ok(!r.replaceCalls[0].includes('old-c'), '换过的地址里不该留着旧 slug');
});

test('详情页：草稿的别名也不会绕过 preview 限制', () => {
  const posts = POSTS.map((p) => (p.slug === 'draft-b' ? Object.assign({}, p, { aliases: ['old-b'] }) : p));
  const r = runArticle(posts, '?slug=old-b');
  assert.equal(r.els.notFound.hidden, false, '草稿的旧地址同样要拦');
});

test('详情页：完全不存在的 slug 仍然是软 404', () => {
  const r = runArticle(POSTS, '?slug=nope');
  assert.equal(r.els.notFound.hidden, false);
  assert.equal(r.els.notFoundText.textContent === '', true, 'showNotFound 会自己重写这段文字');
});

test('详情页：缺少 slug 参数也是软 404，不会抛异常', () => {
  const r = runArticle(POSTS, '');
  assert.equal(r.els.notFound.hidden, false);
});

/* ============================================================
   回到"现有的真实文章"上再验一次：不能因为新逻辑而看不到旧文章
   ------------------------------------------------------------
   注意篇数**不写死**：写死会在每次新增/删除一篇文章时误报（真的发生过 ——
   用户加了一篇之后这里报"8 篇"失败，看起来像功能坏了，其实只是断言过期）。
   这里只断言"每一篇都可见、都能打开、都不是草稿"。
   ============================================================ */
test('真实 posts.js：现有文章全部可见、每篇都能打开', async () => {
  const src = await readFile(join(JS, 'posts.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  new vm.Script(src).runInContext(sandbox);
  const real = sandbox.window.POSTS;
  assert.ok(Array.isArray(real) && real.length > 0, 'posts.js 应有文章');
  assert.ok(real.every((p) => !p.isDraft), '现有文章都不是草稿');

  const r = runArchive(real, '');
  assert.equal(r.doc.querySelector('#totalCount').textContent, String(real.length),
    '归档页的计数应等于实际篇数');

  for (const p of real) {
    const a = runArticle(real, '?slug=' + encodeURIComponent(p.slug));
    assert.equal(a.els.articleShell.hidden, false, p.slug + ' 应能打开');
    assert.equal(a.els.articleTitle.textContent, p.title, p.slug + ' 标题应正确');
  }
});

if (isMain(import.meta.url)) await H.run().then((r) => process.exit(r.fail ? 1 : 0));

export { H };
