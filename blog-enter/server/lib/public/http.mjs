/* ============================================================
   公开服务 HTTP 层 —— 请求体 / 响应 / 状态码 / 路由 / 同源
   ------------------------------------------------------------
   这个文件是**公开面**（公网上任何人都能打）与**管理面**（dev-server.mjs
   的 /_admin/ + /api/）的分界线。它只做四件事：

     1) 把请求体读成 JSON（有硬上限），
     2) 把结果与错误按**统一形状**发出去，
     3) 把 URL + 方法映射到 handler（路由表），
     4) 给 handler 一个"能问当前是谁"的上下文。

   为什么单独一个文件而不是塞进 public-server.mjs：
   公开面要长期暴露在公网上，它的**形状**（状态码、错误码、cookie 属性、
   限流阈值）必须能被逐条审查、逐条验收。把这些集中在一个小文件里，
   "契约"就不是文档里的一段话，而是可被 grep 的代码。

   与 dev-server.mjs 的关系：**没有任何关系**。
   管理面沿用 { error: "人话" } 这种面向"我自己"的宽松形状；
   公开面面向陌生人，必须是 { ok:false, error:{ code, message } }，
   状态码与错误码都要能被前端程序化处理。两套形状混在一起，
   改一处就会悄悄改掉另一处的语义，所以宁可从零写一遍。

   约定：零依赖，只用 node: 内置模块 + lib/util.mjs + lib/security.mjs。
   ============================================================ */
import { HttpError, human } from '../util.mjs';
import * as security from '../security.mjs';

/* ------------------------------------------------------------
   常量
   ------------------------------------------------------------ */

/** 公开接口一律只收 JSON。1MB 对"发一条评论"是天文数字，但留着它可以让
 *  未来的富文本/草稿之类不必再改协议；真正的防线是本文件里的 413。 */
export const MAX_JSON = 1024 * 1024;

/** cookie 名：契约冻结值，改名等于让所有已登录用户掉线 */
export const SESSION_COOKIE = 'p3_uid';

/** 会话有效期 = cookie Max-Age = 30 天。库里的 sessions.expires_at 也用这个数，
 *  两边必须同源，否则会出现"cookie 还在但库里的会话已过期"的怪状态。 */
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

/** 评论长度上限（去首尾空白后的字符数） */
export const COMMENT_MAX = 2000;
export const SLUG_MAX = 200;

/* ------------------------------------------------------------
   错误码
   ------------------------------------------------------------
   code 是给程序看的（前端据此决定"重试 / 提示 / 跳登录"），
   message 是给人看的中文短句。message 里**绝不**能出现
   "用户不存在" 与 "密码错误" 的区别 —— 那是一个账号枚举预言机。
   ------------------------------------------------------------ */
export const ERROR_CODES = {
  BAD_REQUEST: 400,
  INVALID_JSON: 400,
  INVALID_USERNAME: 422,
  INVALID_EMAIL: 422,
  INVALID_PASSWORD: 422,
  INVALID_CONTENT: 422,
  INVALID_SLUG: 422,
  INVALID_PARENT: 422,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  USERNAME_TAKEN: 409,
  EMAIL_TAKEN: 409,
  BODY_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  DB_UNAVAILABLE: 503
};

/** 由 code 反推状态码。自定义 code（插件/后续任务新增）默认 500 ——
 *  猜错的默认值必须是"关"（500）而不是"开"（200）。 */
export const statusForCode = (code) => ERROR_CODES[code] || 500;

/**
 * 业务错误：带上机器可读的 code。
 * 与 util.mjs 的 HttpError 是**父子关系**（继承），这样：
 *   · 上层统一用 `err instanceof HttpError` 判断"这是我方预期的错误"；
 *   · 需要 code 的地方再 downcast 到 ApiError。
 * 只有一种错误类型会让 catch 分支越写越多。
 */
export class ApiError extends HttpError {
  constructor(code, message, status) {
    super(status || statusForCode(code), message);
    this.name = 'ApiError';
    this.code = code;
  }
}

export const fail = (code, message) => new ApiError(code, message);

/* ------------------------------------------------------------
   请求体
   ------------------------------------------------------------ */

/**
 * 读原始请求体，超限时**先把 413 送回客户端**再断连接。
 *
 * 为什么不用 for await (const chunk of req)：
 * 那样拿不到"边读边判超限"的时机，1GB 的请求体得先攒进内存才报错 ——
 * 公开面上这就等于免费的内存耗尽（DoS）。这里累计到上限就停。
 *
 * 【为什么不能在同一 tick 里 req.destroy()】原来这里判超限就立刻 destroy，
 * 结果是**契约承诺的 413 JSON 永远送不到客户端**（实测：curl 看到
 * "Empty reply from server"，前端只能显示网络错误）。fail-closed 没有安全问题，
 * 但一个"承诺了却拿不到"的状态码本身就是缺陷 —— t18 的 413 验收项会直接失败。
 * 现在改成：
 *   1) req.pause()  —— 停止读取，剩下的字节留在内核缓冲区，不再进我们的内存；
 *   2) 抛出带 shutdown=true 标记的 ApiError，由 handleRequest 统一发响应；
 *   3) 发完响应后在 finish 回调里 socket.end()（干净收尾，而不是 RST）。
 * 为什么用 socket.end() 而不是 socket.destroy()：destroy 会发 RST，
 * 客户端可能在我们的响应字节到达之前就丢掉整条连接；end() 是正常 FIN。
 */
export const readBody = (req, limit = MAX_JSON) => new Promise((ok, bail) => {
  const chunks = [];
  let size = 0;
  let settled = false;
  const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) {
      /* 不再读、不再攒，也不在这里动 socket —— 响应由上层发 */
      try { req.pause(); } catch { /* 已经暂停/断开了 */ }
      const err = fail('BODY_TOO_LARGE', '请求体超过上限（' + human(limit) + '）');
      err.shutdown = true;
      finish(bail, err);
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => finish(ok, Buffer.concat(chunks)));
  req.on('error', (err) => finish(bail, new HttpError(400, '读取请求体失败：' + err.message)));
  req.on('aborted', () => finish(bail, new HttpError(400, '客户端提前断开')));
});

/**
 * 响应发完后关掉这条连接（用于 413 这类"必须立刻停手"的情形）。
 * 先 writeHead 再 end；finish 回调里 socket.end()，保证响应字节已经排到
 * 内核缓冲区。整个链路只 end 一次，重复调用无副作用。
 */
export const endConnectionAfterResponse = (res, req) => {
  try {
    if (req && typeof req.destroy === 'function') req.pause();
  } catch { /* 忽略 */ }
  const close = () => {
    try {
      const sock = (req && req.socket) || (res && res.socket);
      if (sock && !sock.destroyed) sock.end();
    } catch { /* 已经断了 */ }
  };
  try { res.once('finish', close); } catch { /* 忽略 */ }
  try { res.once('close', close); } catch { /* 忽略 */ }
};

/**
 * 读 JSON 请求体。
 *
 * · 空体 → {}（方便 curl 不带 -d 调 logout；也让"字段缺失"统一走校验分支，
 *   而不是在解析层先炸出一种只有内行才看得懂的错）
 * · Content-Type 必须是 application/json：否则一个简简单单的
 *   `<form enctype=text/plain>`（不需要预检就能发出去的跨站表单）就能把
 *   任意字节送到这里。强校验 Content-Type 是 CSRF 的一道廉价补充。
 * · 顶层必须是对象：数组/字符串没有"字段"可言，传进来只是后面必然 500。
 */
export const readJson = async (req, { limit = MAX_JSON, requireType = true } = {}) => {
  const raw = req.headers && req.headers['content-type'];
  if (requireType && !(typeof raw === 'string' && raw.toLowerCase().startsWith('application/json'))) {
    throw fail('UNSUPPORTED_MEDIA_TYPE', '请求体必须是 application/json');
  }
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  let parsed;
  try { parsed = JSON.parse(buf.toString('utf8')); }
  catch { throw fail('INVALID_JSON', '请求体不是合法 JSON'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail('BAD_REQUEST', '请求体必须是 JSON 对象');
  }
  return parsed;
};

/* ------------------------------------------------------------
   响应
   ------------------------------------------------------------ */

/** 每个响应都要带的头。 */
export const securityHeaders = (extra) => Object.assign(
  /* 先给 security.baseHeaders（nosniff + no-referrer），保证公开面
     与管理面看到的是同一套底线；再加公开面自己的几条。 */
  security.baseHeaders({
    /* 公开接口的响应永不可缓存：/api/auth/me 是"我"的状态，
       中间缓存（含浏览器 memory cache）把一个用户的 me 给另一个用户，
       就是一次跨账号信息泄露。 */
    'cache-control': 'no-store',
    /* 这些响应永远是 JSON，不可能被当页面渲染；frame-ancestors 之类的
       CSP 对 JSON 意义有限，但 nosniff 已经挡住"把 JSON 当脚本执行"。 */
    'x-frame-options': 'DENY'
  }),
  extra || {}
);

export const sendJson = (res, status, payload, extraHeaders) => {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, securityHeaders(Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  }, extraHeaders || {})));
  res.end(body);
};

export const sendText = (res, status, text, type) => {
  if (res.writableEnded) return;
  res.writeHead(status, securityHeaders({
    'content-type': (type || 'text/plain') + '; charset=utf-8',
    'content-length': Buffer.byteLength(String(text))
  }));
  res.end(String(text));
};

/** 成功：{ ok:true, ... } —— 其它字段由调用方补 */
export const sendOk = (res, fields, extraHeaders) =>
  sendJson(res, 200, Object.assign({ ok: true }, fields || {}), extraHeaders);

/** 失败：{ ok:false, error:{ code, message } } —— 冻结形状，不多不少 */
export const errorBody = (code, message) => ({ ok: false, error: { code, message } });

/**
 * HttpError → 响应。
 *
 * 关键取舍：**只有** HttpError 家族才把自己的 message 发给客户端。
 * 其它异常（TypeError、mysql2 的 ER_DUP_ENTRY、驱动连接失败…）一律
 * 500 + 固定文案，细节只进日志。把驱动的原始报错发到公网上，等于
 * 免费提供"当前 SQL 句子长什么样、表叫什么、库在不在"的情报。
 *
 * `dbUnavailable` 判定：/api/auth/me 在"没有数据库"时必须回 200 + null
 * （见 CONTRACT §1.1），所以这里允许调用方把"库不可用"从 500 提升成
 * 503 + DB_UNAVAILABLE —— 状态码是给运维看的信号，别混进 500 里。
 */
export const sendError = (res, err, { log, dbUnavailable = false } = {}) => {
  let code = 'INTERNAL';
  let status = 500;
  let message = '服务器内部错误';

  if (err instanceof ApiError) {
    code = err.code;
    status = err.status;
    message = err.message;
  } else if (err instanceof HttpError) {
    /* 非 ApiError 的 HttpError（例如 security.mjs 抛的 403）：
       保留状态码，code 按 401/403/404/405 归一，message 沿用。 */
    status = err.status;
    code = ({ 400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 429: 'RATE_LIMITED' })[status] || 'INTERNAL';
    message = status >= 500 ? '服务器内部错误' : err.message;
  } else if (dbUnavailable) {
    code = 'DB_UNAVAILABLE';
    status = 503;
    message = '数据库暂时不可用';
  }

  /* 5xx 一定要留痕：公开面上"500 了但日志里什么都没有"是最难查的一类故障 */
  if (status >= 500 && typeof log === 'function') log('error', status + ' ' + code + ':', String((err && err.stack) || err));
  sendJson(res, status, errorBody(code, message));
};

/* ------------------------------------------------------------
   同源判定
   ------------------------------------------------------------
   【不要另写一套】。判定逻辑（Host 归一、Origin/Referer 精确比对、
   Sec-Fetch-Site）全部复用 lib/security.mjs —— 那是管理面已经在用、
   已经被验签脚本逐条打过的一套。复制一份出来，两份就会各自演化，
   而"两份里更松的那份"就是实际生效的安全边界。
   ------------------------------------------------------------ */

/**
 * @param {object} req
 * @param {{port:number, allowedHosts?:Set<string>|string[], allowedOrigins?:Set<string>|string[]|null,
 *          proxySecret?:string|null}} opts
 */
export const assertPublicOrigin = (req, opts) => {
  const o = opts || {};
  /* 0) 反代共享密钥（只在配置了密钥时校验）。
     为什么它在最前面：反代之后"对端是回环"这条判据恒真（nginx 就在本机），
     于是本机任何进程都能直连 8850 伪造整个 X-Forwarded-For ——
     IP 限流会被逐个假 IP 绕过，审计日志记的也是假 IP。
     密钥把"本机可达"收窄成"只有我们的 nginx 可达"，
     而且它是最便宜的一条检查（一次定长字符串比较），先做最省事。
     未配置密钥时这里不校验，但也因此**不信任 XFF**（见 public-server.mjs 的三态说明）。 */
  if (o.proxySecret) security.assertProxySecret(req, o.proxySecret);

  /* 1) Host 白名单：默认回环集合，加上 --public-host 传入的名字。
     没有这一条，攻击者把自己域名解析到 127.0.0.1 就能以"同源"身份打进来
     （DNS rebinding），而公开面上的写接口（发评论）正是它想要的东西。 */
  security.assertHost(req, o.port, o.allowedHosts);
  /* 2) Origin/Referer/Sec-Fetch-Site：allowedOrigins 为 null 时沿用"只认回环"。
     公开部署时由 --public-origin http://43.108.100.116 给出精确白名单。 */
  security.assertSameOrigin(req, o.port, o.allowedOrigins || null);
  return true;
};

/** 客户端 IP。X-Forwarded-For 只在显式 --trust-proxy 时才信（见 security.clientIp
 *  里对"取最后一段"的解释），默认取 socket 对端。 */
export const clientIp = (req, opts) => security.clientIp(req, opts || {});

/* ------------------------------------------------------------
   cookie
   ------------------------------------------------------------ */

/** 读一个 cookie（不引入 cookie 解析库：格式就是 name=value; name=value） */
export const cookieValue = (req, name) => {
  const raw = (req && req.headers && req.headers.cookie) || '';
  if (!raw || !name) return '';
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    let v = part.slice(i + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { return decodeURIComponent(v); } catch { return v; }
  }
  return '';
};

export const sessionIdFrom = (req) => cookieValue(req, SESSION_COOKIE);

/**
 * 造 Set-Cookie 值。
 *
 * 属性是契约的一部分（CONTRACT §0.5）：
 *   HttpOnly           JS 读不到 → XSS 也偷不走会话
 *   SameSite=Lax       跨站请求不带它（发评论/退出登录这类写操作的第二道闸）；
 *                      用 Lax 而不是 Strict，是因为 Strict 下"从外站点进本站"
 *                      的首次导航不带 cookie，用户会看到"明明登录着却像没登录"
 *   Path=/api          **只发给 API 请求**，静态页与任何同源子应用都拿不到它
 *   Max-Age=2592000    30 天，与 sessions.expires_at 同源
 *   Secure             仅当 --public-origin 是 https 时加。纯 HTTP 下加了它
 *                      浏览器直接不存 → 表现是"登录成功，一刷新就掉线"
 *
 * 【为什么 Path 不是 /】审计 S2：会话 cookie 的作用域是整个 host，
 * 于是每一次 `http://<host>/comments/*` 请求都会把 `Cookie: p3_uid=…`
 * 交给同源上的第三方应用（Waline 那类自托管评论系统）。那种泄露发生在
 * **服务端读头**，HttpOnly 完全无效 —— 对方一旦被攻破或打了日志，攻击者
 * 不需要任何 XSS 就拿到 30 天会话。前端所有请求都只打 `/api/*`
 * （js/auth-ui.js、js/comments.js），静态页不需要这个 cookie，
 * 所以收窄到 /api 是**零功能代价**的收窄。
 */
export const SESSION_COOKIE_PATH = '/api';

export const buildSessionCookie = (sessionId, { secure = false, clear = false, path = SESSION_COOKIE_PATH } = {}) => {
  const parts = [
    SESSION_COOKIE + '=' + (clear ? '' : encodeURIComponent(String(sessionId || ''))),
    'Path=' + (path || SESSION_COOKIE_PATH),
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (secure) parts.push('Secure');
  parts.push('Max-Age=' + (clear ? 0 : SESSION_MAX_AGE_SEC));
  return parts.join('; ');
};

/** 清 cookie：Max-Age=0 + 空值。属性必须与下发时**完全一致**，
 *  否则浏览器可能认为是另一个 cookie，留下一个删不掉的旧会话。 */
export const clearSessionCookie = ({ secure = false, path = SESSION_COOKIE_PATH } = {}) =>
  buildSessionCookie('', { secure, clear: true, path });

/** 是否需要 Secure：看白名单里有没有 https origin（与管理面同一判据） */
export const wantsSecureCookie = (origins) =>
  Array.from(origins || []).some((o) => String(o).toLowerCase().startsWith('https://'));

/* ------------------------------------------------------------
   输入校验
   ------------------------------------------------------------
   全部导出成纯函数（不碰 req/res）：t14 的数据层与测试都要复用同一套
   判据。校验写在两个地方 = 两套规则 = 迟早不一致。
   ------------------------------------------------------------ */

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
/* 邮箱：不做完整 RFC 5322（那是不可维护的正则），只要求
   "非空本地部分 @ 至少一个点分隔的域名 + 无空白"。真正的可达性只能靠发信验证，
   而本轮 SMTP 未配置 —— 所以这里只挡明显不是邮箱的输入。 */
const EMAIL_RE = /^[^\s@]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** 是不是"没给这个字段"（undefined / null / 空串都算） */
const blank = (v) => v === undefined || v === null || v === '';

export const validateUsername = (raw) => {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) throw fail('INVALID_USERNAME', '用户名不能为空');
  if (!USERNAME_RE.test(s)) {
    throw fail('INVALID_USERNAME', '用户名必须是 3-20 位字母、数字或下划线');
  }
  return s;
};

export const validateEmail = (raw) => {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!s) throw fail('INVALID_EMAIL', '邮箱不能为空');
  if (s.length > 190) throw fail('INVALID_EMAIL', '邮箱太长了');
  if (!EMAIL_RE.test(s)) throw fail('INVALID_EMAIL', '邮箱格式不正确');
  return s;
};

/**
 * 口令校验。
 * 刻意**不做**"大小写+数字+符号"这类复杂度规则：它们降低的是熵而不是
 * 攻击者成本，还会诱导用户用 P@ssw0rd1 这种更好猜的口令。
 * 长度下限 8 位，上限 200 —— 上限是为了挡住
 * "拿 1MB 口令让 PBKDF2 替我烧 CPU" 这种免费的 CPU 耗尽。
 */
export const validatePassword = (raw) => {
  if (typeof raw !== 'string' || !raw.length) throw fail('INVALID_PASSWORD', '密码不能为空');
  if (raw.length < 8) throw fail('INVALID_PASSWORD', '密码至少 8 个字符');
  if (raw.length > 200) throw fail('INVALID_PASSWORD', '密码太长了（最多 200 个字符）');
  return raw;
};

/** 登录标识：用户名或邮箱。用"像邮箱就当邮箱"分流，
 *  不做"查两次"（查两次会让数据库调用次数随输入形态变化，且更容易被计时区分）。 */
export const classifyLoginId = (raw) => {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) throw fail('BAD_REQUEST', '请填写用户名或邮箱');
  if (s.length > 190) throw fail('BAD_REQUEST', '用户名或邮箱太长了');
  return s.includes('@') ? { kind: 'email', value: s.toLowerCase() } : { kind: 'username', value: s };
};

export const validateContent = (raw) => {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) throw fail('INVALID_CONTENT', '评论内容不能为空');
  if (s.length > COMMENT_MAX) throw fail('INVALID_CONTENT', '评论最多 ' + COMMENT_MAX + ' 个字符');
  return s;
};

/** slug 来自 URL 查询串或请求体，进入 SQL 之前必须过这一关。
 *  允许中日文与常见标点（站点 slug 可能是拼音或中文），
 *  只排除控制字符与空白 —— 它们不是 slug，只会污染索引与日志。 */
export const validateSlug = (raw) => {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) throw fail('INVALID_SLUG', '缺少 slug');
  if (s.length > SLUG_MAX) throw fail('INVALID_SLUG', 'slug 太长了');
  if (/[\u0000-\u001f\u007f\s]/.test(s)) throw fail('INVALID_SLUG', 'slug 含有非法字符');
  return s;
};

/** parent_id：缺省 null；给了就必须是正整数字符串/数字。
 *  不在这里查"父评论是否属于同一个 slug" —— 那是数据层的事，
 *  但**必须**在数据层查，否则可以把回复挂到别人文章下。
 *
 *  0 / '0' / '' 都当"没有父评论"：<select> 或表单里"不选"通常会传 0 或空串，
 *  把它判成 422 只会让调用方困惑。数据库里也不存在 id=0 的行。 */
export const validateParentId = (raw) => {
  if (blank(raw) || raw === 0 || raw === '0') return null;
  const s = String(raw).trim();
  if (!/^[1-9][0-9]{0,18}$/.test(s)) throw fail('INVALID_PARENT', 'parent_id 必须是正整数');
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw fail('INVALID_PARENT', 'parent_id 超出范围');
  return n;
};

/** 路径里的 :id（DELETE /api/comments/:id） */
export const validateCommentId = (raw) => {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^[1-9][0-9]{0,18}$/.test(s)) throw fail('NOT_FOUND', '没有这条评论');
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw fail('NOT_FOUND', '没有这条评论');
  return n;
};

/* ------------------------------------------------------------
   限流
   ------------------------------------------------------------
   为什么 HTTP 层也要有一道（库里的 auth_throttle 是 t14 的第二道）：
   限流是"在**读数据库之前**就该被挡住"的事。让攻击者用一亿次
   "不存在的用户名"打到 MySQL 上，本身就是一次有效的 DoS ——
   内存里的窗口计数就是这个代价最低的前置闸。

   策略：固定窗口计数（不是令牌桶）。
   理由：固定窗口能在 CONTRACT 里被写成"每 IP 每小时 N 次"这种
   可验收的句子；令牌桶的"速率 + 突发"两个参数没法被一条 curl 命令验证。
   ------------------------------------------------------------ */

export const RATE_LIMITS = {
  /* 登录：每 IP 15 分钟 10 次失败尝试（成功也计数 —— 否则
     "猜对一次就重置窗口"让计数失去意义）。触发后 Retry-After 最多 1 小时。 */
  'auth.login': { windowMs: 15 * 60 * 1000, max: 10, blockMs: 60 * 60 * 1000 },
  /* 注册：每 IP **每小时 5 次**（保持原语义；审计 S4 已裁定本轮不修）。
     我一度改成 3 次/小时并让成功也计数，那会让正常用户填错两次表单就被挡住 ——
     等于拿可用性去换一条业主已经接受的风险。现在恢复原样：成功不计数。 */
  'auth.register': { windowMs: 60 * 60 * 1000, max: 5, blockMs: 60 * 60 * 1000 },
  /* 发评论：每用户 10 分钟 20 条（更细的"每 IP"计数由库里的 auth_throttle 兜） */
  'comment.create': { windowMs: 10 * 60 * 1000, max: 20, blockMs: 5 * 60 * 1000 },
  /* 删评论同样限：否则"删掉的评论"会被反复写库 */
  'comment.delete': { windowMs: 10 * 60 * 1000, max: 20, blockMs: 5 * 60 * 1000 },
  /* 认（读）接口不限流：GET /api/comments 是页面的正常流量，
     给它设一个低阈值等于让正常的翻页/刷新变成 429。 */
  'auth.logout': { windowMs: 60 * 1000, max: 30, blockMs: 60 * 1000 }
};

/** 造一个限流器。进程内存态：服务重启即清零（可接受 —— 重启本身就是攻击者的成本）。 */
export const createRateLimiter = ({ limits = RATE_LIMITS, now = () => Date.now(), maxKeys = 10000 } = {}) => {
  const hits = new Map();   // key → { count, windowStart, blockedUntil }

  /* 定期清理：公网上 IP 数量没有上限，Map 不清就是缓慢内存泄漏。
     上限 maxKeys 是兜底，防止在两次清理之间被打爆。 */
  const prune = (t) => {
    for (const [k, rec] of hits) {
      if (rec.blockedUntil > t) continue;
      if (t - rec.windowStart > 2 * 60 * 60 * 1000) hits.delete(k);
    }
    if (hits.size > maxKeys) {
      /* 超上限时删最旧的，宁可放宽限流也不能把内存吃光 */
      const sorted = Array.from(hits.entries()).sort((a, b) => a[1].windowStart - b[1].windowStart);
      const drop = hits.size - maxKeys;
      for (let i = 0; i < drop; i += 1) hits.delete(sorted[i][0]);
    }
  };

  /**
   * 记一次请求并判断是否放行。
   * @returns {{allowed:boolean, remaining:number, retryAfterSec:number, limit:number}}
   */
  const check = (action, key) => {
    const cfg = limits[action];
    if (!cfg) return { allowed: true, remaining: Infinity, retryAfterSec: 0, limit: 0 };
    const t = now();
    if (hits.size > maxKeys / 2) prune(t);
    const id = action + '|' + (key || 'unknown');
    let rec = hits.get(id);
    if (!rec) { rec = { count: 0, windowStart: t, blockedUntil: 0 }; hits.set(id, rec); }

    if (rec.blockedUntil > t) {
      return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((rec.blockedUntil - t) / 1000), limit: cfg.max };
    }
    if (t - rec.windowStart >= cfg.windowMs) { rec.count = 0; rec.windowStart = t; }

    rec.count += 1;
    if (rec.count > cfg.max) {
      rec.blockedUntil = t + (cfg.blockMs || cfg.windowMs);
      return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((rec.blockedUntil - t) / 1000), limit: cfg.max };
    }
    return { allowed: true, remaining: cfg.max - rec.count, retryAfterSec: 0, limit: cfg.max };
  };

  /** 不管是否放行，超限时抛的统一错误。Retry-After 让客户端能正确地退避。 */
  const assert = (action, key) => {
    const r = check(action, key);
    if (!r.allowed) {
      const err = fail('RATE_LIMITED', '操作过于频繁，请 ' + r.retryAfterSec + ' 秒后再试');
      err.extra = { retryAfterSec: r.retryAfterSec };
      throw err;
    }
    return r;
  };

  return { check, assert, size: () => hits.size, reset: () => hits.clear() };
};

/* ------------------------------------------------------------
   路由表
   ------------------------------------------------------------ */

/** 参数占位符统一写成 :name，避免各家框架的 {name} / <name> 混用。 */
export const compilePath = (pattern) => {
  const names = [];
  const escaped = String(pattern)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .split('/')
    .map((seg) => {
      const m = /^:([A-Za-z_][A-Za-z0-9_]*)$/.exec(seg);
      if (m) { names.push(m[1]); return '([^/]+)'; }
      return seg;
    })
    .join('/');
  return { re: new RegExp('^' + escaped + '$'), names };
};

/**
 * 定义一条路由。
 * handler(ctx) 返回一个对象就是 200 + { ok:true, ... }；
 * 返回 undefined 表示"我自己已经把响应发出去了"（比如要带 Set-Cookie 时）。
 * 这个约定与 dev-server.mjs 的 `if (out !== undefined) sendJson(...)` 一致。
 */
export const route = ({ method, path, handler, auth }) => {
  const { re, names } = compilePath(path);
  return {
    method: String(method).toUpperCase(),
    path,
    handler,
    /** 'required' = 必须已登录；'optional' = 有就用；'none' = 不看会话 */
    auth: auth || 'none',
    re,
    names,
    /* 【静态段优先于参数段】/api/comments/mine 必须赢过 /api/comments/:id，
       否则 GET /api/comments/mine 会被 ":id" 吃掉、拿到一个 404。
       用段数当权重（静态段各占 1 分）而不是"注册顺序"：
       顺序依赖是隐形的、加一条路由就可能悄悄改变另一条的语义。 */
    weight: String(path).split('/').filter((s) => s && !s.startsWith(':')).length
  };
};

/** path 命中但 method 不命中 → 405 而不是 404。
 *  "这个地址存在，但你用错了动词" 是给调用者最有用的那句话。 */
export const findRoute = (routes, method, pathname) => {
  const hits = (routes || []).filter((r) => r.re.test(pathname));
  if (!hits.length) return { route: null, params: null, allowed: [] };
  const allowed = hits.map((r) => r.method);
  const ranked = hits
    .filter((r) => r.method === method)
    .sort((a, b) => (b.weight - a.weight) || (b.path.length - a.path.length));
  if (!ranked.length) return { route: null, params: null, allowed };
  const hit = ranked[0];
  const m = hit.re.exec(pathname);
  const params = {};
  hit.names.forEach((n, i) => { params[n] = m[i + 1]; });
  return { route: hit, params, allowed };
};

/** 路由清单里所有 METHOD 的并集，用于 OPTIONS 应答 */
export const allowedMethods = (routes, pathname) =>
  Array.from(new Set(routes.filter((r) => r.re.test(pathname)).map((r) => r.method)));

/* ------------------------------------------------------------
   统一处理
   ------------------------------------------------------------ */

/**
 * 处理一个请求。调用方（public-server.mjs）只需要：
 *   http.createServer((req,res) => handleRequest(req,res,ctx).catch(...))
 *
 * ctx 里必须给的：
 *   routes, port, allowedHosts, allowedOrigins, rate, services, log
 *
 * 顺序刻意从便宜到贵：
 *   同源判定 → 路由匹配 → 405 → Content-Type → 限流 → 会话 → 业务。
 * 每一步都在"花更多 CPU / 读数据库"之前关掉不可能的请求。
 */
export const handleRequest = async (req, res, ctx) => {
  const c = ctx || {};
  const log = typeof c.log === 'function' ? c.log : () => {};
  const dbDown = c.dbUnavailable || (() => false);

  /* 用假 base URL 解析：只取 pathname 与 searchParams，不做任何网络/权威解析。
     用 'http://localhost' 而不是 req.headers.host —— 后者是攻击者可控的字符串，
     解析它只会把 Host 头引向意料之外的地方。 */
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { sendJson(res, 400, errorBody('BAD_REQUEST', '请求地址不合法')); return; }
  const pathname = url.pathname;

  try {
     /* 0) 来源判定：反代密钥（若配置）+ Host（防 DNS rebinding）
          + Origin/Referer/Sec-Fetch-Site（防 CSRF）。
          放在最前面：不合来源的请求连路由表都不该被探测。 */
    assertPublicOrigin(req, {
      port: c.port,
      allowedHosts: c.allowedHosts,
      allowedOrigins: c.allowedOrigins,
      proxySecret: c.proxySecret
    });

    const { route: matched, params, allowed } = findRoute(c.routes || [], req.method, pathname);

    /* OPTIONS 预检：同源前端用不到，但让 curl / 其它工具能问出方法集合。
       注意**不**发 Access-Control-Allow-Origin —— 公开 API 不支持跨源调用。 */
    if (req.method === 'OPTIONS') {
      res.writeHead(204, securityHeaders({ allow: allowed.length ? allowed.join(', ') : 'GET, POST, DELETE, OPTIONS' }));
      res.end();
      return;
    }

    if (!matched) {
      if (allowed.length) {
        /* 405 必须带 Allow：调用者据此知道该用哪个动词（RFC 7231 要求，
           也是"这个地址存在但你用错了"这句话的可执行版本）。 */
        throw Object.assign(fail('METHOD_NOT_ALLOWED', '这个地址不支持 ' + req.method), {
          extraHeaders: { allow: allowed.join(', ') }
        });
      }
      throw fail('NOT_FOUND', '没有这个接口');
    }

    /* 1) 读会话：只查一次，后面 handler 直接看 ctx.user。
       读会话失败（库连不上）不能变成 500 —— 未登录状态是**正常**状态，
       /api/auth/me 正是靠这个在无库时返回 200 + null。 */
    let session = null;
    if (matched.auth !== 'none') {
      const sid = sessionIdFrom(req);
      if (sid && typeof c.services?.resolveSession === 'function') {
        try { session = await c.services.resolveSession(sid); }
        catch (err) {
          if (!dbDown(err)) throw err;
          log('warn', '会话查询失败（库不可用），按未登录处理');
          session = null;
        }
      }
    }

    /* 2) 授权：required 而没会话 → 401。这里**只**看会话，
       "这条评论是不是我发的" 由数据层判定（绝不能只在前端隐藏按钮）。 */
    if (matched.auth === 'required' && !session) {
      throw fail('UNAUTHENTICATED', '请先登录');
    }

    /* 3) 请求体：只有 POST/PUT/PATCH 需要 JSON */
    let payload = {};
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      payload = await readJson(req, { limit: c.maxJson || MAX_JSON });
    }

    const hctx = {
      req, res,
      method: req.method,
      pathname,
      url,
      query: url.searchParams,
      params: params || {},
      body: payload,
      ip: clientIp(req, { trustProxy: c.trustProxy === true, fallback: 'local' }),
      ua: String(req.headers['user-agent'] || ''),
      session,
      user: session ? session.user : null,
      cookieSecure: c.cookieSecure === true,
      rate: c.rate,
      /* 代理信任是否**生效**（有密钥且校验通过）。handler 用它决定
         "能不能相信 XFF" —— 不安全地用一个可伪造的头，比不用它糟糕得多。 */
      trustProxy: c.trustProxy === true,
      services: c.services || {},
      log,
      dbUnavailable: dbDown,
      /* 库健康状态（'up' | 'down'），由服务端注入：数据层自己知道怎么做
         带缓存的探测，HTTP 层不该替它决定"多久探一次"。
         未注入时返回 'down'（宁可保守，也不要假装库是好的）。 */
      dbHealth: typeof c.dbHealth === 'function' ? c.dbHealth : async () => 'down',
      /* 代理密钥校验：--trust-proxy 只在密钥生效时才允许信 XFF（见 public-server.mjs）。
         未配置密钥时为 null → 不校验密钥，但也不信 XFF。 */
      proxySecret: c.proxySecret || null,
      /* handler 用来下发/清除 cookie */
      setSessionCookie: (sid, extra) => {
        res.setHeader('set-cookie', buildSessionCookie(sid, Object.assign({ secure: c.cookieSecure === true }, extra || {})));
      },
      clearSessionCookie: () => {
        res.setHeader('set-cookie', clearSessionCookie({ secure: c.cookieSecure === true }));
      }
    };

    const out = await matched.handler(hctx);
    if (out !== undefined) sendOk(res, out);
    return;
  } catch (err) {
    if (res.writableEnded) return;
    /* 有些错误码会附带响应头：429 要 Retry-After，405 要 Allow。
       统一从 err.extraHeaders 取，避免每个分支各写一套发送逻辑。 */
    const extra = Object.assign({}, err && err.extraHeaders);
    if (err && err.code === 'RATE_LIMITED' && err.extra && err.extra.retryAfterSec) {
      /* 429 必须带 Retry-After：否则客户端只能瞎猜退避时间，
         表现就是"一直重试一直被拒"的雪崩。 */
      extra['retry-after'] = String(err.extra.retryAfterSec);
    }
    /* 413 这类"必须立刻停手"的错误：先把响应发出去，再关连接。
       （见 readBody 的注释：不能在同一 tick 里 destroy，否则客户端
       看不到结构化错误。）connection: close 让对端知道不要再复用这条连接。 */
    if (err && err.shutdown) {
      extra.connection = 'close';
      const code = err.code || 'INTERNAL';
      log('warn', statusForCode(code) + ' ' + code + ' ' + pathname + '（响应后关闭连接）');
      endConnectionAfterResponse(res, req);
      sendJson(res, statusForCode(code), errorBody(code, err.message), extra);
      return;
    }
    const hasExtra = Object.keys(extra).length > 0;
    if (hasExtra) {
      const code = err.code || 'INTERNAL';
      const status = err.status || statusForCode(code);
      if (status >= 500) log('error', status + ' ' + code + ':', err); else log('warn', status + ' ' + code + ' ' + pathname);
      sendJson(res, status, errorBody(code, err.message), extra);
      return;
    }
    sendError(res, err, { log, dbUnavailable: dbDown(err) });
  }
};

/* ------------------------------------------------------------
   小工具
   ------------------------------------------------------------ */

/** 把任意注入值收敛成"安全的对象形状"里的字段，避免把 undefined 发成 JSON null 之外的怪东西。
 *  （JSON.stringify 会丢掉 undefined 字段，这在契约里等于"字段缺失"，
 *   而契约要求 me 永远有 user 字段 —— 所以这里显式给 null。） */
export const orNull = (v) => (v === undefined ? null : v);

/** 对外暴露的评论形状。**白名单**构造：绝不 spread 数据行。
 *  这是"绝不返回 password_hash / email"这条契约最可靠的实现方式 ——
 *  不是"记得删掉敏感列"，而是"只挑出要给的列"。 */
export const publicComment = (row) => ({
  id: Number(row.id),
  parent_id: row.parent_id == null ? null : Number(row.parent_id),
  content: String(row.content == null ? '' : row.content),
  created_at: row.created_at instanceof Date ? row.created_at.toISOString() : orNull(row.created_at),
  author: {
    id: row.user_id == null ? null : Number(row.user_id),
    username: String(row.username == null ? '' : row.username),
    avatar: orNull(row.avatar)
  }
});

/** 我的评论：在公开评论形状之上多一个 slug（要能跳回那篇文章）。
 *  仍然白名单构造 —— 多给的只有 slug。 */
export const myComment = (row) => Object.assign(publicComment(row), {
  slug: String(row.slug == null ? '' : row.slug)
});

/** 对外暴露的用户形状。同样白名单 —— email 只给本人，绝不给别人。 */
export const publicUser = (row) => ({
  id: Number(row.id),
  username: String(row.username == null ? '' : row.username),
  avatar: orNull(row.avatar),
  role: row.role === 'admin' ? 'admin' : 'user',
  created_at: row.created_at instanceof Date ? row.created_at.toISOString() : orNull(row.created_at)
});

/** 本人的 me：多一个 email（自己的邮箱给自己看没问题） */
export const selfUser = (row) => Object.assign(publicUser(row), { email: orNull(row.email) });

export { HttpError };
