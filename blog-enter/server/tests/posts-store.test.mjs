/* ============================================================
   文章存储层单测
   ------------------------------------------------------------
   跑法：node --test blog-enter/server/tests/
   零依赖：只用 node:test + node:assert。

   最重要的两条断言：
     1) 现有 posts.js 解析后原样重写，**结构化数据零漂移**。
        这是整个方案成立的前提 —— 一旦改写会丢字段或转义出错，
        功能再全也不能上线。
     2) 写回的新源码必须能被 verify() 重新求值并逐字段对上。
   ============================================================ */
import assert from 'node:assert/strict';
import { createHarness, isMain } from './harness.mjs';

const H = createHarness('posts-store.test.mjs');
const test = (name, fn) => H.test(name, fn);
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as store from '../lib/posts-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const POSTS_FILE = join(HERE, '..', '..', 'js', 'posts.js');
const source = await readFile(POSTS_FILE, 'utf8');

const norm = (p) => JSON.stringify({
  slug: p.slug, title: p.title, date: p.date, category: p.category,
  tags: p.tags || [], excerpt: p.excerpt || '', body: p.body || '',
  isDraft: p.isDraft === true, aliases: p.aliases || []
});

/* ------------------------------------------------------------ */
test('解析现有 posts.js：能拿到全部文章且字段完整', () => {
  const parsed = store.parse(source);
  assert.ok(parsed.posts.length >= 8, '至少 8 篇，实际 ' + parsed.posts.length);
  for (const p of parsed.posts) {
    assert.match(p.slug, /^[a-z0-9-]+$/, 'slug 形状: ' + p.slug);
    assert.ok(p.title && p.title.length > 0);
    assert.match(p.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(p.category);
    assert.ok(Array.isArray(p.tags));
    assert.ok(typeof p.body === 'string' && p.body.length > 100, p.slug + ' 正文不该是空的');
  }
  /* 每篇的区间必须正好以 { 开头、以 } 结尾 */
  for (const p of parsed.posts) {
    assert.equal(p.__span.text[0], '{');
    assert.equal(p.__span.text[p.__span.text.length - 1], '}');
  }
});

test('零漂移：原样重写后结构化数据完全一致', () => {
  const parsed = store.parse(source);
  const clean = parsed.posts.map((p) => store.clean(p));
  const order = clean.map((p) => p.slug);

  const rewritten = store.write(source, { posts: clean, order });
  const back = store.evaluatePosts(rewritten);

  assert.equal(back.length, parsed.posts.length, '篇数不变');
  for (let i = 0; i < back.length; i++) {
    assert.equal(norm(back[i]), norm(parsed.posts[i]), '第 ' + (i + 1) + ' 篇零漂移');
  }
});

test('零漂移：未改动的文章在源码里逐字节保留（注释与排版不被格式化）', () => {
  const parsed = store.parse(source);
  const clean = parsed.posts.map((p) => store.clean(p));
  /* 改最后一篇的标题，前面七篇的源码区间应当一字不动 */
  clean[clean.length - 1].title = clean[clean.length - 1].title + '（改过）';

  const rewritten = store.write(source, { posts: clean, order: clean.map((p) => p.slug) });
  for (let i = 0; i < clean.length - 1; i++) {
    assert.ok(rewritten.includes(parsed.spans[i].text),
      '第 ' + (i + 2) + ' 篇的原文区间应原样出现');
  }
  /* 文件头部的说明注释必须还在 */
  assert.ok(rewritten.includes('为什么是 .js 而不是 .json'));
});

/* ------------------------------------------------------------ */
test('转义：正文里的引号 / 反斜杠 / 换行 / U+2028 / 控制字符都能活着回来', () => {
  const nasty = [
    '<p>单引号 \' 与双引号 " 与反斜杠 \\ 与反引号 `</p>',
    '<p>换行\n第二行\r\n第三行</p>',
    '<p>行分隔符\u2028与段分隔符\u2029</p>',
    '<p>控制字符:\u0001\u0007\u000b\u000c</p>',
    '<p>尖括号 </script> 与 </p> 与 --&gt;</p>',
    '<p>emoji 🐟 与代理对 \u{1F600}</p>',
    '<pre><code class="lang-js">const re = /[\\]]/;</code></pre>'
  ];
  for (const body of nasty) {
    const literal = store.jsString(body);
    /* 用沙箱求值而不是 eval：和真实写盘走同一条路径 */
    const back = store.evaluatePosts('window.POSTS = [' + literal + '];');
    assert.equal(back[0], body, '转义往返: ' + JSON.stringify(body));
  }
});

test('转义产物里不出现裸的行终止符', () => {
  const literal = store.jsString('a\u2028b\u2029c\nd');
  assert.ok(!/[\u2028\u2029]/.test(literal.replace(/\\u2028|\\u2029/g, '')), 'U+2028/2029 必须被转义');
  assert.ok(!/\n/.test(literal), '换行必须是 \\n');
});

/* ------------------------------------------------------------ */
const NEW_POST = {
  slug: 'unit-test-post',
  title: '单测文章',
  date: '2026-02-14',
  category: '测试',
  tags: ['单测', '存储'],
  excerpt: '由单测写入，不应真的落盘。',
  body: '<p>正文</p>\n<blockquote><p>引用里的 \' 引号</p></blockquote>'
};

test('新增：新文章排在数组最前，其余文章零漂移', () => {
  const parsed = store.parse(source);
  const all = parsed.posts.map((p) => store.clean(p));
  const next = store.insert(source, NEW_POST, all);

  const values = store.evaluatePosts(next);
  assert.equal(values.length, all.length + 1);
  assert.equal(values[0].slug, 'unit-test-post', '新文章应在最前');
  for (let i = 0; i < all.length; i++) {
    assert.equal(norm(values[i + 1]), norm(all[i]));
  }

  const check = store.verify(next, [NEW_POST].concat(all));
  assert.equal(check.ok, true, check.reason);
});

test('更改：改标题与正文，写回后与期望一致且别名机制可用', () => {
  const parsed = store.parse(source);
  const all = parsed.posts.map((p) => store.clean(p));
  const target = all[2];
  const updated = Object.assign({}, target, { title: '改过的标题', body: '<p>改过的正文</p>' });

  const next = store.update(source, target.slug, updated, all);
  const values = store.evaluatePosts(next);
  assert.equal(values.length, all.length);
  assert.equal(values[2].title, '改过的标题');
  assert.equal(values[2].body, '<p>改过的正文</p>');
  /* 没被改的那些必须一字不差 */
  assert.equal(norm(values[0]), norm(all[0]));
  assert.equal(norm(values[values.length - 1]), norm(all[all.length - 1]));
});

test('更改 slug：自动记下旧 slug 作为别名，外链不失效', () => {
  const parsed = store.parse(source);
  const all = parsed.posts.map((p) => store.clean(p));
  const target = all[1];
  const updated = Object.assign({}, target, { slug: 'brand-new-slug' });

  const next = store.update(source, target.slug, updated, all);
  const values = store.evaluatePosts(next);
  assert.equal(values[1].slug, 'brand-new-slug');
  /* 注意：vm 沙箱里的数组与宿主 Array 原型不同，
     deepStrictEqual 会因为"原型不一致"报 same structure but not reference-equal。
     所以这里比 JSON 字符串，不直接用 deepEqual。 */
  assert.equal(JSON.stringify(values[1].aliases), JSON.stringify([target.slug]));
  /* 位置不能变：改名是就地替换，不是"删一篇 + 加一篇" */
  assert.equal(values[0].slug, all[0].slug);
  assert.equal(values[2].slug, all[2].slug);
});

test('删除：篇数减一、顺序不变、数组结构仍合法', () => {
  const parsed = store.parse(source);
  const all = parsed.posts.map((p) => store.clean(p));
  const victim = all[3].slug;

  const next = store.remove(source, victim, all);
  const values = store.evaluatePosts(next);

  assert.equal(values.length, all.length - 1);
  assert.ok(!values.some((p) => p.slug === victim));
  const expect = all.filter((p) => p.slug !== victim);
  for (let i = 0; i < expect.length; i++) {
    assert.equal(values[i].slug, expect[i].slug, '顺序：第 ' + (i + 1) + ' 位');
    assert.equal(norm(values[i]), norm(expect[i]));
  }
});

test('删除最后一篇：前面的逗号被正确收回，数组不出现拖尾逗号问题', () => {
  const parsed = store.parse(source);
  const all = parsed.posts.map((p) => store.clean(p));
  const last = all[all.length - 1].slug;

  const next = store.remove(source, last, all);
  const values = store.evaluatePosts(next);
  assert.equal(values.length, all.length - 1);
  assert.equal(values[values.length - 1].slug, all[all.length - 2].slug);
  /* 末尾应当是 "  }\n];"，不能出现 "  },\n];" */
  assert.match(next, /\}\s*\]\s*;\s*$/);
  assert.ok(!/,\s*\]\s*;\s*$/.test(next), '不能留拖尾逗号');
});

test('删除第一篇：后面的逗号被吃掉，且不留多余空行', () => {
  const parsed = store.parse(source);
  const all = parsed.posts.map((p) => store.clean(p));
  const next = store.remove(source, all[0].slug, all);
  const values = store.evaluatePosts(next);
  assert.equal(values.length, all.length - 1);
  assert.equal(values[0].slug, all[1].slug);
  /* 只看删除发生的那一小段：正文里本来就有空行，扫全文会误报 */
  const at = parsed.spans[0].start;
  const around = next.slice(Math.max(0, at - 40), at + 40);
  assert.ok(!/\n[ \t]*\n[ \t]*\n/.test(around), '删除处不应出现双空行: ' + JSON.stringify(around));
  assert.ok(!/,\s*,/.test(around), '删除处不应出现连续逗号: ' + JSON.stringify(around));
});

test('不允许删掉最后一篇（不允许空的 window.POSTS）', () => {
  const one = 'window.POSTS = [\n  {\n    slug: \'only\',\n    title: \'唯一\',\n    date: \'2026-01-01\',\n    category: \'测试\',\n    tags: [],\n    body: \'<p>x</p>\'\n  }\n];\n';
  assert.throws(() => store.remove(one, 'only', [{ slug: 'only' }]), /最后一篇/);
});

test('删除后源码里绝不出现连续逗号或拖尾逗号（任何位置各删一遍）', () => {
  const parsed = store.parse(source);
  const all = parsed.posts.map((p) => store.clean(p));

  all.forEach((victim, i) => {
    const next = store.remove(source, victim.slug, all);
    const body = next.slice(next.indexOf('window.POSTS = ['));
    assert.ok(!/,\s*,/.test(body), '删第 ' + (i + 1) + ' 篇后出现连续逗号');
    assert.ok(!/,\s*\]/.test(body), '删第 ' + (i + 1) + ' 篇后出现拖尾逗号');
    const values = store.evaluatePosts(next);
    assert.equal(values.length, all.length - 1, '删第 ' + (i + 1) + ' 篇后篇数');
    assert.ok(!values.some((p) => p.slug === victim.slug));
  });
});

/* ------------------------------------------------------------ */
test('verify 会拒绝不一致的结果（防"写坏了还说成功"）', () => {
  const parsed = store.parse(source);
  const all = parsed.posts.map((p) => store.clean(p));
  const next = store.insert(source, NEW_POST, all);

  const bad = store.verify(next, all);            // 少算了一篇
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /文章数不一致/);

  const broken = store.verify('window.POSTS = [ { slug: \'x\', ', all);
  assert.equal(broken.ok, false);
});

test('结构异常时解析必须失败，而不是猜着改', () => {
  assert.throws(() => store.parse('/* 没有数组 */\nvar x = 1;\n'), /找不到/);
  assert.throws(() => store.parse('window.POSTS = [\n  [1,2,3]\n];\n'), /无法安全改写/);
  assert.throws(() => store.parse(''), /空的/);
});

test('沙箱不泄漏宿主能力：posts.js 里拿不到 process', () => {
  const src = 'window.POSTS = [{ slug: "x", title: String(typeof process), date: "2026-01-01", category: "c", tags: [], body: "b" }];';
  const values = store.evaluatePosts(src);
  assert.equal(values[0].title, 'undefined');
});

if (isMain(import.meta.url)) await H.run().then((r) => process.exit(r.fail ? 1 : 0));

export { H };
