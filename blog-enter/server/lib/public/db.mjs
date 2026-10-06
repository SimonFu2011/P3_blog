/* ============================================================
   数据库连接（公开面）—— mysql2/promise 连接池
   ------------------------------------------------------------
   这个文件里的每一条取舍都是 t13 在那台服务器上实测换来的，
   回退任何一条都会直接连不上库：

   1) **只从环境变量读配置**：P3_DB_HOST / P3_DB_PORT / P3_DB_NAME /
      P3_DB_USER / P3_DB_PASSWORD（部署阶段由 systemd 的
      EnvironmentFile=/etc/p3blog/public.env 注入）。
      缺任何一个都**抛错**，并且把缺的名字列出来。
      绝不回退到默认口令、绝不回退到 root —— "连不上"必须比
      "用错身份连上了"更早、更响地暴露出来。

   2) **绝不读 option file**：MySQL 客户端里 option file 的 password
      优先级**高于** MYSQL_PWD；服务器上 /etc/my.cnf 的 [client] 段存的是
      root 口令，一旦让客户端去读它，应用就可能以 root 身份连库。
      所以字段全部显式传给 createPool，且不设 defaultsFile。

   3) **走 TCP 127.0.0.1:3306，不走 socket**：/tmp/mysql.sock 是 root 的
      socket 路径，p3app 没有理由去碰它。t13 实测通过的路径就是
      `mysql --no-defaults -h127.0.0.1 -u$P3_DB_USER -p...`，这里保持一致。

   4) **只有一个应用账号**：'p3app'@'127.0.0.1'，权限恰为
      SELECT/INSERT/UPDATE/DELETE ON p3blog.*（没有 DDL/GRANT/FILE）。
      这条依赖服务器上 /etc/my.cnf 的 skip-name-resolve（已启用）：
      没有它，127.0.0.1 会被反解成 localhost，'p3app'@'127.0.0.1' 永不匹配。
      **不要**在代码里加 'p3app'@'localhost' 之类的兜底，也不要去改 my.cnf。

   5) **懒连接**：createPool 不立即建连，第一条 SQL 才握手；因此
      "库还没起来"不会阻止服务进程启动（systemd 的 Restart 才有机会生效）。
      但**配置缺失**是另一回事：那是部署错误，必须在启动时就拒绝。

   6) **参数化**：mysql2 的 `?` 占位符把参数走二进制协议发给服务器，
      绝不用模板串拼 SQL。本文件导出的 conf 里也不提供任何"原始 SQL 拼接"
      入口 —— 数据层只拿 pool.execute(sql, params)。

   时区：统一 'Z' + dateStrings 只对 DATETIME 生效；sessions.expires_at 是
   DATETIME，用应用侧算好的 "YYYY-MM-DD HH:mm:ss"（UTC）写入与比较，
   不让 MySQL 按连接时区做换算（schema.sql:104 就是这么定的）。
   ============================================================ */
import { HttpError } from '../util.mjs';

/** 必需的环境变量（缺一个就拒绝启动） */
export const REQUIRED_ENV = ['P3_DB_HOST', 'P3_DB_PORT', 'P3_DB_NAME', 'P3_DB_USER', 'P3_DB_PASSWORD'];

/** 连接池上限：5.7 单机内存有限，5 条连接够一个静态博客的公开面用 */
export const DEFAULT_CONNECTION_LIMIT = 5;

/** 会话有效期默认 30 天（与 cookie Max-Age 同源；可用 P3_SESSION_MAX_AGE_DAYS 覆盖） */
export const DEFAULT_SESSION_MAX_AGE_DAYS = 30;

/**
 * 校验并返回数据库配置。
 * @param {Record<string,string|undefined>} env
 * @returns {{host:string,port:number,user:string,password:string,database:string,sessionMaxAgeDays:number}}
 * @throws {HttpError} 500 —— 缺配置属于部署错误，不属于业务错误；
 *   但它的 message 会被 main() 原样打印出来（含缺失项名字），方便排障。
 */
export const readDbConfig = (env = process.env) => {
  const e = env || {};
  const missing = REQUIRED_ENV.filter((k) => {
    const v = e[k];
    /* 空白串也算缺：`P3_DB_PASSWORD=" "` 这种（比如 env 文件里多打了个空格）
       如果放过去，就会拿着一个空格当口令去连库，然后报一个 1045 ——
       而真正的错误在配置文件里，日志却指向"口令不对"。 */
    return v === undefined || v === null || String(v).trim() === '';
  });
  if (missing.length) {
    /* 明确列出缺哪些 —— "连接失败"这四个字对排障毫无帮助，
       而"缺 P3_DB_PASSWORD"一句话就能定位。
       ⚠️ 只打印**变量名**，绝不打印任何值。 */
    throw new HttpError(500,
      '缺少数据库配置：' + missing.join('、') + '（公开服务拒绝以任何默认身份启动）');
  }

  const portRaw = String(e.P3_DB_PORT).trim();
  if (!/^\d{1,5}$/.test(portRaw)) {
    throw new HttpError(500, 'P3_DB_PORT 不是合法端口：' + portRaw);
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(500, 'P3_DB_PORT 不是合法端口：' + portRaw);
  }

  const days = Number(e.P3_SESSION_MAX_AGE_DAYS || DEFAULT_SESSION_MAX_AGE_DAYS);
  const sessionMaxAgeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : DEFAULT_SESSION_MAX_AGE_DAYS;

  return {
    host: String(e.P3_DB_HOST),
    port,
    user: String(e.P3_DB_USER),
    password: String(e.P3_DB_PASSWORD),
    database: String(e.P3_DB_NAME),
    sessionMaxAgeDays
  };
};

/** 配置是否齐全（不抛错的版本，给 CLI 决定走真库还是显式降级用） */
export const missingDbEnv = (env = process.env) => REQUIRED_ENV.filter((k) => {
  const v = (env || {})[k];
  return v === undefined || v === null || String(v).trim() === '';
});

/** 供 --print-config 使用：**绝不**返回口令 */
export const safeDbSummary = (cfg) => ({
  host: cfg.host,
  port: cfg.port,
  database: cfg.database,
  user: cfg.user,
  password: '(已设置，不显示)',
  sessionMaxAgeDays: cfg.sessionMaxAgeDays,
  connectionLimit: DEFAULT_CONNECTION_LIMIT
});

/**
 * 载入 mysql2/promise。
 * 用动态 import 而不是顶层静态 import，是为了让"没装依赖"这件事
 * 只影响真库模式：骨架模式与单元测试都不需要 mysql2 在场。
 * 装法见 blog-enter/package.json（唯一依赖）。
 */
export const loadMysql = async () => {
  try {
    const mod = await import('mysql2/promise');
    return mod.default || mod;
  } catch (err) {
    /* 依赖清单在 blog-enter/server/package.json（不是 blog-enter/ 顶层 ——
       顶层会被发布脚本同步到站点根目录，见 CONTRACT §5.1）。 */
    throw new HttpError(500,
      '载不到 mysql2（请先在 blog-enter/server/ 下 npm install）：' + String((err && err.code) || (err && err.message)));
  }
};

/**
 * 建连接池。**不立即连接**（第一条 SQL 才握手），所以它不会因为
 * "库暂时没起"而抛错；配置错误则已经在 readDbConfig 里被拦下。
 */
export const createPool = async (cfg, { mysql = null, connectionLimit = DEFAULT_CONNECTION_LIMIT } = {}) => {
  const driver = mysql || await loadMysql();
  const pool = driver.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    connectionLimit,
    /* 等连接的时间上限：宁可 10 秒失败，也不要一个请求挂到天荒地老 */
    connectTimeout: 10_000,
    /* 会话设置（不改变任何数据，只影响本连接的会话变量）：
       +00:00 让 NOW() 与 DATETIME 比较按 UTC；
       time_zone 不是关键字，用引号按字符串设置更稳。 */
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    /* DATETIME 原样返回字符串（expires_at 比较不必经过 Date） */
    dateStrings: ['DATETIME'],
    /* 关掉"一次 query 多条语句"：公开面上没有任何地方需要执行多语句，
       而它会把一个注入点从"改一条 SQL"放大成"任意 SQL"。 */
    multipleStatements: false,
    /* 不做 namedPlaceholders：所有 SQL 一律 `?`，一种占位符只有一种写法 */
    namedPlaceholders: false,
    /* 连接池自身的排队：超过上限立即报错，不无限排队 */
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000
  });

  /* 会话变量：按 UTC 记录与比较时间。失败不致命（连接会被回收），但要说清楚。 */
  try {
    await pool.query("SET time_zone = '+00:00'");
  } catch (err) {
    try { await pool.end(); } catch { /* 已经坏了 */ }
    throw new HttpError(500, '数据库连接建立后设置时区失败：' + String((err && err.code) || (err && err.message)));
  }

  return pool;
};

/**
 * 库是否真的可用（health）。给 /api/auth/me 的 db 字段用：
 *   'up'   最近一次探测成功
 *   'down' 最近一次探测失败
 *   null   还没探过（骨架模式恒为 null → 上层按 'down' 处理）
 *
 * 为什么要缓存：/api/auth/me 是每个页面都会打的接口，
 * 每次都 `SELECT 1` 会给库加一份毫无价值的常态负载。
 * 5 秒的窗口足够让"库挂了"在一两个请求内被反映出来，
 * 又不会让探测本身成为负载。
 */
export const createHealthProbe = ({ pool, ttlMs = 5000, now = () => Date.now() } = {}) => {
  let state = null;      // 'up' | 'down' | null
  let checkedAt = 0;
  let inflight = null;

  const probe = async () => {
    const t = now();
    if (state !== null && t - checkedAt < ttlMs) return state;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        await pool.query('SELECT 1');
        state = 'up';
      } catch {
        state = 'down';
      } finally {
        checkedAt = now();
        inflight = null;
      }
      return state;
    })();
    return inflight;
  };

  return {
    /** 强制下一次调用重新探测（写入失败时用） */
    invalidate: () => { state = null; checkedAt = 0; },
    status: () => state,
    probe
  };
};

/* ------------------------------------------------------------
   时间工具（与 schema.sql 的 DATETIME 语义配套）
   ------------------------------------------------------------ */

/** Date → 'YYYY-MM-DD HH:mm:ss'（UTC）。sessions.expires_at 就用这个格式。 */
export const toDbDateTime = (d) => {
  const t = d instanceof Date ? d : new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} `
    + `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
};

/** 现在 + n 天，返回 DATETIME 字符串 */
export const dbDateTimeInDays = (days, from = new Date()) =>
  toDbDateTime(new Date(from.getTime() + Number(days) * 24 * 60 * 60 * 1000));

/** 现在（UTC DATETIME 字符串），用于比较 expires_at */
export const dbNow = (from = new Date()) => toDbDateTime(from);

/* ------------------------------------------------------------
   错误翻译
   ------------------------------------------------------------ */

/** 唯一键冲突 */
export const DUP_ENTRY = 'ER_DUP_ENTRY';
/** 常见连接类错误（用于判断"库不可用"而不是"我们写错了 SQL"） */
export const DB_DOWN_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST', 'ER_CON_COUNT_ERROR',
  'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR', 'ENOTFOUND', 'EHOSTUNREACH',
  'ER_SERVER_SHUTDOWN', 'ER_LOCK_WAIT_TIMEOUT'
]);

export const isDupEntry = (err) => Boolean(err && (err.code === DUP_ENTRY || err.errno === 1062));
export const isDbDown = (err) => Boolean(err) && (
  err.code === 'DB_UNAVAILABLE'
  || DB_DOWN_CODES.has(err.code)
  || err.fatal === true
  || err.sqlState === 'HY000' && /connect|shutdown|lost/i.test(String(err.message || ''))
);
