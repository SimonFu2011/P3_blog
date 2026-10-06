/* ============================================================
   校验与净化
   ------------------------------------------------------------
   管理端进来的每一个字段都当作**不可信输入**处理 —— 即使这一版只有
   我自己用，理由有两条：
     1) 本机浏览器里任何页面都可能往 localhost 发请求（CSRF 面），
        令牌挡住了大部分，但"挡住之后就不校验"是坏习惯；
     2) 数据最终会写进 posts.js 并成为线上页面的一部分，
        一次手滑的 XSS 会是永久的。

   这里只做两件事：
     · validatePost —— 字段级校验（类型、形状、长度、唯一性）
     · inspectHtml   —— 正文 HTML 的安全与结构检查

   HTML 检查刻意不做完整解析器：只回答"能不能安全地作为片段注入"，
   不试图理解语义。漏报的代价是样式怪，误报的代价是写不进去 ——
   后者更安全，所以宁可严一点。
   ============================================================ */
import { HttpError } from './util.mjs';

/* ------------------------------------------------------------
   常量
   ------------------------------------------------------------ */

export const LIMITS = {
  slug: 64,
  title: 120,
  category: 24,
  tag: 24,
  tags: 12,
  excerpt: 240,
  aliases: 20,
  bodyChars: 400_000,       // 单篇正文上限（约 400 KB 文本）
  titleRequired: 1
};

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

/* 允许出现在正文里的标签白名单。不在表里的一律报错：
   与其"尽力净化"，不如让作者显式知道某个标签不被支持。 */
const ALLOWED_TAGS = new Set(['p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
  'code', 'pre', 'kbd', 'samp', 'var', 'blockquote', 'cite', 'q', 'abbr', 'mark', 'small', 'sub', 'sup',
  'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'a', 'img', 'figure', 'figcaption', 'picture', 'table', 'thead', 'tbody', 'tfoot',
  'tr', 'th', 'td', 'caption', 'colgroup', 'col', 'div', 'span', 'section', 'aside', 'details', 'summary']);

/* 明确禁止（不是"不支持"，是"绝不允许"）：会执行脚本、加载外部资源、
   或改变页面行为的标签。 */
const FORBIDDEN_TAGS = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'applet', 'form', 'input', 'textarea', 'select', 'option', 'button', 'base', 'link', 'meta',
  'template', 'slot', 'noscript', 'animate', 'set', 'foreignobject', 'use', 'math', 'svg']);

/* ------------------------------------------------------------
   URL 判定：先归一化，再比对
   ------------------------------------------------------------
   为什么不能直接对原文做正则（这是实测踩出来的）：
     '<a href="&#106;avascript:alert(1)">'  实体解码后才是 javascript:
     '<a href="java\nscript:alert(1)">'     URL 解析器会剥掉换行
     '<a href="\u0000javascript:...">'      前导 C0 控制字符同样被剥掉
   这三条**都骗过了原来那条正则**（实测全部放行）。所以顺序必须是：
   解码实体 → 去掉全部 ASCII 控制字符与空白 → 再去判协议。
   ------------------------------------------------------------ */
const decodeEntities = (s) => {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c !== '&') { out += c; continue; }
    const semi = s.indexOf(';', i + 1);
    if (semi < 0 || semi - i > 12) { out += c; continue; }
    const body = s.slice(i + 1, semi);
    let ch = null;
    if (/^#[0-9]+$/.test(body)) ch = String.fromCodePoint(Number(body.slice(1)));
    else if (/^#x[0-9a-f]+$/i.test(body)) ch = String.fromCodePoint(parseInt(body.slice(2), 16));
    else {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", tab: '\t', newline: '\n', colon: ':' };
      const k = body.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(named, k)) ch = named[k];
    }
    if (ch === null) { out += c; continue; }
    out += ch;
    i = semi;
  }
  return out;
};

/** 归一化一个待判定的 URL 值 */
const normalizeUrlValue = (raw) => decodeEntities(String(raw))
  .replace(/[\u0000-\u0020\u007f]/g, '')   // 控制字符 + 空白，一律剥掉
  .trim();

const FORBIDDEN_URL = /^(?:javascript|vbscript|data)\s*:/i;
const isForbiddenUrl = (raw) => FORBIDDEN_URL.test(normalizeUrlValue(raw));

/* 结束标签在 HTML5 里可省略的标签 */
const IMPLICIT_CLOSE = new Set(['li', 'dt', 'dd', 'tr', 'td', 'th', 'thead', 'tbody',
  'tfoot', 'option', 'optgroup', 'caption', 'colgroup']);

/* 会让未闭合的 <p> 自动结束的块级标签 */
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'aside', 'details', 'summary', 'ul', 'ol', 'dl',
  'table', 'blockquote', 'pre', 'figure', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'form']);

/* ------------------------------------------------------------
   字段级校验
   ------------------------------------------------------------ */

const asString = (v, field) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(422, field + ' 必须是字符串');
  return v;
};

export const isSlug = (v) => typeof v === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(v);

/** 'YYYY-MM-DD' 且必须是真实存在的日期（2026-02-30 会被拒） */
export const isDate = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/**
 * 校验一篇文章。
 * existing — 现存文章数组（用于 slug 唯一性与别名冲突检查）
 * opts.originalSlug — 编辑场景下的原 slug（允许它等于自己）
 * 返回净化后的对象。
 */
export const validatePost = (input, existing, opts) => {
  const src = input && typeof input === 'object' ? input : {};
  const originalSlug = (opts && opts.originalSlug) || null;
  const errors = [];

  const slug = asString(src.slug, 'slug').trim().toLowerCase();
  if (!isSlug(slug)) {
    errors.push('slug 只能是 2~64 位小写字母/数字/连字符，且不能以连字符开头或结尾');
  }
  const taken = (existing || []).some((p) => String(p.slug) === slug && String(p.slug) !== originalSlug);
  if (taken) errors.push('slug「' + slug + '」已经被另一篇文章占用');

  const title = asString(src.title, 'title').trim();
  if (!title) errors.push('标题不能为空');
  if (title.length > LIMITS.title) errors.push('标题不要超过 ' + LIMITS.title + ' 字');

  const date = asString(src.date, 'date').trim();
  if (!isDate(date)) errors.push('日期必须是 YYYY-MM-DD，且是真实存在的日期');

  const category = asString(src.category, 'category').trim();
  if (!category) errors.push('分类不能为空');
  if (category.length > LIMITS.category) errors.push('分类不要超过 ' + LIMITS.category + ' 字');

  /* 标签：支持数组，也支持 "a, b" 这种手输；去重、去空白、限长限量 */
  let tags = src.tags;
  if (typeof tags === 'string') tags = tags.split(/[,，]/);
  if (tags === undefined || tags === null) tags = [];
  if (!Array.isArray(tags)) errors.push('tags 必须是数组或逗号分隔的字符串');
  tags = (Array.isArray(tags) ? tags : [])
    .map((t) => asString(t, 'tag').trim())
    .filter((t) => t.length > 0);
  if (tags.length > LIMITS.tags) errors.push('标签最多 ' + LIMITS.tags + ' 个');
  tags.forEach((t) => { if (t.length > LIMITS.tag) errors.push('标签「' + t + '」超过 ' + LIMITS.tag + ' 字'); });
  const seenTag = new Set();
  tags = tags.filter((t) => (seenTag.has(t) ? false : (seenTag.add(t), true)));

  const excerpt = asString(src.excerpt, 'excerpt').trim();
  if (excerpt.length > LIMITS.excerpt) errors.push('摘要不要超过 ' + LIMITS.excerpt + ' 字');

  let aliases = src.aliases;
  if (aliases === undefined || aliases === null) aliases = [];
  if (!Array.isArray(aliases)) errors.push('aliases 必须是数组');
  aliases = (Array.isArray(aliases) ? aliases : []).map((a) => asString(a, 'alias').trim().toLowerCase()).filter(Boolean);
  if (aliases.length > LIMITS.aliases) errors.push('别名最多 ' + LIMITS.aliases + ' 个');
  aliases.forEach((a) => { if (!isSlug(a)) errors.push('别名「' + a + '」不是合法 slug'); });
  aliases = aliases.filter((a) => a !== slug);
  /* 别名不能撞上任何现存文章的 slug（否则链接指向谁就说不清了） */
  aliases.forEach((a) => {
    if ((existing || []).some((p) => String(p.slug) === a && String(p.slug) !== originalSlug)) {
      errors.push('别名「' + a + '」与现有文章的 slug 冲突');
    }
  });

  const body = asString(src.body, 'body');
  if (body.length > LIMITS.bodyChars) errors.push('正文太长了（超过 ' + LIMITS.bodyChars + ' 字符）');

  const html = inspectHtml(body);
  if (!html.ok) errors.push.apply(errors, html.errors);

  if (errors.length) throw new HttpError(422, '校验未通过', { errors });

  const out = { slug, title, date, category, tags, excerpt, body };
  if (src.isDraft === true) out.isDraft = true;
  if (aliases.length) out.aliases = aliases;
  return out;
};

/* ------------------------------------------------------------
   正文 HTML 检查
   ------------------------------------------------------------ */

/* ------------------------------------------------------------
   标签扫描：**手写线性分词器**，不用正则
   ------------------------------------------------------------
   原来这里是一条正则：
     /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g
   它有两个实测出来的严重问题：

   1) **ReDoS**（指数回溯）。`(?:"…"|'…'|[^>])*?` 是歧义量词，输入里没有 `>`
      时回溯爆炸。实测：`<a ` + N 个双引号，N=40（43 字节）耗时 1288ms，
      N=44（47 字节）到 8485ms。Node 是单线程，一个 5MB 的上传就够把整台
      服务打到不响应；而正文上限是 40 万字符 —— 等于没有上限。

   2) **未闭合标签绕过**。正则要求结尾有 `>`，于是 `<img src=x onerror=alert(1)`
      （注意：没有 `>`）**整条正则匹配不上**，属性根本没被检查，校验通过。
      而浏览器在 EOF 处会把未闭合的标签照样发出来 —— 事件属性就执行了。

   手写扫描器一次遍历、无回溯，并把"未闭合的 <"当成错误而不是跳过。
   ------------------------------------------------------------ */
const tokenizeTags = (text) => {
  const tags = [];
  let unterminated = null;
  const n = text.length;
  let i = 0;

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    let j = lt + 1;

    /* 属性区里允许出现 `>`：<a title="a>b"> 是合法的 */
    let closing = false;
    if (text[j] === '/') { closing = true; j += 1; }

    const nameStart = j;
    while (j < n && /[a-zA-Z0-9-]/.test(text[j])) j += 1;
    const name = text.slice(nameStart, j);
    /* 不是标签的样子（`<` 后既不是字母也不是 /）：当普通文本，继续往后找 */
    if (!name) { i = lt + 1; continue; }

    let quote = null;
    let end = -1;
    let k = j;
    for (; k < n; k += 1) {
      const c = text[k];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '>') { end = k; break; }
    }
    if (end < 0) { unterminated = text.slice(lt, Math.min(n, lt + 40)); break; }

    const attrText = text.slice(j, end);
    const selfClosing = /\/\s*$/.test(attrText);
    tags.push({
      closing, name, selfClosing,
      attrText: selfClosing ? attrText.replace(/\/\s*$/, '') : attrText
    });
    i = end + 1;
  }
  return { tags, unterminated };
};

const parseAttrs = (raw) => {
  const attrs = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs.push({
      name: m[1].toLowerCase(),
      value: m[2] === undefined ? null : m[2].replace(/^["']|["']$/g, '')
    });
  }
  return attrs;
};

/**
 * 返回 { ok, errors, warnings, tags }
 * 检查项：禁用标签、未知标签、事件属性、危险 URL、标签闭合顺序、未闭合标签。
 */
export const inspectHtml = (html) => {
  const errors = [];
  const warnings = [];
  const stack = [];
  const text = String(html === undefined || html === null ? '' : html);

  /* 注释、CDATA、处理指令一律不允许 —— 它们能藏东西 */
  if (/<!--/.test(text)) errors.push('正文里不要写 HTML 注释（<!-- -->），需要说明请写进正文文字');
  if (/<!\[CDATA\[/.test(text)) errors.push('正文里不允许 CDATA 段');
  if (/<\?/.test(text)) errors.push('正文里不允许处理指令（<? ?>）');

  const { tags, unterminated } = tokenizeTags(text);

  /* 未闭合的标签必须报错：浏览器在 EOF 处会把它照样发出来，
     于是没被检查到的属性（例如 onerror）就会执行。这就是实测过的绕过。 */
  if (unterminated) {
    errors.push('正文里有一个没有闭合的标签：' + JSON.stringify(unterminated)
      + '… —— 标签必须有结束的 ">"，否则里面的属性不会被检查');
  }

  for (const t of tags) {
    const closing = t.closing;
    const name = t.name.toLowerCase();
    const attrs = parseAttrs(t.attrText || '');

    if (FORBIDDEN_TAGS.has(name)) {
      errors.push('不允许使用 <' + name + '> 标签');
      continue;
    }
    if (!ALLOWED_TAGS.has(name) && !VOID_TAGS.has(name)) {
      errors.push('不支持的标签 <' + name + '>' + '（如果确实需要，请在 server/lib/validate.mjs 的白名单里显式加上）');
      continue;
    }

    for (const a of attrs) {
      if (/^on/i.test(a.name)) errors.push('<' + name + '> 上不允许事件属性 ' + a.name);
      if (a.name === 'style') errors.push('<' + name + '> 上不允许 style 属性（样式请写进 CSS 文件）');
      if (a.name === 'srcdoc') errors.push('<' + name + '> 上不允许 srcdoc 属性');
      /* 协议判定必须走 isForbiddenUrl：它先解码 HTML 实体、再剥掉控制字符。
         直接对原文做正则会漏掉 &#106;avascript: / java\nscript: / NUL 前缀
         这三种（都实测放行过）。 */
      if (a.name === 'href' && a.value && isForbiddenUrl(a.value)) {
        errors.push('<' + name + '> 的 href 不允许 javascript:/vbscript:/data: 协议');
      }
      /* 图片只允许站内相对路径与 http(s)：src 用 data: 会绕过图片上传，
         而且体积不可控。 */
      if (a.name === 'src' && a.value) {
        const v = normalizeUrlValue(a.value);
        if (isForbiddenUrl(a.value) && !/^data:image\//i.test(v)) {
          errors.push('<' + name + '> 的 src 不允许 ' + v.slice(0, 24) + '… 这种协议');
        }
      }
    }

    if (closing) {
      if (VOID_TAGS.has(name)) {
        errors.push('<' + name + '> 是自闭合标签，不能写成 </' + name + '>');
        continue;
      }
      /* 从栈顶往回找同名开标签；中间那些没闭合的，就是"漏了闭标签" */
      const at = stack.lastIndexOf(name);
      if (at < 0) {
        errors.push('多了一个 </' + name + '>');
      } else {
        const unclosed = stack.slice(at + 1);
        if (unclosed.length) {
          errors.push('<' + unclosed.join('>、<') + '> 没有闭合，却先遇到了 </' + name + '>');
        }
        stack.length = at;
      }
      continue;
    }

    if (VOID_TAGS.has(name) || t.selfClosing) continue;

    /* 隐式闭合：这些标签的结束标签在 HTML5 里本来就"可以省略"。
       不处理它们，写一个朴素的 <ul><li>a<li>b</ul> 就会被判成漏闭合。
       堆栈里位于同名标签之上的那些，按规范应该已被自动闭合 —— 一并弹掉。 */
    if (IMPLICIT_CLOSE.has(name)) {
      const at = stack.lastIndexOf(name);
      if (at >= 0) stack.length = at;
    } else if (name === 'p') {
      const at = stack.lastIndexOf('p');
      if (at >= 0) stack.length = at;
    }
    /* <p> 是可以由任何块级元素的开始标签自动闭合的 */
    if (BLOCK_TAGS.has(name) && name !== 'p') {
      while (stack.length && stack[stack.length - 1] === 'p') stack.pop();
    }

    stack.push(name);
  }

  if (stack.length) {
    errors.push('这些标签没有闭合：<' + stack.join('>、<') + '>');
  }

  if (!text.trim()) warnings.push('正文是空的');
  if (/<img[^>]*>/i.test(text) && !/<img[^>]*\salt=/i.test(text)) {
    warnings.push('有 <img> 没有 alt（可访问性会打折）');
  }

  return { ok: errors.length === 0, errors, warnings };
};
