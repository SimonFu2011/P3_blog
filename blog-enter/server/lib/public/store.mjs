/* ============================================================
   公开服务的数据服务（把 db / userstore / commentstore 拼成 HTTP 层要的那组方法）
   ------------------------------------------------------------
   为什么需要这一层薄薄的"拼装"：
     · HTTP 层（public-server.mjs）只认识 CONTRACT §4 那张方法表，
       它不该知道连接池、参数化 SQL、事务边界这些事；
     · 数据层（userstore / commentstore）只认识"一个 db 句柄 + 参数"，
       它不该知道 cookie、限流阈值、审计字段从哪来。
   两者的接缝就是这个文件。接缝越薄，"改一边忘了另一边"的机会越少。

   连接池上限 5（db.mjs 的 DEFAULT_CONNECTION_LIMIT）：
   5.7 单机内存有限，一个静态博客的公开面并发不高，5 条连接足够；
   排队（waitForConnections）而不是无限建连，避免库先把内存耗光。

   ⚠️ 任何一个 P3_DB_* 缺失都会在 createStores 里**抛错**，
   由 public-server.mjs 决定"退出"还是"显式降级"（--allow-degraded）。
   ============================================================ */
import { HttpError } from '../util.mjs';
import {
  readDbConfig, missingDbEnv, createPool, createHealthProbe, safeDbSummary,
  DEFAULT_CONNECTION_LIMIT, DEFAULT_SESSION_MAX_AGE_DAYS
} from './db.mjs';
import { hashPassword } from './passwords.mjs';
import * as users from './userstore.mjs';
import * as comments from './commentstore.mjs';

export { missingDbEnv, readDbConfig, safeDbSummary, DEFAULT_CONNECTION_LIMIT, DEFAULT_SESSION_MAX_AGE_DAYS };

/** 过期会话清理间隔（15 分钟；一次删一批，不在高峰期做全表扫描） */
const PURGE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * 造数据服务。
 * @param {{ env?:Record<string,string>, pool?:object, mysql?:object, log?:(...a:any[])=>void,
 *           startSweeper?:boolean }} [opts]
 *   env  —— 默认 process.env（部署时由 systemd EnvironmentFile 注入）
 *   pool —— 测试可以直接给一个假的 db 句柄（不连数据库）
 * @returns {Promise<object>} CONTRACT §4 的方法表 + { mode, health, close }
 */
export const createStores = async (opts = {}) => {
  const env = opts.env || process.env;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  /* 配置缺失 → 立刻抛错（带上缺哪几个名字）。绝不回退默认口令，绝不回退 root。 */
  const cfg = opts.pool ? null : readDbConfig(env);

  let pool = opts.pool || null;
  if (!pool) {
    try {
      pool = await createPool(cfg, { mysql: opts.mysql || null });
    } catch (err) {
      throw (err instanceof HttpError) ? err : new HttpError(500, '建立数据库连接池失败：' + String((err && err.message) || err));
    }
  }

  const probe = createHealthProbe({ pool });
  const maxAgeDays = cfg ? cfg.sessionMaxAgeDays : DEFAULT_SESSION_MAX_AGE_DAYS;

  /* 过期会话清理：只是让表不要无限变大，**不是**正确性依赖 ——
     正确性由每次查询的 `expires_at > ?` 条件保证（过期的会话永远放行不了）。
     定时器 unref，不让它拖住进程退出。 */
  let sweeper = null;
  if (opts.startSweeper !== false) {
    sweeper = setInterval(() => {
      users.purgeExpiredSessions(pool).then((n) => {
        if (n) log('info', '清理过期会话 ' + n + ' 条');
      }).catch((err) => {
        probe.invalidate();
        log('warn', '清理过期会话失败：' + String((err && err.code) || (err && err.message)));
      });
    }, PURGE_INTERVAL_MS);
    if (typeof sweeper.unref === 'function') sweeper.unref();
  }

  const stores = {
    mode: 'mysql',
    pool,
    summary: cfg ? safeDbSummary(cfg) : null,

    /** 'up' | 'down' —— /api/auth/me 的 db 字段用它（第一次调用时探测） */
    async health() {
      const s = probe.status();
      if (s) return s;
      return probe.probe();
    },

    /* ---------- 会话 ---------- */
    resolveSession: (token) => users.resolveSession(pool, token),
    createSession: (user, info) => users.createSession(pool, user, Object.assign({ maxAgeDays }, info || {})),
    destroySession: (token) => users.destroySession(pool, token),
    purgeExpiredSessions: (batch) => users.purgeExpiredSessions(pool, batch),

    /* ---------- 用户 ---------- */
    findUserByLogin: (kind, value) => users.findUserByLogin(pool, kind, value),
    findUserById: (id) => users.findUserById(pool, id),
    checkPassword: (plain, row) => users.checkPassword(plain, row),
    /* 登录成功后的口令哈希灰度升级（S5）：只在验过口令之后调用 */
    upgradePasswordIfNeeded: (plain, row) => users.upgradePasswordIfNeeded(pool, plain, row),
    async createUser({ username, email, password }) {
      /* 明文只在这一层出现一次：算完哈希立即不再引用它。
         下面任何一句抛错都不会把它带进错误信息（HttpError 的 message 是我们自己写的）。 */
      const { hash, algo } = await hashPassword(password);
      try {
        const id = await users.insertUser(pool, { username, email, passwordHash: hash, passwordAlgo: algo });
        const row = await users.findUserById(pool, id);
        if (!row) throw new HttpError(500, '用户写入后读不回来');
        /* 返回前把口令列摘掉：即使调用方写着 `user` 就返回，
           password_hash 也没有机会跟着行对象流到响应里。 */
        const { password_hash: _h, password_algo: _a, ...safe } = row;
        return { user: safe };
      } catch (err) {
        const code = users.translateUserConflict(err, { username, email });
        if (code) {
          /* HttpError 的构造签名是 (status, message, extra)，没有 `code` 位置；
             而 HTTP 层要靠 `err.code` 分辨是用户名还是邮箱撞了。
             这里显式挂上 —— 注意**不要**把原始驱动错误挂在 extra 上
             （那会带着整行 SQL 与数据一起进日志）。 */
          const e = new HttpError(409, code === 'USERNAME_TAKEN' ? '这个用户名已被占用' : '这个邮箱已被注册');
          e.code = code;
          throw e;
        }
        throw err;
      }
    },

    /* ---------- 评论 ---------- */
    listComments: (slug) => comments.listComments(pool, slug),
    listCommentsByUser: (userId) => comments.listCommentsByUser(pool, userId),
    /* 审核开关（S9）本轮不做：新评论走 schema 默认的 status='approved' */
    createComment: (input) => comments.createComment(pool, input),
    commentForDelete: (id) => comments.commentForDelete(pool, id),
    markCommentDeleted: (id, who) => comments.markCommentDeleted(pool, id, who),
    countComments: (slug) => comments.countComments(pool, slug),

    /* ---------- 认证限流 / 审计 ---------- */
    authThrottleState: (ip, action, policy) => users.throttleState(pool, ip, action, policy),
    authThrottleFailure: (ip, action, policy) => users.noteThrottleFailure(pool, ip, action, policy),
    authThrottleSuccess: (ip, action) => users.clearThrottle(pool, ip, action),
    authLog: (entry) => users.writeAuthLog(pool, entry),

    /** 优雅退出：停掉定时器并关闭连接池（否则 systemd stop 会等到超时才杀） */
    async close() {
      if (sweeper) { clearInterval(sweeper); sweeper = null; }
      try { await pool.end(); } catch { /* 已经关了 */ }
    }
  };

  return stores;
};
