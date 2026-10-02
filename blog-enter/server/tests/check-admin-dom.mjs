/* ============================================================
   管理页静态自检（无浏览器）
   ------------------------------------------------------------
   跑法：node blog-enter/server/tests/check-admin-dom.mjs

   沙箱/CI 里常常起不了浏览器，而管理页最容易出的低级问题是
   "脚本引用了不存在的 id" —— 这类错误在页面上表现为"点什么都没反应"，
   静态检查就能抓到，不必等真渲染。

   检查项：
     1. admin.js 引用的每个 #id 都存在于 index.html
     2. admin.js 引用的每个 .class 选择器都存在于 HTML
     3. 被脚本用 hidden 切换的元素，其样式表里有 [hidden] 收口规则
        （作者样式里的 display:grid/flex 会盖掉浏览器默认的 display:none）
     4. 页面实际加载的脚本清单，且不引用已废弃的 token.js 注入路由
   ============================================================ */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = join(HERE, '..', '..', 'admin');

const js = await readFile(join(UI, 'admin.js'), 'utf8');
const html = await readFile(join(UI, 'index.html'), 'utf8');
const css = await readFile(join(UI, 'admin.css'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

/* 1) id 覆盖 */
const ids = [...new Set([...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))].sort();
const missingIds = ids.filter((id) => !new RegExp('id="' + id + '"').test(html));
ok('admin.js 用到的 ' + ids.length + ' 个 #id 全部存在于 HTML',
  missingIds.length === 0, '缺失：' + missingIds.join(', '));

/* 2) class 覆盖 */
const classes = [...new Set([...js.matchAll(/\$\('\.([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
const missingClasses = classes.filter((c) => !new RegExp('class="[^"]*\\b' + c + '\\b').test(html));
ok('admin.js 用到的 ' + classes.length + ' 个 class 选择器都存在',
  missingClasses.length === 0, '缺失：' + missingClasses.join(', '));

/* 3) hidden 收口 */
ok('样式表里有 [hidden] { display: none !important } 收口规则',
  /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css));

/* 3b) 皮肤必须是纯白极简：不许再自己写死深色**背景**。
     只查 background / background-color 声明，且先剥掉 CSS 注释 ——
     上一版没剥注释，把文件头的说明文字（里面正好有"背景"两个字对应的
     background 词）当成声明，报了一串假阳性。深色出现在 box-shadow、
     border 里都是正常的（阴影本来就该是深的）。 */
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
const bgDecls = [...cssNoComments.matchAll(/background(?:-color)?\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
const darkBg = bgDecls.filter((v) => {
  /* 只认"看起来是深色"的十六进制 */
  const hex = v.match(/#([0-9a-f]{6})\b/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    const r = (n >> 16) & 255; const g = (n >> 8) & 255; const b = n & 255;
    if ((r * 299 + g * 587 + b * 114) / 1000 < 128) return true;
  }
  /* 半透明深色只允许用在模态遮罩上（rgb 分量都很小且带 alpha） */
  const rgba = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/i);
  if (rgba) {
    const [r, g, b] = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
    const alpha = rgba[4] === undefined ? 1 : Number(rgba[4]);
    if (alpha >= 0.9 && (r * 299 + g * 587 + b * 114) / 1000 < 128) return true;
  }
  return false;
});
ok('admin.css 没有写死的深色背景（底色应交给 geo.css 的纯白）',
  darkBg.length === 0, '命中：' + darkBg.join(' | '));

ok('admin.css 复用了站点的 --g-* 配色变量',
  /var\(--g-(ink|teal|cyan-dk|paper|tint|rule)\)/.test(css));

/* 3c) 顺序：pages.css（深色）→ geo.css（纯白）→ admin.css，管理页样式必须最后 */
const cssLinks = [...html.matchAll(/<link[^>]*href="([^"]+\.css)"[^>]*>/g)].map((m) => m[1]);
ok('样式表加载顺序为 pages.css → geo.css → admin.css',
  cssLinks.length === 3 &&
  cssLinks[0].includes('pages.css') &&
  cssLinks[1].includes('geo.css') &&
  cssLinks[2].includes('admin.css'),
  cssLinks.join(' → '));

/* 4) 脚本清单。
   先剔除 HTML 注释再扫标签 —— 否则注释里写的示例标签会被误判成真实引用
   （这也正是本检查第一版报假阳性的原因）。 */
const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
const scripts = [...htmlNoComments.matchAll(/<script[^>]*src="([^"]+)"[^>]*>/g)].map((m) => m[1]);
ok('页面加载 admin.js', scripts.some((s) => s.endsWith('/_admin/admin.js')), scripts.join(', '));
ok('页面不再用 script 标签注入令牌（未解锁时会 401 且污染控制台）',
  !scripts.some((s) => s.includes('token.js')), scripts.join(', '));
ok('注释里不出现完整 script 标签（避免任何标签扫描器误判）',
  !/<script/.test(html.replace(/<script[^>]*src="[^"]+"[^>]*><\/script>/g, '')));

console.log('');
console.log('管理页静态自检：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
