/* ============================================================
   公开服务（公开用户登录 / 注册 / 评论）—— 只监听回环，数据面 MySQL
   ------------------------------------------------------------
   与 dev-server.mjs 的关系：**没有关系，也永远不会**。
   本文件不 import dev-server.mjs、不 import lib/auth.mjs、
   不读管理面运行时目录（口令哈希、会话令牌、备份都在那儿），
   也不碰文章源码文件。这不是"洁癖"，是这条边界本身：

     管理面 = 只有我能改文章（本机回环 8849 + 口令 + 文件存储）
     公开面 = 任何访客都能注册、登录、发评论（回环 8850 + MySQL）

   两者跑在不同的进程、不同的端口、不同的监听面、不同的存储上。
   一旦公开服务 import 了管理面的任何模块，"管理员口令与文章存储路径"
   就会出现在一个公网可达的进程的地址空间里 —— 攻击者只需要在这一个
   进程里拿到任意文件读，就同时拿到了文章源码与口令哈希。
   所以是**物理隔离**，靠"这个文件里根本找不到那些路径"来保证。

   本文件只负责：
     · 起 HTTP 服务
     · 组装路由与它们的业务动作
     · 在**库不可用**时给出清晰、结构化、不崩的错误
     · 限流、审计与日志

   用法：
     node blog-enter/server/public-server.mjs
     node blog-enter/server/public-server.mjs --port 8850 --public-origin http://43.108.100.116
     node blog-enter/server/public-server.mjs --public-origin https://example.com   # 自动带 Secure
     node blog-enter/server/public-server.mjs --print-config                       # 只打印配置
     node blog-enter/server/public-server.mjs --allow-degraded                     # 本机没有 MySQL 时

   代理信任（--trust-proxy）的三态（见 CONTRACT §0.7）：
     给了 --proxy-secret-file + 文件可读非空 → 信任 XFF，但每个请求都校验密钥头
     给了 --proxy-secret-file 但读不到/为空/太短 → **拒绝启动**（不悄悄降级）
     没给 --proxy-secret-file                 → 启动，但强制关闭代理信任并告警

   数据面：lib/public/store.mjs 把连接池 / 口令哈希 / 用户会话 / 评论三块
   拼成 HTTP 层要的那组方法。配置只从环境变量读
   （P3_DB_HOST/PORT/NAME/USER/PASSWORD，部署时由 systemd EnvironmentFile 注入）：
     · 配置齐全 → 真库模式
     · 缺任何一个 → **拒绝启动**并打印缺哪几个（绝不回退默认口令或 root）
     · 只有显式 --allow-degraded 才降级成骨架模式（只有 /api/auth/me 可用）

   这个文件既是 CLI 也是模块：createPublicApp() 返回一个未监听的
   http.Server，验签脚本可以在同一进程里起它、注入内存假服务打真实请求，
   不需要 spawn 子进程（受限环境下 spawn 会因命名管道被拒）。
   ============================================================ */
import http from 'node:http';
import { pbkdf2 } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ApiError, SESSION_COOKIE, SESSION_COOKIE_PATH, SESSION_MAX_AGE_SEC, MAX_JSON, RATE_LIMITS, ERROR_CODES,
  route, handleRequest, sendJson, errorBody, securityHeaders, buildSessionCookie,
  clearSessionCookie, sessionIdFrom, createRateLimiter, wantsSecureCookie,
  validateUsername, validateEmail, validatePassword, classifyLoginId,
  validateContent, validateSlug, validateParentId, validateCommentId,
  publicComment, myComment, selfUser, orNull, fail
} from './lib/public/http.mjs';

const SERVER_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));

/** 回环名永远在 Host 白名单里：本服务只绑回环，隧道/直连都要能进来。
 *  与 dev-server.mjs 的取值一致 —— 这不是巧合，是同一台机器上的同一套判据。 */
const LOOPBACK_HOSTS = ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'];

/* ------------------------------------------------------------
   配置
   ------------------------------------------------------------ */
export const resolveConfig = (options) => {
  const o = options || {};
  const secret = o.proxySecret ? String(o.proxySecret).trim() : null;
  return {
    /* 只绑回环，且**没有**绑 0.0.0.0 的开关。
       公网入口由 nginx 反代收口（见 deploy），应用自己绝不直接听公网：
       这样"事故时把 8850 暴露出去"不会发生，因为代码里没有那个选项。 */
    host: o.host || '127.0.0.1',
    port: Number(o.port || 8850),
    /* 反代带来的真实站点名（Host 白名单）与允许的 Origin（精确匹配）。
       Origin 决定 cookie 是否带 Secure —— 与管理面同一套判据。 */
    publicHosts: Array.isArray(o.publicHosts) ? o.publicHosts.slice() : [],
    publicOrigins: Array.isArray(o.publicOrigins) ? o.publicOrigins.slice() : [],
    /* 反代共享密钥（--proxy-secret-file 的内容，已 trim）。空 = 没有配置。 */
    proxySecret: secret,
    /* 调用方**要求**信任 XFF（--trust-proxy）。 */
    trustProxyRequested: o.trustProxy === true,
    /* 【生效值】只有密钥在场时才允许信 XFF：
         · 有密钥（非空）→ 信任 XFF，但每个请求都必须带 x-admin-proxy-secret
         · 没密钥        → **强制关闭**（XFF 一律忽略，客户端 IP 取直连对端）
       调用方要"开"只能通过给密钥来开 —— 这样"忘了配密钥"不会变成
       "信任所有伪造 XFF"（那会让限流被逐个假 IP 绕过、审计记假 IP）。
       trustProxyExplicit 只给测试覆盖用。 */
    trustProxy: o.trustProxyExplicit === true
      ? (o.trustProxy === true)
      : (o.trustProxy === true && Boolean(secret)),
    maxJson: Number(o.maxJson || MAX_JSON),
    /* 服务实现（可由调用方注入；不注入就走 loadStores 载入真库实现） */
    stores: o.stores || null,
    /* 【显式】允许在缺少 P3_DB_* / 载不到 mysql2 时降级到骨架模式。
       默认 false：正常部署时配置不全必须拒绝启动，而不是"起来了但半边不可用"。 */
    allowDegraded: o.allowDegraded === true,
    log: o.log,
    now: o.now || (() => Date.now())
  };
};

/* ------------------------------------------------------------
   服务（业务动作）接口
   ------------------------------------------------------------
   这里只声明**需要的形状**；真库实现在 lib/public/store.mjs。
   本文件不关心它怎么连库，只关心它要么返回数据、要么抛错。

   方法表（CONTRACT §4）：
     resolveSession(token)            → { user, sessionId, expiresAt } | null
     createSession(user, {ip,ua})     → { id, expiresAt }        （id = 原始令牌）
     destroySession(token)            → boolean
     findUserByLogin(kind, value)      → 含 password_hash 的用户行 | null
     checkPassword(plain, userRow|null) → boolean（userRow 为 null 时也要照跑一次假哈希）
     createUser({username,email,password,...}) → { user }（内部做 PBKDF2）
     listComments(slug)               → 评论行[]（approved，created_at 升序）
     listCommentsByUser(userId)       → 评论行[]（同上 + slug，降序）
     createComment({slug,userId,parentId,content}) → 行
     commentForDelete(id)             → 评论行（含 user_id/status）| null
     markCommentDeleted(id, {byUserId, byRole}) → boolean
     health()                         → 'up' | 'down'
     authThrottleState(ip, action, policy) → { fails, waitMs, gated }
     authThrottleFailure(ip, action, policy) → void
     authThrottleSuccess(ip, action)  → void
     authLog(entry)                   → boolean
     close()                          → void
   ------------------------------------------------------------ */

/** 库不可用的统一错误：状态码 503 而不是 500。
 *  500 的意思是"我们的代码有 bug"；503 的意思是"依赖的下游不可用，等会儿再来"。
 *  混在一起，运维就没法从状态码分布里区分"程序坏了"和"数据库挂了"。 */
const dbDown = (what) => fail('DB_UNAVAILABLE', '数据服务暂时不可用（' + what + '）');

/** 骨架模式：所有需要数据的动作都明确拒绝，而不是返回假数据。
 *  返回假数据（比如登录永远成功）是公开面上最危险的一类"临时实现"——
 *  它会在某个忘了配库的部署里变成一个任何人都是管理员的系统。
 *
 *  这套骨架只在**显式** --allow-degraded（本机没有 MySQL 时）才被启用；
 *  正常启动路径上缺少 P3_DB_* 是直接拒绝启动的（见 main()）。 */
const createSkeletonStores = () => ({
  mode: 'skeleton',
  resolveSession: async () => null,
  createSession: async () => { throw dbDown('会话'); },
  destroySession: async () => { throw dbDown('会话'); },
  findUserByLogin: async () => { throw dbDown('用户'); },
  /* 骨架模式下没有用户，但**不能**因此把这一步变成"立刻返回 false"：
     那样"库没配好"与"用户不存在"的响应耗时又会不一样。这里照跑一次
     PBKDF2-SHA256（与真库模式同一套参数），再恒返回 false。 */
  checkPassword: async () => {
    await new Promise((ok) => pbkdf2('skeleton', 'p3-skeleton-salt', 210000, 32, 'sha256', () => ok()));
    return false;
  },
  createUser: async () => { throw dbDown('用户'); },
  listComments: async () => { throw dbDown('评论'); },
  listCommentsByUser: async () => { throw dbDown('评论'); },
  createComment: async () => { throw dbDown('评论'); },
  commentForDelete: async () => { throw dbDown('评论'); },
  markCommentDeleted: async () => { throw dbDown('评论'); },
  /* 限流/审计在骨架模式下一律"放行但不记"：
     骨架模式本来就只有 /api/auth/me 可用，没有可保护的写操作；
     这里若抛错，会让 /api/auth/me 也变成 503（与"me 恒回 200"的契约冲突）。 */
  health: async () => 'down',
  authThrottleState: async () => ({ fails: 0, waitMs: 0, gated: false }),
  authThrottleFailure: async () => false,
  authThrottleSuccess: async () => false,
  authLog: async () => false,
  /* 访问统计在骨架模式下也明确拒绝（与评论/用户同一口径）：
     返回假数字会让"库没配好"看起来像"站点没人来"，是最难查的一类假象。 */
  statsHit: async () => { throw dbDown('访问统计'); },
  statsSummary: async () => { throw dbDown('访问统计'); },
  close: async () => {}
});

/**
 * 载入数据服务。
 *
 * 默认是**严格**的：缺任何一个 P3_DB_* 就抛错，让 main() 拒绝启动并打印缺哪几个。
 * 理由：静默降级到骨架模式 = 服务起来了、me 也回 200，但注册/登录/评论全都 503，
 * 而运维看到的横幅是"已启动"。这种"半边可用"比直接起不来难查得多，
 * 也违背"拒绝以任何默认身份启动"这条硬约束。
 *
 * 唯一的降级入口是**显式**的 --allow-degraded（本机没有 MySQL 时用）。
 *
 * 动态 import（变量路径）而不是静态 import：让"依赖没装/文件缺失"这件事
 * 变成一条可读的错误，而不是进程直接起不来。
 */
export const loadStores = async ({ log = () => {}, env = process.env, allowDegraded = false } = {}) => {
  const modPath = new URL('./lib/public/store.mjs', import.meta.url).href;
  let mod;
  try {
    mod = await import(modPath);
  } catch (err) {
    if (!allowDegraded) {
      throw new Error('载入 lib/public/store.mjs 失败：' + String((err && err.code) || (err && err.message)));
    }
    log('warn', '载入 lib/public/store.mjs 失败（' + String((err && err.code) || (err && err.message)) + '），按 --allow-degraded 走骨架模式');
    return createSkeletonStores();
  }
  if (typeof mod.createStores !== 'function') {
    if (!allowDegraded) throw new Error('lib/public/store.mjs 没有导出 createStores()');
    log('warn', 'lib/public/store.mjs 没有导出 createStores()，按 --allow-degraded 走骨架模式');
    return createSkeletonStores();
  }

  /* 先静态检查配置是否齐全：能给出"缺哪几个变量名"这种可直接照做的错误。 */
  if (typeof mod.missingDbEnv === 'function') {
    const missing = mod.missingDbEnv(env);
    if (missing.length) {
      if (!allowDegraded) throw new Error('缺少数据库配置：' + missing.join('、'));
      log('warn', '未配置 ' + missing.join('、') + '，按 --allow-degraded 走骨架模式（只有 /api/auth/me 可用）');
      return createSkeletonStores();
    }
  }

  try {
    const stores = await mod.createStores({ env, log });
    log('info', '数据服务已载入（' + (stores.mode || 'mysql') + '）');
    return stores;
  } catch (err) {
    /* 配置在、但池建不起来（例如 mysql2 没装）：**不**降级 ——
       这是需要人去修的部署问题，不是"可以凑合用"的状态。 */
    if (!allowDegraded) throw err;
    log('warn', '创建数据服务失败（' + String((err && err.message) || err) + '），按 --allow-degraded 走骨架模式');
    return createSkeletonStores();
  }
};

/* ------------------------------------------------------------
   认证限流（第二道：落库 auth_throttle）
   ------------------------------------------------------------
   HTTP 层已有一道内存窗口限流（进程重启即清零，挡的是瞬时洪峰）；
   这里再加一道落库的，跨进程重启仍然生效 —— 攻击者没法靠"等它重启"
   重置计数。阈值与 CONTRACT §0.6 一致。

   两道闸的分工不是冗余：
     · 内存那道在**读数据库之前**就挡住洪峰（不花钱）；
     · 落库那道管"慢慢试"（每小时几次、每天几百次这种洪峰看不出来的）。
   ------------------------------------------------------------ */
export const THROTTLE_POLICY = {
  login: { action: 'login', maxFails: 10, windowMs: 15 * 60 * 1000, gateMs: 60 * 60 * 1000 },
  /* 【注册：只计**失败**调用，5 次/6 小时 —— 保持原语义（审计 S4 已裁定本轮不修）】
     我一度改成"每次调用都计数 + 收紧到 3 次/6 小时"，那是拿可用性去换一条
     业主已经决定接受的风险：正常用户填错两次表单就会被挡在门外。
     现在恢复原样：成功不计数（成功后清零），失败才累加。
     S4 的两条残余（注册可枚举、无邮箱验证可批量造号）按业主决定**保持开放注册**，
     只作为已知风险记录在 AUDIT-public-login.md，不在本轮收紧。 */
  register: { action: 'register', maxFails: 5, windowMs: 6 * 60 * 60 * 1000, gateMs: 60 * 60 * 1000 }
};

/**
 * 把"唯一键冲突"翻译成可读的业务错误（409），**在 HTTP 层再兜一次**。
 *
 * 为什么要在这一层也兜：数据层（store.mjs）已经翻译过一遍，但 store 是
 * **可注入**的 —— 测试或集成时可能注入一个不带翻译的实现，那时
 * ER_DUP_ENTRY 会直接冒成 500「服务器内部错误」。而"这个用户名已被占用"
 * 是完全正常的业务结果：前端要把提示放到对应的输入框下面，不是报故障。
 * 兜在契约边上，比指望每个实现都记得翻译更可靠。
 */
const translateDuplicate = (err) => {
  if (!err || (err.code !== 'ER_DUP_ENTRY' && err.errno !== 1062)) return null;
  const hay = String(err.sqlMessage || err.message || '');
  if (/uk_users_username|'username'/i.test(hay)) return 'USERNAME_TAKEN';
  if (/uk_users_email|'email'/i.test(hay)) return 'EMAIL_TAKEN';
  /* 认不出撞的是哪个键：给一条不指名道姓但可读的冲突提示。
     绝不用"哪个字段有值"去猜 —— 猜错会把提示放到错误的输入框下面。 */
  return 'USERNAME_TAKEN';
};

/**
 * 审计与限流记账用的客户端 IP。
 *
 * 取值与"代理信任"严格绑定：
 *   · 有密钥且校验通过（--proxy-secret-file 生效）→ 用 ctx.ip（XFF 最后一段，
 *     即 nginx 亲自看到的那一跳）。密钥已经证明"这个请求确实经过我们的 nginx"，
 *     此时 XFF 是可信的，用它才能让审计日志与限流区分出不同的真实客户端。
 *   · 没有密钥 / 密钥未生效 → 用**直连对端**。此时 XFF 谁都能伪造，
 *     拿它记账等于让攻击者用假 IP 洗掉审计与限流。
 *
 * 为什么不能无条件用直连对端：反代之后那一列恒为 127.0.0.1，
 * 于是"同一个人连错 10 次"会变成"全世界共享一个计数器" ——
 * 既锁死正常用户，也让审计日志失去全部信息量。
 */
const auditIpOf = (ctx) => String(
  (ctx.trustProxy && ctx.ip)
  || (ctx.req && ctx.req.socket && ctx.req.socket.remoteAddress)
  || ctx.ip || 'unknown'
);

/**
 * "被访问的页面路径"——给访问统计的 path 列用。
 *
 * 为什么要从 Referer 取，而不是直接用 ctx.pathname：
 *   统计请求打的是 POST /api/stats/hit，所以 ctx.pathname 恒等于
 *   `/api/stats/hit`，记下来毫无信息量。真正想知道的是"哪一页被看了"，
 *   而浏览器发同源请求时会自动带 `Referer: http://<本站>/about.html`
 *   （默认 referrerPolicy 是 strict-origin-when-cross-origin，同源带全路径）。
 *
 * 三条纪律：
 *   · **只信同源**：Referer 的主机名必须与本次请求的 Host 一致，否则记空。
 *     （Host 本身已在 http.mjs 的白名单里校过，所以这里只需比对两者。）
 *   · **只当参考值**：客户端可以不发、也可以伪造它。所以任何计数、限流、
 *     授权都不许读这一列 —— 它只为"哪几篇受欢迎"服务。
 *   · 取不到就记空串，绝不因为 Referer 畸形而让整个统计请求失败。
 */
const pagePathOf = (ctx) => {
  const raw = String((ctx.req && ctx.req.headers && ctx.req.headers.referer) || '');
  if (!raw) return '';
  const hostname = (h) => String(h || '').split(':')[0].toLowerCase();
  try {
    const u = new URL(raw);
    if (hostname(u.host) !== hostname(ctx.req.headers.host)) return '';
    return u.pathname || '';
  } catch {
    return '';
  }
};

/** 触发熔断时抛出的错误（带 Retry-After，由 http.mjs 统一发出去） */
const rateLimited = (waitMs) => {
  const sec = Math.max(1, Math.ceil(waitMs / 1000));
  const err = fail('RATE_LIMITED', '操作过于频繁，请 ' + sec + ' 秒后再试');
  err.extra = { retryAfterSec: sec };
  return err;
};

/**
 * 认证写操作的事务性收尾：无论成功或失败都记 auth_log。
 *
 * 审计是旁路：写日志失败**不**改变认证结果（既不改状态码，也不改响应体），
 * 但**要留下一条服务端日志** —— 吞掉错误和"不影响业务"是两件事：
 * 前者只会让"审计从来没写成功"这件事在线上完全不可见。
 */
const withAuthLog = (ctx, action) => async (fn) => {
  const write = (entry) => ctx.services.authLog(entry).catch((logErr) => {
    ctx.log('warn', '写 auth_log 失败（不影响本次 ' + action + ' 结果）：' + String((logErr && logErr.code) || (logErr && logErr.message)));
    return false;
  });
  try {
    const out = await fn();
    await write({
      userId: out && out.userId != null ? out.userId : null,
      ip: auditIpOf(ctx),
      action,
      ok: true,
      detail: out && out.detail ? out.detail : null
    });
    return out;
  } catch (err) {
    await write({
      userId: null,
      ip: auditIpOf(ctx),
      action,
      ok: false,
      /* detail 只放"失败分类"，不放用户名/口令/哈希 —— 审计表是会被到处贴给人看的。 */
      detail: String((err && err.code) || (err && err.name) || 'error').slice(0, 32)
    });
    throw err;
  }
};

/* ------------------------------------------------------------
   路由
   ------------------------------------------------------------ */

/**
 * 构造路由表。handler 返回对象 = 200 + { ok:true, ... }；
 * 需要下发 cookie 时自己写 res 并返回 undefined（http.mjs 的约定）。
 */
export const buildRoutes = () => [
  /* ---------- GET /api/auth/me ----------
     "现在是谁"。没有会话就 200 + user:null，**不是** 401：
     前端每个页面都要问一次这个问题，401 会让浏览器控制台刷满红字，
     也会让"未登录"这个正常状态看起来像故障。
     库不可用时同样回 200 + null —— 查不到会话 = 未登录，这是一个真答案。 */
  route({
    method: 'GET', path: '/api/auth/me', auth: 'optional',
    handler: async (ctx) => ({
      user: ctx.user ? selfUser(ctx.user) : null,
      /* 明确告诉前端"库现在通不通"：库挂了却回一个正常的空评论列表，
         会让用户以为"我的评论被删了"。
         dbHealth() 是数据服务自己的探测（骨架模式恒 'down'），
         比"这个请求恰好有没有出错"更接近"库现在到底怎么样"。 */
      db: await ctx.dbHealth(),
      session_max_age_days: Math.round(SESSION_MAX_AGE_SEC / 86400)
    })
  }),

  /* ---------- POST /api/auth/register ---------- */
  route({
    method: 'POST', path: '/api/auth/register', auth: 'none',
    handler: async (ctx) => {
      /* 限流放在最前：校验也花 CPU，而"用垃圾请求打满 CPU"本身是攻击目标。
         注册按 IP 计数（同一台机器批量造号是主要威胁模型）。
         两道闸：内存窗口（ctx.rate）挡洪峰，落库的 auth_throttle 挡"慢慢试"。 */
      ctx.rate.assert('auth.register', 'ip:' + ctx.ip);
      const ip = auditIpOf(ctx);
      const policy = THROTTLE_POLICY.register;
      const gate = await ctx.services.authThrottleState(ip, policy.action, policy);
      if (gate.gated) throw rateLimited(gate.waitMs);

      /* 【注册：只计**失败**，成功不计数 —— 保持原语义（审计 S4 已裁定本轮不修）】
         我一度改成"每次调用都计数"，那会让正常用户填错两次表单就被挡在门外。
         S4 的两条残余（409 可枚举、无邮箱验证可批量造号）按业主决定保持开放注册，
         只作为已知风险记录，不在本轮收紧。 */
      const logAuth = withAuthLog(ctx, 'register');
      const username = validateUsername(ctx.body.username);
      const email = validateEmail(ctx.body.email);
      const password = validatePassword(ctx.body.password);

      return logAuth(async () => {
        let created;
        try {
          /* 明文口令只交给**这一处**：数据层内部立即算 PBKDF2 哈希，
             之后本进程再不引用它。日志、错误、响应体里都不会出现它。 */
          created = await ctx.services.createUser({ username, email, password, ip, ua: ctx.ua });
        } catch (err) {
          /* 唯一键冲突必须变成 409，而不是让 500 暴露驱动报错。
             数据层（store.mjs）已经翻译过一次；这里再兜一次是为了
             **注入的 store**（测试/集成）也能拿到契约规定的 409 —— 见 translateDuplicate。 */
          const code = (err && (err.code === 'USERNAME_TAKEN' || err.code === 'EMAIL_TAKEN')) ? err.code : translateDuplicate(err);
          if (code) throw fail(code, code === 'USERNAME_TAKEN' ? '这个用户名已被占用' : '这个邮箱已被注册');
          throw err;
        }

        /* 注册成功即登录：不给用户"注册完了再输一遍"的额外负担，
           也避免"注册成功但没登录"这种半完成状态被前端误当失败。 */
        const user = created.user || created;
        const sid = await ctx.services.createSession(user, { ip, ua: ctx.ua });
        if (!sid || !sid.id) throw dbDown('会话');

        /* 注册成功清零该 IP 的注册失败计数（原语义：只有失败才累加）。
           正常用户填错一次再成功，不该带着那次失败继续占额度。 */
        await ctx.services.authThrottleSuccess(ip, policy.action);
        ctx.setSessionCookie(sid.id);
        ctx.log('info', '注册成功 user=' + user.username + ' id=' + user.id + ' ip=' + ip);
        sendJson(ctx.res, 201, { ok: true, user: selfUser(user) });
        return { userId: user.id, detail: 'ok' };
      }).catch(async (err) => {
        /* 只有失败才落一次计数。注册的限流维度 = "这个 IP 失败了几次"。
           否则攻击者可以用"换个已占用的用户名"把注册接口当免费的用户名探测器。 */
        try { await ctx.services.authThrottleFailure(ip, policy.action, policy); } catch { /* 记账失败不改业务结果 */ }
        throw err;
      });
    }
  }),

  /* ---------- POST /api/auth/login ---------- */
  route({
    method: 'POST', path: '/api/auth/login', auth: 'none',
    handler: async (ctx) => {
      ctx.rate.assert('auth.login', 'ip:' + ctx.ip);
      const ip = auditIpOf(ctx);
      const policy = THROTTLE_POLICY.login;
      /* 落库退避（跨进程重启仍然生效）：被熔断时直接 429，
         连"口令对不对"都不再查 —— 否则攻击者可以靠响应时间/文案继续探。 */
      const gate = await ctx.services.authThrottleState(ip, policy.action, policy);
      if (gate.gated) throw rateLimited(gate.waitMs);

      /* 字段名按契约是 user。兼容 username/email/login 三个别名 ——
         它们是调用方最容易顺手写出来的名字，而**只**因为字段名不同就返回
         "请填写用户名或邮箱"，在公开面上会被当成服务故障而不是参数错误。
         别名只在读取时归一，响应形状不变。 */
      const rawLogin = ctx.body.user !== undefined ? ctx.body.user
        : (ctx.body.username !== undefined ? ctx.body.username
          : (ctx.body.email !== undefined ? ctx.body.email : ctx.body.login));
      const id = classifyLoginId(rawLogin);
      const password = validatePassword(ctx.body.password);

      const logAuth = withAuthLog(ctx, 'login');
      return logAuth(async () => {
        const row = await ctx.services.findUserByLogin(id.kind, id.value);
        /* 【账号枚举】用户不存在与口令错误必须是**同一个**响应：
           同一个状态码、同一个 code、同一句 message、同一段耗时。
           让"口令校验"在用户不存在时也跑一遍假哈希，是为了让耗时也一致 ——
           否则一个只看响应时间的攻击者照样能问出"这个用户名存在吗"。

           接口只留一个 checkPassword(plain, userRow)：
             userRow 为 null / status 非 active → 内部必须**照跑**一次 PBKDF2
             再返回 false（passwords.dummyVerify 就是这个假哈希）。 */
        const ok = await ctx.services.checkPassword(password, (row && row.status !== 'disabled') ? row : null);
        if (!ok) {
          ctx.log('info', '登录失败 ip=' + ip + ' id=' + id.kind);
          throw fail('INVALID_CREDENTIALS', '用户名或密码不正确');
        }

        /* 【口令哈希灰度升级，S5】这里已经是"验过且通过"之后，用**同一份明文**
           重算一次新参数并回写（老记录轮数偏低 / 换了算法时才真写库）。
           失败不影响登录：用户已经证明是本人，升级是我们的事。 */
        try {
          const upgraded = await ctx.services.upgradePasswordIfNeeded(password, row);
          if (upgraded) ctx.log('info', '口令哈希已升级到当前参数 user=' + row.username + ' id=' + row.id);
        } catch (err) {
          ctx.log('warn', '口令哈希升级失败（不影响本次登录）：' + String((err && err.code) || (err && err.message)));
        }

        const sid = await ctx.services.createSession(row, { ip, ua: ctx.ua });
        if (!sid || !sid.id) throw dbDown('会话');

        /* 登录成功清零该 IP 的失败计数（同一动作维度）。 */
        await ctx.services.authThrottleSuccess(ip, policy.action);
        ctx.setSessionCookie(sid.id);
        ctx.log('info', '登录成功 user=' + row.username + ' id=' + row.id + ' ip=' + ip);
        return { user: selfUser(row), userId: row.id, detail: 'ok' };
      }).catch(async (err) => {
        try { await ctx.services.authThrottleFailure(ip, policy.action, policy); } catch { /* 记账失败不改业务结果 */ }
        throw err;
      });
    }
  }),

  /* ---------- POST /api/auth/logout ---------- */
  route({
    method: 'POST', path: '/api/auth/logout', auth: 'none',
    handler: async (ctx) => {
      /* 登出**不要求**已登录：能带上 cookie 就销毁；带不上也要把 cookie 清掉。
         否则会话过期后用户会卡在"退不出去"的状态里（这正是管理面踩过的坑）。 */
      ctx.rate.assert('auth.logout', 'ip:' + ctx.ip);
      const sid = sessionIdFrom(ctx.req);
      let destroyed = false;
      let who = null;
      if (sid) {
        try {
          /* 先解析出"是谁在登出"，会话销毁之后就查不到了（审计要留住 user_id）。 */
          const s = await ctx.services.resolveSession(sid);
          who = s && s.user ? s.user.id : null;
          destroyed = Boolean(await ctx.services.destroySession(sid));
        } catch (err) {
          /* 登出时库挂了：cookie 一定要清（这是用户明确表达的意图），
             但要记一条日志，别让"会话仍在库里活着"这件事无声无息。 */
          if (!ctx.dbUnavailable(err)) throw err;
          ctx.log('warn', '登出时库不可用，仅清除 cookie');
        }
      }
      await ctx.services.authLog({
        userId: who, ip: auditIpOf(ctx), action: 'logout', ok: true,
        detail: destroyed ? 'destroyed' : 'no-session'
      }).catch((err) => {
        ctx.log('warn', '写 auth_log 失败（不影响 logout 结果）：' + String((err && err.code) || (err && err.message)));
        return false;
      });
      ctx.clearSessionCookie();
      sendJson(ctx.res, 200, { ok: true, destroyed });
      return undefined;
    }
  }),

  /* ---------- GET /api/comments?slug=xxx ---------- */
  route({
    method: 'GET', path: '/api/comments', auth: 'optional',
    handler: async (ctx) => {
      const slug = validateSlug(ctx.query.get('slug'));
      const rows = await ctx.services.listComments(slug);
      /* 数据层只返回 status='approved'，按 created_at 升序。
         这里再用 publicComment() **白名单**构造输出：
         不 spread 数据行 → password_hash / email 这类列没有机会漏出去。 */
      return { comments: (rows || []).map(publicComment) };
    }
  }),

  /* ---------- POST /api/comments ---------- */
  route({
    method: 'POST', path: '/api/comments', auth: 'required',
    handler: async (ctx) => {
      /* 按**用户**限流：公开面上一个登录账号就是一次写权限，
         同一个账号刷评论是最常见的滥用形态（IP 限流挡不住换 IP 的脚本）。 */
      ctx.rate.assert('comment.create', 'user:' + ctx.user.id);

      const slug = validateSlug(ctx.body.slug);
      const content = validateContent(ctx.body.content);
      const parentId = validateParentId(ctx.body.parent_id);

      const row = await ctx.services.createComment({
        slug,
        userId: ctx.user.id,
        parentId,
        content,
        ip: ctx.ip
      });
      ctx.log('info', '新增评论 id=' + (row && row.id) + ' slug=' + slug + ' user=' + ctx.user.id
        + (parentId ? ' parent=' + parentId : ''));
      sendJson(ctx.res, 201, { ok: true, comment: publicComment(row) });
      return undefined;
    }
  }),

  /* ---------- GET /api/comments/mine ----------
     【为什么需要它】右上角登录下拉里有「我的评论」这一项。缺了它，前端只能
     把整个站点的评论拉下来自己筛 —— 那是把"别人在别的文章下的评论"也发给
     浏览器，既浪费带宽又把不该由前端处理的数据给了前端。
     注意路由顺序：这条**必须**在 /api/comments/:id 之前被匹配到，
     由 http.mjs 的 findRoute 用"静态段权重"保证（不依赖注册顺序）。 */
  route({
    method: 'GET', path: '/api/comments/mine', auth: 'required',
    handler: async (ctx) => {
      const rows = await ctx.services.listCommentsByUser(ctx.user.id);
      return { comments: (rows || []).map(myComment) };
    }
  }),

  /* ---------- DELETE /api/comments/:id ---------- */
  route({
    method: 'DELETE', path: '/api/comments/:id', auth: 'required',
    handler: async (ctx) => {
      ctx.rate.assert('comment.delete', 'user:' + ctx.user.id);

      const id = validateCommentId(ctx.params.id);
      const row = await ctx.services.commentForDelete(id);
      /* 评论不存在 → 404；存在但不是我的 → 403。
         两者都不泄露评论内容之外的任何信息（内容本来就是公开的）。 */
      if (!row) throw fail('NOT_FOUND', '没有这条评论');
      if (row.status === 'deleted') throw fail('NOT_FOUND', '没有这条评论');

      const isOwner = Number(row.user_id) === Number(ctx.user.id);
      const isAdmin = ctx.user.role === 'admin';
      /* 【授权判定必须在服务端】前端"隐藏删除按钮"只是体验，不是控制。
         这里用 user_id 与 role 两条服务端判据，二者都不来自请求体。 */
      if (!isOwner && !isAdmin) throw fail('FORBIDDEN', '只能删除自己的评论');

      const changed = await ctx.services.markCommentDeleted(id, {
        byUserId: ctx.user.id,
        byRole: ctx.user.role
      });
      if (!changed) throw dbDown('评论');
      ctx.log('info', '软删评论 id=' + id + ' by=' + ctx.user.id + (isAdmin && !isOwner ? ' (admin)' : ''));
      return { deleted: id };
    }
  }),

  /* ---------- POST /api/stats/hit ----------
     访问统计：记一次访问，并把记完之后的汇总一起返回（前端一次请求拿到全部数字）。

     【为什么是 POST，不是 GET】
       GET 会被浏览器预取、被 CDN/中间层缓存、被爬虫与"链接预览"重放 ——
       那样统计出来的就不是"人看过"，而且重放会凭空灌水。计数是写操作，
       写操作走 POST；顺带吃到契约 §0.3 那条"写接口必须 application/json"，
       跨站表单（不需要预检的那种）也因此发不进来。

     【IP 从哪来，去了哪】
       用 auditIpOf(ctx)：只有反代密钥校验通过时才采信 XFF 的最后一段
       （nginx 亲自追加的 $remote_addr），否则用直连对端。明文 IP 只作为
       参数交给数据层，在那里当场 HMAC 成访客标识，不落库、不写日志。

     【path 记的是"被访问的页面"，不是这个接口自己】
       从同源 Referer 的 pathname 取（见 pagePathOf）；取不到或不同源就记空。
       它是参考值，不参与任何计数与判权。

     【限流】
       每 IP 每分钟 30 次（契约 §0.6）：正常浏览（一分钟点开 30 个页面）够用，
       脚本刷量会被挡住并拿到 429 + Retry-After。它不是安全闸，只是不让
       "总访问量"被人为灌水。 */
  route({
    method: 'POST', path: '/api/stats/hit', auth: 'none',
    handler: async (ctx) => {
      ctx.rate.assert('stats.hit', 'ip:' + ctx.ip);
      const stats = await ctx.services.statsHit({
        ip: auditIpOf(ctx),
        ua: ctx.ua,
        path: pagePathOf(ctx)
      });
      return { stats };
    }
  }),

  /* ---------- GET /api/stats ----------
     只读汇总，**不计数**。给"看一眼数字"、排障与将来的后台看板用；
     读接口不限流（契约 §0.6）。 */
  route({
    method: 'GET', path: '/api/stats', auth: 'none',
    handler: async (ctx) => ({ stats: await ctx.services.statsSummary() })
  })
];

/* ------------------------------------------------------------
   应用
   ------------------------------------------------------------ */
export const createPublicApp = async (options) => {
  const cfg = resolveConfig(options);
  const lines = [];
  const log = (...args) => {
    if (options && options.log === false) return;
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    lines.push(line);
    console.log('[public]' + (args[0] === 'error' || args[0] === 'warn' ? ' ' + args[0] : '') + ' ' + line);
  };

  const stores = cfg.stores || await loadStores({ log, allowDegraded: cfg.allowDegraded });
  const mode = stores.mode || (cfg.stores ? 'injected' : 'mysql');

  const allowedHosts = new Set(LOOPBACK_HOSTS);
  cfg.publicHosts.forEach((h) => {
    const n = String(h || '').trim().toLowerCase();
    if (n) allowedHosts.add(n);
  });
  const allowedOrigins = cfg.publicOrigins.length ? new Set(cfg.publicOrigins) : null;
  const cookieSecure = wantsSecureCookie(cfg.publicOrigins);

  const rate = createRateLimiter({ now: cfg.now });
  const routes = buildRoutes();

  /* 库挂了的判据：骨架模式恒为"挂"；真库模式下由错误码说话。
     /api/auth/me 靠它回 200 + null，其它端点靠它把 500 提升成 503。 */
  const dbUnavailable = (err) => {
    if (mode === 'skeleton') return true;
    if (!err) return false;
    return err.code === 'DB_UNAVAILABLE' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT'
      || err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ER_ACCESS_DENIED_ERROR'
      || err.fatal === true;
  };

  /* 给 /api/auth/me 用的库健康状态：优先用数据层自己的探测结果
     （它有缓存，不会让每个页面请求都去敲库），
     数据层没提供 health() 时退化为 'down'（宁可保守，也不假装库是好的）。 */
  const dbHealth = async () => {
    if (typeof stores.health === 'function') {
      try { return await stores.health(); }
      catch { return 'down'; }
    }
    return 'down';
  };

  const server = http.createServer((req, res) => {
    handleRequest(req, res, {
      routes,
      port: cfg.port,
      allowedHosts,
      allowedOrigins,
      cookieSecure,
      /* 生效值：只有密钥在场时才为 true（见 resolveConfig） */
      trustProxy: cfg.trustProxy,
      proxySecret: cfg.proxySecret,
      maxJson: cfg.maxJson,
      rate,
      services: stores,
      log,
      dbUnavailable,
      dbHealth
    }).catch((err) => {
      /* handleRequest 自己已经把预期错误发成了响应；这里只兜"连它也崩了"的情况。 */
      try { console.error('[public] 未捕获异常：', err); } catch { /* 忽略 */ }
      try {
        if (!res.headersSent) {
          res.writeHead(500, securityHeaders({ 'content-type': 'application/json; charset=utf-8' }));
        }
      } catch { /* 已断 */ }
      try { res.end(JSON.stringify(errorBody('INTERNAL', '服务器内部错误'))); } catch { /* 已断 */ }
    });
  });
  server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* 已断 */ }
  });

  return {
    server, cfg, routes, stores, rate, mode,
    cookieSecure, dbHealth,
    allowedHosts: Array.from(allowedHosts),
    allowedOrigins: allowedOrigins ? Array.from(allowedOrigins) : null,
    trustProxy: cfg.trustProxy,
    proxySecretConfigured: Boolean(cfg.proxySecret),
    log, lines,
    /* 端口 0 = 系统分配；Host 校验必须用真实端口，不能用配置里的 0 */
    setPort: (p) => { cfg.port = Number(p); },
    /* 优雅退出：关掉连接池与清理定时器（否则 systemd stop 会等到超时才杀） */
    close: () => (typeof stores.close === 'function' ? stores.close() : Promise.resolve())
  };
};

/* ------------------------------------------------------------
   启动横幅（纯函数，测试可直接调用）
   ------------------------------------------------------------
   与 dev-server.mjs 同样的理由：把"启动路径"变成可执行的判据。
   横幅里**不打印**任何库口令、cookie 值、会话 id。
   ------------------------------------------------------------ */
export const bannerLines = (cfg, app) => {
  const a = app || {};
  return [
    '',
    '  公开 API   http://' + cfg.host + ':' + cfg.port + '/api/',
    '  监听       ' + cfg.host + ':' + cfg.port + '（仅回环；公网入口由 nginx 反代）',
    '  数据服务   ' + (a.mode || '?') + (a.mode === 'skeleton' ? '  ← 只有 /api/auth/me 可用，其余端点 503' : ''),
    '  Cookie     ' + SESSION_COOKIE + '  HttpOnly + SameSite=Lax + Path=' + SESSION_COOKIE_PATH + ' + Max-Age '
      + Math.round(SESSION_MAX_AGE_SEC / 86400) + ' 天' + (a.cookieSecure ? ' + Secure' : '（无 Secure：当前 Origin 是 http）'),
    '  Origin     ' + ((cfg.publicOrigins || []).join(' ') || '（只认回环来源）'),
    '  代理信任   ' + (a.trustProxy
      ? '已启用（XFF 取最后一段；每个请求校验 x-admin-proxy-secret）'
      : (cfg.trustProxyRequested
        ? '⚠ 已请求但**强制关闭**（没有 --proxy-secret-file）：XFF 一律忽略，客户端 IP 取直连对端'
        : '关闭（XFF 一律忽略，客户端 IP 取直连对端）')),
    '  Host 白名单 ' + ((a.allowedHosts || LOOPBACK_HOSTS).join(' ')),
    '  限流       登录 ' + RATE_LIMITS['auth.login'].max + ' 次/' + (RATE_LIMITS['auth.login'].windowMs / 60000)
      + ' 分钟·每 IP；注册 ' + RATE_LIMITS['auth.register'].max + ' 次/小时·每 IP；发评论 '
      + RATE_LIMITS['comment.create'].max + ' 次/10 分钟·每用户',
    '  停止       Ctrl+C',
    ''
  ];
};

/* ------------------------------------------------------------
   CLI
   ------------------------------------------------------------ */
const isMain = (() => {
  try {
    const arg = process.argv[1] ? resolve(process.argv[1]) : '';
    return arg === resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

const main = async () => {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes('--' + n);
  const value = (n, d) => {
    const i = argv.indexOf('--' + n);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
  };
  const values = (n) => {
    const out = [];
    argv.forEach((a, i) => {
      if (a === '--' + n && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]);
    });
    return out;
  };

  /* ---- 反代共享密钥（--proxy-secret-file） ----
     与管理面 dev-server.mjs 的 --proxy-secret-file 是同一套做法、同一个理由：
     开了 --trust-proxy 之后客户端 IP 取自 X-Forwarded-For，而**本机任何进程**
     都能直连 127.0.0.1:8850 伪造整个 XFF —— IP 限流会被逐个假 IP 绕过，
     审计日志也会记下假 IP。密钥把"本机可达"收窄成"只有我们的 nginx 可达"。

     三种情况刻意分开（见 CONTRACT §0.7）：给了参数就必须能用（fail-fast），
     否则一条打错的路径会静默退化成"不校验密钥但仍然信任 XFF"。 */
  const secretFile = value('proxy-secret-file', '');
  let proxySecret = null;
  if (secretFile) {
    try {
      proxySecret = (await readFile(secretFile, 'utf8')).trim();
    } catch (err) {
      console.error('拒绝启动：读不到反代密钥文件 ' + secretFile + '（' + String((err && err.code) || (err && err.message)) + '）。');
      console.error('  生成方式：openssl rand -hex 32 > /etc/p3blog/public-proxy-secret && chmod 640 /etc/p3blog/public-proxy-secret');
      process.exit(7);
    }
    if (!proxySecret) {
      console.error('拒绝启动：反代密钥文件 ' + secretFile + ' 是空的。');
      console.error('  空密钥等于"任何请求都能过"，比不配密钥更危险（不配至少还会关闭 XFF 信任）。');
      console.error('  生成方式：openssl rand -hex 32 > ' + secretFile);
      process.exit(7);
    }
    if (proxySecret.length < 32) {
      console.error('拒绝启动：反代密钥太短（' + proxySecret.length + ' 字符，至少 32）。文件：' + secretFile);
      process.exit(7);
    }
  } else if (flag('trust-proxy')) {
    /* 情况 3：显式告警。绝不静默 —— "开了 --trust-proxy 却没有密钥"
       恰恰是最容易被误以为"限流已经按真实 IP 生效"的状态。 */
    console.warn('⚠ 警告：指定了 --trust-proxy 但没有 --proxy-secret-file。');
    console.warn('  代理信任已**强制关闭**：X-Forwarded-For 一律忽略，客户端 IP 取直连对端。');
    console.warn('  带来的后果：所有请求（含 nginx 转发的）都会算到 127.0.0.1 这一个桶上 ——');
    console.warn('  本机任何进程连错 10 次口令就能把全站的登录限流锁死。');
    console.warn('  生产部署必须同时给 --proxy-secret-file（见 deploy/PLAN-PUBLIC-LOGIN.md）。');
  }

  const cfg = resolveConfig({
    host: value('listen', process.env.P3_LISTEN || '127.0.0.1'),
    port: value('port', process.env.P3_PORT || 8850),
    publicHosts: values('public-host'),
    publicOrigins: values('public-origin'),
    trustProxy: flag('trust-proxy'),
    proxySecret,
    allowDegraded: flag('allow-degraded')
  });

  /* 【硬性拒绝绑 0.0.0.0】配置写错一个字符，就把"只有 nginx 能到"的应用
     直接挂到公网上，而且它背后的库也一起暴露。宁可起不来。 */
  if (cfg.host !== '127.0.0.1' && cfg.host !== '::1' && cfg.host !== 'localhost') {
    console.error('拒绝启动：公开服务只能监听回环（--listen 127.0.0.1 或 ::1）。');
    console.error('  公网入口请用 nginx 反代到 127.0.0.1:' + cfg.port + ' —— 见 deploy/PLAN-PUBLIC-LOGIN.md。');
    process.exit(4);
  }

  /* 【配置不全就拒绝启动】这是硬约束：绝不回退默认口令、绝不回退 root、
     绝不"起来了但注册登录全 503"。要让缺配置这件事在部署那一刻就炸，
     而不是等用户点了注册才发现。本机没有 MySQL 时用 --allow-degraded 显式降级。 */
  let app;
  try {
    app = await createPublicApp(cfg);
  } catch (err) {
    console.error('拒绝启动：' + String((err && err.message) || err));
    console.error('  配置来源：环境变量（部署时由 systemd 的 EnvironmentFile=/etc/p3blog/public.env 注入）。');
    console.error('  本机没有 MySQL、只想看路由与错误形状：node blog-enter/server/public-server.mjs --allow-degraded');
    process.exit(6);
  }

  if (flag('print-config')) {
    console.log(JSON.stringify({
      host: cfg.host, port: cfg.port, mode: app.mode,
      allowDegraded: cfg.allowDegraded,
      allowedHosts: app.allowedHosts, allowedOrigins: app.allowedOrigins,
      cookieSecure: app.cookieSecure, cookie: SESSION_COOKIE,
      sessionMaxAgeDays: Math.round(SESSION_MAX_AGE_SEC / 86400),
      db: app.stores && app.stores.summary ? app.stores.summary : null,
      trustProxy: app.trustProxy,
      trustProxyRequested: cfg.trustProxyRequested,
      proxySecretConfigured: app.proxySecretConfigured,
      routes: app.routes.map((r) => r.method + ' ' + r.path + ' (' + r.auth + ')'),
      errorCodes: ERROR_CODES,
      rateLimits: RATE_LIMITS,
      throttlePolicies: THROTTLE_POLICY
    }, null, 2));
    return;
  }

  app.server.listen(cfg.port, cfg.host, () => {
    bannerLines(cfg, app).forEach((l) => console.log(l));
  });
  app.server.on('error', (err) => {
    console.error('监听失败：' + err.message);
    process.exit(5);
  });

  const shutdown = () => {
    /* 先关监听，再关连接池：反过来会让"正在处理的请求"拿到已关闭的池。 */
    try {
      app.server.close(() => { app.close().finally(() => process.exit(0)); });
    } catch {
      app.close().finally(() => process.exit(0));
    }
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

if (isMain) {
  main().catch((err) => { console.error('启动异常：', err); process.exit(1); });
}
