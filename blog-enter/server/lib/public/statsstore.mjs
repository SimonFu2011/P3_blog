/* ============================================================
   访问统计的数据层（page_views / page_meta）
   ------------------------------------------------------------
   只有三件事：记一次访问、算三个数、管那把 HMAC 盐。

   1) **访客标识是"带盐 HMAC 的截断"，不是 IP 本身**
      IPv4 空间只有 43 亿，裸 SHA-256 的哈希表可以被离线枚举回 IP ——
      那等于换了个地方存 IP。所以用每套部署一份的随机盐（存 page_meta，
      只在本机库里）做 HMAC，再截断到 32 位十六进制。
      本文件里 IP 只作为**函数参数**出现：不写日志、不入库、不进错误信息。
      （auth_log 里存明文 IP 是另一件事：那是安全取证，口径见 schema.sql。）

   2) **"今日"由应用算，不用 CURDATE()**
      站点时区固定 +08:00（与仓库其它时间戳一致）。交给库算的话，
      库或容器的时区一变，"今日访问量"就会在半夜跳错一天，
      而这种错只有盯着数字看才发现。

   3) **UV 用 COUNT(DISTINCT visitor)**
      十万行级毫秒级，个人博客足够。真到百万行再按 schema.sql 的注释
      换每日去重表 —— 那时也别删本表，历史只能从它重算。
   ============================================================ */
import { createHmac, randomBytes } from 'node:crypto';

/** 盐在 page_meta 里的键名 */
export const VISITOR_SALT_KEY = 'visitor_salt';

/** 站点时区偏移（分钟）：+08:00 = 480。仓库里其它时间戳也是这个口径 */
export const SITE_TZ_OFFSET_MIN = 480;

/** path 列上限（与 schema.sql 的 VARCHAR(120) 一致） */
export const PATH_MAX = 120;

/** 站点时区下的日期 'YYYY-MM-DD' */
export const siteDay = (now = new Date(), offsetMin = SITE_TZ_OFFSET_MIN) =>
  new Date(now.getTime() + offsetMin * 60_000).toISOString().slice(0, 10);

/** 访客标识：HMAC-SHA256(盐, 'IP|UA') 的前 32 位十六进制 */
export const visitorOf = (salt, ip, ua) => createHmac('sha256', String(salt))
  .update(String(ip == null ? '' : ip) + '|' + String(ua == null ? '' : ua))
  .digest('hex')
  .slice(0, 32);

/** 路径清洗：剔掉控制字符并截断。参数化 SQL 已经挡住注入，这里只是不让控制字符入列 */
export const cleanPath = (raw) => String(raw == null ? '' : raw)
  .replace(/[\u0000-\u001f\u007f]/g, '')
  .slice(0, PATH_MAX);

/* 盐的进程内缓存。为什么可以缓存：
   它是"一套部署一份"的常量，进程活着的时候不会变；每次请求都读一次库
   等于给统计加一份毫无价值的常态负载（与 health 探测缓存同一个理由）。 */
let cachedSalt = null;

/**
 * 取盐，没有就生成一次（惰性、幂等）。
 *
 * 并发安全靠 `ON DUPLICATE KEY UPDATE v = v`：两个进程同时首次写入时，
 * 先到的那把胜出，后到的这条是**空操作**（不是覆盖），随后双方都读回同一个值。
 * 若写成 `v = VALUES(v)` 就会出现"后写覆盖先写"，已入库的 visitor 立刻对不上。
 *
 * @throws 库不可用时原样抛出（由 HTTP 层翻成 503）
 */
export const getOrCreateSalt = async (pool) => {
  if (cachedSalt) return cachedSalt;

  const [rows] = await pool.execute('SELECT v FROM page_meta WHERE k = ? LIMIT 1', [VISITOR_SALT_KEY]);
  if (rows && rows.length && rows[0].v) {
    cachedSalt = String(rows[0].v);
    return cachedSalt;
  }

  const fresh = randomBytes(32).toString('hex');
  await pool.execute(
    'INSERT INTO page_meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = v',
    [VISITOR_SALT_KEY, fresh]
  );
  const [again] = await pool.execute('SELECT v FROM page_meta WHERE k = ? LIMIT 1', [VISITOR_SALT_KEY]);
  cachedSalt = (again && again.length && again[0].v) ? String(again[0].v) : fresh;
  return cachedSalt;
};

/** 供测试复位（进程内缓存不该污染下一个用例） */
export const resetSaltCache = () => { cachedSalt = null; };

/**
 * 汇总三个数。
 * @returns {Promise<{total:number, today:number, visitors:number, day:string}>}
 */
export const summary = async (pool, { now = new Date() } = {}) => {
  const day = siteDay(now);
  /* 一条 SQL 算三个数：三次查询会让"今日/总数"落在不同的时间点上，
     而这三个数字是要并排显示的（差一条也不该出现"总数比今日还小"）。
     SUM(day = ?) 在没有行时返回 NULL，下面统一兜成 0。 */
  const [rows] = await pool.execute(
    'SELECT COUNT(*) AS total, COUNT(DISTINCT visitor) AS visitors, SUM(day = ?) AS today FROM page_views',
    [day]
  );
  const r = (rows && rows[0]) || {};
  return {
    total: Number(r.total) || 0,
    today: Number(r.today) || 0,
    visitors: Number(r.visitors) || 0,
    day
  };
};

/**
 * 记一次访问（PV），并返回记完之后的汇总 —— 前端一次请求就拿到要显示的数字。
 * @param {object} pool
 * @param {{ip?:string, ua?:string, path?:string, now?:Date}} info
 */
export const recordHit = async (pool, { ip, ua, path, now = new Date() } = {}) => {
  const salt = await getOrCreateSalt(pool);
  await pool.execute(
    'INSERT INTO page_views (day, visitor, path) VALUES (?, ?, ?)',
    [siteDay(now), visitorOf(salt, ip, ua), cleanPath(path)]
  );
  return summary(pool, { now });
};
