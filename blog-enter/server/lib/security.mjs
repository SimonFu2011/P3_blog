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
import { timingSafeEqual } from 'node:crypto';

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

/** 把 "http://43.108.100.116" / "https://simonfu.xin" 归一成 origin 形式 */
const normalizeOrigin = (raw) => {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.protocol + '//' + u.host.toLowerCase();
  } catch { return ''; }
};

/** 对端是否回环。req.socket.remoteAddress 也可能是 undefined（已断开）。 */
export const isLoopbackPeer = (req) => {
  const addr = req.socket && (req.socket.remoteAddress || req.socket.localAddress);
  if (!addr) return false;
  if (LOOPBACK.has(addr)) return true;
  return addr.startsWith('127.') || addr === '::1';
};

/**
 * 客户端 IP。
 * 直连时就是 remoteAddress；反代之后那一列恒为 127.0.0.1，退避计数与日志
 * 会全部失效，所以要能从 X-Forwarded-For 里取。
 *
 * 取**最后一段**：nginx 用 $proxy_add_x_forwarded_for 在**已有** XFF 后面
 * 追加 $remote_addr，最后一段才是 nginx 亲自看到的对端。取第一段等于相信
 * 攻击者自己伪造的值。
 *
 * trustProxy 必须是显式开关：只有确认请求一定经过我们那台 nginx 时才开。
 * 更硬的兜底是 proxySecret（见下）—— 密钥不对就连门都进不来，
 * 所以本机其他进程也没法通过伪造 XFF 来绕过计数。
 */
export const clientIp = (req, { trustProxy = false, fallback = 'local' } = {}) => {
  const direct = (req.socket && req.socket.remoteAddress) || fallback;
  if (!trustProxy) return direct;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return direct;
};

/**
 * 反代共享密钥。
 * 反代之后"对端必须是回环"这条判据恒真，于是本机任何进程（含被入侵的
 * 低权限服务）都能直连 8848 拿写权限。nginx 注入一个只有它知道的头，
 * 应用侧比对，不匹配就 403 —— 把"本机可达"收窄成"只有我们的 nginx 可达"。
 */
const safeEqualStr = (a, b) => {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
};

export const assertProxySecret = (req, expect) => {
  if (!expect) return true;
  const got = req.headers['x-admin-proxy-secret'];
  if (typeof got !== 'string' || !got.length) throw new HttpError(403, 'forbidden');
  if (!safeEqualStr(got.trim(), String(expect).trim())) throw new HttpError(403, 'forbidden');
  return true;
};

/**
 * Host 头白名单。
 * 本地模式下 allowedHosts 就是回环集合（行为与从前完全一致）。
 * 反代之后浏览器发来的是真实站点名（IP 或域名），必须显式列进来。
 *
 * 端口校验放宽成"只有**白名单里带端口**且不符时才拒"：
 *   Host: 127.0.0.1:8848   本地直连 → 必须等于实际监听端口（防 DNS rebinding 换端口）
 *   Host: 43.108.100.116   反代场景 → 无端口，放行
 *   Host: 43.108.100.116:80 / :443   反代可能带上 → 放行
 * 这样既不放松本地那条硬判据，也不把反代挡在门外。
 */
export const assertHost = (req, port, allowedHosts = LOOPBACK) => {
  const raw = req.headers.host;
  if (!raw) throw new HttpError(403, 'missing Host header');
  const name = normalizeHost(raw);
  const allowed = allowedHosts instanceof Set ? allowedHosts : new Set(allowedHosts || LOOPBACK);
  if (!allowed.has(name)) throw new HttpError(403, 'host not allowed');

  const m = String(raw).match(/:(\d+)$/);
  if (m) {
    const got = Number(m[1]);
    /* 回环名：必须等于本次实际监听端口（本地直连的既有判据，不放松） */
    if (LOOPBACK.has(name) && got !== Number(port)) {
      throw new HttpError(403, 'host port mismatch');
    }
    /* 非回环（反代带来的真实站点名）：只接受常规 web 端口 */
    if (!LOOPBACK.has(name) && got !== 80 && got !== 443 && got !== Number(port)) {
      throw new HttpError(403, 'host port mismatch');
    }
  }
  return name;
};

/** Origin / Referer 与 Sec-Fetch-Site 判定 */
export const assertSameOrigin = (req, port, allowedOrigins = null) => {
  /* allowedOrigins 给了就只认它（反代场景）；否则沿用"只认回环"（本地场景）。
     用归一化后的 origin 精确比对，不做通配 —— 通配等于把这道闸拆了。 */
  const allowed = allowedOrigins == null
    ? null
    : new Set(Array.from(allowedOrigins).map(normalizeOrigin).filter(Boolean));

  const hostAllowed = (h) => {
    if (allowed == null) return LOOPBACK.has(h);
    return false;
  };

  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    if (allowed != null) {
      const norm = normalizeOrigin(origin);
      if (!norm || !allowed.has(norm)) throw new HttpError(403, 'cross-origin request rejected');
    } else {
      let host = '';
      try { host = normalizeHost(new URL(origin).host); } catch { throw new HttpError(403, 'bad Origin'); }
      if (!hostAllowed(host)) throw new HttpError(403, 'cross-origin request rejected');
    }
  } else if (origin === 'null' && allowed != null) {
    /* 远端模式下 "Origin: null" 一律拒：沙箱 iframe / data: URL 会发这个值，
       它绕过不了密钥那一道，但没必要给它开口子。 */
    throw new HttpError(403, 'cross-origin request rejected');
  }

  const referer = req.headers.referer;
  if (!origin && referer) {
    if (allowed != null) {
      let norm = '';
      try {
        const u = new URL(referer);
        norm = u.protocol + '//' + u.host.toLowerCase();
      } catch { throw new HttpError(403, 'bad Referer'); }
      if (!allowed.has(norm)) throw new HttpError(403, 'cross-site referer rejected');
    } else {
      let host = '';
      try { host = normalizeHost(new URL(referer).host); } catch { throw new HttpError(403, 'bad Referer'); }
      if (!hostAllowed(host)) throw new HttpError(403, 'cross-site referer rejected');
    }
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
 * 顺序刻意从便宜到贵：反代密钥 → 对端 → Host → 来源。
 */
export const guard = (req, ctx) => {
  assertProxySecret(req, ctx && ctx.proxySecret);
  if (!isLoopbackPeer(req)) throw new HttpError(403, 'non-loopback peer rejected');
  assertHost(req, ctx && ctx.port, ctx && ctx.allowedHosts);
  assertSameOrigin(req, ctx && ctx.port, ctx && ctx.allowedOrigins);
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
