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
