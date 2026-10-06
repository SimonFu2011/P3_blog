/* ============================================================
   本地冒烟用：静态站 + 契约形状的假 API（只在开发机上跑，不进仓库）
   ------------------------------------------------------------
   用途：t12（前端）在没有真后端/真库、也还没部署的情况下，把
   "登录入口 + 评论组件"整条渲染路径跑一遍：
     · 真浏览器脚本：server/tests/verify-comments-live.mjs（本机被沙箱挡住时改用下面的 DOM 冒烟）
     · DOM 冒烟：.preview/smoke-comments.mjs（linkedom + 真 fetch）

   响应形状严格照 blog-enter/server/CONTRACT-public-api.md，
   但**没有真实认证与存储**：登录态由一个内存开关控制，供冒烟脚本切换。

   跑法：
     node D:\DS\.preview\stub-p3-api.mjs 8877
     POST /api/__stub/mode  {"user": {...}|null, "post": "normal|401|429"}

   故意塞进去的样本：一条带 HTML/script 的评论、一条外站头像、一条同源头像、
   一条回复、一个含尖括号的超长用户名 —— 用来确认"用户输入一律当纯文本渲染"。
   ============================================================ */
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve('D:\\DS\\blog-enter');
const PORT = Number(process.argv[2] || 8877);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

const XSS = '<img src=x onerror="window.__cmXss = true"><script>window.__cmXss = true</script>';

let seq = 100;
const mkComments = () => ([
  {
    id: 1, parent_id: null, content: '写得清楚，第二段的推导我照着走了一遍。',
    created_at: '2026-02-14T09:31:07.000Z',
    author: { id: 7, username: 'simon', avatar: null }
  },
  {
    id: 2, parent_id: 1, content: '+1，另外想问下第三张图的坐标是怎么定的。',
    created_at: '2026-02-14T09:32:00.000Z',
    author: { id: 9, username: 'guest', avatar: null }
  },
  {
    id: 3, parent_id: null, content: '试试注入：' + XSS + ' 还有换行\n第二行。',
    created_at: '2026-02-14T09:33:00.000Z',
    author: { id: 11, username: '<b>不</b>是标签_这是一段很长的用户名用来试省略号', avatar: 'https://evil.example.com/a.png' }
  },
  {
    id: 4, parent_id: null, content: '同源头像这条应该真的加载图片。',
    created_at: '2026-02-14T09:34:00.000Z',
    author: { id: 12, username: 'ava', avatar: '/img/avatar.svg' }
  }
]);

let list = mkComments();
let mode = { user: null, post: 'normal' };

/* 访问统计（契约 §1.8）：底数刻意用非整数个位，断言里一眼就能看出
   "显示的是后端数字"还是"退回了本机 localStorage"（后者是 1/1/1 那种小数字） */
let hits = 0;
const statsSnapshot = () => ({
  total: 1234 + hits,
  today: 56 + hits,
  visitors: 789,
  day: '2026-10-06'
});

const json = (res, status, body, extra) => {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': buf.length
  }, extra || {}));
  res.end(buf);
};

const fail = (res, status, code, message, extra) =>
  json(res, status, { ok: false, error: { code, message } }, extra);

const readBody = (req) => new Promise((res) => {
  let s = '';
  req.on('data', (c) => { s += c; });
  req.on('end', () => { try { res(s ? JSON.parse(s) : null); } catch { res(null); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const path = url.pathname;

  /* 契约 §0.3：写接口（POST / DELETE）必须带 Content-Type: application/json，
     否则 415。这里照实实现，好让冒烟脚本真的验到前端有没有漏这个头
     （无 body 的 logout / DELETE 最容易漏）。 */
  if (/^(POST|DELETE)$/.test(req.method) && path.startsWith('/api/') && !path.startsWith('/api/__stub')) {
    const ct = String(req.headers['content-type'] || '');
    if (!/^application\/json/i.test(ct)) {
      return fail(res, 415, 'UNSUPPORTED_MEDIA_TYPE', '请求体必须是 application/json');
    }
  }

  /* ---- 冒烟脚本专用的开关（真后端没有这个端点） ---- */
  if (path === '/api/__stub/mode' && req.method === 'POST') {
    const body = await readBody(req);
    if (body && 'user' in body) mode.user = body.user;
    if (body && body.post) mode.post = body.post;
    if (body && body.reset) { list = mkComments(); seq = 100; }
    return json(res, 200, { ok: true, mode });
  }

  if (path === '/api/auth/me') {
    return json(res, 200, { ok: true, user: mode.user, db: 'up', session_max_age_days: 30 });
  }
  if (path === '/api/auth/login' || path === '/api/auth/register') {
    return fail(res, 401, 'INVALID_CREDENTIALS', '用户名或密码不正确');
  }
  if (path === '/api/auth/logout') {
    mode.user = null;
    return json(res, 200, { ok: true, destroyed: true });
  }
  if (path === '/api/comments/mine') {
    if (!mode.user) return fail(res, 401, 'UNAUTHENTICATED', '请先登录');
    return json(res, 200, { ok: true, comments: list.filter((c) => c.author.id === mode.user.id).map((c) => Object.assign({ slug: 'water-entry' }, c)) });
  }
  if (path === '/api/comments' && req.method === 'GET') {
    const slug = url.searchParams.get('slug');
    if (!slug) return fail(res, 422, 'INVALID_SLUG', '缺少 slug');
    return json(res, 200, { ok: true, comments: list });
  }
  if (path === '/api/comments' && req.method === 'POST') {
    const body = await readBody(req);
    if (!mode.user) return fail(res, 401, 'UNAUTHENTICATED', '请先登录');
    if (mode.post === '429') {
      return fail(res, 429, 'RATE_LIMITED', '操作过于频繁，请 3 秒后再试', { 'Retry-After': '3' });
    }
    if (!body || !body.content) return fail(res, 422, 'INVALID_CONTENT', '评论内容不能为空');
    const created = {
      id: ++seq,
      parent_id: body.parent_id ? Number(body.parent_id) : null,
      content: String(body.content),
      created_at: new Date().toISOString(),
      author: { id: mode.user.id, username: mode.user.username, avatar: null }
    };
    list = list.concat([created]);
    return json(res, 201, { ok: true, comment: created });
  }
  const del = /^\/api\/comments\/(\d+)$/.exec(path);
  if (del && req.method === 'DELETE') {
    if (!mode.user) return fail(res, 401, 'UNAUTHENTICATED', '请先登录');
    const id = Number(del[1]);
    const hit = list.find((c) => c.id === id);
    if (!hit) return fail(res, 404, 'NOT_FOUND', '没有这条评论');
    if (hit.author.id !== mode.user.id && mode.user.role !== 'admin') {
      return fail(res, 403, 'FORBIDDEN', '只能删除自己的评论');
    }
    list = list.filter((c) => c.id !== id);
    return json(res, 200, { ok: true, deleted: id });
  }
  /* ---- 访问统计（契约 §1.8 / §1.9）----
     桩里的数字是可预期的：每次 hit 自增，方便断言"前端拿到的是后端数字、
     而不是退回本机 localStorage"。 */
  if (path === '/api/stats' && req.method === 'GET') {
    return json(res, 200, { ok: true, stats: statsSnapshot() });
  }
  if (path === '/api/stats/hit' && req.method === 'POST') {
    await readBody(req);
    hits += 1;
    return json(res, 200, { ok: true, stats: statsSnapshot() });
  }

  if (path.startsWith('/api/')) return fail(res, 404, 'NOT_FOUND', '没有这个接口');

  let rel = decodeURIComponent(path);
  if (rel.endsWith('/')) rel += 'index.html';
  const target = normalize(join(ROOT, rel));
  if (!target.startsWith(ROOT + sep)) { res.writeHead(403).end('no'); return; }
  try {
    const st = await stat(target);
    if (!st.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store'
    });
    createReadStream(target).pipe(res);
  } catch (err) {
    /* 静态路径不存在：照 nginx 的做法回 404.html，地址栏不变 */
    const notFound = join(ROOT, '404.html');
    const st = await stat(notFound);
    res.writeHead(404, { 'Content-Type': TYPES['.html'], 'Content-Length': st.size });
    createReadStream(notFound).pipe(res);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('stub 站点 + API: http://127.0.0.1:' + PORT + '  (root=' + ROOT + ')');
});
