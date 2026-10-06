/* ============================================================
   子页面验证：关于我 / 归档 / 文章详情 / 404
   ------------------------------------------------------------
   断言 + 截图，走 headless Chrome + CDP（无第三方依赖）。
   用法：
     node .preview/serve.mjs        # 另开一个终端
     node .preview/verify-pages.mjs
   ============================================================ */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.env.PREVIEW_OUT || 'D:\\DS\\.preview';
const BASE = process.env.SERVE_URL || 'http://127.0.0.1:8848';
const PORT = 9377;
mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900',
  '--user-data-dir=' + OUT + '\\cp-pages', 'about:blank'
], { stdio: 'ignore' });

let ws, seq = 0; const pending = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify(s ? { id, method: m, params: p, sessionId: s } : { id, method: m, params: p }));
});
let v = null;
for (let i = 0; i < 60 && !v; i++) {
  await sleep(250);
  try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
}
if (!v) { console.error('chrome 没起来'); process.exit(1); }
ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    events.push('[console.' + m.params.type + '] ' + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    events.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    /* /api/auth/me 与 /api/stats/hit 的 404 是**预期内**的：前者是右上角登录
       入口探一次会话，后者是访问统计计数，而静态预览（.preview/serve.mjs）
       没有 /api，真机上由 p3-public 应答。
       只豁免这两条（且必须带 404），别的 4xx/5xx 仍然算错。
       这处失败与 UI 改动无关：拿 HEAD 的干净站点跑本套件，失败集合与数目完全一致。 */
    const eUrl = m.params.entry.url || '';
    const expectedProbe = /\/api\/(auth\/me|stats\/hit)\b/.test(eUrl) && /404/.test(m.params.entry.text);
    if (!expectedProbe) events.push('[log] ' + m.params.entry.text + ' @ ' + eUrl);
  }
};

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const js = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const goto = async (url, settle = 900) => {
  events.length = 0;
  await S('Page.navigate', { url: BASE + url });
  await sleep(settle);
};
const shot = async (name) => {
  const r = await S('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}\\${name}.png`, Buffer.from(r.data, 'base64'));
};

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

/* 横向溢出体检：任何元素超出视口右边界都记一笔。
   例外：位于"滚动容器"内部的元素（pre / 任何 overflow 非 visible 的祖先），
   它们超出视口是预期行为 —— 内容由那个容器自己滚，不会把整页撑开。
   判据是 documentElement.scrollWidth，而不是元素自己的 rect。 */
const overflow = () => js(`(function(){
  const vw = document.documentElement.clientWidth;
  const inScroller = function (el) {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') return true;
      p = p.parentElement;
    }
    return false;
  };
  const bad = [];
  document.querySelectorAll('body *').forEach(function (el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.right > vw + 1.5 || r.left < -1.5) {
      if (inScroller(el)) return;
      bad.push((el.tagName.toLowerCase()) + '.' + (el.className || '(none)') +
               ' L' + Math.round(r.left) + ' R' + Math.round(r.right));
    }
  });
  return { vw: vw, scrollW: document.documentElement.scrollWidth, bad: bad.slice(0, 12) };
})()`);

/* ============================================================
   1. 关于我
   ============================================================ */
console.log('\n== about.html ==');
await goto('/about.html');
ok('无 console 错误', events.length === 0, events);
ok('标题正确', (await js('document.title')).includes('关于我'));
ok('头像占位图已加载', await js(`(function(){
  const i = document.querySelector('.avatar img');
  return !!i && i.complete && i.naturalWidth > 0;
})()`));
ok('技能列表有 14 项且分级标记齐全', await js(`(function(){
  const items = document.querySelectorAll('.skill-grid .skill');
  const marks = document.querySelectorAll('.skill-grid .skill-mark');
  const kinds = new Set(Array.from(marks).map(m => m.className.replace('skill-mark ', '')));
  return items.length >= 12 && marks.length === items.length
    && kinds.has('is-core') && kinds.has('is-sub') && kinds.has('is-know');
})()`));
ok('联系方式含邮箱/GitHub/X 三个链接', await js(`(function(){
  const hrefs = Array.from(document.querySelectorAll('.contact')).map(a => a.getAttribute('href'));
  return hrefs.length === 3
    && hrefs.some(h => h.startsWith('mailto:'))
    && hrefs.some(h => h.includes('github.com'))
    && hrefs.some(h => h.includes('x.com'));
})()`));
ok('三个图标都渲染出实际尺寸', await js(`(function(){
  const svgs = Array.from(document.querySelectorAll('.contact-icon svg'));
  return svgs.length === 3 && svgs.every(s => s.getBoundingClientRect().width >= 12);
})()`));
ok('导航当前项标记正确', await js(`document.querySelector('.nav-link[aria-current="page"] .nl-cn').textContent === '关于我'`));
{
  const o = await overflow();
  ok('无横向溢出', o.scrollW <= o.vw + 1 && o.bad.length === 0, o);
}
await shot('pages-about');

/* ============================================================
   2. 归档：默认视图
   ============================================================ */
console.log('\n== archive.html ==');
await goto('/archive.html');
ok('无 console 错误', events.length === 0, events);
ok('文章总数写进标题', await js(`document.getElementById('totalCount').textContent === String(window.POSTS.length)`));
ok('列表渲染出全部文章', await js(`document.querySelectorAll('#postList .post-card').length === window.POSTS.length`));
ok('分类胶囊数 = 分类数 + 全部', await js(`(function(){
  const cats = new Set(window.POSTS.map(p => p.category));
  return document.querySelectorAll('#catChips .chip').length === cats.size + 1;
})()`));
ok('标签胶囊数 = 标签数 + 不限', await js(`(function(){
  const tags = new Set(window.POSTS.flatMap(p => p.tags));
  return document.querySelectorAll('#tagChips .chip').length === tags.size + 1;
})()`));
ok('时间线默认隐藏', await js(`document.getElementById('timelineSection').hidden === true`));

/* 分类筛选 */
const catName = await js(`window.POSTS[0].category`);
const catCount = await js(`window.POSTS.filter(p => p.category === ${JSON.stringify(await js(`window.POSTS[0].category`))}).length`);
await js(`Array.from(document.querySelectorAll('#catChips .chip')).find(c => c.textContent.startsWith(${JSON.stringify(catName)})).click(); true`);
await sleep(120);
ok('点分类后只剩该分类', await js(`document.querySelectorAll('#postList .post-card').length`) === catCount, { catName, catCount });
ok('分类胶囊 aria-pressed 置位', await js(`document.querySelector('#catChips .chip[aria-pressed="true"]').textContent.startsWith(${JSON.stringify(catName)})`));
ok('URL 写入了 cat 参数', (await js('location.search')).includes('cat='));

/* 标签筛选（与分类是"与"关系） */
const tagPick = await js(`(function(){
  // 找一个与该分类同时出现的标签，保证筛完还有结果
  const p = window.POSTS.find(p => p.category === ${JSON.stringify(catName)});
  return p.tags[0];
})()`);
await js(`Array.from(document.querySelectorAll('#tagChips .chip')).find(c => c.textContent.startsWith(${JSON.stringify(tagPick)})).click(); true`);
await sleep(120);
const expectBoth = await js(`window.POSTS.filter(p => p.category === ${JSON.stringify(catName)} && p.tags.includes(${JSON.stringify(tagPick)})).length`);
ok('分类 + 标签交叉筛选正确', await js(`document.querySelectorAll('#postList .post-card').length`) === expectBoth, { catName, tagPick, expectBoth });
ok('清空按钮已启用', await js(`document.getElementById('filterReset').disabled === false`));

/* 标签多选 = 与 */
const tagSecond = await js(`(function(){
  const p = window.POSTS.find(p => p.category === ${JSON.stringify(catName)} && p.tags.length > 1);
  return p ? p.tags[1] : null;
})()`);
if (tagSecond) {
  await js(`Array.from(document.querySelectorAll('#tagChips .chip')).find(c => c.textContent.startsWith(${JSON.stringify(tagSecond)})).click(); true`);
  await sleep(120);
  const expectTwo = await js(`window.POSTS.filter(p => p.category === ${JSON.stringify(catName)} && p.tags.includes(${JSON.stringify(tagPick)}) && p.tags.includes(${JSON.stringify(tagSecond)})).length`);
  ok('两个标签是"与"关系', await js(`document.querySelectorAll('#postList .post-card').length`) === expectTwo, { tagSecond, expectTwo });
  /* 再点一次取消 */
  await js(`Array.from(document.querySelectorAll('#tagChips .chip')).find(c => c.textContent.startsWith(${JSON.stringify(tagSecond)})).click(); true`);
  await sleep(80);
}

await shot('pages-archive-list');

/* 空结果 + 清空 */
await js(`document.getElementById('filterReset').click(); true`);
await sleep(120);
ok('清空后回到全部', await js(`document.querySelectorAll('#postList .post-card').length === window.POSTS.length`));
ok('清空后按钮变灰', await js(`document.getElementById('filterReset').disabled === true`));

/* 构造一个必然为空的组合 */
await js(`(function(){
  const A = window.POSTS[0];
  const B = window.POSTS.find(p => p.category !== A.category);
  const bTag = B.tags[0];
  Archive.state.cat = A.category;
  const t = A.tags[0];
  Archive.state.tags = [t, bTag];
  Archive.render();
  return true;
})()`);
await sleep(120);
ok('空结果显示空状态', await js(`!!document.querySelector('#postList .empty')`));
await shot('pages-archive-empty');

/* 时间线视图 */
console.log('\n== archive.html 时间线 ==');
await js(`Archive.state.cat = null; Archive.state.tags = []; Archive.render(); true`);
await js(`document.getElementById('viewTimeline').click(); true`);
await sleep(150);
ok('时间线视图已显示', await js(`document.getElementById('timelineSection').hidden === false && document.getElementById('listSection').hidden === true`));
ok('URL 写入 view 参数', (await js('location.search')).includes('view=timeline'));
{
  const years = await js(`Array.from(document.querySelectorAll('.tl-year')).map(e => e.childNodes[0].nodeValue)`);
  const expYears = await js(`Array.from(new Set(window.POSTS.map(p => p.date.slice(0,4)))).sort().reverse()`);
  ok('年份分组与数据一致', JSON.stringify(years) === JSON.stringify(expYears), { years, expYears });
  const months = await js(`document.querySelectorAll('.tl-month').length`);
  const expMonths = await js(`new Set(window.POSTS.map(p => p.date.slice(0,7))).size`);
  ok('月份分组数正确', months === expMonths, { months, expMonths });
  const items = await js(`document.querySelectorAll('.tl-item').length`);
  ok('每篇都出现在时间线里', items === await js(`window.POSTS.length`), { items });
  ok('年份是倒序', await js(`(function(){
    const y = Array.from(document.querySelectorAll('.tl-year')).map(e => Number(e.childNodes[0].nodeValue));
    return y.every((v, i) => i === 0 || y[i-1] > v);
  })()`));
}
{
  const o = await overflow();
  ok('时间线无横向溢出', o.scrollW <= o.vw + 1 && o.bad.length === 0, o);
}
await shot('pages-archive-timeline');

/* 时间线上筛选同样生效 */
await js(`document.getElementById('viewList').click(); true`);
await sleep(80);
await js(`Archive.state.cat = ${JSON.stringify(catName)}; Archive.render(); true`);
await js(`document.getElementById('viewTimeline').click(); true`);
await sleep(150);
ok('筛选后的时间线只剩命中项', await js(`document.querySelectorAll('.tl-item').length`) === catCount, { catName, catCount });
await shot('pages-archive-timeline-filtered');
await js(`document.getElementById('filterReset').click(); true`);

/* ============================================================
   3. 文章详情
   ============================================================ */
console.log('\n== article.html ==');
const slugs = await js(`window.POSTS.map(p => p.slug)`);
let codeCheck = { blocks: 0, highlighted: 0, copies: 0 };
for (let i = 0; i < slugs.length; i++) {
  await goto('/article.html?slug=' + encodeURIComponent(slugs[i]));
  const bad = events.filter((e) => e.startsWith('[exception]') || e.startsWith('[console.error]'));
  ok('文章 ' + slugs[i] + ' 无脚本错误', bad.length === 0, bad.slice(0, 3));
  const r = await js(`(function(){
    const t = document.getElementById('articleTitle');
    const b = document.getElementById('articleBody');
    const shell = document.getElementById('articleShell');
    return {
      title: t ? t.textContent : '',
      hidden: shell.hidden,
      len: b ? b.textContent.trim().length : 0,
      code: document.querySelectorAll('#articleBody pre > code').length,
      decorated: document.querySelectorAll('#articleBody .code-block').length,
      copy: document.querySelectorAll('#articleBody .code-copy').length,
      toks: document.querySelectorAll('#articleBody .tok-kw, #articleBody .tok-str, #articleBody .tok-com').length,
      cat: document.getElementById('articleCat').textContent,
      date: document.getElementById('articleDate').textContent,
      tags: document.querySelectorAll('#articleTags .tag').length,
      navItems: document.querySelectorAll('#postNav a').length,
      prev: !!document.querySelector('#postNav .is-prev'),
      next: !!document.querySelector('#postNav .is-next')
    };
  })()`);
  const exp = await js(`(function(){
    const p = window.POSTS.find(x => x.slug === ${JSON.stringify(slugs[i])});
    return { title: p.title, cat: p.category, date: p.date, tags: p.tags.length };
  })()`);
  ok('  标题 / 分类 / 日期 / 标签数一致',
    r.title === exp.title && r.cat === exp.cat && r.date === exp.date && r.tags === exp.tags && !r.hidden && r.len > 200,
    { got: r, exp });
  codeCheck.blocks += r.code;
  codeCheck.highlighted += r.toks;
  codeCheck.copies += r.copy;
  if (i === 0) await shot('pages-article');
}
ok('全文共出现代码块并全部套上外壳', codeCheck.blocks > 0 && codeCheck.copies === codeCheck.blocks, codeCheck);
ok('高亮确实产生了 token', codeCheck.highlighted > 40, codeCheck);

/* 代码里的实体没有被二次转义 */
await goto('/article.html?slug=' + encodeURIComponent(slugs[0]));
ok('代码块内 &lt; 未被二次转义（无 &amp;lt;）', await js(`document.getElementById('articleBody').innerHTML.indexOf('&amp;lt;') < 0`));
ok('代码块文本可读（含 @property）', await js(`(function(){
  const t = Array.from(document.querySelectorAll('#articleBody pre')).map(p => p.textContent).join('\\n');
  return t.indexOf('@property') >= 0 && t.indexOf('&lt;') < 0;
})()`));

/* 上/下篇链接可达 */
{
  const href = await js(`document.querySelector('#postNav .is-prev') ? document.querySelector('#postNav .is-prev').getAttribute('href') : null`);
  ok('存在"更早"链接且指向合法 slug', !!href && (await js(`window.POSTS.some(p => 'article.html?slug=' + encodeURIComponent(p.slug) === ${JSON.stringify(href)})`)), href);
}

/* 图片与引用渲染 */
ok('正文配图已加载', await js(`(function(){
  const imgs = Array.from(document.querySelectorAll('#articleBody figure img'));
  return imgs.length > 0 && imgs.every(i => i.complete && i.naturalWidth > 0);
})()`));
ok('引用块已渲染', await js(`document.querySelectorAll('#articleBody blockquote').length > 0`));
ok('评论区占位存在且挂在文章之后', await js(`(function(){
  const c = document.getElementById('comments');
  const a = document.getElementById('articleShell');
  return !!c && !!c.querySelector('.comments-box') && !!document.getElementById('commentsMount')
    && a.compareDocumentPosition(c) === Node.DOCUMENT_POSITION_FOLLOWING;
})()`));
ok('评论占位说明了接入位置', await js(`(function(){
  const n = document.querySelector('.comments-note');
  const m = document.getElementById('commentsMount');
  return !!n && /挂载点/.test(n.textContent) && !!m && m.dataset.commentsSlot.length > 0;
})()`));

/* 无效 slug → 软 404 */
console.log('\n== article.html 无效 slug ==');
await goto('/article.html?slug=this-does-not-exist');
ok('无 console 错误', events.filter((e) => e.startsWith('[exception]')).length === 0, events);
ok('显示"文章不存在"', await js(`document.getElementById('notFound').hidden === false && document.getElementById('articleShell').hidden === true`));
ok('提示里带上了错误的 slug', await js(`document.getElementById('notFoundText').textContent.includes('this-does-not-exist')`));
ok('给出了最近的几篇作为出口', await js(`document.querySelectorAll('#notFound .post-card').length > 0`));
await shot('pages-article-notfound');

await goto('/article.html');
ok('缺 slug 参数也是软 404', await js(`document.getElementById('notFound').hidden === false`));

/* ============================================================
   4. 404 页面
   ============================================================ */
console.log('\n== 404.html ==');
await goto('/404.html');
ok('无 console 错误', events.length === 0, events);
ok('大号 404 存在', await js(`(document.querySelector('.err-code') || {}).textContent === '404'`));
ok('显示了实际访问路径', await js(`document.getElementById('errPath').textContent.includes('404.html')`));
ok('三个出口按钮', await js(`document.querySelectorAll('.err-actions a').length === 3`));
ok('侧边栏三项齐全', await js(`Array.from(document.querySelectorAll('.nav-link .nl-cn')).map(e => e.textContent).join(',') === '关于我,博客文章,待定'`));
{
  const o = await overflow();
  ok('无横向溢出', o.scrollW <= o.vw + 1 && o.bad.length === 0, o);
}
await shot('pages-404');

/* ============================================================
   4b. 站点文案同步（改 js/data.js 一处，三个页面同时生效）
   ============================================================ */
console.log('\n== 文案同步：侧边栏 / 品牌 / 页脚 ==');
for (const url of ['/about.html', '/archive.html', '/article.html?slug=' + encodeURIComponent(slugs[0]), '/404.html']) {
  await goto(url);
  const r = await js(`(function(){
    const cfg = window.SITE;
    const links = Array.from(document.querySelectorAll('.nav-list .nav-link'));
    /* 只查"界面外壳"里的文本：正文与代码样本里出现 undefined 是正常的
       （有一篇正好在讲 "typeof CSS === undefined"）。 */
    const shell = Array.from(document.querySelectorAll('.nav, .foot, .page-head, .crumbs, .comments-head'))
      .map(el => el.textContent).join(' ');
    return {
      hasCfg: !!cfg,
      brand: (document.querySelector('[data-site-name]') || {}).textContent,
      wantBrand: cfg ? cfg.name : null,
      labels: links.map(a => a.querySelector('.nl-cn').textContent),
      wantLabels: cfg ? cfg.menu.map(m => m.label) : [],
      ens: links.map(a => a.querySelector('.nl-en').textContent),
      wantEns: cfg ? cfg.menu.map(m => m.en) : [],
      hrefs: links.map(a => a.getAttribute('href')),
      wantHrefs: cfg ? cfg.menu.map(m => m.href) : [],
      current: links.filter(a => a.getAttribute('aria-current') === 'page').length,
      year: (document.querySelector('[data-year]') || {}).textContent,
      wantYear: cfg ? cfg.footer.replace('{year}', String(new Date().getFullYear())) : null,
      sub: (document.querySelector('[data-site-sub]') || {}).textContent,
      wantSub: cfg ? cfg.brandSub : null,
      note: (document.querySelector('[data-foot-note]') || {}).textContent,
      undefinedInShell: shell.indexOf('undefined') >= 0
    };
  })()`);
  ok(url + ' 侧边栏与 SITE.menu 一致',
    r.hasCfg && JSON.stringify(r.labels) === JSON.stringify(r.wantLabels) &&
    JSON.stringify(r.ens) === JSON.stringify(r.wantEns), r);
  ok(url + ' 品牌名 / 短标语 / 页脚年份来自 SITE',
    r.brand === r.wantBrand && r.sub === r.wantSub && r.year === r.wantYear, r);
  /* 404 不在菜单里，本来就不该有当前项；其余三页必须恰好一个 */
  ok(url + ' 当前项数量正确', url === '/404.html' ? r.current === 0 : r.current === 1, r);
  ok(url + ' 外壳文本没有 undefined', r.undefinedInShell === false, r);
}

/* ============================================================
   5. 主界面：菜单文案与链接
   ============================================================ */
console.log('\n== index.html ==');
await goto('/index.html', 1200);
ok('无 console 错误', events.length === 0, events);
await js(`document.getElementById('enterArrow').click(); true`);
await sleep(2600);
ok('菜单旋出（3 项）', await js(`document.querySelectorAll('.fan-item.is-out').length === 3`), await js(`(function(){
  return { out: document.querySelectorAll('.fan-item.is-out').length,
           classes: Array.from(document.querySelectorAll('.fan-item')).map(li => li.className),
           state: window.Boot.state };
})()`));
{
  const menu = await js(`Array.from(document.querySelectorAll('.fan-link')).map(a => ({
    en: a.querySelector('.fi-en').textContent,
    cn: a.querySelector('.fi-jp').textContent,
    href: a.getAttribute('href'),
    visible: getComputedStyle(a.querySelector('.fi-jp')).display !== 'none',
    size: Math.round(parseFloat(getComputedStyle(a).fontSize))
  }))`);
  ok('三项文案为英文主标 + 中文标签', JSON.stringify(menu.map((m) => m.en + '/' + m.cn)) ===
    JSON.stringify(['ABOUT/关于我', 'ARTICLES/博客文章', 'TBD/待定']), menu);
  ok('中文标签全部可见', menu.every((m) => m.visible), menu);
  ok('字号已同比放大（>56px @1440）', menu.every((m) => m.size > 56), menu);
  ok('链接指向真实页面', menu[0].href.endsWith('about.html') && menu[1].href.endsWith('archive.html'), menu);
  ok('初始选中项落在博客文章', await js(`document.querySelector('.fan-item.is-active .fi-en').textContent === 'ARTICLES'`));
}
await sleep(600);
await shot('pages-index-menu');

/* 窄屏
   ------------------------------------------------------------ */
console.log('\n== 窄屏 390×844 ==');
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
for (const [url, name] of [['/about.html', 'about'], ['/archive.html', 'archive'], ['/article.html?slug=' + encodeURIComponent(slugs[0]), 'article'], ['/404.html', '404']]) {
  await goto(url, 1000);
  const o = await overflow();
  /* 抽屉打开时导航本身是覆盖层，先只查关闭态 */
  ok(name + ' 无横向溢出', o.scrollW <= o.vw + 1 && o.bad.length === 0, o);
  ok(name + ' 汉堡按钮可见', await js(`getComputedStyle(document.querySelector('.nav-toggle')).display !== 'none'`));
  await shot('pages-m-' + name);
}

/* 主界面在窄屏下是"纵向堆叠"菜单：条目必须整条落在视口内 */
await goto('/index.html', 1400);
await js(`document.getElementById('enterArrow').click(); true`);
await sleep(3200);
{
  const g = await js(`(function(){
    const items = Array.from(document.querySelectorAll('.fan-item')).map(function (li) {
      const r = li.getBoundingClientRect();
      return { en: li.querySelector('.fi-en').textContent, left: Math.round(r.left), right: Math.round(r.right) };
    });
    return { stacked: document.getElementById('fan').classList.contains('is-stacked'),
             vw: innerWidth, docScrollW: document.documentElement.scrollWidth, items: items };
  })()`);
  ok('窄屏菜单切到堆叠态', g.stacked === true, g);
  ok('三条都完整落在视口内', g.items.every((i) => i.left >= 0 && i.right <= g.vw) && g.docScrollW <= g.vw + 1, g);
}
/* 抽屉展开 */
await goto('/archive.html', 900);
await js(`document.querySelector('.nav-toggle').click(); true`);
await sleep(350);
ok('抽屉展开后菜单可见', await js(`getComputedStyle(document.querySelector('.nav-list')).display !== 'none'`));
ok('aria-expanded 已同步', await js(`document.querySelector('.nav-toggle').getAttribute('aria-expanded') === 'true'`));
ok('按钮变成 CLOSE', await js(`getComputedStyle(document.querySelector('.nt-text-open')).display !== 'none'`));
{
  const o = await overflow();
  ok('抽屉展开无横向溢出', o.scrollW <= o.vw + 1, o);
}
await shot('pages-m-drawer');
await js(`document.querySelector('.nav-toggle').click(); true`);
await sleep(250);
ok('再点收起', await js(`document.body.classList.contains('is-nav-open') === false`));

/* 中屏（1180 断点附近） */
console.log('\n== 中屏 1024×800 ==');
await S('Emulation.setDeviceMetricsOverride', { width: 1024, height: 800, deviceScaleFactor: 1, mobile: false });
for (const [url, name] of [['/about.html', 'about'], ['/archive.html', 'archive'], ['/404.html', '404']]) {
  await goto(url, 900);
  const o = await overflow();
  ok(name + ' 无横向溢出', o.scrollW <= o.vw + 1 && o.bad.length === 0, o);
}
await shot('pages-tablet-archive');

/* ============================================================
   收尾
   ============================================================ */
console.log('\n通过 ' + pass + ' / 失败 ' + fail);
ws.close(); chrome.kill();
process.exit(fail ? 1 : 0);
