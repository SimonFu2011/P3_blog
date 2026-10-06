/* ============================================================
   文章存储 —— js/posts.js 的"读—改—写"唯一入口
   ------------------------------------------------------------
   为什么不用 JSON.parse / 手写 JS 解析器：
   这个文件是手写的 JavaScript，正文里满是 '&lt;'、反斜杠、中文引号，
   真正的字符串边界只有 JS 引擎说了算。所以：

     · 定位：自己扫源码，只做一件事 —— 找出 window.POSTS = [ ... ]
       这一段，以及每个顶层对象字面量的字符区间（span）。
     · 求值：把这一段交给 node:vm 在**空沙箱**里跑，拿到结构化对象。
       沙箱里没有 require / process / fetch，posts.js 里就算有恶意代码
       也拿不到宿主能力（它是我们自己的文件，但防御性编程不花钱）。
     · 写回：只替换"被改动的那些对象"的原区间，其余文章逐字节保留，
       所以你的注释、缩进、空行都不会被格式化掉。

   写回后必须能通过 verify()：把结果重新求值，逐字段与期望比对。
   不通过就拒绝写盘 —— 宁可不保存，也不能把站点写坏。
   ============================================================ */
import vm from 'node:vm';
import { HttpError, sha256 } from './util.mjs';

/* ------------------------------------------------------------
   1. 定位 window.POSTS = [ ... ]
   ------------------------------------------------------------ */

const OPENERS = [
  /window\s*\.\s*POSTS\s*=\s*\[/,
  /(?:var|let|const)\s+POSTS\s*=\s*\[/,
  /^\s*POSTS\s*=\s*\[/m
];

/**
 * 把注释内容抹成空格（长度与下标保持一致），字符串与模板字符串原样保留。
 * 必须先做这一步再找 window.POSTS —— 文件头部的说明注释里就写着
 * "把 window.POSTS 换成一次接口请求即可"，不剔注释就会锚到那句话上，
 * 后面的区间全算错，写回时会把文件改烂。
 */
const blankComments = (source) => {
  const out = source.split('');
  let quote = null;
  let line = false;
  let block = false;

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (line) {
      if (c === '\n') line = false;
      else out[i] = ' ';
      continue;
    }
    if (block) {
      if (c === '*' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i++; block = false; continue; }
      if (c !== '\n') out[i] = ' ';
      continue;
    }
    if (quote) {
      if (c === '\\') { i++; continue; }          // 转义：两个字符都属于字符串
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i++; line = true; continue; }
    if (c === '/' && next === '*') { out[i] = ' '; out[i + 1] = ' '; i++; block = true; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
  }
  return out.join('');
};

/** 找到数组字面量的 '[' 下标与它匹配的 ']' 下标；找不到抛 HttpError。 */
const findArray = (source) => {
  const clean = blankComments(source);
  let open = -1;
  for (const re of OPENERS) {
    const m = re.exec(clean);
    if (m) { open = m.index + m[0].length - 1; break; }
  }
  if (open < 0) throw new HttpError(422, 'posts.js 里找不到 window.POSTS = [ 数组字面量');

  let depth = 0;
  let i = open;
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }

    if (c === '/' && next === '/') { lineComment = true; i++; continue; }
    if (c === '/' && next === '*') { blockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }

    if (c === '[' || c === '{' || c === '(') depth++;
    else if (c === ']' || c === '}' || c === ')') {
      depth--;
      if (depth === 0 && c === ']') return { open, close: i };
    }
  }
  throw new HttpError(422, 'posts.js 的数组字面量没有闭合');
};

/* ------------------------------------------------------------
   2. 切出每个顶层对象的区间
   ------------------------------------------------------------ */

/**
 * 返回 [{ start, end, text }]，start/end 是对象字面量 '}' 之后一位。
 * 只有大括号深度回到 0 才算一个条目 —— 正文里出现的 '{' 不会干扰。
 */
const entrySpans = (source, open, close) => {
  const spans = [];
  let depth = 0;
  let start = -1;
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = open + 1; i < close; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }

    if (c === '/' && next === '/') { lineComment = true; i++; continue; }
    if (c === '/' && next === '*') { blockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }

    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        spans.push({ start, end: i + 1, text: source.slice(start, i + 1), index: spans.length });
        start = -1;
      }
    }
  }
  return spans;
};

/* ------------------------------------------------------------
   3. 沙箱求值
   ------------------------------------------------------------ */

const SANDBOX_LIMIT_MS = 2000;

/**
 * 把整份 posts.js 放进 vm 上下文执行，取回 window.POSTS。
 *
 * ⚠️ **这不是安全边界，别把它当沙箱。** 实测（Node 22/24）：
 *      window.constructor.constructor("return process")().version  →  能拿到宿主 process
 *      window.__proto__.X = 1  →  污染的是**宿主**的 Object.prototype
 *    原因是把宿主对象（`{}`、`console.log`）递进了上下文，它们的
 *    `.constructor.constructor` 就是宿主 Function。`codeGeneration.strings:false`
 *    拦不住这条；vm 模块本身也**不承诺**能当安全边界。
 *
 * 它在真实拓扑里够用的理由：写入 posts.js 的唯一途径是本进程自己的
 * `jsString`/`serializePost`（转义正确），没有任何 API 能塞进任意 JS。
 * 要真正隔离，得换成子进程 + 权限模型，或者干脆用解析器而不是 eval。
 *
 * 即便不是边界，下面这几件事也**必须**做对（都是实测踩出来的）：
 *   1) 上下文里的对象在**上下文内部**构造，不要把宿主对象递进去；
 *   2) 结果在**上下文内部** JSON 序列化后再交回宿主 —— 否则 window.POSTS 里
 *      的一个 getter/Proxy 会在宿主侧的每次属性读取时执行，**不受 timeout 约束**
 *      （死循环就等于永久挂住进程）。放进脚本里做，timeout 才罩得住它。
 */
export const evaluatePosts = (source) => {
  let context;
  try {
    context = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false }
    });
    /* 这一切都在上下文内部执行：window / console 是**上下文自己的**对象
       （Object.create(null) 没有原型链，拿不到 constructor 这条路），
       并且把 JSON 冻住，防止被替换掉之后在宿主侧执行。 */
    new vm.Script(`
      this.window = Object.create(null);
      this.console = Object.freeze({ log() {}, warn() {}, error() {}, info() {}, debug() {} });
      this.globalThis.window = this.window;
      Object.freeze(this.console);
      if (this.JSON) { Object.freeze(this.JSON.stringify); Object.freeze(this.JSON.parse); }
    `, { filename: 'sandbox-boot.js' }).runInContext(context, { timeout: SANDBOX_LIMIT_MS });

    new vm.Script(source, { filename: 'posts.js' }).runInContext(context, { timeout: SANDBOX_LIMIT_MS });

    /* 关键：序列化也在上下文里、同一个 timeout 之下完成 */
    const json = new vm.Script(
      'JSON.stringify(this.window.POSTS === undefined ? null : this.window.POSTS)',
      { filename: 'sandbox-read.js' }
    ).runInContext(context, { timeout: SANDBOX_LIMIT_MS });

    if (json === 'null' || json === undefined) {
      throw new HttpError(422, 'posts.js 没有产出 window.POSTS 数组');
    }
    const posts = JSON.parse(json);
    if (!Array.isArray(posts)) throw new HttpError(422, 'posts.js 没有产出 window.POSTS 数组');
    return posts;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(422, 'posts.js 求值失败：' + err.message);
  }
};

/* ------------------------------------------------------------
   4. 读取：源码 → { source, hash, prefix, spans, posts }
   ------------------------------------------------------------ */

export const parse = (source) => {
  if (typeof source !== 'string' || !source.trim()) throw new HttpError(422, 'posts.js 是空的');
  const { open, close } = findArray(source);
  const spans = entrySpans(source, open, close);
  const values = evaluatePosts(source);

  if (spans.length !== values.length) {
    throw new HttpError(422,
      'posts.js 的结构无法安全改写：数组里有 ' + values.length + ' 个值，但只定位到 ' +
      spans.length + ' 个顶层对象字面量（可能存在展开运算符或外部常量引用）');
  }

  const posts = values.map((value, i) => Object.assign({}, value, {
    __span: { start: spans[i].start, end: spans[i].end, text: spans[i].text },
    __index: i
  }));

  return {
    source,
    hash: sha256(source),
    open,
    close,
    spans,
    values,
    posts,
    /* 新增文章要插在数组末尾（= 文章列表尾部）。
       现有文件是"越靠前越新"，所以新文章按 content 顺序依次插在这里，
       最终由 order 决定谁在最前面。 */
    insertAt: spans.length ? spans[spans.length - 1].end : open + 1
  };
};

/* ------------------------------------------------------------
   5. JS 字符串字面量转义
   ------------------------------------------------------------ */

const ESCAPES = {
  '\\': '\\\\',
  "'": "\\'",
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
  '\v': '\\v',
  '\0': '\\x00',
  '\u2028': '\\u2028',   // 这两个在 JS 里算行终止符，必须转义
  '\u2029': '\\u2029'
};

/**
 * 一个字符一个字符地转义。刻意不用 JSON.stringify：
 * JSON 不允许单引号字符串，也不转义 U+2028/2029。
 */
export const jsString = (value) => {
  const s = String(value === undefined || value === null ? '' : value);
  let out = '';
  for (const ch of s) {
    if (Object.prototype.hasOwnProperty.call(ESCAPES, ch)) { out += ESCAPES[ch]; continue; }
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) { out += '\\x' + code.toString(16).padStart(2, '0'); continue; }
    out += ch;
  }
  return "'" + out + "'";
};

const jsArray = (list) => '[' + (list || []).map(jsString).join(', ') + ']';

/* ------------------------------------------------------------
   6. 序列化：对象 → 源码（风格对齐现有文件）
   ------------------------------------------------------------ */

export const FIELD_ORDER = [
  'slug', 'title', 'date', 'category', 'tags', 'excerpt', 'isDraft', 'aliases', 'body'
];

/**
 * 生成一个对象字面量（不带缩进），字段顺序与现有文章一致。
 * body 直接给成单引号长字符串：每次保存都重新生成，注释不会随时间腐坏，
 * 而且写完立刻会被 verify() 重新求值复核。
 */
export const serializePost = (post) => {
  const lines = ['{'];

  const push = (key, literal) => lines.push('  ' + key + ': ' + literal + ',');

  push('slug', jsString(post.slug));
  push('title', jsString(post.title));
  push('date', jsString(post.date));
  push('category', jsString(post.category));
  push('tags', jsArray(post.tags));
  /* excerpt 只在有内容时才写：现有 8 篇都有，新文章留空就不写这个字段 */
  if (post.excerpt) push('excerpt', jsString(post.excerpt));
  /* 新增的两个可选字段只在"非默认值"时输出 —— 这样旧文章重写后
     不会凭空多出 isDraft: false，diff 保持最小。 */
  if (post.isDraft === true) push('isDraft', 'true');
  if (Array.isArray(post.aliases) && post.aliases.length) push('aliases', jsArray(post.aliases));
  push('body', jsString(post.body));

  const last = lines.length - 1;
  lines[last] = lines[last].replace(/,$/, '');   // 末字段不吃逗号
  lines.push('}');
  return lines.join('\n');
};

/* ------------------------------------------------------------
   7. 写回：只动被改的区间
   ------------------------------------------------------------ */

/**
 * write(source, { posts, order })
 *   posts —— 全量文章数组（结构化数据）
 *   order —— slug 顺序（数组首元素排最前）
 *
 * 做法：能按 slug 在原文里找到区间的，就替换那段区间；找不到的（新增）
 * 追加到数组末尾；不在 posts 里的（删除）区间直接删掉。
 * 所有替换从后往前做，避免前面的改动让后面的下标失效。
 */
export const write = (source, opts) => {
  const parsed = parse(source);
  const posts = (opts && opts.posts) || [];
  const order = (opts && opts.order) || posts.map((p) => p.slug);
  const renameFrom = (opts && opts.renameFrom) || null;

  const bySlug = new Map();
  parsed.posts.forEach((p) => {
    if (p.slug) bySlug.set(String(p.slug), p);
  });

  /* 每一篇只有三种命运：就地替换 / 新增 / 删除。
     分成三个数组而不是一个，是为了让"逗号归谁"这件事在删除时说得清。 */
  const edits = [];      // { start, end, text }  就地替换
  const appends = [];    // { text, order }       新增
  const deletions = [];  // { start, end, isLast } 删除

  order.forEach((slug, i) => {
    const data = posts.find((p) => p.slug === slug);
    if (!data) return;

    /* 条目可能是"改了 slug 的同一篇"：原文里没有新 slug，
       但有 renameFrom 指出的旧 slug。这种情况要**就地替换**，
       否则会走成"删掉旧的 + 新增一篇"，位置跟着变，diff 也难看。 */
    const origin = renameFrom && Object.prototype.hasOwnProperty.call(renameFrom, slug)
      ? renameFrom[slug]
      : slug;
    const existing = bySlug.get(String(origin));
    if (!existing) { appends.push({ text: serializePost(data), order: i }); return; }

    /* 值没变就**不写**。这一条不只是省事：
       如果每次保存都重排所有文章，一次删除就会把另外七篇的注释和排版
       全部重刷一遍，git diff 变成"整文件重写"，也更容易改坏结构。
       比较时忽略内部字段，只比真实内容。 */
    if (JSON.stringify(clean(existing)) !== JSON.stringify(clean(data))) {
      edits.push({ start: existing.__span.start, end: existing.__span.end, text: serializePost(data) });
    }
  });

  /* 原文里的每一条，只有"既不在 order 里、也不是别人改名的来源"才算被删。
     漏掉后半句会把"改 slug"变成"删一篇" —— 静默丢文章是最不能接受的 bug。 */
  const keepOrigins = new Set(order.map(String));
  if (renameFrom) Object.keys(renameFrom).forEach((k) => keepOrigins.add(String(renameFrom[k])));

  parsed.posts.forEach((p) => {
    if (!keepOrigins.has(String(p.slug))) {
      deletions.push({
        start: p.__span.start,
        end: p.__span.end,
        /* 后面还有没有同级的 `,`？有 = 不是最后一条 */
        isLast: !/^\s*,/.test(source.slice(p.__span.end))
      });
    }
  });

  if (deletions.length === parsed.posts.length && !appends.length) {
    throw new HttpError(422, '不能删掉最后一篇文章（空的 window.POSTS 会让所有页面进入空状态）');
  }

  /* 就地替换：从后往前，避免前面的改动让后面的下标失效 */
  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }

  /* 删除。逗号归属是这里唯一的坑：
       被删条目的**前面**有一个逗号（属于上一条），**后面**也可能有一个
       （如果不是最后一条）。两头的逗号必须都剥干净，再由我们统一拼一个
       回去 —— 只剥一头就会拼出 ",," 或留下拖尾逗号。

       不用 /,\s*$/ 这种写法：head 与条目之间可能隔着空行（"},\n\n  "），
       贪婪的 \s* 会把空行连同前面一条的收尾一起啃掉，而 /,[ \t]*\n?[ \t]*$/
       又匹配不到它（逗号后面先跟换行，锚点上不止一个换行）。
       直接往回找到第一个非空白字符、看它是不是逗号，最省事也最准。
       源码里的逗号一律被转义成普通字符，所以这里遇到的 ',' 一定是结构逗号。 */
  deletions.sort((a, b) => b.start - a.start);
  for (const d of deletions) {
    let head = out.slice(0, d.start);
    let i = head.length - 1;
    while (i >= 0 && (head[i] === ' ' || head[i] === '\t' || head[i] === '\n' || head[i] === '\r')) i--;
    if (i >= 0 && head[i] === ',') {
      head = head.slice(0, i);                  // 吃掉这条自己前面的分隔逗号
    } else {
      /* 首条：前面只有 "[ + 空白"。把空白换成 '\n'，
         而不是全部删掉 —— 否则会拼出 "[,\n\n  "，
         等于在数组开头凭空多了一个逗号。 */
      head = head.replace(/\s+$/, '') + '\n';
    }

    /* tail 要拆两段：被删条目与"下一个条目 / 数组右括号"之间的空白，
       以及那之后**原样保留**的内容（下一个条目本身，或数组的 "]"）。
       三种情况：
         · rest 匹配不上空白分隔符（空数组）→ 原样接回
         · suffix 以 ']' 开头 = 删掉的是最后一条 → 不需要分隔符，只补换行
         · 其他 → 用与全文一致的分隔符接上下一条；
           但如果 head 已经落在数组左括号上（删的是第一条），
           左括号后面不能跟逗号，这时也只补换行。
       把"第一条 / 最后一条"当成"中间条"，就会拼出 "[," 或 "},\n\n  ];"。 */
    const rest = out.slice(d.end);
    const m = /^[ \t]*(?:,[ \t]*)?\n?[ \t]*/.exec(rest);
    if (!m) {
      out = head + rest;
    } else {
      const suffix = rest.slice(m[0].length);
      const flat = head.replace(/\s+$/, '');      // 拼接口一律先右裁，避免新旧空白叠加
      const atEdge = flat.endsWith('[') ||
        !suffix || suffix.trimStart().startsWith(']');
      out = atEdge ? flat + '\n' + suffix : flat + ',\n\n  ' + suffix;
    }
  }

  /* 新增：插在数组**最前**（现有文件的约定是"越靠前越新"，归档页倒序展示）。
     锚点取第一条的起点，插进去的文本自己带尾逗号，空行缩进与全文一致。
     多篇时按 order 升序（新→旧）依次插在游标处、游标随后右移，
     最终先后正好等于 order。 */
  if (appends.length) {
    const fresh = findArray(out);
    const first = entrySpans(out, fresh.open, fresh.close)[0];
    if (!first) throw new HttpError(422, '数组是空的，无法确定插入位置');
    let at = first.start;
    appends.slice().sort((a, b) => a.order - b.order).forEach((a) => {
      const text = a.text + ',\n\n  ';
      out = out.slice(0, at) + text + out.slice(at);
      at += text.length;
    });
  }

  return out;
};

/* ------------------------------------------------------------
   8. 复核：写完必须能原样读回来
   ------------------------------------------------------------ */

/**
 * 把刚生成的新源码重新求值，逐字段与期望比对。
 * 这是"宁可不保存也不能写坏"的兜底 —— 也是整个方案里最重要的一次断言。
 */
export const verify = (newSource, expectedPosts) => {
  let values;
  try {
    const { open, close } = findArray(newSource);
    const spans = entrySpans(newSource, open, close);
    values = evaluatePosts(newSource);
    if (spans.length !== values.length) {
      return { ok: false, reason: '区间数与实际值数不一致（' + spans.length + ' vs ' + values.length + '）' };
    }
  } catch (err) {
    return { ok: false, reason: '重新求值失败：' + err.message };
  }

  if (values.length !== expectedPosts.length) {
    return { ok: false, reason: '文章数不一致（' + values.length + ' vs ' + expectedPosts.length + '）' };
  }

  const norm = (p) => JSON.stringify({
    slug: p.slug, title: p.title, date: p.date, category: p.category,
    tags: p.tags || [], excerpt: p.excerpt || '', body: p.body || '',
    isDraft: p.isDraft === true, aliases: p.aliases || []
  });

  for (let i = 0; i < values.length; i++) {
    const a = norm(values[i]);
    const b = norm(expectedPosts[i]);
    if (a !== b) {
      return { ok: false, reason: '第 ' + (i + 1) + ' 篇（' + values[i].slug + '）写回后与期望不一致' };
    }
  }
  return { ok: true };
};

/* ------------------------------------------------------------
   9. 面向业务的薄封装（供路由层调用）
   ------------------------------------------------------------ */

/** 从原始结构化文章里去掉内部字段，得到干净的对外表示 */
export const clean = (post) => {
  const out = {
    slug: post.slug,
    title: post.title,
    date: post.date,
    category: post.category,
    tags: (post.tags || []).slice(),
    excerpt: post.excerpt || '',
    body: post.body || ''
  };
  if (post.isDraft === true) out.isDraft = true;
  if (Array.isArray(post.aliases) && post.aliases.length) out.aliases = post.aliases.slice();
  return out;
};

/** 源码 → [{ ...clean, __span }] */
export const list = (source) => parse(source).posts.map((p) => {
  const c = clean(p);
  c.__index = p.__index;
  return c;
});

/**
 * 新增一篇。pages 是"全部文章的净化数组"，newPost 是要插进来的那篇。
 * 新文章放最前（与现有文件"越靠前越新"的约定一致）。
 */
export const insert = (source, newPost, allPosts) => {
  const next = [clean(newPost)].concat((allPosts || []).map(clean));
  return write(source, { posts: next, order: next.map((p) => p.slug) });
};

/** 更改一篇：slug 相同就地替换；slug 变了就地改名并保留旧 slug 作为别名 */
export const update = (source, originalSlug, updated, allPosts) => {
  const renameFrom = {};
  const next = (allPosts || []).map((p) => {
    const own = clean(p);
    if (own.slug !== originalSlug) return own;
    const merged = clean(updated);
    if (merged.slug !== originalSlug) {
      const aliases = (merged.aliases || []).slice();
      if (aliases.indexOf(originalSlug) < 0) aliases.push(originalSlug);
      merged.aliases = aliases;
      /* 告诉 write："这个新 slug 顶替的是原来那一条" ——
         少了这一步就会走成"删掉旧的 + 新增一篇"，位置和 diff 都不对。 */
      renameFrom[merged.slug] = originalSlug;
    }
    return merged;
  });
  return write(source, { posts: next, order: next.map((p) => p.slug), renameFrom });
};

/** 删除一篇 */
export const remove = (source, slug, allPosts) => {
  const next = (allPosts || []).map(clean).filter((p) => p.slug !== slug);
  return write(source, { posts: next, order: next.map((p) => p.slug) });
};
