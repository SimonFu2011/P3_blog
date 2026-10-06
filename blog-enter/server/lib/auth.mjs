/* ============================================================
   认证
   ------------------------------------------------------------
   先说清楚这一层**不是**什么：它不是"把静态站变成有登录的后台"。
   真正的安全边界是「服务只监听回环 + 对端必须是回环 + Host/Origin/
   Sec-Fetch-Site 三重同源判定」（见 security.mjs）。这一层负责的是
   另一件事：

     · **防误触与防陌生页面的 CSRF**：任何写操作都要一次性会话令牌，
       令牌只发给本站自己的管理页。别人页面上一个 <form action=
       "http://127.0.0.1:8848/api/posts"> 打过来会被挡掉。
     · **本机多人场景下的第二把锁**（可选口令）：家里/公司机器上
       别人也能开浏览器，口令能挡住"顺手点两下"。

   因此：
     · 令牌每次进程启动都重新生成（session.json 里的 token 会被覆盖），
       进程一停，旧令牌立刻作废 —— 不留长期有效的凭据。
     · 口令用 PBKDF2-SHA256（210k 轮 + 随机盐）存哈希，
       并配失败计数与指数退避，不做"明文写进配置文件"这种事。
   ============================================================ */
import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomToken, safeEqual, HttpError, writeFileAtomic } from './util.mjs';

const PBKDF2_ITER = 210_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_HASH = 'sha256';

const SESSION_FILE = 'session.json';
const PASS_FILE = 'passphrase.json';

const derive = (pass, salt, iter) => new Promise((resolve, reject) => {
  pbkdf2(pass, salt, iter, PBKDF2_KEYLEN, PBKDF2_HASH, (err, key) => (err ? reject(err) : resolve(key)));
});

/* ------------------------------------------------------------
   会话令牌
   ------------------------------------------------------------ */

export const loadSession = async (runtimeDir) => {
  const file = join(runtimeDir, SESSION_FILE);
  /* 每次启动新生成：旧令牌不管有没有落盘都不再有效 */
  const token = randomToken(32);
  const data = { token, startedAt: new Date().toISOString(), pid: process.pid };
  await writeFileAtomic(file, JSON.stringify(data, null, 2));
  try { await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 }); } catch { /* 权限收紧失败不影响功能 */ }
  return data;
};

export const readSession = async (runtimeDir) => {
  try { return JSON.parse(await readFile(join(runtimeDir, SESSION_FILE), 'utf8')); }
  catch { return null; }
};

/* ------------------------------------------------------------
   口令
   ------------------------------------------------------------ */

export const hasPassphrase = async (runtimeDir) => {
  try { await readFile(join(runtimeDir, PASS_FILE), 'utf8'); return true; }
  catch { return false; }
};

export const setPassphrase = async (runtimeDir, pass) => {
  const text = String(pass || '');
  if (text.length < 8) throw new HttpError(422, '口令至少 8 个字符');
  if (text.length > 200) throw new HttpError(422, '口令太长了');
  const salt = randomBytes(16);
  const key = await derive(text, salt, PBKDF2_ITER);
  const record = {
    v: 1,
    algo: 'pbkdf2-' + PBKDF2_HASH,
    iter: PBKDF2_ITER,
    salt: salt.toString('base64'),
    key: key.toString('base64'),
    setAt: new Date().toISOString()
  };
  await writeFileAtomic(join(runtimeDir, PASS_FILE), JSON.stringify(record, null, 2));
  return true;
};

export const clearPassphrase = async (runtimeDir) => {
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(join(runtimeDir, PASS_FILE));
    return true;
  } catch { return false; }
};

export const checkPassphrase = async (runtimeDir, pass) => {
  let record;
  try { record = JSON.parse(await readFile(join(runtimeDir, PASS_FILE), 'utf8')); }
  catch { return { ok: false, reason: 'no-passphrase' }; }

  const salt = Buffer.from(record.salt, 'base64');
  const expect = Buffer.from(record.key, 'base64');
  const got = await derive(String(pass || ''), salt, record.iter || PBKDF2_ITER);
  const ok = got.length === expect.length && timingSafeEqual(got, expect);
  return { ok };
};

/* ------------------------------------------------------------
   失败退避
   ------------------------------------------------------------ */

const attempts = new Map();   // ip → { fails, gateUntil }

/**
 * 退避闸门。
 * 语义刻意定成"**冷却窗口**"而不是"锁死"：
 * 触发了退避之后，窗口内一切登录尝试都直接 429（连正确口令也一起挡，
 * 否则攻击者只要"猜对一次"就能立刻重置计数 —— 那计数就白设了）；
 * 窗口一到自动恢复，不存在"永久锁死自己"的状态。
 * 以本机单一用户为主的使用场景里，最坏代价是等 1~30 秒。
 */
export const guardThrottle = (ip) => {
  const rec = attempts.get(ip);
  if (!rec) return;
  const waitMs = rec.gateUntil - Date.now();
  if (waitMs > 0) {
    throw new HttpError(429, '尝试过于频繁，请 ' + Math.ceil(waitMs / 1000) + ' 秒后再试');
  }
};

export const noteFailure = (ip) => {
  const rec = attempts.get(ip) || { fails: 0, gateUntil: 0 };
  rec.fails += 1;
  /* 1s、2s、4s…最多 30s */
  const backoff = Math.min(30_000, 1000 * Math.pow(2, Math.min(rec.fails - 1, 5)));
  rec.gateUntil = Date.now() + backoff;
  attempts.set(ip, rec);
  return rec;
};

export const noteSuccess = (ip) => { attempts.delete(ip); };

export const throttleState = (ip) => {
  const rec = attempts.get(ip);
  if (!rec) return { fails: 0, waitMs: 0 };
  return { fails: rec.fails, waitMs: Math.max(0, rec.gateUntil - Date.now()) };
};

/** 仅供测试：清掉退避状态 */
export const resetThrottle = () => { attempts.clear(); };

/* ------------------------------------------------------------
   每客户端会话（远端模式）
   ------------------------------------------------------------
   本地模式下"已解锁"是**进程全局**的一个布尔值，这在单人本机场景下没问
   题；一旦服务暴露到公网，它就变成致命缺陷：

     你在公网上登录一次 → 整个进程置为已解锁 → 此后**任何人**请求
     GET /api/session 都能拿到写令牌，直到进程重启。

   所以远端模式改用真正的会话：登录成功生成一个随机 sessionId，
   经 HttpOnly cookie 下发，服务端存 { ip, ua, createdAt, lastSeen }。
   判定只依据**当前请求携带的 cookie**，取不到就是未解锁。

   cookie 的属性：
     HttpOnly                  JS 读不到（XSS 也偷不走）
     SameSite=Strict           跨站请求不带它（CSRF 第二道）
     Secure                    仅 HTTPS；纯 HTTP 下必须关掉，否则浏览器
                               直接不存 —— 见 dev-server 的 --public-origin
   ------------------------------------------------------------ */

const SESSION_COOKIE = 'p3_admin_sid';
const DEFAULT_IDLE_MS = 2 * 60 * 60 * 1000;        // 纯 HTTP 阶段默认 2 小时
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export const sessionCookieName = () => SESSION_COOKIE;

export const createSessionStore = ({ idleMs = DEFAULT_IDLE_MS, bind = true } = {}) => {
  const sessions = new Map();     // sessionId → { ip, ipPrefix, ua, createdAt, lastSeen }

  const touch = (rec) => { rec.lastSeen = Date.now(); return rec; };

  /* IPv4 取 /24、IPv6 取前 4 组：同一个客户端换 IP 的情况（移动网络、
     多出口家宽）不会被误杀，但"从另一个网络重放 cookie"会被挡住。 */
  const ipPrefix = (ip) => {
    const s = String(ip || '');
    if (!s) return '';
    if (s.includes(':')) return s.split(':').slice(0, 4).join(':');
    const parts = s.split('.');
    return parts.length === 4 ? parts.slice(0, 3).join('.') : s;
  };

  /**
   * 取会话，并做**绑定校验**。
   *
   * 为什么要绑定：纯 HTTP 阶段 cookie 是明文过网的（Secure 加不了，加了浏览器
   * 就不存），任何一个中间跳看到 `Cookie: p3_admin_sid=…` 就能原样重放到任何
   * 地方 —— 那就是完整的内容写权限。绑定 IP 网段 + UA 之后，重放至少要在同一
   * 个网段并伪造同一个 UA，攻击成本从"复制一个头"变成"还得在同一网络里"。
   *
   * 这不是 TLS 的替代品。真正的解法只有 HTTPS（或隧道），见 PLAN-ADMIN-LIVE §3.2。
   */
  const get = (sessionId, opts) => {
    if (!sessionId) return null;
    const rec = sessions.get(sessionId);
    if (!rec) return null;
    if (Date.now() - rec.lastSeen > idleMs) { sessions.delete(sessionId); return null; }

    if (bind && opts) {
      const ua = String(opts.ua || '');
      /* UA 变了 → 不是同一个浏览器，直接作废 */
      if (rec.ua && ua && rec.ua !== ua) { sessions.delete(sessionId); return null; }
      /* 网段变了 → 作废（同网段内换 IP 仍放行） */
      const now = ipPrefix(opts.ip);
      if (rec.ipPrefix && now && rec.ipPrefix !== now) { sessions.delete(sessionId); return null; }
    }
    return touch(rec);
  };

  const create = ({ ip, ua } = {}) => {
    const sessionId = randomToken(32);
    sessions.set(sessionId, {
      ip: ip || '', ipPrefix: ipPrefix(ip), ua: ua || '',
      createdAt: Date.now(), lastSeen: Date.now()
    });
    return sessionId;
  };

  const destroy = (sessionId) => sessions.delete(sessionId);

  /* 定期清掉过期会话，别让 Map 无限增长（公网会有很多半途而废的登录） */
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, rec] of sessions) {
      if (now - rec.lastSeen > idleMs) sessions.delete(id);
    }
  }, SWEEP_INTERVAL_MS);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  return {
    create, get, destroy,
    size: () => sessions.size,
    idleMs: () => idleMs,
    stop: () => clearInterval(sweeper),
    /* 仅供测试 */
    _sessions: sessions
  };
};

/* ---------- cookie 读写 ---------- */

export const parseCookies = (req) => {
  const raw = (req && req.headers && req.headers.cookie) || '';
  const out = new Map();
  if (!raw) return out;
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    /* cookie 值可能被引号包起来 */
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { out.set(k, decodeURIComponent(v)); } catch { out.set(k, v); }
  }
  return out;
};

export const sessionCookieFrom = (req) => parseCookies(req).get(SESSION_COOKIE) || '';

export const buildSessionCookie = (sessionId, { secure = false, maxAgeSec = null, clear = false } = {}) => {
  const parts = [
    SESSION_COOKIE + '=' + (clear ? '' : encodeURIComponent(sessionId)),
    'Path=/',
    'HttpOnly',
    'SameSite=Strict'
  ];
  if (secure) parts.push('Secure');
  parts.push('Max-Age=' + (clear ? 0 : (maxAgeSec == null ? 0 : Math.floor(maxAgeSec))));
  return parts.join('; ');
};

/* ------------------------------------------------------------
   令牌校验
   ------------------------------------------------------------ */

export const tokenFromHeaders = (req) => {
  const raw = req.headers['x-admin-token'];
  if (typeof raw === 'string' && raw.length) return raw;
  /* 也接受 Authorization: Bearer <token>，方便 curl 与验签脚本 */
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return '';
};

export const requireToken = (req, session) => {
  const token = tokenFromHeaders(req);
  if (!token) throw new HttpError(401, '缺少会话令牌');
  if (!session || !session.token) throw new HttpError(401, '会话已失效，请刷新管理页');
  if (!safeEqual(token, session.token)) throw new HttpError(403, '会话令牌不正确');
  return true;
};
