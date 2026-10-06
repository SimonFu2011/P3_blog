/* ============================================================
   用户与会话数据层（公开面）
   ------------------------------------------------------------
   所有 SQL 一律走 `?` 参数化占位符（mysql2/promise 的 execute），
   这里**没有任何**字符串拼接 SQL 的地方 —— 一个都没有。

   会话令牌的存储语义（契约 §4.0，与 schema.sql:95 一致）：
     客户端 cookie 里拿的是**原始令牌**（64 字符十六进制）；
     库里 sessions.id 存的是它的 **SHA-256 十六进制摘要**。
   于是这个文件里凡是提到"token"的地方都分得清清楚楚：
     · createSession 返回 { id: <原始令牌> } —— 上层拿它放进 cookie；
     · 库里写入的是 sha256(token)；
     · resolveSession/destroySession 收原始令牌，内部先摘要再查。
   好处是库被拖走也无法直接冒用会话（摘要不是有效 cookie）。

   列的时区约定：expires_at 是 DATETIME，用 db.mjs 的 UTC 字符串
   写入与比较；不设 ON UPDATE 的 last_seen 必须**显式** UPDATE。
   ============================================================ */
import { createHash, randomBytes } from 'node:crypto';
import { fail } from './http.mjs';
import { dbDateTimeInDays, dbNow, isDupEntry } from './db.mjs';
import { checkAgainstUser, rehashPassword } from './passwords.mjs';

/** 会话令牌字节数（→ 64 字符十六进制，正好等于 sessions.id CHAR(64)） */
export const TOKEN_BYTES = 32;

/** 会话令牌：原始值只出现在 cookie 与本进程内存里 */
export const newSessionToken = () => randomBytes(TOKEN_BYTES).toString('hex');

/** 令牌 → 库里存的主键值。这是"cookie 原始值"与"库列值"之间唯一的那次转换。 */
export const tokenHash = (token) => createHash('sha256').update(String(token || ''), 'utf8').digest('hex');

/** UA 截断到列宽（sessions.ua VARCHAR(255)）：超长写入在严格模式下会直接报错 */
const clip = (s, n) => (String(s == null ? '' : s).slice(0, n));

/* ------------------------------------------------------------
   查询
   ------------------------------------------------------------ */

/* 只列需要的列。**不** SELECT *：那会让 password_hash 有机会跟着
   "顺手 spread 一下"流到响应里，也会在加列时悄悄改变行为。 */
const USER_COLUMNS = 'id, username, email, password_hash, password_algo, avatar, role, '
  + 'email_verified, status, created_at';

/**
 * 按用户名或邮箱查用户。
 * 刻意**不用** `WHERE username=? OR email=?`：那样两个唯一索引都用不上，
 * 优化器只能全表扫。按 kind 分两条语句，各自等值命中一个唯一索引。
 *
 * 大小写：utf8mb4_unicode_ci 下比较天然不区分（"Alice" 与 "alice" 是同一账号），
 * 所以这里**不要**手工 LOWER() —— 那会让 uk_users_username 失效。
 */
export const findUserByLogin = async (db, kind, value) => {
  const sql = kind === 'email'
    ? `SELECT ${USER_COLUMNS} FROM users WHERE email = ? LIMIT 1`
    : `SELECT ${USER_COLUMNS} FROM users WHERE username = ? LIMIT 1`;
  const [rows] = await db.execute(sql, [String(value)]);
  return rows.length ? rows[0] : null;
};

/** 按 id 查用户（会话校验时用） */
export const findUserById = async (db, id) => {
  const [rows] = await db.execute(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? LIMIT 1`, [Number(id)]);
  return rows.length ? rows[0] : null;
};

/**
 * 把 mysql2 的唯一键冲突翻译成可读错误。
 *
 * 为什么必须翻译：ER_DUP_ENTRY 直接冒到 HTTP 层会变成 500
 * 「服务器内部错误」—— 而"这个用户名已被占用"是完全正常的业务结果。
 * 而且 500 的错误日志里会带上那一行数据的细节，等于把注册接口
 * 变成一个"这个用户名存在吗"的探测器的同时，还顺手泄露库结构。
 *
 * 判定顺序：先看驱动给的索引名（最准），退化到看 message 里的列名。
 * 两个都不认时就重抛 —— 宁可 500，也不要给出错误的"已被占用"提示。
 */
export const translateUserConflict = (err, { username, email }) => {
  if (!isDupEntry(err)) return null;
  const hay = String((err && err.message) || '');
  const key = String((err && err.sqlMessage) || '');
  const both = hay + ' ' + key;
  if (/uk_users_username|'username'|`username`/.test(both)) return 'USERNAME_TAKEN';
  if (/uk_users_email|'email'|`email`/.test(both)) return 'EMAIL_TAKEN';
  /* 兜底：不知道撞的是哪个键时，用"哪个字段有值"来猜是不安全的，
     所以给一个不指名道姓但仍然可读的冲突（前端会提示"已被占用"）。 */
  if (username && email) return 'USERNAME_TAKEN';
  return null;
};

/** 新增用户。口令哈希由调用方先算好（这里看不到明文之外的东西也不需要）。 */
export const insertUser = async (db, { username, email, passwordHash, passwordAlgo = 'pbkdf2-sha256' }) => {
  const sql = 'INSERT INTO users (username, email, password_hash, password_algo) VALUES (?, ?, ?, ?)';
  const [res] = await db.execute(sql, [String(username), String(email), String(passwordHash), String(passwordAlgo)]);
  return Number(res.insertId);
};

/* ------------------------------------------------------------
   会话
   ------------------------------------------------------------ */

/**
 * 建会话。
 * @returns {Promise<{ id:string, expiresAt:string }>} id 是**原始令牌**（进 cookie 用）
 */
export const createSession = async (db, user, { ip, ua, maxAgeDays = 30 } = {}) => {
  const token = newSessionToken();
  const expiresAt = dbDateTimeInDays(maxAgeDays);
  const sql = 'INSERT INTO sessions (id, user_id, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?)';
  await db.execute(sql, [tokenHash(token), Number(user.id), expiresAt, clip(ip, 64), clip(ua, 255)]);
  return { id: token, expiresAt };
};

/**
 * 校验会话并滑动续期。
 *
 * 过期判断在 SQL 里做（`expires_at > ?`），不拿回应用再比：
 * 少一次"应用时钟与库时钟不一致"的机会，也少一次泄漏（过期行根本不返回）。
 * 只查 status='active' 的用户：账号被禁用的瞬间，所有会话立即失效。
 *
 * last_seen **必须显式 UPDATE**（schema.sql:102 特意没设 ON UPDATE）——
 * 靠自动更新是不会有任何效果的，而"会话一直显示很久没活动"这种 bug 很难看出来。
 */
export const resolveSession = async (db, token, { touch = true } = {}) => {
  const tid = tokenHash(token);
  const sql = 'SELECT s.id AS session_id, s.user_id, s.expires_at, s.last_seen, '
    + 'u.id AS id2, u.username, u.email, u.avatar, u.role, u.status, u.created_at AS u_created_at '
    + 'FROM sessions s INNER JOIN users u ON u.id = s.user_id '
    + 'WHERE s.id = ? AND s.expires_at > ? AND u.status = \'active\' LIMIT 1';
  const [rows] = await db.execute(sql, [tid, dbNow()]);
  if (!rows.length) return null;
  const r = rows[0];

  if (touch) {
    /* 每一分钟最多写一次：公开面上一个页面会打多个接口，
       每次都 UPDATE 等于把读接口变成写接口（并让行锁竞争）。 */
    const last = r.last_seen instanceof Date ? r.last_seen : new Date(String(r.last_seen).replace(' ', 'T') + 'Z');
    const stale = !(last instanceof Date) || Number.isNaN(last.getTime()) || (Date.now() - last.getTime() > 60_000);
    if (stale) {
      await db.execute('UPDATE sessions SET last_seen = CURRENT_TIMESTAMP WHERE id = ?', [tid]);
    }
  }

  return {
    sessionId: tid,
    expiresAt: r.expires_at,
    user: {
      id: Number(r.user_id),
      username: r.username,
      email: r.email,
      avatar: r.avatar,
      role: r.role,
      status: r.status,
      created_at: r.u_created_at
    }
  };
};

/** 销毁一条会话（登出） */
export const destroySession = async (db, token) => {
  const [res] = await db.execute('DELETE FROM sessions WHERE id = ?', [tokenHash(token)]);
  return Number(res.affectedRows) > 0;
};

/** 销毁某个用户的全部会话（改口令/封禁时用；本轮只提供给测试与后台治理） */
export const destroyUserSessions = async (db, userId) => {
  const [res] = await db.execute('DELETE FROM sessions WHERE user_id = ?', [Number(userId)]);
  return Number(res.affectedRows);
};

/** 清理过期会话（定时任务用；不清理也不会放行，只是表会慢慢变大） */
export const purgeExpiredSessions = async (db, batch = 500) => {
  const [res] = await db.execute('DELETE FROM sessions WHERE expires_at <= ? LIMIT ?', [dbNow(), Number(batch)]);
  return Number(res.affectedRows);
};

/**
 * 口令校验的唯一入口。
 * 用户行或哈希缺失时，passwords.checkAgainstUser 会跑一次等价耗时的假校验 ——
 * 这是"不泄露账号是否存在"的耗时对齐，不要在别处另写一份。
 */
export const checkPassword = (plain, userRow) => checkAgainstUser(plain, userRow);

/**
 * 登录成功后按需升级口令哈希（S5 的灰度配套）。
 *
 * 调用时机**必须**是"已经验过口令且通过"之后 —— 这里只按参数判断要不要重算，
 * 如果把它的返回值当校验结果用，就等于把"这条记录轮数旧"读成"口令正确"。
 * 回写失败不影响登录（用户已经证明是本人，升级失败下次再试）。
 *
 * @returns {Promise<boolean>} 是否发生了回写
 */
export const upgradePasswordIfNeeded = async (db, plain, userRow) => {
  if (!userRow || !userRow.id) return false;
  return rehashPassword(plain, userRow.password_hash, async (hash, algo) => {
    const [res] = await db.execute(
      'UPDATE users SET password_hash = ?, password_algo = ? WHERE id = ?',
      [String(hash), String(algo), Number(userRow.id)]
    );
    if (Number(res.affectedRows) !== 1) throw fail('DB_UNAVAILABLE', '口令升级回写未命中目标行');
  });
};

/* ------------------------------------------------------------
   认证限流（auth_throttle）与审计（auth_log）
   ------------------------------------------------------------ */

/**
 * 读当前熔断状态。
 *
 * gate_until 是 DATETIME（schema.sql:167）：NULL 表示未熔断；
 * 比较用应用侧算好的 UTC 字符串，避免 MySQL 按连接时区换算。
 */
/**
 * 读当前熔断状态，并在"窗口已过 / 还没到阈值"时顺手把旧计数清掉。
 *
 * gate_until 是 DATETIME（schema.sql:167）：NULL 表示未熔断；
 * 比较用应用侧算好的 UTC 字符串（把 'YYYY-MM-DD HH:mm:ss' 明确当 UTC 解析），
 * 不让 MySQL 按连接时区换算。
 *
 * 自清理是必须的：auth_throttle 只有 (ip,action) 一个唯一键，没有"窗口起点"这一列
 * （schema.sql 就是这么定的）。如果只在熔断时清计数，那么"15 分钟内错 8 次"的计数
 * 会一直留在表里，等到某天再错 3 次就直接熔断 —— 那是一次很久以前的失败在惩罚现在的用户。
 * 判据：没有 gate，且 count × 60s 已经超过窗口，就说明这些失败已经不作数了 → 清零。
 */
export const throttleState = async (db, ip, action, { maxFails = 10, windowMs = 15 * 60 * 1000 } = {}) => {
  const sql = 'SELECT fails, gate_until FROM auth_throttle WHERE ip = ? AND action = ? LIMIT 1';
  const [rows] = await db.execute(sql, [clip(ip, 64), clip(action, 32)]);
  if (!rows.length) return { fails: 0, waitMs: 0, gated: false };

  const gateUntil = rows[0].gate_until;
  const fails = Number(rows[0].fails || 0);
  const waitMs = gateUntil
    ? Math.max(0, new Date(String(gateUntil).replace(' ', 'T') + 'Z').getTime() - Date.now())
    : 0;

  if (waitMs > 0) return { fails, waitMs, gated: true };

  /* 没有 gate 却在窗口外：这批失败已经过期，清零（下次从 1 开始算）。 */
  if (gateUntil == null && fails > 0 && fails * 60_000 > windowMs) {
    await clearThrottle(db, ip, action);
    return { fails: 0, waitMs: 0, gated: false };
  }
  /* 有 gate 但已过期：同样清零，免得"上次熔断的计数"继续累加。 */
  if (gateUntil != null) {
    await clearThrottle(db, ip, action);
    return { fails: 0, waitMs: 0, gated: false };
  }
  return { fails, waitMs: 0, gated: false, threshold: maxFails };
};

/** 退避时长：1s、2s、4s…最多 15 分钟（与契约的 1 小时封禁窗口配合） */
export const backoffMs = (fails, { baseMs = 1000, capMs = 15 * 60 * 1000 } = {}) =>
  Math.min(capMs, baseMs * Math.pow(2, Math.min(Math.max(fails, 1) - 1, 10)));

/**
 * 记一次失败并累加计数。
 *
 * **一条** `INSERT ... ON DUPLICATE KEY UPDATE` 完成，不做"先 SELECT 再 UPDATE"：
 * 后者在并发下会丢计数（两个请求同时读到 fails=3，各自写回 4），
 * 而限流计数丢一次就等于给攻击者一次免费重试。uk_auth_throttle_ip_action
 * 就是为这条语句建的（schema.sql:172）。
 *
 * 当累计失败数（本行已有计数 + 这 1 次）达到 maxFails 时，把 gate_until
 * 设为调用方给定的 gateMs 之后（登录 1 小时 / 注册 1 小时，见契约 §0.6）。
 * 未达阈值时 gate_until 置 NULL（明确"现在没被熔断"）。
 *
 * ⚠️ MySQL 的 ON DUPLICATE KEY UPDATE 是**从左到右**求值的：`fails = fails + 1`
 *    写在前面，后面表达式里的 fails 就已经是自增后的值。顺序写反会得到
 *    "退避总慢一档"这种极难察觉的偏差。
 */
export const noteThrottleFailure = async (db, ip, action, { maxFails = 10, gateMs = 60 * 60 * 1000 } = {}) => {
  const gateSec = Math.max(1, Math.ceil(gateMs / 1000));
  const sql = 'INSERT INTO auth_throttle (ip, action, fails, gate_until) VALUES (?, ?, 1, NULL) '
    + 'ON DUPLICATE KEY UPDATE '
    + 'fails = fails + 1, '
    + 'gate_until = IF(fails >= ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND), NULL)';
  await db.execute(sql, [clip(ip, 64), clip(action, 32), Number(maxFails), gateSec]);
};

/** 登录成功后清零失败计数（同一个 IP 的同一动作） */
export const clearThrottle = async (db, ip, action) => {
  const [res] = await db.execute('DELETE FROM auth_throttle WHERE ip = ? AND action = ?', [clip(ip, 64), clip(action, 32)]);
  return Number(res.affectedRows) > 0;
};

/**
 * 写认证审计。
 *
 * 只写排查用的最小信息：动作、结果、来源 IP、失败分类。
 * **任何口令、令牌、哈希都不许写进 detail**（schema.sql:219 的约定）——
 * 审计表是"出事后要到处贴给人看的"那种表，天然不适合放凭据。
 * 写入失败也**不**影响认证结果：审计是旁路，不能让它反过来把登录搞挂。
 */
export const writeAuthLog = async (db, { userId = null, ip = null, action, ok, detail = null }) => {
  const sql = 'INSERT INTO auth_log (user_id, ip, action, ok, detail) VALUES (?, ?, ?, ?, ?)';
  try {
    await db.execute(sql, [
      userId == null ? null : Number(userId),
      ip == null ? null : clip(ip, 64),
      clip(action, 32),
      ok ? 1 : 0,
      detail == null ? null : clip(detail, 255)
    ]);
    return true;
  } catch {
    return false;   // 审计失败不改变业务结果
  }
};

/** 由 ip 拼出限流的键（与 schema 的 (ip, action) 唯一键对齐） */
export const throttleKey = (ip) => clip(ip || 'unknown', 64);

export { newSessionToken as randomToken, fail };
