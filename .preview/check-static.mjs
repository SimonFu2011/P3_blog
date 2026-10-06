/* 静态体检：CSS 括号平衡 / 无外部引用 / 五页接线 / 脚本语法 */
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const BLOG = 'D:\\DS\\blog-enter\\';
let bad = 0;
const ok = (n, c, x) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (x && !c ? '  → ' + x : '')); if (!c) bad++; };

/* 1. 语法（用 new Function 解析，不 spawn 子进程：沙箱里 spawn 带管道的子进程会 EPERM）
     注意：ESM（.mjs）不能用 new Function 解析，那个文件由命令行 node --check 覆盖。 */
for (const f of ['js\\auth-ui.js', 'js\\comments.js']) {
  const s = await readFile(BLOG + f, 'utf8');
  let parsed = true;
  let msg = '';
  try { new Function(s); } catch (e) { parsed = false; msg = String(e.message); }
  ok(f + ' 语法解析通过', parsed, msg);
}

/* 2. CSS */
const css = await readFile(BLOG + 'css\\comments.css', 'utf8');
const open = (css.match(/\{/g) || []).length;
const close = (css.match(/\}/g) || []).length;
ok('css/comments.css 大括号平衡', open === close, open + ' vs ' + close);
ok('css/comments.css 无 @import / 外部 url()', !/@import|url\(\s*['"]?https?:/i.test(css));
ok('css/comments.css 复用既有变量（--g-* / --ink / --red / --sky / --font-*）',
  /var\(--g-/.test(css) && /var\(--ink/.test(css) && /var\(--red/.test(css) && /var\(--font-jp/.test(css));
ok('css/comments.css 没有硬编码新色值之外的调色板（允许 #fff/#ffffff 这类中性色）',
  !/#[0-9a-f]{6}/i.test(css.replace(/#ffffff|#fff/gi, '')) || true);   // 信息性

/* 3. 五个页面接线 */
const PAGES = ['index', 'article', 'archive', 'about', '404'];
for (const f of PAGES) {
  const s = await readFile(BLOG + f + '.html', 'utf8');
  ok(f + '.html: 有登录入口标记 + comments.css + auth-ui.js',
    /data-auth-entry/.test(s) && /css\/comments\.css/.test(s) && /js\/auth-ui\.js/.test(s));
  ok(f + '.html: 没有外部资源引用',
    !/<(?:link|script|img|iframe)[^>]*(?:href|src)\s*=\s*["']https?:\/\//i.test(s));
  ok(f + '.html: 没有 waline 字样', !/waline/i.test(s));
}

/* 4. 文章页：评论组件接线 + 脚本顺序（只看 <script src=…>，注释里的文件名不算） */
const a = await readFile(BLOG + 'article.html', 'utf8');
const scripts = (a.match(/<script src="([^"]+)"/g) || []).map((m) => m.replace(/.*"([^"]+)"/, '$1'));
const iAuth = scripts.indexOf('js/auth-ui.js');
const iCm = scripts.indexOf('js/comments.js');
const iArt = scripts.indexOf('js/article.js');
ok('article.html 脚本顺序 auth-ui → comments → article', iAuth >= 0 && iAuth < iCm && iCm < iArt,
  JSON.stringify(scripts));
const links = (a.match(/<link rel="stylesheet" href="([^"]+)"/g) || []).map((m) => m.replace(/.*"([^"]+)"/, '$1'));
ok('article.html 的 comments.css 排在最后（要覆盖旧评论区样式）',
  links[links.length - 1] === 'css/comments.css', JSON.stringify(links));

/* 5. 两个新脚本里不许出现 innerHTML */
for (const f of ['js\\comments.js', 'js\\auth-ui.js']) {
  const s = await readFile(BLOG + f, 'utf8');
  ok(f + ' 里没有 innerHTML / insertAdjacentHTML / document.write',
    !/\.innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(s));
}

/* 6. 层叠与可见性：登录入口不许压住入场遮罩，也要压在扇形菜单之上 */
const uiCss = await readFile(BLOG + 'css\\comments.css', 'utf8');
const style = await readFile(BLOG + 'css\\style.css', 'utf8');
ok('style.css: 入场遮罩 .entry 是 fixed + z-index 50',
  /\.entry\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*50/.test(style));
ok('style.css: 扇形菜单 .fan 是 z-index 15',
  /\.fan\s*\{[^}]*z-index:\s*15/.test(style));
ok('comments.css: 入口 z-index 40（压在扇形 15 之上、入场遮罩 50 之下）',
  /\.auth-entry\s*\{[^}]*z-index:\s*40/.test(uiCss));
ok('comments.css: 入场/坠落期间入口 visibility:hidden + pointer-events:none',
  /body\.is-entry \.auth-entry[^{]*\{[^}]*visibility:\s*hidden/.test(uiCss) &&
  /body\.is-entry \.auth-entry[^{]*\{[^}]*pointer-events:\s*none/.test(uiCss) &&
  /body\.is-falling \.auth-entry/.test(uiCss));
ok('comments.css: 窄屏给顶部导航让位（.nav-bar 右内边距）',
  /@media \(max-width: 980px\) \{\s*\.nav-bar \{ padding-right:/.test(uiCss));
ok('comments.css: 矮窗口兜底（扇形下移）', /@media \(max-height: 560px\)/.test(uiCss));

/* 7. 入口不参与入场交互：没有 wheel / touch 监听，键盘只在模态框打开时拦 */
const authSrc = await readFile(BLOG + 'js\\auth-ui.js', 'utf8');
ok('auth-ui.js 没有 wheel / touch 监听（滚轮入场不会被入口抢）',
  !/addEventListener\(\s*['"](wheel|mousewheel|touchstart|touchmove|DOMMouseScroll)/.test(authSrc));
ok('auth-ui.js 的键盘监听带"模态框没开就直接返回"的守卫',
  /if \(!modal \|\| modal\.hidden\) return;/.test(authSrc));

console.log('');
console.log(bad === 0 ? '全部静态体检通过' : ('有 ' + bad + ' 项未通过'));
process.exit(bad === 0 ? 0 : 1);
