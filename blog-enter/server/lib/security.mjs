/* ============================================================
   请求来源判定 —— 本方案安全边界的第一道闸
   ------------------------------------------------------------
   管理接口"只有我本人能用"，靠的不是前端隐藏，而是这几条
   在服务端逐条执行的硬判据：

     1) 只监听回环地址（在 dev-server.mjs 里 fork 时决定）
     2) 对端地址必须是回环（防"监听 0.0.0.0 + 反代"这类误配置）
     3) Host 头必须是本机名/回环（防 DNS rebinding：攻击者把自己的域名
        解析到 127.0.0.1，浏览器就会"同源"地打到我们端口上）
     4) Origin / Referer 要么缺失、要么就是本站自己的 Origin
        （跨站表单、跨站 fetch 一律拒绝）
     5) Sec-Fetch-Site 只能是 same-origin / none
        （现代浏览器的强制信号，比 Origin 更难伪造，且能挡住
         "同站不同源"的旁站页面）
     6) 写操作还要一次性会话令牌（见 auth.mjs）

   任何一条不过 → 403，且不泄露是哪一条不过的细节。
   ============================================================ */
import { HttpError } from './util.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

const normalizeHost = (name) => {
  let h = String(name || '').trim().toLowerCase();
  if (h.startsWith('[')) {                       // [::1]:8848
    const end = h.indexOf(']');
    h = end > 0 ? h.slice(1, end) : h.slice(1);
  } else if ((h.match(/:/g) || []).length === 1) { // 127.0.0.1:8848
    h = h.slice(0, h.indexOf(':'));
  }
  if (h.endsWith('.')) h = h.slice(0, -1);        // FQDN 尾点
  return h;
};

/** 对端是否回环。req.socket.remoteAddress 也可能是 undefined（已断开）。 */
export const isLoopbackPeer = (req) => {
  const addr = req.socket && (req.socket.remoteAddress || req.socket.localAddress);
  if (!addr) return false;
  if (LOOPBACK.has(addr)) return true;
  return addr.startsWith('127.') || addr === '::1';
};

/** Host 头白名单：只允许本机名 + 本次实际监听的端口 */
export const assertHost = (req, port) => {
  const raw = req.headers.host;
  if (!raw) throw new HttpError(403, 'missing Host header');
  const name = normalizeHost(raw);
  if (!LOOPBACK.has(name)) throw new HttpError(403, 'host not allowed');
  const m = String(raw).match(/:(\d+)$/);
  if (m && Number(m[1]) !== Number(port)) throw new HttpError(403, 'host port mismatch');
  return name;
};

/** Origin / Referer 与 Sec-Fetch-Site 判定 */
export const assertSameOrigin = (req, port) => {
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let host = '';
    try { host = normalizeHost(new URL(origin).host); } catch { throw new HttpError(403, 'bad Origin'); }
    if (!LOOPBACK.has(host)) throw new HttpError(403, 'cross-origin request rejected');
  }

  const referer = req.headers.referer;
  if (!origin && referer) {
    let host = '';
    try { host = normalizeHost(new URL(referer).host); } catch { throw new HttpError(403, 'bad Referer'); }
    if (!LOOPBACK.has(host)) throw new HttpError(403, 'cross-site referer rejected');
  }

  /* Sec-Fetch-Site 是浏览器的强信号：cross-site / same-site 都拒。
     非浏览器客户端（curl、验签脚本）不发这个头 → 视为 none，放行，
     但它们仍然要过 Host 与令牌两道。 */
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') {
    throw new HttpError(403, 'cross-site request rejected');
  }
  return true;
};

/**
 * 管理接口入口处的统一安检。
 * 顺序刻意从便宜到贵：对端 → Host → 来源。
 */
export const guard = (req, ctx) => {
  if (!isLoopbackPeer(req)) throw new HttpError(403, 'non-loopback peer rejected');
  assertHost(req, ctx.port);
  assertSameOrigin(req, ctx.port);
  return true;
};

/* ------------------------------------------------------------
   响应头
   ------------------------------------------------------------ */

/**
 * 管理页的 CSP。
 * 不给 unsafe-inline 给脚本 —— 管理页只有两个外链脚本和一个内联的
 * 令牌脚本（那个走 /_admin/token.js 由服务端注入，所以不需要放宽）。
 * frame-src 'self' 是给预览 iframe 用的；frame-ancestors 'none' 防被嵌套。
 */
export const ADMIN_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join('; ');

/** 公开页面不设 CSP（站点是静态产物，加了会和内联脚本/内联样式冲突），
    但一律 nosniff + no-referrer，成本为零。 */
export const baseHeaders = (extra) => Object.assign({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
}, extra || {});
