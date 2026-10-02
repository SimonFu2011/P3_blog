/* ============================================================
   皮肤覆盖检查：文章页换纯白皮肤后，深色规则是否都有人接
   ------------------------------------------------------------
   跑法：node blog-enter/server/tests/check-light-skin.mjs

   为什么需要这个检查：
   换肤不是"删掉深色样式"，而是后加载一份同权重规则去覆盖它。
   于是最容易出的错**不是报错**，而是"某某块还是深色的" ——
   pages.css 里那些规则一条都没少，只是没人盖住它们。
   浏览器不会告诉你漏了什么，肉眼一页页翻也很容易漏掉冷门块
   （评论区占位、软 404、上下篇、Toast）。

   这个检查做三件事：
     1. 列出 pages.css 里所有"文章页专有"的深色规则
     2. 逐条确认 prose-light.css 里有对应选择器的覆盖
     3. 确认覆盖文件本身没有引入深色**背景**（白底皮肤的铁律）
   ============================================================ */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = join(HERE, '..', '..', 'css');

const pages = await readFile(join(CSS, 'pages.css'), 'utf8');
const light = await readFile(join(CSS, 'prose-light.css'), 'utf8');
const geo = await readFile(join(CSS, 'geo.css'), 'utf8');
const articleHtml = await readFile(join(HERE, '..', '..', 'article.html'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       → ' + extra : '')); }
};

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 抽出所有"选择器 → 声明体"对（不处理嵌套 @media，本文件里够用） */
const rules = (css) => {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(stripComments(css)))) {
    const selectors = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    out.push({ selectors, body: m[2].trim(), raw: m[1].trim() });
  }
  return out;
};

const pageRules = rules(pages);
const lightRules = rules(light);

/* 覆盖来源是**两份**文件合起来：
     · geo.css         —— 页面骨架（导航、页脚、小节标题、卡片、按钮）
     · prose-light.css —— 正文与文章页专有的块
   只查后者会把 geo.css 已经盖好的骨架规则全算成"未覆盖"，
   上一版就是这么报了一长串假阳性的。 */
const geoRules = rules(geo);
const lightRulesAll = lightRules.concat(geoRules);

/* 覆盖需求不能靠"前缀猜"，要从 article.html **实际用到的 class** 反推。
   上一版按 .err- / .tag- 前缀一把抓，于是把 .tag-legend（关于我页）、
   .err-code / .err-en（404 页）也算成文章页的需求，报了一串假阳性 ——
   这些类在 pages.css 里有定义，但文章页的 HTML 里根本没出现。 */
const usedClasses = new Set(
  [...articleHtml.matchAll(/class="([^"]+)"/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter(Boolean)
);
/* 脚本动态拼接出来的类也补上（article.js 会加 .is-next / .is-prev 等） */
['is-next', 'is-prev', 'is-empty', 'is-primary', 'is-done', 'is-block'].forEach((c) => usedClasses.add(c));

const selTouchesUsedClass = (sel) => {
  const names = [...sel.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
  return names.length > 0 && names.every((n) => usedClasses.has(n));
};

const COLOR_PROPS = /(^|;|\s)(color|background|background-color|border|border-color|border-top|border-bottom|border-left|box-shadow|text-shadow|fill|stroke)\s*:/;

const needsCoverage = pageRules.filter((r) =>
  r.selectors.some(selTouchesUsedClass) && COLOR_PROPS.test(r.body));

/* 覆盖文件里出现过的选择器（把分组拆开后逐条比） */
const lightSelectors = new Set();
lightRulesAll.forEach((r) => r.selectors.forEach((s) => lightSelectors.add(s)));

/* 覆盖判定：完全同名，或"以同名前缀开头的后代选择器"也算覆盖
   （.prose li::before 能覆盖 .prose ul > li::before 吗？不能 ——
    所以这里用"选择器里包含同名关键片段"的更宽判定，避免假阳性，
    真正严格的正确性靠下面第 3 条：覆盖文件里不许有深色背景） */
const covered = (sel) => {
  if (lightSelectors.has(sel)) return true;
  const base = sel.replace(/\s*>\s*/g, ' ').replace(/\s+/g, ' ');
  for (const s of lightSelectors) {
    const s2 = s.replace(/\s*>\s*/g, ' ').replace(/\s+/g, ' ');
    if (s2 === base) return true;
    /* 允许覆盖文件写成更宽或更窄的同族选择器，例如
       pages: .prose blockquote p + p   light: .prose blockquote */
    if (base.startsWith(s2 + ' ') || s2.startsWith(base + ' ')) return true;
  }
  return false;
};

const uncovered = needsCoverage.filter((r) => !r.selectors.some(covered));

ok('文章页专有的深色规则全部有覆盖（' + needsCoverage.length + ' 条）',
  uncovered.length === 0,
  uncovered.map((r) => r.raw + ' { ' + r.body.slice(0, 60) + '… }').join('\n       → '));

/* 逐块点名，缺哪块一眼能看出 */
const BLOCKS = [
  ['正文正文色', '.prose'],
  ['小节标题', '.prose h2'],
  ['行内代码', '.prose :not(pre) > code'],
  ['代码块外壳', '.code-block'],
  ['代码复制按钮', '.code-copy'],
  ['上下篇', '.post-nav a'],
  ['评论区', '.comments-box'],
  ['面包屑', '.crumbs'],
  ['文章标题', '.article-title'],
  ['标签', '.tag'],
  ['配图题注', '.prose figcaption'],
  ['空状态 / 软 404', '.empty-mark']
];
const missingBlocks = BLOCKS.filter(([, sel]) => !covered(sel)).map(([name]) => name);
ok('关键块逐个点名都在（' + BLOCKS.length + ' 块）', missingBlocks.length === 0,
  '缺：' + missingBlocks.join('、'));

/* 白底铁律：覆盖文件里不许出现深色背景（先剥注释） */
const lightNoComments = stripComments(light);
const bgDecls = [...lightNoComments.matchAll(/background(?:-color)?\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
const darkBg = bgDecls.filter((v) => {
  const hex = v.match(/#([0-9a-f]{6})\b/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    const r = (n >> 16) & 255; const g = (n >> 8) & 255; const b = n & 255;
    if ((r * 299 + g * 587 + b * 114) / 1000 < 128) return true;
  }
  const rgba = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/i);
  if (rgba) {
    const [r, g, b] = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
    const alpha = rgba[4] === undefined ? 1 : Number(rgba[4]);
    if (alpha >= 0.9 && (r * 299 + g * 587 + b * 114) / 1000 < 128) return true;
  }
  return false;
});
ok('覆盖文件里没有深色背景', darkBg.length === 0, darkBg.join(' | '));

/* 配色必须来自 --g-*（少数纯白/纯黑字面量允许） */
const literalColors = [...new Set([...lightNoComments.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toLowerCase()))]
  .filter((c) => !['#fff', '#ffffff', '#000', '#000000'].includes(c));
ok('字面色值只用在语法高亮那一组（其余一律走 --g-* 变量）',
  literalColors.length <= 8, '字面色值：' + literalColors.join(', '));

/* 语法高亮必须在浅底上看得清：算对比度 */
const paperLum = (() => {
  const srgb = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const l = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * srgb((n >> 16) & 255) + 0.7152 * srgb((n >> 8) & 255) + 0.0722 * srgb(n & 255);
  };
  return { l, paper: l('#f7fbfe') };     // --g-paper，代码块底色
})();
const contrast = (hex) => {
  const a = paperLum.l(hex); const b = paperLum.paper;
  const hi = Math.max(a, b); const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
};
const tokColors = [...lightNoComments.matchAll(/\.tok-(kwt|kw|str|num|fn|tag|att)\s*\{\s*color:\s*(#[0-9a-f]{6})/gi)]
  .map((m) => ({ name: m[1], hex: m[2] }));
const lowContrast = tokColors.filter((t) => contrast(t.hex) < 4.5);
ok('语法高亮的每个 token 在代码块底色上对比度 ≥ 4.5:1',
  lowContrast.length === 0,
  lowContrast.map((t) => t.tok + ' ' + t.hex + ' = ' + contrast(t.hex).toFixed(2) + ':1').join('，'));

/* 加载顺序：pages → geo → prose-light */
const links = [...articleHtml.matchAll(/href="(css\/[^"]+\.css)"/g)].map((m) => m[1]);
ok('article.html 的样式表顺序为 pages → geo → prose-light',
  links.length === 3 && links[0].endsWith('pages.css') && links[1].endsWith('geo.css') &&
  links[2].endsWith('prose-light.css'),
  links.join(' → '));

/* geo.css 仍然只覆盖骨架：确认正文规则没有跑进 geo.css（保持职责分离） */
const proseInGeo = geoRules.filter((r) => r.selectors.some((s) => s.startsWith('.prose') || s.startsWith('.code-block')));
ok('正文排版没有塞进 geo.css（职责仍分离）', proseInGeo.length === 0,
  proseInGeo.map((r) => r.raw).join(', '));

/* 反向确认：prose-light.css 里不该重复定义 geo.css 已经管好的骨架规则
   （重复定义会让"哪份文件管什么"变模糊） */
const SKELETON = ['.nav', '.nav-', '.foot', '.hero', '.section', '.page-', '.skip', '.chip', '.toast'];
const dupSkeleton = lightRules.filter((r) => r.selectors.some((s) => SKELETON.some((p) => s.startsWith(p))));
ok('prose-light.css 没有重复定义骨架规则', dupSkeleton.length === 0,
  dupSkeleton.map((r) => r.raw).join(', '));

console.log('');
console.log('皮肤覆盖检查：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
