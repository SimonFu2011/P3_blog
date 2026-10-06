#!/usr/bin/env node
/* ============================================================
   t16 独立验证：公开登录 / 注册 / 评论（本地端到端 + 线上真实 HTTP）
   ------------------------------------------------------------
   谁写它：verifier（t16），**不参与实现**。所以这个文件里：
     · 不 import 任何"被验的"业务逻辑去自己证明自己；
     · 期望值（状态码、错误码、cookie 属性、限流阈值、响应键集合）全部
       从 blog-enter/server/CONTRACT-public-api.md 抄下来，硬编码在这里 ——
       验证脚本必须"先有判据，再看实现"，而不是"实现什么样就断言什么样"；
     · 本地模式只动态 import 一次 createPublicApp()（要起真 HTTP 服务），
       外加 http.mjs 的 fail() 给内存假 store 造 ApiError。线上模式零产品依赖。

   两种模式
   --------
   A) 本地（默认）：内存假 store + 真实 http.Server，把 7 个端点 + mine 的
      成功与失败路径逐条打一遍；外加 5 个页面的静态结构检查（t12 产物）。

        node blog-enter/server/tests/verify-public-live.mjs --local
        node blog-enter/server/tests/verify-public-live.mjs --local --static-only

   B) 线上：对给定 base 跑真实 HTTP 闭环 —— 注册 → 登录 → 发评论 → 列表可见
      → 删自己的 → 列表不可见 → 退出 → 旧 cookie 401；两个账号验跨账号删除 403
      且目标仍在；未登录删除 401；错误口令连打触发 429；并核对库里行数。

        # 从本机打公网入口（每次最多 2 个注册，登录限流会临时锁本机 IP 1 小时）
        node blog-enter/server/tests/verify-public-live.mjs --base http://43.108.100.116 --ssh root@43.108.100.116

        # 打回环端口（在服务器上跑；--sql-local 用 /etc/my.cnf [client] 的凭据）
        node /tmp/t16-verify-public-live.mjs --base http://127.0.0.1:8850 --sql-local

   自检（部署前预演"线上那段代码路径"，用本进程内存 store 起一个服务）：
        node blog-enter/server/tests/verify-public-live.mjs --shim

   写进报告的每一项都是「判据 → 命令 → 实际结果 → 通过/失败」。
   失败项的命令一栏就是最小复现（curl/fetch 形状），可直接照抄重跑。

   自清理与可重复
   --------------
   · 每轮的账号名/评论内容/slug 都带随机 runId（t16v<6 hex>），不会撞上一轮的残留；
   · 退出时软删自己的评论（API），并用 --ssh/--sql-local 提供的通道删除
     本轮的用户行（外键级联会带走会话与评论）；没有 SQL 通道时打印残留清理 SQL；
   · --keep-data 可跳过清理（人工看数据时用）；--skip-rate-limit 可在
     本机 IP 已被限流的情况下跳过 429 那一段（跳过会被记为 FAIL，不隐瞒）。

   退出码：0 全过 · 1 有失败项 · 2 用法错误
   ============================================================ */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // …/blog-enter/server/tests
const BLOG_DIR = resolve(HERE, '..', '..');           // …/blog-enter
const REPO_DIR = resolve(BLOG_DIR, '..');             // …（仓库根）

/* ------------------------------------------------------------
   0. CLI
   ------------------------------------------------------------ */
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

if (flag('help') || flag('h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('/* ============================================================')[1]
    .split('============================================================ */')[0]);
  process.exit(0);
}

const BASES = values('base');
const SHIM = flag('shim');
const SKELETON = flag('skeleton');
/* 模式：默认 = 线上（基址默认 127.0.0.1:8850，用 --base 换成公网入口或其他地址）；
   --local        = 本进程内存 store 的全端点套件（107 项）
   --skeleton     = 真子进程骨架模式端到端（--allow-degraded --port 18861）
   --static-only  = 只跑静态结构检查
   --shim         = 线上代码路径自检（本进程内存 store 当后端） */
const MODE = SHIM
  ? 'live'
  : (BASES.length
    ? 'live'
    : (SKELETON
      ? 'skeleton'
      : (flag('static-only') ? 'static' : (flag('local') ? 'local' : 'live'))));
if (MODE === 'live' && !SHIM && !BASES.length) BASES.push('http://127.0.0.1:8850');
const SSH_TARGET = value('ssh', '');
const SQL_LOCAL = flag('sql-local');
const HAS_SQL = Boolean(SSH_TARGET || SQL_LOCAL);
const KEEP_DATA = flag('keep-data');
const SKIP_RATE_LIMIT = flag('skip-rate-limit');
const OUT_PATH = value('out', '');
const RUN_ID = randomBytes(3).toString('hex');
const MARKER = 't16v' + RUN_ID;            // 用户名/邮箱/内容前缀
const CONTENT_TAG = 't16v-' + RUN_ID;      // 评论内容里的标记

/* ------------------------------------------------------------
   1. 报告
   ------------------------------------------------------------ */
const ROWS = [];
const trunc = (s, n = 300) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '…' : t;
};
const say = (...a) => console.log(...a);

const record = ({ id, criterion, command, expected, actual, pass, group }) => {
  ROWS.push({ id, criterion, command, expected, actual, pass, group: group || CURRENT_GROUP });
  if (pass) {
    say(`[PASS] ${id} ${criterion}`);
    say(`       命令: ${command}`);
    say(`       实测: ${trunc(actual, 300)}`);
  } else {
    say(`[FAIL] ${id} ${criterion}`);
    say(`       命令: ${command}`);
    say(`       期望: ${trunc(expected, 300)}`);
    say(`       实测: ${trunc(actual, 400)}`);
  }
};

/** 不适用（环境/通道缺失）：既不算通过也不算失败，但要如实记进报告 */
const notApplicable = (id, criterion, command, reason) => {
  ROWS.push({ id, criterion, command, expected: '（不适用）', actual: reason, pass: true, na: true, group: CURRENT_GROUP });
  say(`[NA]   ${id} ${criterion}`);
  say(`       命令: ${command}`);
  say(`       说明: ${reason}`);
};

let CURRENT_GROUP = '';
const group = async (title, fn) => {
  CURRENT_GROUP = title;
  say('\n──── ' + title + ' ────');
  try {
    await fn();
  } catch (err) {
    if (err instanceof AbortGroup) {
      record({
        id: '—', criterion: '本组闭环未完成：' + err.message,
        command: '（见本组前面失败的项）', expected: '前置检查全部通过',
        actual: '前置失败，后续断言未执行', pass: false
      });
      return;
    }
    throw err; // 脚本自身的 bug：让它炸出来，别伪装成"某项失败"
  }
};

class CheckFailure extends Error {
  constructor(expectation, observed) { super(expectation); this.name = 'CheckFailure'; this.observed = observed; }
}
class AbortGroup extends Error {}

const must = (cond, expectation, observed) => {
  if (!cond) throw new CheckFailure(expectation, observed);
};
const need = (v, what) => {
  if (v === undefined || v === null || v === '') throw new AbortGroup(what || '前置依赖未就绪');
  return v;
};

const describeAny = (v) => {
  if (v && typeof v === 'object' && typeof v.status === 'number') {
    return `HTTP ${v.status} ${trunc(JSON.stringify(v.body !== undefined ? v.body : v.text), 300)}`;
  }
  if (typeof v === 'string') return trunc(v, 300);
  try { return trunc(JSON.stringify(v), 300); } catch { return String(v); }
};

/** 一条检查。fn 里用 must() 断言，返回一句"实测"描述（可选）。 */
const it = async (id, criterion, command, fn) => {
  try {
    const actual = await fn();
    record({ id, criterion, command, actual: actual === undefined ? 'OK' : actual, expected: '按契约', pass: true });
    return actual;
  } catch (err) {
    if (err instanceof AbortGroup) throw err;
    if (err instanceof CheckFailure) {
      record({ id, criterion, command, expected: err.message, actual: describeAny(err.observed), pass: false });
    } else {
      record({ id, criterion, command, expected: '按契约', actual: trunc((err && err.stack) || String(err), 400), pass: false });
    }
    return undefined;
  }
};

/** 失败路径的统一断言：状态码 + code + 冻结形状（顺带累计形状检查次数） */
let SHAPE_CHECKED = 0;
const expectFail = (id, criterion, command, res, status, code) => it(id, criterion, command, () => {
  must(res.status === status, `应回 HTTP ${status}`, res);
  must(res.body && res.body.ok === false, '失败体必须 ok:false', res);
  must(res.body && res.body.error && res.body.error.code === code,
    `error.code 应为 ${code}`, res);
  must(JSON.stringify(Object.keys(res.body).sort()) === '["error","ok"]',
    '失败体顶层键集合必须恰为 ["ok","error"]', res);
  must(JSON.stringify(Object.keys(res.body.error).sort()) === '["code","message"]',
    'error 键集合必须恰为 ["code","message"]', res);
  must(res.headers.get('content-type') === 'application/json; charset=utf-8',
    'Content-Type 必须是 application/json; charset=utf-8', res);
  SHAPE_CHECKED += 1;
  return `HTTP ${status} ${code} ${JSON.stringify(res.body.error)}`;
});

/* ------------------------------------------------------------
   2. 小工具（口令哈希按契约 §4.0 的存储格式自实现，不 import 产品代码）
   ------------------------------------------------------------ */
const ALGO = 'pbkdf2-sha256';
/* 契约 §4.0（t21 起）：600000 轮（原 210000，审计 S5 加严）。假 store 用同一套参数，
   这样"库里存的是契约格式"这条断言验的才是契约，而不是我自己的常量。 */
const ITERS = 600000;

const sha256hex = (s) => createHash('sha256').update(String(s)).digest('hex');
const hex64 = () => randomBytes(32).toString('hex');

const hashPassword = (plain, salt = randomBytes(16)) => {
  const key = pbkdf2Sync(String(plain), salt, ITERS, 32, 'sha256');
  return `${ALGO}$${ITERS}$${salt.toString('base64')}$${key.toString('base64')}`;
};
const verifyPassword = (plain, stored) => {
  const parts = String(stored == null ? '' : stored).split('$');
  if (parts.length !== 4 || parts[0] !== ALGO) return false;
  const want = Buffer.from(parts[3], 'base64');
  const got = pbkdf2Sync(String(plain), Buffer.from(parts[2], 'base64'), Number(parts[1]), want.length, 'sha256');
  return got.length === want.length && timingSafeEqual(got, want);
};

/** 裸 HTTP：需要自己控制 Host / Origin / X-Forwarded-For / 不带 Content-Type 时用它 */
const rawSend = (port, method, path, headers, body) => new Promise((ok, bail) => {
  const payload = body == null ? null : Buffer.from(String(body), 'utf8');
  const h = Object.assign({}, headers || {});
  if (payload) h['content-length'] = String(payload.length);
  const req = http.request({ host: '127.0.0.1', port, path, method, setHost: false, headers: h }, (res) => {
    let out = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { out += c; });
    res.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* 非 JSON */ }
      ok({ status: res.statusCode, headers: res.headers, text: out, body: parsed,
        setCookies: res.headers['set-cookie'] || [] });
    });
  });
  req.on('error', bail);
  if (payload) req.write(payload);
  req.end();
});

/** fetch 版调用器：返回 {status, headers, body, text, setCookies, sessionCookie} */
const makeCaller = (base) => async (path, opts = {}) => {
  const o = { method: opts.method || 'GET', headers: Object.assign({}, opts.headers || {}) };
  if (opts.cookie) o.headers.cookie = opts.cookie;
  if (opts.body !== undefined) {
    o.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    if (opts.contentType !== null && !Object.keys(o.headers).some((k) => k.toLowerCase() === 'content-type')) {
      o.headers['content-type'] = opts.contentType || 'application/json';
    }
  }
  const res = await fetch(base + path, o);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON */ }
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  const sessionCookie = (setCookies.find((c) => /^p3_uid=/.test(c)) || '').split(';')[0];
  return { status: res.status, headers: res.headers, body, text, setCookies, sessionCookie };
};

/** 剥掉 // 与 块注释：用来判断"某个危险 API 是否真的被使用"（注释里提到不算） */
const stripJsComments = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const P3_ENV_KEYS = ['P3_DB_HOST', 'P3_DB_PORT', 'P3_DB_NAME', 'P3_DB_USER', 'P3_DB_PASSWORD',
  'P3_LISTEN', 'P3_PORT', 'P3_SESSION_MAX_AGE_DAYS'];

/** 起子进程跑 CLI：默认把继承来的 P3_* 全部清掉（否则本机环境会悄悄改变被测行为） */
const runCli = (args, env = {}) => {
  const e = Object.assign({}, process.env, env);
  for (const k of P3_ENV_KEYS) if (!(k in env)) delete e[k];
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', env: e, timeout: 120000 });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : -1,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || '')
    };
  }
};

/* ------------------------------------------------------------
   3. 本地：内存假 store（按 CONTRACT §4 的方法表 + §4.0 的存储语义）
   ------------------------------------------------------------ */
const makeMemoryStores = ({ fail, down = false, boom = false, noThrottleGate = false, throttleGate = false } = {}) => {
  const users = new Map();
  const sessions = new Map();
  const comments = new Map();
  const throttle = new Map();
  const authLogRows = [];
  /* 访问统计：STATS_DAY 固定成一个确定值，断言里就不必跟着系统时间跑 */
  const statsRows = [];
  const STATS_DAY = '2026-10-06';
  const calls = { findUserByLogin: 0, createUser: 0, createSession: 0, createComment: 0, resolveSession: 0, markCommentDeleted: 0 };
  let nextUserId = 1;
  let nextCommentId = 1;

  const downErr = (what) => fail('DB_UNAVAILABLE', '数据服务暂时不可用（' + what + '）');
  const up = (what) => { if (down) throw downErr(what); };
  const dup = (key) => {
    const e = new Error(`Duplicate entry 'x' for key '${key}'`);
    e.code = 'ER_DUP_ENTRY';
    e.errno = 1062;
    e.sqlMessage = `Duplicate entry 'x' for key '${key}'`;
    return e;
  };
  const userOf = (id) => (users.get(id) ? Object.assign({}, users.get(id)) : null);
  const withAuthor = (c) => Object.assign({}, c, {
    username: (users.get(c.user_id) || {}).username || '',
    avatar: (users.get(c.user_id) || {}).avatar == null ? null : users.get(c.user_id).avatar
  });
  const sansSecrets = (row) => {
    const out = Object.assign({}, row);
    delete out.password_hash;
    delete out.password_algo;
    return out;
  };

  return {
    mode: 'memory-verify',
    users, sessions, comments, throttle, authLogRows, calls, statsRows,

    /** 直接塞一行用户（绕开 register 的限流，用于给别的场景铺数据） */
    seedUser({ username, email, password = 'a-good-password', role = 'user', status = 'active' }) {
      const u = {
        id: nextUserId++, username, email,
        password_hash: hashPassword(password), password_algo: ALGO,
        avatar: null, role, status, created_at: new Date()
      };
      users.set(u.id, u);
      const safe = sansSecrets(u);
      safe.__plain = password;
      return safe;
    },
    seedComment({ slug, userId, parentId = null, content, status = 'approved', at }) {
      const id = nextCommentId++;
      comments.set(id, {
        id, slug, user_id: userId, parent_id: parentId, content, status,
        created_at: at instanceof Date ? at : new Date()
      });
      return id;
    },

    async health() { return down ? 'down' : 'up'; },

    async resolveSession(token) {
      calls.resolveSession += 1;
      up('会话');
      const rec = sessions.get(sha256hex(token));
      if (!rec) return null;
      if (rec.expiresAt.getTime() <= Date.now()) { sessions.delete(sha256hex(token)); return null; }
      const u = userOf(rec.userId);
      if (!u || u.status === 'disabled') return null;
      return { sessionId: sha256hex(token), expiresAt: rec.expiresAt, user: u };
    },
    async createSession(user, { ip, ua } = {}) {
      calls.createSession += 1;
      up('会话');
      const token = hex64();
      const expiresAt = new Date(Date.now() + 30 * 86400_000);
      sessions.set(sha256hex(token), { userId: user.id, ip: ip || null, ua: ua || '', expiresAt });
      return { id: token, expiresAt };
    },
    async destroySession(token) { up('会话'); return sessions.delete(sha256hex(token)); },

    async findUserByLogin(kind, value) {
      calls.findUserByLogin += 1;
      up('用户');
      for (const u of users.values()) {
        if (kind === 'email' && String(u.email).toLowerCase() === String(value).toLowerCase()) return Object.assign({}, u);
        if (kind === 'username' && u.username.toLowerCase() === String(value).toLowerCase()) return Object.assign({}, u);
      }
      return null;
    },
    /** 与 passwords.checkAgainstUser 同语义：没有行也要照跑一次 PBKDF2（耗时对齐） */
    async checkPassword(plain, row) {
      if (!row || !row.password_hash) {
        pbkdf2Sync(String(plain == null ? '' : plain), Buffer.from('p3-dummy-salt'), ITERS, 32, 'sha256');
        return false;
      }
      return verifyPassword(plain, row.password_hash);
    },
    async createUser({ username, email, password }) {
      calls.createUser += 1;
      if (boom) throw new Error('verify-boom-should-never-leak');
      up('用户');
      /* 复刻 utf8mb4_unicode_ci：用户名/邮箱大小写不敏感 */
      for (const u of users.values()) {
        if (u.username.toLowerCase() === String(username).toLowerCase()) throw dup('uk_users_username');
        if (String(u.email).toLowerCase() === String(email).toLowerCase()) throw dup('uk_users_email');
      }
      const u = {
        id: nextUserId++, username, email,
        password_hash: hashPassword(password), password_algo: ALGO,
        avatar: null, role: 'user', status: 'active', created_at: new Date()
      };
      users.set(u.id, u);
      const safe = sansSecrets(u);
      safe.__plain = password;
      return { user: safe };
    },

    async listComments(slug) {
      up('评论');
      return [...comments.values()]
        .filter((c) => c.slug === slug && c.status === 'approved')
        .sort((a, b) => (a.created_at - b.created_at) || (a.id - b.id))
        .map(withAuthor);
    },
    async listCommentsByUser(userId) {
      up('评论');
      return [...comments.values()]
        .filter((c) => c.user_id === userId && c.status === 'approved')
        .sort((a, b) => (b.created_at - a.created_at) || (b.id - a.id))
        .map(withAuthor);
    },
    async createComment({ slug, userId, parentId, content }) {
      calls.createComment += 1;
      up('评论');
      if (parentId != null) {
        const p = comments.get(parentId);
        if (!p || p.slug !== slug || p.status !== 'approved') {
          throw fail('INVALID_PARENT', '要回复的评论不存在或不属于这篇文章');
        }
      }
      const c = {
        id: nextCommentId++, slug, user_id: userId,
        parent_id: parentId == null ? null : parentId, content,
        status: 'approved', created_at: new Date()
      };
      comments.set(c.id, c);
      return withAuthor(c);
    },
    async commentForDelete(id) {
      up('评论');
      const c = comments.get(Number(id));
      return c ? Object.assign({}, c) : null;
    },
    async markCommentDeleted(id, { byUserId, byRole }) {
      calls.markCommentDeleted += 1;
      up('评论');
      const c = comments.get(Number(id));
      if (!c || c.status === 'deleted') return false;
      if (byRole !== 'admin' && Number(c.user_id) !== Number(byUserId)) return false;
      c.status = 'deleted';
      return true;
    },

    /* 落库限流（第二道闸）。语义严格对齐 userstore.throttleState：
       只有"窗口已过 / gate 已过期"才清零，窗口内的失败计数必须留住 ——
       否则计数永远回不到阈值，熔断就成了摆设（这个坑我在自己的假 store 里踩过一次）。

       throttleGate=false（默认）：只记账、永不返回 gated。
         这是**故意的**：验"单次请求语义"（缺字段、超长、越权…）时不能让前一条用例
         攒下的失败计数把后一条遮成 429 —— 那样测的就成了"限流"而不是"这条路径本身"。
       throttleGate=true：完整复刻真实现（达到 policy.maxFails 就 gated），
         专供"库内熔断"与"限流值的后果"那几条用例。 */
    async authThrottleState(ip, action, policy = {}) {
      if (noThrottleGate) return { fails: 0, waitMs: 0, gated: false };
      const key = ip + '|' + action;
      const rec = throttle.get(key);
      if (!rec) return { fails: 0, waitMs: 0, gated: false };
      if (!throttleGate) return { fails: rec.fails, waitMs: 0, gated: false };
      if (rec.gateUntil > Date.now()) return { fails: rec.fails, waitMs: rec.gateUntil - Date.now(), gated: true };
      const windowMs = policy.windowMs || 15 * 60 * 1000;
      if (rec.gateUntil === 0 && rec.fails > 0 && rec.fails * 60_000 > windowMs) {
        throttle.delete(key);
        return { fails: 0, waitMs: 0, gated: false };
      }
      if (rec.gateUntil > 0) { throttle.delete(key); return { fails: 0, waitMs: 0, gated: false }; }
      return { fails: rec.fails, waitMs: 0, gated: false };
    },
    async authThrottleFailure(ip, action, policy) {
      const key = ip + '|' + action;
      const rec = throttle.get(key) || { fails: 0, gateUntil: 0 };
      rec.fails += 1;
      if (rec.fails >= ((policy && policy.maxFails) || 10)) rec.gateUntil = Date.now() + ((policy && policy.gateMs) || 3600_000);
      throttle.set(key, rec);
      return true;
    },
    async authThrottleSuccess(ip, action) { return throttle.delete(ip + '|' + action); },
    async authLog(entry) { authLogRows.push(entry); return true; },
    /* 访问统计（契约 §1.8 / §1.9）：形状与真实现一致。
       真实现的 HMAC + SQL 由 public-api.test.mjs 的"六之二"用假 db 句柄单测；
       这里只提供"记一次、能汇总"的行为，供 HTTP 层与前端接线验证。 */
    statsRows,
    async statsHit({ ip, ua, path }) {
      statsRows.push({ ip, ua, path, day: STATS_DAY });
      return { total: statsRows.length, today: statsRows.length, visitors: statsRows.length ? 1 : 0, day: STATS_DAY };
    },
    async statsSummary() {
      const n = statsRows.length;
      return { total: n, today: n, visitors: n ? 1 : 0, day: STATS_DAY };
    },
    async close() {}
  };
};

/* ------------------------------------------------------------
   4. 本地 A 部分
   ------------------------------------------------------------ */
const localDeps = async () => {
  const httpLib = await import('../lib/public/http.mjs');
  const server = await import('../public-server.mjs');
  return { fail: httpLib.fail, createPublicApp: server.createPublicApp };
};

const startLocal = async (deps, stores) => {
  const app = await deps.createPublicApp({
    port: 0, log: false, stores,
    publicOrigins: ['http://127.0.0.1']
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  app.setPort(port);
  const base = 'http://127.0.0.1:' + port;
  return { app, stores, port, base, call: makeCaller(base) };
};

const stopLocal = async (h) => { try { h.app.server.close(); } catch { /* 已关 */ } await h.app.close(); };

const runLocalStatic = async () => {
  const modules = [
    'public-server.mjs',
    'lib/public/http.mjs', 'lib/public/db.mjs', 'lib/public/passwords.mjs',
    'lib/public/userstore.mjs', 'lib/public/commentstore.mjs', 'lib/public/store.mjs'
  ];
  await group('本地 0：语法检查与启动路径（CLI）', async () => {
    for (const m of modules) {
      const r = runCli(['--check', join(BLOG_DIR, 'server', m)]);
      await it('A-00-' + m.replace(/\W+/g, '_'), `node --check ${m}`,
        `node --check blog-enter/server/${m}`, () => {
          must(r.code === 0, 'node --check 必须 exit 0', { status: r.code, text: r.stderr });
          return `exit ${r.code}`;
        });
    }

    await it('A-01', '--print-config（骨架模式）暴露的常量与契约一致：9 条路由 + mine / cookie 名 / 限流阈值 / 会话天数',
      'node public-server.mjs --allow-degraded --print-config', () => {
        const r = runCli([join(BLOG_DIR, 'server', 'public-server.mjs'), '--allow-degraded', '--print-config'], {});
        must(r.code === 0, 'exit 0', { status: r.code, text: r.stderr });
        /* 服务会在 JSON 之前打印日志行（[public] …），所以取最后一段 JSON */
        const start = r.stdout.indexOf('{');
        must(start >= 0, '--print-config 必须打印 JSON（实测 stdout 里没有 {）', r.stdout.slice(0, 200));
        const cfg = JSON.parse(r.stdout.slice(start));
        const routes = cfg.routes.slice().sort();
        const want = [
          'DELETE /api/comments/:id (required)',
          'GET /api/auth/me (optional)',
          'GET /api/comments (optional)',
          'GET /api/comments/mine (required)',
          'GET /api/stats (none)',
          'POST /api/auth/login (none)',
          'POST /api/auth/logout (none)',
          'POST /api/auth/register (none)',
          'POST /api/comments (required)',
          'POST /api/stats/hit (none)'
        ].sort();
        must(JSON.stringify(routes) === JSON.stringify(want), '路由表必须恰为契约的 9 个端点 + mine', routes);
        must(cfg.cookie === 'p3_uid', 'cookie 名必须是 p3_uid', cfg.cookie);
        must(cfg.sessionMaxAgeDays === 30, '会话 30 天', cfg.sessionMaxAgeDays);
        must(cfg.rateLimits['auth.login'].max === 10 && cfg.rateLimits['auth.login'].windowMs === 900000,
          '登录限流 10 次/15 分钟', cfg.rateLimits['auth.login']);
        must(cfg.rateLimits['auth.register'].max === 5 && cfg.rateLimits['auth.register'].windowMs === 3600000
          && cfg.rateLimits['auth.register'].blockMs === 3600000,
        '注册限流必须是契约 §0.6 的 5 次/小时、触顶封禁 1 小时', cfg.rateLimits['auth.register']);
        must(cfg.rateLimits['comment.create'].max === 20 && cfg.rateLimits['comment.create'].windowMs === 600000,
          '发评论限流 20 次/10 分钟', cfg.rateLimits['comment.create']);
        must(cfg.rateLimits['auth.logout'].max === 30 && cfg.rateLimits['auth.logout'].windowMs === 60000,
          '登出限流 30 次/分钟', cfg.rateLimits['auth.logout']);
        must(cfg.rateLimits['stats.hit'] && cfg.rateLimits['stats.hit'].max === 30
          && cfg.rateLimits['stats.hit'].windowMs === 60000,
        '访问统计限流必须是契约 §0.6 的 30 次/分钟', cfg.rateLimits['stats.hit']);
        must(cfg.errorCodes.RATE_LIMITED === 429 && cfg.errorCodes.DB_UNAVAILABLE === 503 && cfg.errorCodes.FORBIDDEN === 403,
          '错误码表 429/503/403 与契约一致', cfg.errorCodes);
        /* 库内 auth_throttle 的阈值也是冻结契约的一部分（§0.6 表下方那段）：
           登录 10 次失败/15 分钟、门 1 小时；注册 5 次/6 小时、门 1 小时。 */
        must(cfg.throttlePolicies && cfg.throttlePolicies.login
          && cfg.throttlePolicies.login.maxFails === 10 && cfg.throttlePolicies.login.gateMs === 3600000,
        '库内登录熔断必须是 10 次失败 / 封禁 1 小时', cfg.throttlePolicies && cfg.throttlePolicies.login);
        must(cfg.throttlePolicies && cfg.throttlePolicies.register
          && cfg.throttlePolicies.register.maxFails === 5 && cfg.throttlePolicies.register.gateMs === 3600000
          && cfg.throttlePolicies.register.windowMs === 21600000,
        '库内注册熔断必须是 5 次失败 / 6 小时窗口 / 封禁 1 小时（契约 §0.6）', cfg.throttlePolicies && cfg.throttlePolicies.register);
        return `routes=${routeCount(cfg.routes)} cookie=${cfg.cookie} login=${cfg.rateLimits['auth.login'].max}/15min`
          + ` register=${cfg.rateLimits['auth.register'].max}/${cfg.rateLimits['auth.register'].windowMs / 60000}min`
          + ` gate=${cfg.rateLimits['auth.register'].blockMs / 3600000}h`;
      });

    await it('A-01b', '口令哈希轮数与存储串格式必须是契约 §4.0 的 pbkdf2-sha256$600000$…（t21 起 600000，原 210000）',
      "grep -nE 'ITERATIONS *=' blog-enter/server/lib/public/passwords.mjs", () => {
        const src = readFileSync(join(BLOG_DIR, 'server', 'lib', 'public', 'passwords.mjs'), 'utf8');
        const m = src.match(/export const ITERATIONS\s*=\s*([0-9_]+)/);
        must(m, 'passwords.mjs 必须导出 ITERATIONS 常量', src.slice(0, 200));
        const iters = Number(String(m[1]).replace(/_/g, ''));
        must(iters === 600000, '契约 §4.0（t21 更新）冻结的是 600000 轮（存储串形如 pbkdf2-sha256$600000$…）',
          `实测 ITERATIONS = ${iters}`);
        return `ITERATIONS = ${iters}`;
      });

    await it('A-01c', '旧格式兼容（契约 §4.0）：210000 轮的既有哈希仍能校验通过；新哈希写 600000（换轮数不得让老用户登不进来）',
      '（用 210000 轮的手工旧串调 passwords.verifyPassword，再 hashPassword 看新串）', async () => {
        const mod = await import('../lib/public/passwords.mjs');
        const salt = Buffer.alloc(16, 5);
        const key = pbkdf2Sync('legacy-password-1', salt, 210000, 32, 'sha256').toString('base64');
        const stored = ['pbkdf2-sha256', 210000, salt.toString('base64'), key].join('$');
        const okOld = await mod.verifyPassword('legacy-password-1', stored);
        const badOld = await mod.verifyPassword('not-the-password', stored);
        must(okOld === true && badOld === false, '旧格式（210000）的哈希必须仍能校验通过、错口令仍被拒', { okOld, badOld });
        const fresh = await mod.hashPassword('new-password-1');
        must(/^pbkdf2-sha256\$600000\$/.test(fresh.hash), '新哈希必须写成 $600000$', String(fresh.hash).slice(0, 32));
        return '旧串（210000）校验通过；新哈希前缀 pbkdf2-sha256$600000$';
      });

    await it('A-02', '缺 P3_DB_* 且不带 --allow-degraded → 拒绝启动（exit 6，stderr 列出缺失变量名）',
      'node public-server.mjs   （清空 P3_DB_*）', () => {
        const r = runCli([join(BLOG_DIR, 'server', 'public-server.mjs')], {});
        must(r.code === 6, 'exit 必须是 6（数据库配置缺失）', { status: r.code, text: r.stderr });
        must(/P3_DB_HOST/.test(r.stderr) && /P3_DB_PASSWORD/.test(r.stderr), 'stderr 必须列出缺失的变量名', r.stderr);
        return `exit 6；stderr 含 P3_DB_HOST/P3_DB_PASSWORD`;
      });

    await it('A-03', '--listen 非回环 → 拒绝启动（exit 4）',
      'node public-server.mjs --allow-degraded --listen 0.0.0.0', () => {
        const r = runCli([join(BLOG_DIR, 'server', 'public-server.mjs'), '--allow-degraded', '--listen', '0.0.0.0'], {});
        must(r.code === 4, 'exit 必须是 4（监听地址非法）', { status: r.code, text: r.stderr });
        return 'exit 4';
      });

    await it('A-04', '--proxy-secret-file 指向不存在的路径 → 拒绝启动（exit 7）',
      'node public-server.mjs --allow-degraded --trust-proxy --proxy-secret-file <不存在>', () => {
        const r = runCli([join(BLOG_DIR, 'server', 'public-server.mjs'), '--allow-degraded', '--trust-proxy',
          '--proxy-secret-file', join(REPO_DIR, 'no-such-secret-file.txt')], {});
        must(r.code === 7, 'exit 必须是 7（代理密钥不可用）', { status: r.code, text: r.stderr });
        return 'exit 7';
      });
  });
};

const routeCount = (routes) => (routes || []).length;

const runLocalEndpoints = async (deps) => {
  /* ---------- 1) me ---------- */
  await group('本地 1：GET /api/auth/me（可选认证，未登录是正常状态）', async () => {
    const stores = makeMemoryStores(deps);
    const h = await startLocal(deps, stores);
    try {
      const { call } = h;
      await it('A-10', '匿名 → 200 + user:null + db:"up" + session_max_age_days:30，且顶层键恰为 4 个',
        'GET /api/auth/me', async () => {
          const r = await call('/api/auth/me');
          must(r.status === 200, '应回 200（未登录不是 401）', r);
          must(JSON.stringify(Object.keys(r.body).sort()) === '["db","ok","session_max_age_days","user"]',
            '顶层键必须恰为 ok/db/session_max_age_days/user', r.body);
          must(r.body.ok === true && r.body.user === null, 'user 必须是 null', r.body);
          must(r.body.db === 'up', 'db 必须是 up', r.body);
          must(r.body.session_max_age_days === 30, '会话必须是 30 天', r.body);
          return `HTTP 200 user=null db=up days=30`;
        });

      await it('A-11', '带会话 → 200 + 本人字段（含 email，仅本人），不含 password_hash',
        'GET /api/auth/me（带 p3_uid）', async () => {
          const u = stores.seedUser({ username: MARKER + 'me', email: MARKER + 'me@t16v.example', password: 'me-password-1' });
          const login = await call('/api/auth/login', { method: 'POST', body: { user: u.username, password: 'me-password-1' } });
          must(login.status === 200, '登录应成功', login);
          const r = await call('/api/auth/me', { cookie: login.sessionCookie });
          must(r.status === 200 && r.body.user && r.body.user.id === u.id, 'me 必须认出这个会话', r);
          must(r.body.user.email === u.email, '本人的 me 必须带自己的 email', r.body);
          must(JSON.stringify(Object.keys(r.body.user).sort()) === '["avatar","created_at","email","id","role","username"]',
            'user 键集合必须恰为契约形状', r.body.user);
          must(!/password_hash|password_algo/.test(r.text), '不得出现口令列名', r.text);
          return `HTTP 200 user=${u.username} id=${u.id} role=user`;
        });

      await it('A-12', '响应头：application/json; charset=utf-8 + Cache-Control: no-store + nosniff',
        'GET /api/auth/me（看响应头）', async () => {
          const r = await call('/api/auth/me');
          must(r.headers.get('content-type') === 'application/json; charset=utf-8', 'Content-Type', r.headers.get('content-type'));
          must(r.headers.get('cache-control') === 'no-store', 'Cache-Control 必须 no-store（me 不可缓存）', r.headers.get('cache-control'));
          must(r.headers.get('x-content-type-options') === 'nosniff', 'nosniff', r.headers.get('x-content-type-options'));
          const cookie = await call('/api/auth/logout', { method: 'POST', body: {} });
          must(/Max-Age=0/.test(cookie.setCookies.join(']')), '登出必须发清 cookie（Max-Age=0）', cookie.setCookies);
          return 'no-store + nosniff + 清 cookie';
        });
    } finally { await stopLocal(h); }
  });

  /* ---------- 2) register ---------- */
  await group('本地 2：POST /api/auth/register（成功 + 12 条失败路径）', async () => {
    const stores = makeMemoryStores(deps);
    const h = await startLocal(deps, stores);
    try {
      const { call, app } = h;
      const PASSWORD = 'a-good-password';
      const UNAME = MARKER + 'reg';

      await it('A-20', '注册成功 → 201 + {ok:true,user:{...}} + 建会话',
        `POST /api/auth/register {username:"${UNAME}",email,password}`, async () => {
          const r = await call('/api/auth/register', { method: 'POST', body: { username: UNAME, email: UNAME + '@t16v.example', password: PASSWORD } });
          must(r.status === 201, '应回 201', r);
          must(r.body.ok === true && r.body.user && r.body.user.username === UNAME, 'user 必须回填', r.body);
          must(JSON.stringify(Object.keys(r.body).sort()) === '["ok","user"]', '成功体顶层键必须恰为 ok/user', r.body);
          must(!/password_hash|password_algo|a-good-password/.test(r.text), '响应体不得含口令或口令列', r.text);
          must(stores.sessions.size === 1, '注册成功必须建会话（注册即登录）', [...stores.sessions.keys()]);
          return `HTTP 201 id=${r.body.user.id} sessions=${stores.sessions.size}`;
        });

      await it('A-21', 'Set-Cookie 属性齐全：p3_uid=64hex; Path=/api（契约 §0.5，t21 起由 / 收窄为 /api）; HttpOnly; SameSite=Lax; Max-Age=2592000，http 下无 Secure',
        'POST /api/auth/register（看 Set-Cookie）', async () => {
          app.rate.reset();
          const r = await call('/api/auth/register', { method: 'POST', body: { username: UNAME + 'b', email: UNAME + 'b@t16v.example', password: PASSWORD } });
          must(r.status === 201, '应回 201', r);
          const c = r.setCookies.find((x) => /^p3_uid=/.test(x)) || '';
          must(/^p3_uid=[0-9a-f]{64}/.test(c), 'cookie 值必须是 64 位十六进制会话 id', c);
          must(/; Path=\/api/.test(c), 'Path 必须是 /api（契约 §0.5：会话 cookie 不交给同源第三方应用）', c);
          must(/HttpOnly/.test(c) && /SameSite=Lax/.test(c), 'HttpOnly/SameSite 必须齐全', c);
          must(/Max-Age=2592000/.test(c), 'Max-Age 必须是 2592000', c);
          must(!/Secure/.test(c), 'http origin 下不得带 Secure（否则浏览器不存）', c);
          return c.split(';')[0].slice(0, 12) + '… ; Path=/api; HttpOnly; SameSite=Lax; Max-Age=2592000';
        });

      await it('A-22', '库里存的：口令是 pbkdf2-sha256$600000$… 且不含明文；会话行主键是 token 的 SHA-256 摘要',
        '（读内存 store）sessions 键 / users.password_hash', async () => {
          const row = [...stores.users.values()].find((u) => u.username === UNAME);
          must(/^pbkdf2-sha256\$600000\$/.test(row.password_hash), '哈希格式必须是 pbkdf2-sha256$600000$salt$key（契约 §4.0）', row.password_hash);
          must(!row.password_hash.includes(PASSWORD), '哈希里绝不能含明文', row.password_hash);
          const cookie = [...stores.sessions.keys()][0];
          must(/^[0-9a-f]{64}$/.test(cookie), 'sessions.id 是 64 位十六进制摘要', cookie);
          const rawTokens = [...stores.sessions.keys()].filter((k) => k.length === 64);
          must(rawTokens.length === stores.sessions.size, '每个会话键都是摘要', rawTokens.length);
          return 'hash=pbkdf2-sha256$600000$… sessions.id=sha256 摘要';
        });

      const bad = [
        ['A-23', '缺 username → 422 INVALID_USERNAME', { email: 'x@t16v.example', password: PASSWORD }, 422, 'INVALID_USERNAME'],
        ['A-24', 'username 2 位 → 422 INVALID_USERNAME', { username: 'ab', email: 'x@t16v.example', password: PASSWORD }, 422, 'INVALID_USERNAME'],
        ['A-25', 'username 含连字符 → 422 INVALID_USERNAME', { username: 'bad-name', email: 'x@t16v.example', password: PASSWORD }, 422, 'INVALID_USERNAME'],
        ['A-26', '缺 email → 422 INVALID_EMAIL（email 必填，本轮就收）', { username: MARKER + 'noemail', password: PASSWORD }, 422, 'INVALID_EMAIL'],
        ['A-27', 'email 无点 → 422 INVALID_EMAIL', { username: MARKER + 'bademail', email: 'a@b', password: PASSWORD }, 422, 'INVALID_EMAIL'],
        ['A-28', 'email 191 字符 → 422 INVALID_EMAIL', { username: MARKER + 'longmail', email: 'a'.repeat(184) + '@t16v.example', password: PASSWORD }, 422, 'INVALID_EMAIL'],
        ['A-29', '口令 7 位 → 422 INVALID_PASSWORD', { username: MARKER + 'shortpw', email: 's@t16v.example', password: '1234567' }, 422, 'INVALID_PASSWORD'],
        ['A-30', '口令 201 位 → 422 INVALID_PASSWORD', { username: MARKER + 'longpw', email: 'l@t16v.example', password: 'p'.repeat(201) }, 422, 'INVALID_PASSWORD'],
        ['A-31', '用户名重复 → 409 USERNAME_TAKEN', { username: UNAME, email: 'other@t16v.example', password: PASSWORD }, 409, 'USERNAME_TAKEN'],
        ['A-32', '用户名大小写不同也算重复（utf8mb4_unicode_ci）→ 409 USERNAME_TAKEN', { username: UNAME.toUpperCase(), email: 'case@t16v.example', password: PASSWORD }, 409, 'USERNAME_TAKEN'],
        ['A-33', '邮箱大小写不同也算重复 → 409 EMAIL_TAKEN', { username: MARKER + 'casemail', email: (UNAME + '@T16V.EXAMPLE'), password: PASSWORD }, 409, 'EMAIL_TAKEN']
      ];
      for (const [id, criterion, body, status, code] of bad) {
        app.rate.reset();
        const r = await call('/api/auth/register', { method: 'POST', body });
        await expectFail(id, criterion, `POST /api/auth/register ${JSON.stringify(body).slice(0, 90)}`, r, status, code);
      }

      await it('A-34', '注册限流（内存窗口按**请求**计数·设计如此）：同一 IP 第 6 次请求 → 429 + Retry-After: 3600（契约 §0.6：每 IP 60 分钟 5 次、触顶封禁 1 小时）',
        '连续 6 次 POST /api/auth/register（第 6 次触发）；本条只验内存窗口，落库计数语义见 A-38/A-39', async () => {
          app.rate.reset();
          let last = null;
          for (let i = 1; i <= 6; i += 1) {
            last = await call('/api/auth/register', { method: 'POST', body: { username: MARKER + 'rl' + i, email: `rl${i}@t16v.example`, password: PASSWORD } });
            if (i <= 5) must(last.status === 201, `第 ${i} 次应放行（201）`, last);
          }
          must(last.status === 429, '第 6 次必须 429', last);
          must(last.body.error.code === 'RATE_LIMITED', 'code 必须是 RATE_LIMITED', last.body);
          must(last.headers.get('retry-after') === '3600', 'Retry-After 必须是封禁时长 3600 秒', last.headers.get('retry-after'));
          SHAPE_CHECKED += 1;
          return '前 5 次 201，第 6 次 429 Retry-After=3600';
        });
    } finally { await stopLocal(h); }
  });

  /* 契约 §0.6「注册的计数语义（冻结，勿改）」：校验失败（422）既不算一次尝试、
     也不消耗额度；只有真正走到"创建用户"这一步并失败（如 409 冲突）才累加 auth_throttle；
     注册成功清零。这一组用"开着库闸"的独立实例验落库那一层，
     每轮清内存窗口（内存闸按请求计数是设计如此，不清会遮住结论）。 */
  await group('本地 2b：注册的两层计数语义（校验失败不计入落库 / 409 冲突才累加）', async () => {
    const gStores = makeMemoryStores(Object.assign({}, deps, { throttleGate: true }));
    const g = await startLocal(deps, gStores);
    const KEY = '127.0.0.1|register';
    try {
      await it('A-38', 'F3 回归闸：连续 6 次「用户名不合规」(422) 不计入落库计数，随后**合法**注册必须 201（契约 §0.6/§1.2：注册恒 5 次/小时、校验失败不计入落库计数）',
        `6 × POST ${g.base}/api/auth/register（username:"ab"）+ 1 × 合法注册；每轮清内存窗口`, async () => {
          for (let i = 1; i <= 6; i += 1) {
            g.app.rate.reset();
            const bad = await g.call('/api/auth/register', { method: 'POST', body: { username: 'ab', email: `bad${i}@t16v.example`, password: 'a-good-password' } });
            must(bad.status === 422, `第 ${i} 次格式非法应是 422（实测 ${bad.status}）`, bad);
            must(!gStores.throttle.get(KEY),
              `第 ${i} 次校验失败后不得写落库计数（实测 ${JSON.stringify(gStores.throttle.get(KEY) || null)}）`,
              gStores.throttle.get(KEY));
          }
          g.app.rate.reset();
          const ok = await g.call('/api/auth/register', { method: 'POST', body: { username: MARKER + 'after', email: 'after@t16v.example', password: 'a-good-password' } });
          must(ok.status === 201, '填错 6 次后合法注册必须仍然 201（被判 429 = 校验失败被计入了落库计数）', ok);
          return '6 次 422（每轮落库计数均为 null，从未累加）→ 合法注册 201';
        });

      await it('A-39', '反向判据：真正失败到「创建用户」这一步（409 用户名冲突）**必须**累加落库计数，第 6 次被库闸拦下 → 429 + Retry-After: 3600',
        `5 × POST ${g.base}/api/auth/register（已占用的用户名 → 409）+ 1 × 合法注册`, async () => {
          gStores.throttle.clear();
          for (let i = 1; i <= 5; i += 1) {
            g.app.rate.reset();
            const dup = await g.call('/api/auth/register', { method: 'POST', body: { username: MARKER + 'after', email: `dup${i}@t16v.example`, password: 'a-good-password' } });
            must(dup.status === 409, `第 ${i} 次用户名冲突应是 409（实测 ${dup.status}）`, dup);
          }
          const rec = gStores.throttle.get(KEY);
          must(rec && rec.fails === 5, '5 次 409 必须把落库计数累加到 5（契约 §0.6）', rec);
          must(rec.gateUntil > Date.now(), '第 5 次失败必须置 gate（契约：触顶封禁 1 小时）', rec);
          g.app.rate.reset();
          const blocked = await g.call('/api/auth/register', { method: 'POST', body: { username: MARKER + 'never', email: 'never@t16v.example', password: 'a-good-password' } });
          must(blocked.status === 429 && blocked.body.error.code === 'RATE_LIMITED', '被库闸拦下时应回 429 RATE_LIMITED', blocked);
          must(blocked.headers.get('retry-after') === '3600', 'Retry-After 必须是 3600 秒（封禁 1 小时）', blocked.headers.get('retry-after'));
          return '5 次 409 → fails=5 且 gate 生效 → 第 6 次 429 Retry-After=3600';
        });
    } finally { await stopLocal(g); }
  });
  await group('本地 3：POST /api/auth/login（换发会话 / 文案不可区分 / 限流两道闸）', async () => {
    const stores = makeMemoryStores(deps);
    const h = await startLocal(deps, stores);
    try {
      const { call, app } = h;
      const PW = 'login-password-9';
      const U = stores.seedUser({ username: MARKER + 'login', email: MARKER + 'login@t16v.example', password: PW });
      stores.seedUser({ username: MARKER + 'dis', email: MARKER + 'dis@t16v.example', password: PW, status: 'disabled' });

      await it('A-40', '用户名登录成功 → 200 + cookie（含契约要求的 ok/user 字段，且不含任何敏感列）',
        `POST /api/auth/login {user:"${U.username}",password}`, async () => {
          const r = await call('/api/auth/login', { method: 'POST', body: { user: U.username, password: PW } });
          must(r.status === 200, '应回 200', r);
          must(r.body.ok === true && r.body.user && r.body.user.id === U.id, 'user 必须回本人', r.body);
          must(/^p3_uid=[0-9a-f]{64}/.test(r.setCookies.join(']')), '必须下发会话 cookie', r.setCookies);
          /* 契约 §0.1 允许成功体带额外字段（只有失败体被冻结成恰好 ok/error），
             所以这里只要求"契约字段在场 + 无敏感列"，并把额外字段如实记进报告。 */
          ['ok', 'user'].forEach((k) => must(k in r.body, `成功体必须含 ${k}`, r.body));
          must(JSON.stringify(Object.keys(r.body.user).sort()) === '["avatar","created_at","email","id","role","username"]',
            'user 键集合必须恰为契约形状', r.body.user);
          must(!/password_hash|password_algo|login-password/.test(r.text), '响应体不得含口令或口令列', r.text);
          const extra = Object.keys(r.body).filter((k) => k !== 'ok' && k !== 'user');
          return `HTTP 200 id=${U.id} cookie=${r.sessionCookie.split('=')[1].slice(0, 10)}…`
            + (extra.length ? `；【观察】成功体另有非契约顶层字段 ${extra.join(',')}（§0.1 允许，前端按 code 分支不受影响）` : '');
        });

      await it('A-41', '邮箱登录成功 → 200（user 字段接受邮箱）',
        `POST /api/auth/login {user:"${U.email}",password}`, async () => {
          app.rate.reset();
          const r = await call('/api/auth/login', { method: 'POST', body: { user: U.email, password: PW } });
          must(r.status === 200 && r.body.user.id === U.id, '邮箱登录必须成功', r);
          return 'HTTP 200';
        });

      await it('A-42', '字段别名 username / email / login 都被接受（读取时归一，形状不变）',
        'POST /api/auth/login 分别用 username/email/login 字段', async () => {
          const out = [];
          for (const field of ['username', 'email', 'login']) {
            app.rate.reset();
            const body = { password: PW };
            body[field] = field === 'email' ? U.email : U.username;
            const r = await call('/api/auth/login', { method: 'POST', body });
            must(r.status === 200, `别名 ${field} 必须被接受`, r);
            out.push(`${field}=200`);
          }
          return out.join(' ');
        });

      await it('A-43', '错口令 → 401 INVALID_CREDENTIALS（与"用户不存在"完全同形，含同一句 message）',
        'POST /api/auth/login {user:存在,password:错}', async () => {
          const a = await call('/api/auth/login', { method: 'POST', body: { user: U.username, password: 'wrong-password-1' } });
          const b = await call('/api/auth/login', { method: 'POST', body: { user: MARKER + 'nobody', password: 'wrong-password-1' } });
          await expectFail('A-43', '错口令 → 401 INVALID_CREDENTIALS', 'POST /api/auth/login {password:错}', a, 401, 'INVALID_CREDENTIALS');
          must(a.status === b.status && a.body.error.code === b.body.error.code && a.body.error.message === b.body.error.message,
            '用户不存在与口令错误的响应必须逐字节一致', { a: a.body, b: b.body });
          must(a.body.error.message === '用户名或密码不正确', 'message 必须是契约里那一句', a.body.error.message);
          return `401 INVALID_CREDENTIALS "用户名或密码不正确"（两路完全一致）`;
        });

      await it('A-44', '账号枚举的耗时对齐：用户不存在时也照跑一次 PBKDF2',
        '（计时）错口令 vs 不存在用户 各 3 次取中位数', async () => {
          app.rate.reset();
          const time = async (body) => {
            const t0 = Date.now();
            await call('/api/auth/login', { method: 'POST', body });
            return Date.now() - t0;
          };
          const med = (xs) => xs.slice().sort((x, y) => x - y)[1];
          const real = [];
          const fake = [];
          for (let i = 0; i < 3; i += 1) {
            real.push(await time({ user: U.username, password: 'wrong-password-1' }));
            app.rate.reset();
            fake.push(await time({ user: MARKER + 'nobody2', password: 'wrong-password-1' }));
            app.rate.reset();
          }
          const mr = med(real); const mf = med(fake);
          must(mf >= mr * 0.25, `不存在用户的耗时不能比真校验快一个数量级（真 ${mr}ms / 假 ${mf}ms）`, { real, fake });
          return `真 ${mr}ms / 不存在 ${mf}ms（比值 ${(mf / mr).toFixed(2)}）`;
        });

      app.rate.reset();
      const r45 = await call('/api/auth/login', { method: 'POST', body: { password: PW } });
      await expectFail('A-45', '缺 user 字段 → 400 BAD_REQUEST', 'POST /api/auth/login {password:"…"}', r45, 400, 'BAD_REQUEST');
      app.rate.reset();
      const r46 = await call('/api/auth/login', { method: 'POST', body: { user: U.username, password: '123' } });
      await expectFail('A-46', '口令 3 位 → 422 INVALID_PASSWORD（超界直接拒，不烧 PBKDF2）', 'POST /api/auth/login {password:"123"}', r46, 422, 'INVALID_PASSWORD');
      app.rate.reset();
      const r47 = await call('/api/auth/login', { method: 'POST', body: { user: U.username, password: PW }, contentType: null });
      await expectFail('A-47', '未带 Content-Type: application/json → 415（CSRF 补充闸）', 'POST /api/auth/login（不写 Content-Type）', r47, 415, 'UNSUPPORTED_MEDIA_TYPE');
      app.rate.reset();
      const r48 = await call('/api/auth/login', { method: 'POST', body: { user: MARKER + 'dis', password: PW } });
      await it('A-48', '被禁用账号 → 与"口令错误"完全同形（不泄露账号存在/被禁）',
        'POST /api/auth/login {user:status=disabled}', async () => {
          must(r48.status === 401 && r48.body.error.code === 'INVALID_CREDENTIALS' && r48.body.error.message === '用户名或密码不正确',
            'disabled 账号必须走同一条 401 路径', r48);
          return '401 INVALID_CREDENTIALS';
        });

      await it('A-49', 'HTTP 层内存限流：第 11 次失败 → 429 + Retry-After: 3600（且该次不再查库）',
        '连续 11 次 POST /api/auth/login（错口令），第 11 次触发', async () => {
          app.rate.reset();
          stores.throttle.clear(); /* 先清掉前面用例攒下的库内失败计数，让这一条只验内存窗口 */
          const before = stores.calls.findUserByLogin;
          let last = null;
          for (let i = 1; i <= 11; i += 1) {
            last = await call('/api/auth/login', { method: 'POST', body: { user: U.username, password: 'wrong-password-1' } });
            if (i <= 10) must(last.status === 401, `第 ${i} 次应是 401`, last);
          }
          must(last.status === 429, '第 11 次必须 429', last);
          must(last.headers.get('retry-after') === '3600', 'Retry-After 必须是 3600 秒', last.headers.get('retry-after'));
          must(stores.calls.findUserByLogin - before === 10, '429 那次必须在读库之前被挡下（不再查用户）',
            `findUserByLogin 增加了 ${stores.calls.findUserByLogin - before} 次`);
          SHAPE_CHECKED += 1;
          return '前 10 次 401，第 11 次 429 Retry-After=3600，查库仅 10 次';
        });

      await it('A-50', '库内 auth_throttle 熔断：清空内存窗口后，第 11 次由库闸拦下且不再查用户',
        '每轮清内存窗口 + 连续 11 次错口令（模拟"换个 IP 慢慢试"）', async () => {
          /* 这一条必须用"开着库闸"的独立实例：默认实例为了不遮挡单请求语义，只记账不熔断。 */
          const gStores = makeMemoryStores(Object.assign({}, deps, { throttleGate: true }));
          const g = await startLocal(deps, gStores);
          const GU = gStores.seedUser({ username: MARKER + 'gate', email: MARKER + 'gate@t16v.example', password: PW });
          try {
            const before = gStores.calls.findUserByLogin;
            let last = null;
            for (let i = 1; i <= 10; i += 1) {
              last = await g.call('/api/auth/login', { method: 'POST', body: { user: GU.username, password: 'wrong-password-1' } });
              must(last.status === 401, `第 ${i} 次应是 401（内存窗口每轮清零）`, last);
              g.app.rate.reset();
            }
            const mid = gStores.calls.findUserByLogin;
            const gated = await g.call('/api/auth/login', { method: 'POST', body: { user: GU.username, password: 'wrong-password-1' } });
            must(gated.status === 429 && gated.body.error.code === 'RATE_LIMITED', '第 11 次必须被库内闸拦下（429）', gated);
            must(gStores.calls.findUserByLogin === mid, '库内熔断必须短路，不再查用户',
              `${mid} → ${gStores.calls.findUserByLogin}`);
            return `十次失败后 gated 429（查库次数 ${before} → ${mid} → 未再增加）`;
          } finally { await stopLocal(g); }
        });
    } finally { await stopLocal(h); }
  });

  /* ---------- 4) logout ---------- */
  await group('本地 4：POST /api/auth/logout（不需要登录，绝不 401）', async () => {
    const stores = makeMemoryStores(deps);
    const h = await startLocal(deps, stores);
    try {
      const { call, app } = h;
      const PW = 'logout-password-1';
      const U = stores.seedUser({ username: MARKER + 'out', email: MARKER + 'out@t16v.example', password: PW });

      const login = await call('/api/auth/login', { method: 'POST', body: { user: U.username, password: PW } });
      const cookie = need(login.sessionCookie, '登录没拿到 cookie');

      await it('A-60', '带 cookie 登出 → 200 {ok:true,destroyed:true} + 清 cookie（属性与下发时一致、Max-Age=0）',
        'POST /api/auth/logout（带 p3_uid）', async () => {
          const r = await call('/api/auth/logout', { method: 'POST', body: {}, cookie });
          must(r.status === 200 && r.body.ok === true && r.body.destroyed === true, '必须 200 + destroyed:true', r);
          const c = r.setCookies.find((x) => /^p3_uid=/.test(x)) || '';
          must(/^p3_uid=;/.test(c), '清 cookie 必须把值清空（p3_uid=）', c);
          must(/Path=\/api/.test(c) && /HttpOnly/.test(c) && /SameSite=Lax/.test(c) && /Max-Age=0/.test(c),
            '清 cookie 属性必须与下发时完全一致（Path=/api、HttpOnly、SameSite=Lax、Max-Age=0）', c);
          must(stores.sessions.size === 0, '库里的会话行必须被删掉', stores.sessions.size);
          return `HTTP 200 destroyed=true ${c}`;
        });

      await it('A-61', '登出后旧 cookie 失效：再问 me → user:null（不是 401）',
        'GET /api/auth/me（带已登出的 cookie）', async () => {
          const r = await call('/api/auth/me', { cookie });
          must(r.status === 200 && r.body.user === null, '登出后必须认不出这个会话', r);
          return 'HTTP 200 user=null';
        });

      await it('A-62', '不带 cookie 登出 → 200 + destroyed:false（会话过期也不会卡在"退不出去"）',
        'POST /api/auth/logout（无 cookie）', async () => {
          const r = await call('/api/auth/logout', { method: 'POST', body: {} });
          must(r.status === 200 && r.body.destroyed === false, '必须 200 + destroyed:false', r);
          return 'HTTP 200 destroyed=false';
        });

      await it('A-63', '伪造/过期 cookie 登出 → 200 + destroyed:false（不 401、不 500）',
        'POST /api/auth/logout（cookie=p3_uid=deadbeef…）', async () => {
          const r = await call('/api/auth/logout', { method: 'POST', body: {}, cookie: 'p3_uid=' + 'f'.repeat(64) });
          must(r.status === 200 && r.body.destroyed === false, '必须 200 + destroyed:false', r);
          return 'HTTP 200 destroyed=false';
        });

      await it('A-64', '登出限流：每分钟第 31 次 → 429 + Retry-After: 60',
        '连续 31 次 POST /api/auth/logout（第 31 次触发）', async () => {
          app.rate.reset();
          let last = null;
          for (let i = 1; i <= 31; i += 1) {
            last = await call('/api/auth/logout', { method: 'POST', body: {} });
            if (i <= 30) must(last.status === 200, `第 ${i} 次应放行`, last);
          }
          must(last.status === 429, '第 31 次必须 429', last);
          must(last.headers.get('retry-after') === '60', 'Retry-After 必须是 60 秒', last.headers.get('retry-after'));
          return '前 30 次 200，第 31 次 429 Retry-After=60';
        });
    } finally { await stopLocal(h); }
  });

  /* ---------- 5~8) 评论（共享一个 app） ---------- */
  await group('本地 5：GET /api/comments（可读 / 排序 / 不泄露 / 非法 slug）', async () => {
    const stores = makeMemoryStores(deps);
    const h = await startLocal(deps, stores);
    try {
      const { call, app } = h;
      const SLUG = MARKER + '-slug';
      const PW = 'comment-password-1';
      const A = stores.seedUser({ username: MARKER + 'ca', email: MARKER + 'ca@t16v.example', password: PW });
      const B = stores.seedUser({ username: MARKER + 'cb', email: MARKER + 'cb@t16v.example', password: PW });
      const t0 = new Date(Date.now() - 60_000);
      const id1 = stores.seedComment({ slug: SLUG, userId: A.id, content: CONTENT_TAG + ' A1', at: t0 });
      const id2 = stores.seedComment({ slug: SLUG, userId: B.id, content: CONTENT_TAG + ' B1', at: t0 }); // 同秒 → 按 id 升序
      const id3 = stores.seedComment({ slug: SLUG, userId: A.id, content: CONTENT_TAG + ' A2', at: new Date(t0.getTime() + 1000) });
      const id4 = stores.seedComment({ slug: SLUG, userId: B.id, content: CONTENT_TAG + ' 已删', status: 'deleted', at: t0 });

      await it('A-70', '未知 slug → 200 + comments:[]（不是 404、不是 503）',
        'GET /api/comments?slug=no-such-slug', async () => {
          const r = await call('/api/comments?slug=' + MARKER + '-nothing');
          must(r.status === 200 && Array.isArray(r.body.comments) && r.body.comments.length === 0, '必须是空数组', r);
          return 'HTTP 200 comments=[]';
        });

      await it('A-71', '排序：created_at 升序、同秒按 id 升序；软删的不返回',
        `GET /api/comments?slug=${SLUG}`, async () => {
          const r = await call('/api/comments?slug=' + SLUG);
          must(r.status === 200, '应回 200', r);
          const ids = r.body.comments.map((c) => c.id);
          must(JSON.stringify(ids) === JSON.stringify([id1, id2, id3]), `顺序必须是 [${id1},${id2},${id3}]`, ids);
          must(!ids.includes(id4), 'status=deleted 的评论绝不能返回', ids);
          return `ids=${ids.join(',')}（升序、软删已隐藏）`;
        });

      await it('A-72', '每条评论的键集合恰为契约形状（绝不 spread 数据行），author.id 是真实作者',
        `GET /api/comments?slug=${SLUG}`, async () => {
          const r = await call('/api/comments?slug=' + SLUG);
          r.body.comments.forEach((c) => {
            must(JSON.stringify(Object.keys(c).sort()) === '["author","content","created_at","id","parent_id"]',
              '评论键集合必须恰为 5 个', c);
            must(JSON.stringify(Object.keys(c.author).sort()) === '["avatar","id","username"]',
              'author 键集合必须恰为 id/username/avatar', c.author);
            const owner = c.id === id2 ? B.id : A.id;
            must(c.author.id === owner, `id=${c.id} 的 author.id 应为 ${owner}`, c.author);
          });
          return `5 个键 + author 3 个键；作者分别对得上（A=${A.id} B=${B.id}）`;
        });

      await it('A-73', '评论列表不泄露：全文无 password_hash / password_algo / email / user_id / status / ip',
        `GET /api/comments?slug=${SLUG}（扫全文）`, async () => {
          const r = await call('/api/comments?slug=' + SLUG);
          ['password_hash', 'password_algo', '"email"', 'user_id', '"status"', '"ip"', 'a-good-password'].forEach((needle) => {
            must(!r.text.includes(needle), `响应全文不得出现 ${needle}`, r.text);
          });
          must(!/t16v\.example/.test(r.text), '评论列表不得出现邮箱（含域名的邮箱串）', r.text);
          return `${r.text.length} 字节，白名单构造，无敏感列`;
        });

      app.rate.reset();
      const s1 = await call('/api/comments');
      await expectFail('A-74', '缺 slug → 422 INVALID_SLUG', 'GET /api/comments（不带 slug）', s1, 422, 'INVALID_SLUG');
      const s2 = await call('/api/comments?slug=' + encodeURIComponent('a b'));
      await expectFail('A-75', 'slug 含空白 → 422 INVALID_SLUG', 'GET /api/comments?slug=a%20b', s2, 422, 'INVALID_SLUG');
      const s3 = await call('/api/comments?slug=' + 'x'.repeat(201));
      await expectFail('A-76', 'slug 201 字符 → 422 INVALID_SLUG', 'GET /api/comments?slug=<201×x>', s3, 422, 'INVALID_SLUG');
    } finally { await stopLocal(h); }
  });

  await group('本地 6：POST /api/comments（必需登录 / 边界 / 父评论 / 415 / 413）', async () => {
    const stores = makeMemoryStores(deps);
    const h = await startLocal(deps, stores);
    try {
      const { call, app, port } = h;
      const SLUG = MARKER + '-post';
      const OTHER = MARKER + '-other';
      const PW = 'post-password-1';
      const A = stores.seedUser({ username: MARKER + 'pa', email: MARKER + 'pa@t16v.example', password: PW });
      const login = await call('/api/auth/login', { method: 'POST', body: { user: A.username, password: PW } });
      const cookie = need(login.sessionCookie, '登录没拿到 cookie');
      let firstId = null;
      app.rate.reset();

      const anon = await call('/api/comments', { method: 'POST', body: { slug: SLUG, content: CONTENT_TAG + ' 未登录' } });
      await expectFail('A-80', '未登录发评论 → 401 UNAUTHENTICATED', 'POST /api/comments（无 cookie）', anon, 401, 'UNAUTHENTICATED');

      await it('A-81', '发评论成功 → 201 + 键集合恰为契约形状 + 作者是自己',
        'POST /api/comments {slug,content}（带 cookie）', async () => {
          const r = await call('/api/comments', { method: 'POST', body: { slug: SLUG, content: CONTENT_TAG + ' 第一条' }, cookie });
          must(r.status === 201, '应回 201', r);
          must(JSON.stringify(Object.keys(r.body).sort()) === '["comment","ok"]', '顶层键必须恰为 ok/comment', r.body);
          const c = r.body.comment;
          must(JSON.stringify(Object.keys(c).sort()) === '["author","content","created_at","id","parent_id"]', '评论键集合', c);
          must(c.author.id === A.id && c.parent_id === null, 'author.id 必须是本人、parent_id 必须 null', c);
          firstId = c.id;
          return `HTTP 201 id=${c.id} parent_id=null author=${c.author.username}`;
        });

      await it('A-82', '内容首尾空白被去掉；2000 字符边界通过（不是 1999）',
        'POST /api/comments content="  x…x  "（2000 字符）', async () => {
          app.rate.reset();
          const body = '  ' + CONTENT_TAG + ' ' + 'x'.repeat(2000 - CONTENT_TAG.length - 1) + '   ';
          const r = await call('/api/comments', { method: 'POST', body: { slug: SLUG, content: body }, cookie });
          must(r.status === 201, '长度 ≤ 2000 必须通过', r);
          must(!/^\s|\s$/.test(r.body.comment.content), '首尾空白必须被去掉', r.body.comment.content.slice(0, 20));
          return `HTTP 201 len=${r.body.comment.content.length}`;
        });

      app.rate.reset();
      const e1 = await call('/api/comments', { method: 'POST', body: { slug: SLUG, content: '   ' }, cookie });
      await expectFail('A-83', '纯空白内容 → 422 INVALID_CONTENT', 'POST /api/comments content="   "', e1, 422, 'INVALID_CONTENT');
      app.rate.reset();
      const e2 = await call('/api/comments', { method: 'POST', body: { slug: SLUG, content: 'x'.repeat(2001) }, cookie });
      await expectFail('A-84', '2001 字符 → 422 INVALID_CONTENT', 'POST /api/comments content=<2001×x>', e2, 422, 'INVALID_CONTENT');
      app.rate.reset();
      const e3 = await call('/api/comments', { method: 'POST', body: { content: CONTENT_TAG + ' 无 slug' }, cookie });
      await expectFail('A-85', '缺 slug → 422 INVALID_SLUG', 'POST /api/comments（不带 slug）', e3, 422, 'INVALID_SLUG');
      app.rate.reset();
      const e4 = await call('/api/comments', { method: 'POST', body: { slug: SLUG, content: CONTENT_TAG + ' 坏父', parent_id: 'abc' }, cookie });
      await expectFail('A-86', "parent_id='abc' → 422 INVALID_PARENT", "POST /api/comments parent_id='abc'", e4, 422, 'INVALID_PARENT');
      app.rate.reset();
      const e5 = await call('/api/comments', { method: 'POST', body: { slug: SLUG, content: CONTENT_TAG + ' 不存在父', parent_id: 999999 }, cookie });
      await expectFail('A-87', 'parent_id 指向不存在的评论 → 422 INVALID_PARENT', 'POST /api/comments parent_id=999999', e5, 422, 'INVALID_PARENT');

      await it('A-88', "parent_id 指向别的 slug 的评论 → 422 INVALID_PARENT（禁止跨文章挂回复，判定在数据层）",
        'POST /api/comments {slug:OTHER, parent_id:<别的文章里的评论>}', async () => {
          app.rate.reset();
          const foreign = stores.seedComment({ slug: OTHER, userId: A.id, content: CONTENT_TAG + ' 别的文章' });
          const r = await call('/api/comments', { method: 'POST', body: { slug: SLUG, content: CONTENT_TAG + ' 跨文章回复', parent_id: foreign }, cookie });
          must(r.status === 422 && r.body.error.code === 'INVALID_PARENT', '跨 slug 的父评论必须被拒', r);
          SHAPE_CHECKED += 1;
          return `HTTP 422 INVALID_PARENT（父评论 ${foreign} 属于 ${OTHER}）`;
        });

      await it('A-89', "parent_id 为 '0'/0/'' 视为无父评论；合法 parent_id 正常回落",
        'POST /api/comments parent_id=0 / "0" / "" / <真实 id>', async () => {
          const out = [];
          for (const p of [0, '0', '']) {
            app.rate.reset();
            const r = await call('/api/comments', { method: 'POST', body: { slug: SLUG, content: CONTENT_TAG + ' 无父' + String(p), parent_id: p }, cookie });
            must(r.status === 201 && r.body.comment.parent_id === null, `parent_id=${JSON.stringify(p)} 必须当成无父评论`, r);
          }
          app.rate.reset();
          const rep = await call('/api/comments', { method: 'POST', body: { slug: SLUG, content: CONTENT_TAG + ' 回复', parent_id: firstId }, cookie });
          must(rep.status === 201 && rep.body.comment.parent_id === firstId, '合法 parent_id 必须回落', rep);
          return `0/"0"/"" → null；parent_id=${firstId} → 已回落`;
        });

      app.rate.reset();
      const t1 = await call('/api/comments', { method: 'POST', body: { slug: SLUG, content: 'x' }, cookie, contentType: 'text/plain' });
      await expectFail('A-90', 'Content-Type: text/plain → 415 UNSUPPORTED_MEDIA_TYPE', 'POST /api/comments（Content-Type: text/plain）', t1, 415, 'UNSUPPORTED_MEDIA_TYPE');
      app.rate.reset();
      const j1 = await call('/api/comments', { method: 'POST', body: '{not json', cookie });
      await expectFail('A-91', '请求体不是合法 JSON → 400 INVALID_JSON', 'POST /api/comments body="{not json"', j1, 400, 'INVALID_JSON');
      app.rate.reset();
      const a1 = await call('/api/comments', { method: 'POST', body: '[1,2,3]', cookie });
      await expectFail('A-92', '请求体是数组 → 400 BAD_REQUEST（顶层必须是对象）', 'POST /api/comments body="[1,2,3]"', a1, 400, 'BAD_REQUEST');

      await it('A-93', '（S6）请求体 > 1 MiB → **能读到** 413 + `connection: close` + BODY_TOO_LARGE 响应体（裸 http，不用 fetch：fetch 在"响应 + 断连同时发生"时会抛 fetch failed，把实现正确误读成拿不到 413）',
        'raw POST /api/comments content=1MiB+4KiB', async () => {
          app.rate.reset();
          const big = JSON.stringify({ slug: SLUG, content: 'x'.repeat(1024 * 1024 + 4096) });
          let r = null;
          try {
            r = await rawSend(port, 'POST', '/api/comments', { host: '127.0.0.1:' + port, cookie, 'content-type': 'application/json' }, big);
          } catch (err) {
            must(false, 'S6 判据是"客户端必须能读到 413"，连接被直接销毁说明响应没发完',
              `${String(err.code || err.message)}`);
          }
          must(r.status === 413, `必须回 413（实测 ${r.status}）`, r);
          must(r.body && r.body.error && r.body.error.code === 'BODY_TOO_LARGE', '响应体必须是 BODY_TOO_LARGE', r.body);
          must(String(r.headers.connection || '') === 'close', '必须带 connection: close', r.headers.connection);
          const cl = Number(r.headers['content-length']);
          must(Number.isFinite(cl) && cl === Buffer.byteLength(r.text), 'content-length 必须与实际响应体长度一致',
            { contentLength: r.headers['content-length'], actual: Buffer.byteLength(r.text) });
          SHAPE_CHECKED += 1;
          return `HTTP 413 BODY_TOO_LARGE · connection: close · content-length ${cl}`;
        });

      await it('A-94', '发评论限流：同一用户第 21 条 → 429 + Retry-After: 300',
        '连续 21 次 POST /api/comments（第 21 次触发）', async () => {
          app.rate.reset();
          let last = null;
          for (let i = 1; i <= 21; i += 1) {
            last = await call('/api/comments', { method: 'POST', body: { slug: SLUG, content: CONTENT_TAG + ' rl' + i }, cookie });
            if (i <= 20) must(last.status === 201, `第 ${i} 条应放行`, last);
          }
          must(last.status === 429, '第 21 条必须 429', last);
          must(last.headers.get('retry-after') === '300', 'Retry-After 必须是 300 秒（5 分钟）', last.headers.get('retry-after'));
          return '前 20 条 201，第 21 条 429 Retry-After=300';
        });
    } finally { await stopLocal(h); }
  });

  await group('本地 7：DELETE /api/comments/:id（越权 403 / 未登录 401 / 软删 404）', async () => {
    const stores = makeMemoryStores(deps);
    const h = await startLocal(deps, stores);
    try {
      const { call, app } = h;
      const SLUG = MARKER + '-del';
      const PW = 'delete-password-1';
      const A = stores.seedUser({ username: MARKER + 'da', email: MARKER + 'da@t16v.example', password: PW });
      const B = stores.seedUser({ username: MARKER + 'db', email: MARKER + 'db@t16v.example', password: PW });
      const ADMIN = stores.seedUser({ username: MARKER + 'adm', email: MARKER + 'adm@t16v.example', password: PW, role: 'admin' });
      const loginA = await call('/api/auth/login', { method: 'POST', body: { user: A.username, password: PW } });
      const loginB = await call('/api/auth/login', { method: 'POST', body: { user: B.username, password: PW } });
      const loginAdmin = await call('/api/auth/login', { method: 'POST', body: { user: ADMIN.username, password: PW } });
      const cookieA = need(loginA.sessionCookie, 'A 登录失败');
      const cookieB = need(loginB.sessionCookie, 'B 登录失败');
      const cookieAdmin = need(loginAdmin.sessionCookie, 'admin 登录失败');
      const ownA = stores.seedComment({ slug: SLUG, userId: A.id, content: CONTENT_TAG + ' A 自己的' });
      const ownB = stores.seedComment({ slug: SLUG, userId: B.id, content: CONTENT_TAG + ' B 的' });

      app.rate.reset();
      const anon = await call('/api/comments/' + ownB, { method: 'DELETE', headers: { 'content-type': 'application/json' } });
      await expectFail('A-100', '未登录删评论 → 401 UNAUTHENTICATED', `DELETE /api/comments/${ownB}（无 cookie）`, anon, 401, 'UNAUTHENTICATED');

      await it('A-101', 'A 删 B 的评论 → 403 FORBIDDEN，且 B 的评论仍然存在（列表里还在）',
        `DELETE /api/comments/${ownB}（以 A 的身份）`, async () => {
          app.rate.reset();
          const r = await call('/api/comments/' + ownB, { method: 'DELETE', headers: { 'content-type': 'application/json' }, cookie: cookieA });
          must(r.status === 403, '跨账号删除必须 403', r);
          must(r.body.error.code === 'FORBIDDEN', 'code 必须是 FORBIDDEN', r.body);
          must(r.body.error.message === '只能删除自己的评论', 'message 必须是契约那句', r.body.error.message);
          SHAPE_CHECKED += 1;
          const list = await call('/api/comments?slug=' + SLUG);
          must(list.body.comments.some((c) => c.id === ownB), '目标评论必须仍然存在', list.body.comments.map((c) => c.id));
          return `HTTP 403 FORBIDDEN；列表仍含 id=${ownB}`;
        });

      await it('A-102', 'A 删自己的评论 → 200 {ok:true,deleted:id}；列表与 mine 都不再返回（软删）',
        `DELETE /api/comments/${ownA}（以 A 的身份）`, async () => {
          app.rate.reset();
          const r = await call('/api/comments/' + ownA, { method: 'DELETE', headers: { 'content-type': 'application/json' }, cookie: cookieA });
          must(r.status === 200 && r.body.ok === true && r.body.deleted === ownA, '必须 200 + deleted:id', r);
          const list = await call('/api/comments?slug=' + SLUG);
          must(!list.body.comments.some((c) => c.id === ownA), '软删后列表不得再返回', list.body.comments.map((c) => c.id));
          const mine = await call('/api/comments/mine', { cookie: cookieA });
          must(!mine.body.comments.some((c) => c.id === ownA), '软删后 mine 不得再返回', mine.body.comments.map((c) => c.id));
          must(stores.comments.get(ownA).status === 'deleted', '库里必须是软删（status=deleted）而不是物理删除', stores.comments.get(ownA).status);
          return `HTTP 200 deleted=${ownA}；status=deleted（行仍在）`;
        });

      app.rate.reset();
      const again = await call('/api/comments/' + ownA, { method: 'DELETE', headers: { 'content-type': 'application/json' }, cookie: cookieA });
      await expectFail('A-103', '再删已软删的评论 → 404 NOT_FOUND', `DELETE /api/comments/${ownA}（已软删）`, again, 404, 'NOT_FOUND');
      app.rate.reset();
      const nf = await call('/api/comments/999999', { method: 'DELETE', headers: { 'content-type': 'application/json' }, cookie: cookieA });
      await expectFail('A-104', '评论不存在 → 404 NOT_FOUND', 'DELETE /api/comments/999999', nf, 404, 'NOT_FOUND');
      const ids = ['0', 'abc', '-1', '1e3'];
      for (const id of ids) {
        app.rate.reset();
        const r = await call('/api/comments/' + id, { method: 'DELETE', headers: { 'content-type': 'application/json' }, cookie: cookieA });
        await expectFail('A-105' + id, `路径 id 非正整数（${id}）→ 404 NOT_FOUND`, `DELETE /api/comments/${id}`, r, 404, 'NOT_FOUND');
      }

      await it('A-106', 'admin 可以删别人的评论（契约 §1.7：后台治理需要，role 来自服务端）',
        `DELETE /api/comments/${ownB}（以 admin 身份）`, async () => {
          app.rate.reset();
          const r = await call('/api/comments/' + ownB, { method: 'DELETE', headers: { 'content-type': 'application/json' }, cookie: cookieAdmin });
          must(r.status === 200 && r.body.deleted === ownB, 'admin 必须能删', r);
          const list = await call('/api/comments?slug=' + SLUG);
          must(!list.body.comments.some((c) => c.id === ownB), '删后不得返回', list.body.comments.map((c) => c.id));
          return `HTTP 200 deleted=${ownB}`;
        });

      await it('A-107', '删评论限流：同一用户第 21 次 → 429 + Retry-After: 300',
        '连续 21 次 DELETE /api/comments/:id（第 21 次触发）', async () => {
          app.rate.reset();
          let last = null;
          for (let i = 1; i <= 21; i += 1) {
            last = await call('/api/comments/999999', { method: 'DELETE', headers: { 'content-type': 'application/json' }, cookie: cookieB });
            if (i <= 20) must(last.status === 404, `第 ${i} 次应放行（404）`, last);
          }
          must(last.status === 429, '第 21 次必须 429', last);
          must(last.headers.get('retry-after') === '300', 'Retry-After 必须是 300 秒', last.headers.get('retry-after'));
          return '前 20 次 404，第 21 次 429 Retry-After=300';
        });
    } finally { await stopLocal(h); }
  });

  await group('本地 8：GET /api/comments/mine（必需登录 / 只给自己的 / 路由不被 :id 抢）', async () => {
    const stores = makeMemoryStores(deps);
    const h = await startLocal(deps, stores);
    try {
      const { call, app } = h;
      const PW = 'mine-password-1';
      const A = stores.seedUser({ username: MARKER + 'ma', email: MARKER + 'ma@t16v.example', password: PW });
      const B = stores.seedUser({ username: MARKER + 'mb', email: MARKER + 'mb@t16v.example', password: PW });
      const login = await call('/api/auth/login', { method: 'POST', body: { user: A.username, password: PW } });
      const cookieA = need(login.sessionCookie, 'A 登录失败');
      const S1 = MARKER + '-mine1';
      const S2 = MARKER + '-mine2';
      const old = stores.seedComment({ slug: S1, userId: A.id, content: CONTENT_TAG + ' 早', at: new Date(Date.now() - 5000) });
      const newer = stores.seedComment({ slug: S2, userId: A.id, content: CONTENT_TAG + ' 晚', at: new Date() });
      stores.seedComment({ slug: S1, userId: B.id, content: CONTENT_TAG + ' 别人的' });
      stores.seedComment({ slug: S1, userId: A.id, content: CONTENT_TAG + ' 我删过的', status: 'deleted' });

      app.rate.reset();
      const anon = await call('/api/comments/mine');
      await expectFail('A-110', '未登录 → 401 UNAUTHENTICATED', 'GET /api/comments/mine（无 cookie）', anon, 401, 'UNAUTHENTICATED');

      await it('A-111', 'mine 只返回自己的、approved 的评论；带 slug；按 created_at 降序',
        'GET /api/comments/mine（带 cookie）', async () => {
          const r = await call('/api/comments/mine', { cookie: cookieA });
          must(r.status === 200, '应回 200', r);
          const ids = r.body.comments.map((c) => c.id);
          must(JSON.stringify(ids) === JSON.stringify([newer, old]), `降序且只含自己的 [${newer},${old}]`, ids);
          must(r.body.comments.every((c) => typeof c.slug === 'string' && c.slug.length > 0), '每条必须带 slug', r.body.comments);
          must(JSON.stringify(Object.keys(r.body.comments[0]).sort()) === '["author","content","created_at","id","parent_id","slug"]',
            'mine 的键集合 = 公开形状 + slug', Object.keys(r.body.comments[0]));
          must(!/password_hash|"email"/.test(r.text), 'mine 不得泄露口令列/邮箱', r.text);
          return `HTTP 200 ids=${ids.join(',')}（降序、含 slug）`;
        });

      await it('A-112', '路由优先级：GET /api/comments/mine 命中自己的静态路由（不被 /api/comments/:id 吃掉）',
        'GET /api/comments/mine（对比 DELETE /api/comments/mine 与 GET /api/comments/123）', async () => {
          const mine = await call('/api/comments/mine', { cookie: cookieA });
          must(mine.status === 200, 'mine 必须命中静态路由（若被 :id 吃掉会回 404）', mine);
          /* 静态段优先：:id 那条只注册了 DELETE，所以 is :id 判定不该影响 GET */
          const asId = await call('/api/comments/mine', { method: 'DELETE', headers: { 'content-type': 'application/json' }, cookie: cookieA });
          must(asId.status === 404 && asId.body.error.code === 'NOT_FOUND',
            "'mine' 不是正整数 id → DELETE 走 :id 路由并回 404（契约 §1.7）", asId);
          const num = await call('/api/comments/123');
          must(num.status === 405 && (num.headers.get('allow') || '').includes('DELETE'),
            'GET /api/comments/123 → 405 + Allow: DELETE（证明 :id 只注册了 DELETE）', num);
          return 'GET mine=200；DELETE mine=404；GET /123=405 Allow:DELETE';
        });
    } finally { await stopLocal(h); }
  });

  /* ---------- 8b) 访问统计（契约 §1.8 / §1.9） ---------- */
  await group('本地 8b：访问统计（POST /api/stats/hit 计数、GET /api/stats 只读、405/415/429）', async () => {
    const stores = makeMemoryStores(deps);
    const h = await startLocal(deps, stores);
    try {
      const { call, app } = h;
      app.rate.reset();

      await it('A-113', 'POST /api/stats/hit → 200 + stats{total,today,visitors,day}，每次调用都是一次 PV',
        `curl -s -X POST ${'<base>'}/api/stats/hit -H 'Content-Type: application/json' -d '{}'`, async () => {
          const r1 = await call('/api/stats/hit', { method: 'POST', body: {} });
          must(r1.status === 200, '应回 200', r1);
          must(r1.body.ok === true, 'ok:true', r1.body);
          must(JSON.stringify(Object.keys(r1.body.stats).sort()) === '["day","today","total","visitors"]',
            'stats 的键集合必须恰为 day/today/total/visitors', Object.keys(r1.body.stats));
          must(r1.body.stats.total === 1 && r1.body.stats.today === 1, '第一次调用后 total=today=1', r1.body.stats);
          const r2 = await call('/api/stats/hit', { method: 'POST', body: {} });
          must(r2.body.stats.total === 2, '第二次调用后 total=2（PV 语义）', r2.body.stats);
          must(stores.statsRows.length === 2, '数据层必须真的被调用两次', stores.statsRows.length);
          must(stores.statsRows[0].path === '/api/stats/hit',
            'path 由服务端自己取（不接受客户端上报"我访问了哪一页"）', stores.statsRows[0]);
          must(r1.headers.get('cache-control') === 'no-store', 'Cache-Control: no-store', r1.headers.get('cache-control'));
          return `HTTP 200 total=${r1.body.stats.total}→${r2.body.stats.total} day=${r1.body.stats.day}`;
        });

      await it('A-114', 'GET /api/stats 只读不计数；POST /api/stats 与 GET /api/stats/hit → 405 + Allow',
        `curl -s ${'<base>'}/api/stats`, async () => {
          const before = stores.statsRows.length;
          const g1 = await call('/api/stats');
          must(g1.status === 200, 'GET /api/stats 必须 200', g1);
          must(g1.body.stats.total === before, 'total 必须等于已记录的条数', g1.body.stats);
          await call('/api/stats');
          must(stores.statsRows.length === before, 'GET 不允许写库', stores.statsRows.length);
          const wrong = await call('/api/stats', { method: 'POST', body: {} });
          must(wrong.status === 405 && wrong.body.error.code === 'METHOD_NOT_ALLOWED', 'POST /api/stats → 405', wrong);
          must((wrong.headers.get('allow') || '').includes('GET'), '405 必须带 Allow: GET', wrong.headers.get('allow'));
          const wrong2 = await call('/api/stats/hit');
          must(wrong2.status === 405 && (wrong2.headers.get('allow') || '').includes('POST'),
            'GET /api/stats/hit → 405 + Allow: POST', wrong2);
          return `GET /api/stats=200（total 不变）；405 两条都带 Allow`;
        });

      await it('A-115', '写接口必须 application/json：POST /api/stats/hit 缺 content-type → 415',
        `curl -s -o /dev/null -w '%{http_code}' -X POST ${'<base>'}/api/stats/hit`, async () => {
          const r = await call('/api/stats/hit', { method: 'POST' });
          must(r.status === 415 && r.body.error.code === 'UNSUPPORTED_MEDIA_TYPE', '应回 415', r);
          return 'HTTP 415（跨站表单也发不进来）';
        });

      await it('A-116', '限流：第 31 次 POST /api/stats/hit → 429 + Retry-After（GET 不受影响）',
        `# 连打 31 次 POST /api/stats/hit`, async () => {
          app.rate.reset();
          for (let i = 0; i < 30; i++) {
            const ok = await call('/api/stats/hit', { method: 'POST', body: {} });
            must(ok.status === 200, `第 ${i + 1} 次不该被限流`, ok.status);
          }
          const r = await call('/api/stats/hit', { method: 'POST', body: {} });
          must(r.status === 429 && r.body.error.code === 'RATE_LIMITED', '第 31 次必须 429', r);
          must(Number(r.headers.get('retry-after')) > 0, '必须带 Retry-After', r.headers.get('retry-after'));
          const g = await call('/api/stats');
          must(g.status === 200, '读接口不受写接口限流影响（契约 §0.6）', g);
          return `31 次 → 429（Retry-After=${r.headers.get('retry-after')}s）；GET 仍 200`;
        });
    } finally { await stopLocal(h); }
  });

  /* ---------- 9) 通用 ---------- */
  await group('本地 9：OPTIONS / 404 / 405 / 来源判定（Host 与 Origin）', async () => {
    const stores = makeMemoryStores(deps);
    const h = await startLocal(deps, stores);
    try {
      const { call, port } = h;
      await it('A-120', 'OPTIONS /api/comments → 204 + Allow: GET, POST，且不发任何 CORS 头',
        'OPTIONS /api/comments', async () => {
          const r = await call('/api/comments', { method: 'OPTIONS' });
          must(r.status === 204, '必须 204', r);
          const allow = r.headers.get('allow') || '';
          must(/\bGET\b/.test(allow) && /\bPOST\b/.test(allow), 'Allow 必须含 GET 与 POST', allow);
          must(!r.headers.get('access-control-allow-origin'), '不得发 ACAO（不支持跨源）', r.headers.get('access-control-allow-origin'));
          return `HTTP 204 Allow: ${allow}`;
        });

      const g404 = await call('/api/nope');
      await expectFail('A-121', '未知路径 → 404 NOT_FOUND', 'GET /api/nope', g404, 404, 'NOT_FOUND');
      const g405 = await call('/api/auth/login', { method: 'GET' });
      await it('A-122', '路径存在但方法不对 → 405 + Allow 头', 'GET /api/auth/login', async () => {
        must(g405.status === 405, '必须 405', g405);
        must(g405.body.error.code === 'METHOD_NOT_ALLOWED', 'code', g405.body);
        must((g405.headers.get('allow') || '').includes('POST'), 'Allow 必须含 POST', g405.headers.get('allow'));
        SHAPE_CHECKED += 1;
        return `HTTP 405 Allow: ${g405.headers.get('allow')}`;
      });

      await it('A-123', 'Host 白名单：伪造 Host（DNS rebinding）→ 403；端口不符 → 403',
        'raw GET /api/auth/me，Host: evil.example / 127.0.0.1:1', async () => {
          const bad = await rawSend(port, 'GET', '/api/auth/me', { host: 'evil.example' });
          must(bad.status === 403 && bad.body.error.code === 'FORBIDDEN', '伪造 Host 必须 403', bad);
          const port2 = await rawSend(port, 'GET', '/api/auth/me', { host: '127.0.0.1:1' });
          must(port2.status === 403, 'Host 端口与实际监听端口不符必须 403', port2);
          const okHost = await rawSend(port, 'GET', '/api/auth/me', { host: '127.0.0.1:' + port });
          must(okHost.status === 200, '回环 Host + 正确端口必须放行', okHost);
          SHAPE_CHECKED += 1;
          return 'evil.example → 403；127.0.0.1:1 → 403；127.0.0.1:' + port + ' → 200';
        });

      await it('A-124', 'Origin / Sec-Fetch-Site：跨源 Origin → 403；cross-site → 403；同源 Origin → 200',
        'raw GET /api/auth/me，Origin: http://evil.example / Sec-Fetch-Site: cross-site', async () => {
          const bad = await rawSend(port, 'GET', '/api/auth/me', { host: '127.0.0.1:' + port, origin: 'http://evil.example' });
          must(bad.status === 403, '跨源 Origin 必须 403', bad);
          const sfs = await rawSend(port, 'GET', '/api/auth/me', { host: '127.0.0.1:' + port, 'sec-fetch-site': 'cross-site' });
          must(sfs.status === 403, 'Sec-Fetch-Site: cross-site 必须 403', sfs);
          const same = await rawSend(port, 'GET', '/api/auth/me', { host: '127.0.0.1:' + port, origin: 'http://127.0.0.1', 'sec-fetch-site': 'same-origin' });
          must(same.status === 200, '同源 Origin + same-origin 必须放行', same);
          return '跨源 403 / cross-site 403 / 同源 200';
        });
    } finally { await stopLocal(h); }
  });

  /* ---------- 10) 库不可用与内部异常 ---------- */
  await group('本地 10：库不可用（骨架）与内部异常：503 与 500 必须分开', async () => {
    const downStores = makeMemoryStores(Object.assign({}, deps, { down: true }));
    const hd = await startLocal(deps, downStores);
    try {
      const { call } = hd;
      await it('A-130', '库不可用时 /api/auth/me → 200 + user:null + db:"down"（不是 401/503）',
        'GET /api/auth/me（库不可用）', async () => {
          const r = await call('/api/auth/me');
          must(r.status === 200 && r.body.user === null && r.body.db === 'down', '必须 200 + null + down', r);
          return 'HTTP 200 user=null db=down';
        });

      const dbCases = [
        /* auth=none：库不可用 → 503（绝不 500、绝不假装成功） */
        ['A-131', 'POST /api/auth/register', 'POST /api/auth/register', { username: MARKER + 'dn1', email: 'dn1@t16v.example', password: 'down-password-1' }, 503, 'DB_UNAVAILABLE'],
        ['A-132', 'POST /api/auth/login', 'POST /api/auth/login', { user: MARKER + 'dn1', password: 'down-password-1' }, 503, 'DB_UNAVAILABLE'],
        /* auth=optional 且未带 cookie：读会话这一步没有会话，直接进 handler → 取数据时撞库不可用 → 503（不是空数组） */
        ['A-133', 'GET /api/comments', 'GET /api/comments?slug=' + MARKER + '-down', null, 503, 'DB_UNAVAILABLE'],
        /* auth=required：授权先于取数据，所以未登录是 401（而不是把 503 泄露给未登录者） */
        ['A-134', 'GET /api/comments/mine', 'GET /api/comments/mine', null, 401, 'UNAUTHENTICATED'],
        ['A-135', 'DELETE /api/comments/1', 'DELETE /api/comments/1', null, 401, 'UNAUTHENTICATED']
      ];
      for (const [id, label, cmd, body, status, code] of dbCases) {
        const method = cmd.startsWith('DELETE') ? 'DELETE' : (cmd.startsWith('POST') ? 'POST' : 'GET');
        const r = method === 'GET'
          ? await call(cmd.split(' ')[1])
          : await call(cmd.split(' ')[1], { method, body: body || {}, headers: method === 'DELETE' ? { 'content-type': 'application/json' } : {} });
        await expectFail(id, `${label} → ${status} ${code}（库不可用时不返回空数据、不混成 500）`, cmd, r, status, code);
      }

      await it('A-136', '库不可用时登出仍回 200（清 cookie 不需要库）',
        'POST /api/auth/logout（库不可用）', async () => {
          const r = await call('/api/auth/logout', { method: 'POST', body: {} });
          must(r.status === 200 && r.body.ok === true, '必须 200', r);
          must(/Max-Age=0/.test(r.setCookies.join(']')), '仍必须清 cookie', r.setCookies);
          return 'HTTP 200 destroyed=false + 清 cookie';
        });
    } finally { await stopLocal(hd); }

    const boomStores = makeMemoryStores(Object.assign({}, deps, { boom: true }));
    const hb = await startLocal(deps, boomStores);
    try {
      const r = await hb.call('/api/auth/register', { method: 'POST', body: { username: MARKER + 'boom', email: 'boom@t16v.example', password: 'boom-password-1' } });
      await it('A-137', '数据层抛未知异常 → 500 INTERNAL，文案固定，绝不回显异常细节',
        'POST /api/auth/register（store.createUser 抛 Error）', async () => {
          must(r.status === 500, '必须 500', r);
          must(r.body.error.code === 'INTERNAL', 'code 必须是 INTERNAL', r.body);
          must(r.body.error.message === '服务器内部错误', '文案必须是那一句固定的中文', r.body.error.message);
          must(!/verify-boom|stack|at .*\.mjs/.test(r.text), '绝不回显异常内容/堆栈', r.text);
          SHAPE_CHECKED += 1;
          return 'HTTP 500 INTERNAL "服务器内部错误"（无细节外泄）';
        });
    } finally { await stopLocal(hb); }
  });
};

/* ------------------------------------------------------------
   4.5 真子进程端到端（骨架模式）：独立于 t14 的自测，自己起服务自己打
   ------------------------------------------------------------
   为什么要有这一段（而不只是内存 store + 同进程 createPublicApp）：
     · 它走的是**真正的 CLI 启动路径**（argv 解析、环境变量、exit code、横幅、
       SIGTERM 退出码），同进程 createPublicApp 覆盖不到；
     · 它证明"没有数据库时服务不崩、不假装成功、失败形状仍然合规"。
   骨架模式下需要数据的端点回 503 DB_UNAVAILABLE —— 这是**契约要求的行为**
   （CONTRACT §4.1 / §6 第 3 条），记为符合性判据，不是失败。
   ------------------------------------------------------------ */
const cleanP3Env = () => {
  const e = Object.assign({}, process.env);
  for (const k of P3_ENV_KEYS) delete e[k];
  return e;
};

const startSkeleton = async (port) => {
  const child = spawn(process.execPath, [
    join(BLOG_DIR, 'server', 'public-server.mjs'),
    '--allow-degraded', '--listen', '127.0.0.1', '--port', String(port)
  ], { cwd: join(BLOG_DIR, 'server'), env: cleanP3Env(), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  const base = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !exited) {
    try { const r = await fetch(base + '/api/auth/me'); if (r.status) break; } catch { /* 还没监听 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  const stop = async () => {
    if (exited) return exited;
    child.kill('SIGTERM');
    const d = Date.now() + 8000;
    while (Date.now() < d && !exited) await new Promise((r) => setTimeout(r, 100));
    if (!exited) { try { child.kill('SIGKILL'); } catch { /* 已退 */ } return { code: null, signal: 'SIGKILL' }; }
    return exited;
  };
  return { base, port, output: () => out, exited: () => exited, stop };
};

const runSkeletonE2E = async () => {
  const PORT = Number(value('port', '18861'));
  await group(`本地 11：真服务端到端（子进程骨架模式 127.0.0.1:${PORT}）`, async () => {
    const srv = await startSkeleton(PORT);
    const call = makeCaller(srv.base);
    let up = false;
    try { const r = await fetch(srv.base + '/api/auth/me'); up = Boolean(r.status); } catch { up = false; }

    try {
      await it('A-SK-01', '真子进程按 CLI 起来并监听 127.0.0.1:18861（--allow-degraded 骨架模式），横幅不含任何凭据',
        'node blog-enter/server/public-server.mjs --allow-degraded --listen 127.0.0.1 --port 18861', () => {
          must(up, '服务没起来（20s 内没有响应）', srv.output().slice(-400));
          const out = srv.output();
          must(/公开 API/.test(out), '启动横幅应打印 API 地址', out.slice(-300));
          /* 只打印变量**名**（契约 §5 要求列出缺哪些变量）是可以的；
             不允许的是把变量的**值**打出来 —— 所以查"名=值"形状，不查名字本身。 */
          must(!/P3_DB_PASSWORD\s*=|password\s*=\s*\S/i.test(out), '横幅不得打印口令的值', out.slice(-300));
          return `已监听 ${srv.base}；横幅含「公开 API」，且只列缺失变量名、无变量值`;
        });
      need(up, '骨架模式服务未就绪，本组其余断言无法执行');

      await it('A-SK-02', '无数据库时 GET /api/auth/me → 200 + user:null + db:"down"（未登录是正常状态，不 401/503）',
        `curl -s ${srv.base}/api/auth/me`, async () => {
          const r = await call('/api/auth/me');
          must(r.status === 200, `应回 200（实测 ${r.status}）`, r);
          must(r.body.ok === true && r.body.user === null, 'user 必须是 null', r.body);
          must(r.body.db === 'down', 'db 必须是 down', r.body);
          return `HTTP 200 user=null db=down days=${r.body.session_max_age_days}`;
        });

      const reg = await call('/api/auth/register', { method: 'POST', body: { username: MARKER + 'sk1', email: 'sk1@t16v.example', password: 'sk-password-1' } });
      await expectFail('A-SK-03', '骨架模式：POST /api/auth/register（合法体）→ 503 DB_UNAVAILABLE（不是 500、更不假装成功）',
        `curl -s -X POST ${srv.base}/api/auth/register -d '{...}'`, reg, 503, 'DB_UNAVAILABLE');

      const r4 = await call('/api/auth/register', { method: 'POST', body: { email: 'sk2@t16v.example', password: 'sk-password-1' } });
      await expectFail('A-SK-04', '骨架模式：缺 username → 422 INVALID_USERNAME（校验在取数据之前）',
        `curl -s -X POST ${srv.base}/api/auth/register -d '{"email":"…","password":"…"}'`, r4, 422, 'INVALID_USERNAME');
      const r5 = await call('/api/auth/register', { method: 'POST', body: { username: MARKER + 'sk2', email: 'sk2@t16v.example', password: 'p'.repeat(201) } });
      await expectFail('A-SK-05', '骨架模式：口令 201 字符（超长）→ 422 INVALID_PASSWORD',
        `curl -s -X POST ${srv.base}/api/auth/register -d '{…"password":"<201>"}'`, r5, 422, 'INVALID_PASSWORD');
      const r6 = await call('/api/auth/register', { method: 'POST', body: { username: MARKER + 'sk3', email: 'a@b', password: 'sk-password-1' } });
      await expectFail('A-SK-06', '骨架模式：邮箱无点 → 422 INVALID_EMAIL',
        `curl -s -X POST ${srv.base}/api/auth/register -d '{…"email":"a@b"}'`, r6, 422, 'INVALID_EMAIL');

      const l1 = await call('/api/auth/login', { method: 'POST', body: { user: MARKER + 'sk1', password: 'sk-password-1' } });
      await expectFail('A-SK-07', '骨架模式：POST /api/auth/login（合法体）→ 503 DB_UNAVAILABLE',
        `curl -s -X POST ${srv.base}/api/auth/login -d '{"user":"…","password":"…"}'`, l1, 503, 'DB_UNAVAILABLE');
      const l2 = await call('/api/auth/login', { method: 'POST', body: { password: 'sk-password-1' } });
      await expectFail('A-SK-08', '骨架模式：登录缺 user 字段 → 400 BAD_REQUEST',
        `curl -s -X POST ${srv.base}/api/auth/login -d '{"password":"…"}'`, l2, 400, 'BAD_REQUEST');
      const l3 = await call('/api/auth/login', { method: 'POST', body: { user: MARKER + 'sk1', password: '123' } });
      await expectFail('A-SK-09', '骨架模式：登录口令 3 字符 → 422 INVALID_PASSWORD',
        `curl -s -X POST ${srv.base}/api/auth/login -d '{"user":"…","password":"123"}'`, l3, 422, 'INVALID_PASSWORD');
      const l4 = await call('/api/auth/login', { method: 'POST', body: { user: MARKER + 'sk1', password: 'sk-password-1' }, contentType: null });
      await expectFail('A-SK-10', '骨架模式：写接口缺 Content-Type: application/json → 415 UNSUPPORTED_MEDIA_TYPE',
        `curl -s -X POST ${srv.base}/api/auth/login -d '{...}' -H 'Content-Type: text/plain'`, l4, 415, 'UNSUPPORTED_MEDIA_TYPE');

      const c1 = await call('/api/comments', { method: 'POST', body: { slug: 'sk', content: 'x' } });
      await expectFail('A-SK-11', '骨架模式：未登录发评论 → 401 UNAUTHENTICATED（授权先于取数据）',
        `curl -s -X POST ${srv.base}/api/comments -d '{"slug":"sk","content":"x"}'`, c1, 401, 'UNAUTHENTICATED');
      const d1 = await call('/api/comments/1', { method: 'DELETE', headers: { 'content-type': 'application/json' } });
      await expectFail('A-SK-12', '骨架模式：未登录删评论 → 401 UNAUTHENTICATED',
        `curl -s -X DELETE ${srv.base}/api/comments/1`, d1, 401, 'UNAUTHENTICATED');
      const d2 = await call('/api/comments/1', { method: 'DELETE', headers: { 'content-type': 'application/json' }, cookie: 'p3_uid=' + 'f'.repeat(64) });
      await expectFail('A-SK-13', '骨架模式：伪造会话 cookie 删评论 → 401（不认伪造会话）',
        `curl -s -X DELETE ${srv.base}/api/comments/1 -b 'p3_uid=ffff…'`, d2, 401, 'UNAUTHENTICATED');
      const g1 = await call('/api/comments?slug=sk');
      await expectFail('A-SK-14', '骨架模式：未登录读评论列表 → 503 DB_UNAVAILABLE（不是空数组：空数组等于"评论没了"）',
        `curl -s '${srv.base}/api/comments?slug=sk'`, g1, 503, 'DB_UNAVAILABLE');
      const g2 = await call('/api/comments');
      await expectFail('A-SK-15', '骨架模式：评论列表缺 slug → 422 INVALID_SLUG',
        `curl -s '${srv.base}/api/comments'`, g2, 422, 'INVALID_SLUG');
      const m1 = await call('/api/comments/mine');
      await expectFail('A-SK-16', '骨架模式：未登录读「我的评论」→ 401 UNAUTHENTICATED',
        `curl -s ${srv.base}/api/comments/mine`, m1, 401, 'UNAUTHENTICATED');

      const j1 = await call('/api/auth/register', { method: 'POST', body: '{not json' });
      await expectFail('A-SK-17', '骨架模式：请求体不是合法 JSON → 400 INVALID_JSON',
        `curl -s -X POST ${srv.base}/api/auth/register -d '{not json'`, j1, 400, 'INVALID_JSON');
      const a1 = await call('/api/auth/register', { method: 'POST', body: '[1,2,3]' });
      await expectFail('A-SK-18', '骨架模式：请求体是数组 → 400 BAD_REQUEST',
        `curl -s -X POST ${srv.base}/api/auth/register -d '[1,2,3]'`, a1, 400, 'BAD_REQUEST');

      await it('A-SK-19', '骨架模式（S6）：请求体 > 1 MiB → **能读到** 413 + `connection: close` + BODY_TOO_LARGE 响应体（裸 http，不用 fetch）',
        `raw POST ${srv.base}/api/auth/register content=1MiB+4KiB`, async () => {
          const big = JSON.stringify({ username: MARKER + 'big', email: 'big@t16v.example', password: 'x'.repeat(1024 * 1024 + 4096) });
          let r = null;
          try {
            r = await rawSend(PORT, 'POST', '/api/auth/register', { host: '127.0.0.1:' + PORT, 'content-type': 'application/json' }, big);
          } catch (err) {
            must(false, 'S6 的判据是"客户端必须能读到 413"；连接被直接销毁说明响应没发完（用裸 http 仍应读得到）',
              `${String(err.code || err.message)}`);
          }
          must(r.status === 413, `必须回 413（实测 ${r.status}）`, r);
          must(r.body && r.body.error && r.body.error.code === 'BODY_TOO_LARGE', '响应体必须是 BODY_TOO_LARGE', r.body);
          must(JSON.stringify(Object.keys(r.body).sort()) === '["error","ok"]', '失败体顶层键必须恰为 ok/error', r.body);
          must(String(r.headers.connection || '') === 'close', '必须带 connection: close（否则客户端不知道连接要断）', r.headers.connection);
          const cl = Number(r.headers['content-length']);
          must(Number.isFinite(cl) && cl === Buffer.byteLength(r.text), 'content-length 必须与实际响应体长度一致',
            { contentLength: r.headers['content-length'], actual: Buffer.byteLength(r.text) });
          SHAPE_CHECKED += 1;
          return `HTTP 413 BODY_TOO_LARGE · connection: close · content-length ${cl}`;
        });

      await it('A-SK-20', '来源判定（真服务）：伪造 Host / 跨源 Origin / Sec-Fetch-Site: cross-site → 403；回环同源 → 200',
        `raw GET ${srv.base}/api/auth/me 带 Host: evil.example / Origin: http://evil.example`, async () => {
          const badHost = await rawSend(PORT, 'GET', '/api/auth/me', { host: 'evil.example' });
          must(badHost.status === 403 && badHost.body.error.code === 'FORBIDDEN', '伪造 Host 必须 403', badHost);
          const badPort = await rawSend(PORT, 'GET', '/api/auth/me', { host: '127.0.0.1:1' });
          must(badPort.status === 403, 'Host 端口与监听端口不符必须 403', badPort);
          const badOrigin = await rawSend(PORT, 'GET', '/api/auth/me', { host: '127.0.0.1:' + PORT, origin: 'http://evil.example' });
          must(badOrigin.status === 403, '跨源 Origin 必须 403', badOrigin);
          const badSfs = await rawSend(PORT, 'GET', '/api/auth/me', { host: '127.0.0.1:' + PORT, 'sec-fetch-site': 'cross-site' });
          must(badSfs.status === 403, 'Sec-Fetch-Site: cross-site 必须 403', badSfs);
          const good = await rawSend(PORT, 'GET', '/api/auth/me', { host: '127.0.0.1:' + PORT, origin: 'http://127.0.0.1', 'sec-fetch-site': 'same-origin' });
          must(good.status === 200, '回环同源必须放行', good);
          return '伪 Host 403 · 错端口 403 · 跨源 Origin 403 · cross-site 403 · 同源 200';
        });

      const nf = await call('/api/nope');
      await expectFail('A-SK-21', '骨架模式：未知路径 → 404 NOT_FOUND', `curl -s ${srv.base}/api/nope`, nf, 404, 'NOT_FOUND');
      const m405 = await call('/api/auth/login');
      await it('A-SK-22', '骨架模式：路径存在但方法不对 → 405 + Allow 头', `curl -si ${srv.base}/api/auth/login（GET）`, () => {
        must(m405.status === 405, '必须 405', m405);
        must((m405.headers.get('allow') || '').includes('POST'), 'Allow 必须含 POST', m405.headers.get('allow'));
        return `HTTP 405 Allow: ${m405.headers.get('allow')}`;
      });
      const opt = await call('/api/comments', { method: 'OPTIONS' });
      await it('A-SK-23', '骨架模式：OPTIONS → 204 + Allow，且不发任何 CORS 头', `curl -si -X OPTIONS ${srv.base}/api/comments`, () => {
        must(opt.status === 204, '必须 204', opt);
        must(!opt.headers.get('access-control-allow-origin'), '不得发 ACAO', opt.headers.get('access-control-allow-origin'));
        return `HTTP 204 Allow: ${opt.headers.get('allow')}`;
      });

      const ex = await srv.stop();
      if (process.platform === 'win32') {
        notApplicable('A-SK-24', 'SIGTERM → 优雅退出（exit code 0）', 'kill -TERM <pid>；观察退出码',
          'Windows 没有 POSIX 信号：Node 的 child.kill("SIGTERM") 直接 TerminateProcess，'
          + '被测进程的 SIGTERM 处理器不会被调用（实测 ' + JSON.stringify(ex) + '）。'
          + '这一条必须在 Linux（服务器）上核 —— 部署后由 t20 用 '
          + '`systemctl restart p3-public` / `kill -TERM` 复核退出码 0。');
      } else {
        await it('A-SK-24', 'SIGTERM → 优雅退出（exit code 0，不是被 SIGKILL）', 'kill -TERM <pid>；观察退出码',
          () => {
            must(ex && ex.code === 0, `退出码应为 0（实测 ${JSON.stringify(ex)}）`, ex);
            return `exit code ${ex.code}`;
          });
      }
    } finally {
      await srv.stop();
    }
  });

  /* 独立实例：注册限流（5 次/小时）—— 必须换一个进程，因为内存窗口是按进程的 */
  await group(`本地 12：真服务限流（子进程骨架模式，端口 ${PORT + 1}）`, async () => {
    const srv = await startSkeleton(PORT + 1);
    try {
      const call = makeCaller(srv.base);
      await it('A-SK-30', '注册限流：同一 IP 第 6 次 → 429 RATE_LIMITED + Retry-After: 3600（前 5 次放行到 503）',
        `for i in 1..6; do curl -s -X POST ${srv.base}/api/auth/register -d '{...}'; done`, async () => {
          const codes = [];
          let last = null;
          for (let i = 1; i <= 6; i += 1) {
            last = await call('/api/auth/register', { method: 'POST', body: { username: MARKER + 'rl' + i, email: `rl${i}@t16v.example`, password: 'rl-password-' + i } });
            codes.push(last.status);
            if (i <= 5) must(last.status === 503, `第 ${i} 次应放行到骨架模式的 503（实测 ${last.status}）`, last);
          }
          must(last.status === 429, '第 6 次必须 429', last);
          must(last.body.error.code === 'RATE_LIMITED', 'code 必须是 RATE_LIMITED', last.body);
          must(last.headers.get('retry-after') === '3600', 'Retry-After 必须是 3600 秒', last.headers.get('retry-after'));
          return `状态序列 ${codes.join(',')}（第 6 次 429 Retry-After=3600）`;
        });
    } finally { await srv.stop(); }
  });

  /* 独立实例：登录限流（10 次/15 分钟）第 11 次 429 */
  await group(`本地 13：真服务限流（子进程骨架模式，端口 ${PORT + 2}）`, async () => {
    const srv = await startSkeleton(PORT + 2);
    try {
      const call = makeCaller(srv.base);
      await it('A-SK-31', '登录限流：第 11 次错口令 → 429 + Retry-After: 3600（前 10 次骨架模式回 503）',
        `for i in 1..11; do curl -s -X POST ${srv.base}/api/auth/login -d '{"user":"…","password":"wrong-password-1"}'; done`, async () => {
          const codes = [];
          let last = null;
          for (let i = 1; i <= 11; i += 1) {
            last = await call('/api/auth/login', { method: 'POST', body: { user: MARKER + 'nobody', password: 'wrong-password-1' } });
            codes.push(last.status);
            if (i <= 10) must(last.status === 503, `第 ${i} 次应放行到骨架模式的 503（实测 ${last.status}）`, last);
          }
          must(last.status === 429, '第 11 次必须 429', last);
          must(last.headers.get('retry-after') === '3600', 'Retry-After 必须是 3600 秒', last.headers.get('retry-after'));
          must(!/password_hash|password_algo/.test(last.text), '429 响应体不得含口令列', last.text);
          return `状态序列 ${codes.join(',')}（第 11 次 429 Retry-After=3600）`;
        });
    } finally { await srv.stop(); }
  });
};

/* ------------------------------------------------------------
   5. 静态结构检查（t12 产物）
   ------------------------------------------------------------ */
const runStaticChecks = async () => {
  await group('静态：右上角登录入口 / Waline 已下线 / 无 innerHTML 拼接', async () => {
    const PAGES = ['index.html', 'archive.html', 'article.html', 'about.html', '404.html'];
    for (const p of PAGES) {
      await it('S-' + p, `${p}：挂登录入口标记（data-auth-entry + 登录按钮 + auth-ui.js + comments.css），且不再引用 Waline`,
        `Select-String -Path blog-enter\\${p} -Pattern 'data-auth-entry|waline'`, () => {
          const src = readFileSync(join(BLOG_DIR, p), 'utf8');
          must(/data-auth-entry/.test(src), '缺少 data-auth-entry 标记', p);
          must(/data-auth-open/.test(src), '缺少可点击的登录按钮（data-auth-open）', p);
          must(/js\/auth-ui\.js/.test(src), '缺少 js/auth-ui.js', p);
          must(/css\/comments\.css/.test(src), '缺少 css/comments.css', p);
          must(!/waline/i.test(src), '页面里不得再出现 waline', (src.match(/.{0,60}waline.{0,60}/i) || [''])[0]);
          must(!/comments-assets/.test(src), '页面不得再引用 comments-assets/', p);
          return `标记齐全；waline 命中 0 次`;
        });
    }

    await it('S-article', 'article.html：评论区换成 js/comments.js，且暴露 window.initComments(slug)',
      "Select-String -Path blog-enter\\article.html,blog-enter\\js\\comments.js -Pattern 'comments.js|initComments'", () => {
      const page = readFileSync(join(BLOG_DIR, 'article.html'), 'utf8');
      const js = readFileSync(join(BLOG_DIR, 'js', 'comments.js'), 'utf8');
      must(/js\/comments\.js/.test(page), 'article.html 必须加载 js/comments.js', page.match(/<script[^>]*>/g));
      must(/window\.initComments\s*=/.test(js), 'comments.js 必须导出 window.initComments', '');
      return 'article.html 引 js/comments.js；comments.js 导出 window.initComments';
    });

    for (const f of ['js/auth-ui.js', 'js/comments.js']) {
      await it('S-' + f.replace(/\W+/g, '_'), `${f}：注释剥离后不得出现 innerHTML / outerHTML / insertAdjacentHTML / document.write`,
        `（读文件 + 剥注释 + 搜危险 API）blog-enter\\${f}`, () => {
          const code = stripJsComments(readFileSync(join(BLOG_DIR, f), 'utf8'));
          const hits = code.match(/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write/g) || [];
          must(hits.length === 0, '不得使用 HTML 拼接 API（渲染层只允许 createElement + textContent）', hits.join(','));
          const textCalls = (code.match(/textContent/g) || []).length;
          must(textCalls >= 3, '应当用 textContent 写文本（至少 3 处）', textCalls);
          return `危险 API 0 次；textContent ${textCalls} 处`;
        });

      await it('S-cred-' + f.replace(/\W+/g, '_'), `${f}：写请求带 credentials:'same-origin'，且 POST/DELETE 带 Content-Type: application/json`,
        `（读文件）blog-enter\\${f}`, () => {
          const code = readFileSync(join(BLOG_DIR, f), 'utf8');
          must(/credentials:\s*'same-origin'/.test(code), "必须带 credentials: 'same-origin'", '');
          must(/init\.headers\['Content-Type'\]\s*=\s*'application\/json'/.test(code)
            || /'Content-Type':\s*'application\/json'/.test(code),
          '必须显式设置 Content-Type: application/json（否则服务端 415）', '');
          return "credentials:'same-origin' + Content-Type: application/json";
        });
    }

    await it('S-mine', 'comments.js 用 /api/comments/mine 驱动「我的评论」（不是把全站评论拉下来自己筛）',
      "Select-String -Path blog-enter\\js\\comments.js,blog-enter\\js\\auth-ui.js -Pattern '/api/comments/mine'", () => {
      const js = readFileSync(join(BLOG_DIR, 'js', 'comments.js'), 'utf8')
        + readFileSync(join(BLOG_DIR, 'js', 'auth-ui.js'), 'utf8');
      must(/comments\/mine/.test(js), '必须调用 /api/comments/mine', '');
      return '/api/comments/mine 已被引用';
    });

    await it('S-isolation', '公开服务代码里没有管理面引用（dev-server / lib/auth.mjs / posts-store / passphrase 只在注释里出现）',
      "grep -nE 'dev-server|lib/auth\\.mjs|posts-store|passphrase|\\.admin/' blog-enter/server/public-server.mjs blog-enter/server/lib/public/*.mjs", () => {
      const files = ['public-server.mjs', 'lib/public/http.mjs', 'lib/public/db.mjs', 'lib/public/passwords.mjs',
        'lib/public/userstore.mjs', 'lib/public/commentstore.mjs', 'lib/public/store.mjs'];
      const bad = [];
      for (const f of files) {
        const code = stripJsComments(readFileSync(join(BLOG_DIR, 'server', f), 'utf8'));
        const m = code.match(/dev-server|lib\/auth\.mjs|posts-store|passphrase|\.admin\//g) || [];
        if (m.length) bad.push(f + ': ' + m.join(','));
      }
      must(bad.length === 0, '公开服务代码里不得出现管理面引用', bad.join(' | '));
      return `${files.length} 个公开服务模块，管理面引用 0 次（全在注释里）`;
    });

    await it('S-s9', '（S9 回退）产品代码里没有评论审核开关的残留：comments-hold-for-review / MODERATION_MODES / normalizeCommentStatus 在 public-server.mjs + lib/public/** 中 0 命中',
      "grep -nE 'comments-hold-for-review|MODERATION_MODES|normalizeCommentStatus' blog-enter/server/public-server.mjs blog-enter/server/lib/public/*.mjs",
      () => {
        const files = ['public-server.mjs', 'lib/public/http.mjs', 'lib/public/db.mjs', 'lib/public/passwords.mjs',
          'lib/public/userstore.mjs', 'lib/public/commentstore.mjs', 'lib/public/store.mjs'];
        const hits = [];
        for (const f of files) {
          const raw = readFileSync(join(BLOG_DIR, 'server', f), 'utf8');
          /* 判据按"产品代码"算：注释里写"没有这个参数"也算命中，故注释与代码分开统计 */
          const code = stripJsComments(raw);
          (code.match(/comments-hold-for-review|MODERATION_MODES|normalizeCommentStatus/g) || [])
            .forEach((h) => hits.push(f + '(代码): ' + h));
          (raw.match(/comments-hold-for-review|MODERATION_MODES|normalizeCommentStatus/g) || [])
            .forEach((h) => hits.push(f + '(含注释): ' + h));
        }
        const inCode = hits.filter((h) => h.includes('(代码)'));
        must(inCode.length === 0, '产品代码里不得出现审核开关的实现（全仓的 3 处命中都在文档/测试里，属正当）', inCode.join(' | '));
        return `产品代码命中 0 次（含注释共 ${hits.length} 次${hits.length ? '：' + hits.join(' | ') : ''}）`;
      });

    await it('S-contract', '契约文本已同步 t21 的四项（文字级核对）：§0.5 cookie `Path=/api`、§4.0 `600000` + 旧格式兼容、§0.6/§1.2 注册恒 5 次/小时 + 校验失败不计入落库计数、§5 明确没有 `--comments-hold-for-review`',
      "grep -nE 'Path=/api|600000|5 次|校验失败不计入|comments-hold-for-review' blog-enter/server/CONTRACT-public-api.md", () => {
        const md = readFileSync(join(BLOG_DIR, 'server', 'CONTRACT-public-api.md'), 'utf8');
        must(/Path=\/api/.test(md), '契约必须写下 Path=/api（§0.5，t21 同步项）', 'no Path=/api');
        must(/600000/.test(md) && /210000/.test(md), '契约必须写新轮数 600000 并说明旧格式 210000 仍可校验（§4.0）', 'missing iterations text');
        must(/校验失败不计入落库计数/.test(md), '契约必须写死"校验失败不计入落库计数"（§0.6，防止下一轮再漂）', 'missing 校验失败不计入');
        must(/\| `auth\.register` \| 每 IP \| 60 分钟 \| \*\*5 次\*\*/.test(md), '§0.6 注册阈值必须仍是 5 次/60 分钟', md.match(/\| `auth\.register`[^\n]*/)?.[0]);
        must(/没有\*\* `--comments-hold-for-review`/.test(md), '§5 必须明确没有 --comments-hold-for-review（S9 本轮不做）', 'missing S9 note');
        return '§0.5 Path=/api · §4.0 600000+210000 兼容 · §0.6 5 次/小时+校验失败不计入 · §5 无审核开关';
      });
  });
};

/* ------------------------------------------------------------
   6. 线上 B 部分
   ------------------------------------------------------------ */
const runSql = (sql) => {
  if (SQL_LOCAL) {
    return execFileSync('mysql', ['-N', '-B', 'p3blog'], { input: sql, encoding: 'utf8', timeout: 60000 });
  }
  if (SSH_TARGET) {
    return execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', SSH_TARGET, 'mysql -N -B p3blog'],
      { input: sql, encoding: 'utf8', timeout: 60000 });
  }
  return null;
};

/**
 * SQL 字符串转义（审计 N2 的处置）。
 *
 * 【为什么这里不是"参数化"】这个通道的形态是 `ssh <host> mysql <<'SQL' … SQL` ——
 * 一条 SQL 文本经 stdin 喂给 mysql 客户端，**没有**绑定参数的余地（不像 mysql2
 * 的 `?` 占位符）。所以能做的是把"拼进 SQL 的每个字符串"都过一遍真正的转义，
 * 而不是裸模板串。
 *
 * 【为什么仍然值得改】现在拼进去的 MARKER / SLUG 都是脚本自己用
 * `t16v<runId>` 生成的、不含引号，所以**当前不构成注入**。但"靠调用方保证
 * 输入干净"这种写法一旦被抄进产品代码就是真漏洞 —— 审计明确建议改掉。
 * 转义规则（与 mysql 客户端的 mysql_real_escape_string 同语义）：
 *   \  → \\      '  → \'      "  → \"      NUL → \0
 *   \n → \n      \r → \r      \x1a → \Z
 * 非字符串一律 String() 后走同一条路（数字不会被改变语义）。
 */
const sqlEscape = (v) => String(v)
  .replace(/\\/g, '\\\\')
  .replace(/'/g, "\\'")
  .replace(/"/g, '\\"')
  .replace(/\0/g, '\\0')
  .replace(/\n/g, '\\n')
  .replace(/\r/g, '\\r')
  .replace(/\x1a/g, '\\Z');

/** 拼一个 SQL 字符串字面量（含引号）。所有要进 SQL 的字符串都必须走它。 */
const sqlStr = (v) => "'" + sqlEscape(v) + "'";

const sqlScalar = (sql) => {
  const out = runSql(sql);
  if (out == null) return null;
  const line = String(out).trim().split('\n')[0].trim();
  return /^-?\d+$/.test(line) ? Number(line) : line;
};

const runLive = async (base) => {
  const call = makeCaller(base);
  const tag = base.replace(/^https?:\/\//, '').replace(/\W+/g, '_');
  const USER_A = MARKER + 'a';
  const USER_B = MARKER + 'b';
  const EMAIL_A = USER_A + '@t16v.example';
  const EMAIL_B = USER_B + '@t16v.example';
  const PW_A = 'live-password-' + RUN_ID + '-a';
  const PW_B = 'live-password-' + RUN_ID + '-b';
  const SLUG = CONTENT_TAG + '-slug';
  say(`\n======== 线上：${base} ========`);
  say(`本轮标记：user=${USER_A}/${USER_B} slug=${SLUG} content 前缀=${CONTENT_TAG}`);

  let cookieA = '';
  let cookieB = '';
  let commentA = null;
  let commentB = null;
  let sessionA = '';
  /* 所有下发过的会话 cookie（注册/登录各一条）：最后要逐个登出，
     否则"退出后会话行清空"这条 DB 核对会因为别的会话还在而假失败。 */
  const sessionJar = [];

  await group(`线上 ${base}：连通性与 me`, async () => {
    let me = null;
    let meErr = null;
    try { me = await call('/api/auth/me'); } catch (err) { meErr = err; }
    await it('B-' + tag + '-01', 'GET /api/auth/me → 200 + user:null + db:"up"（库真的通）',
      `curl -s ${base}/api/auth/me`, () => {
        must(!meErr, `入口不可达（${String((meErr && meErr.cause && meErr.cause.code) || (meErr && meErr.message) || meErr)}）`
          + '：未部署 / 端口未监听 / 地址写错；部署后重跑本命令', base);
        must(me.status === 200, `应回 200（实测 ${me.status}）—— 若 404 说明还没部署或没反代`, me);
        must(me.body && me.body.ok === true, 'ok:true', me.body);
        must(me.body.db === 'up', 'db 必须是 up（说明 MySQL 真的连上了）', me.body);
        must(me.body.session_max_age_days === 30, '会话 30 天', me.body);
        must(me.headers.get('cache-control') === 'no-store', 'Cache-Control: no-store', me.headers.get('cache-control'));
        return `HTTP 200 user=null db=${me.body.db} days=${me.body.session_max_age_days}`;
      });
    need(me && me.status === 200, `线上入口 ${base} 不可达或未部署（/api/auth/me 未返回 200）`);

    await it('B-' + tag + '-02', '发布面：GET /package.json 与 /server/package.json 必须 404（依赖清单不能挂到公网）',
      `curl -s -o /dev/null -w '%{http_code}' ${base}/package.json`, async () => {
        for (const p of ['/package.json', '/server/package.json', '/server/public-server.mjs']) {
          const r = await call(p);
          must(r.status === 404, `${p} 必须 404（实测 ${r.status}）`, r.text.slice(0, 120));
        }
        return '/package.json → 404；/server/package.json → 404；/server/public-server.mjs → 404';
      });
  });

  /* -------- 访问统计（契约 §1.8 / §1.9）：线上真实 HTTP，真写一行 -------- */
  await group(`线上 ${base}：访问统计（真计数，会写一行 page_views）`, async () => {
    if (ROWS.some((r) => r.id === 'B-' + tag + '-01' && !r.pass)) {
      throw new AbortGroup('连通性/me 前置失败，访问统计未执行');
    }
    const g0 = await call('/api/stats');
    await it('B-' + tag + '-03', 'GET /api/stats → 200 + stats{total,today,visitors,day} + no-store',
      `curl -s ${base}/api/stats`, () => {
        must(g0.status === 200, `应回 200（实测 ${g0.status}）—— 404 说明 nginx 白名单还没加 /api/stats`, g0);
        must(g0.body && g0.body.ok === true, 'ok:true', g0.body);
        const s = (g0.body && g0.body.stats) || {};
        must(JSON.stringify(Object.keys(s).sort()) === '["day","today","total","visitors"]',
          'stats 的键集合必须恰为 day/today/total/visitors（多了就是实现里混进了别的东西）', Object.keys(s));
        for (const k of ['total', 'today', 'visitors']) {
          must(typeof s[k] === 'number' && s[k] >= 0, `${k} 必须是非负数字（字符串会让前端显示成原样）`, s);
        }
        must(/^\d{4}-\d{2}-\d{2}$/.test(String(s.day)), 'day 必须是 YYYY-MM-DD', s.day);
        must(g0.headers.get('cache-control') === 'no-store', 'Cache-Control: no-store', g0.headers.get('cache-control'));
        return `HTTP 200 total=${s.total} today=${s.today} visitors=${s.visitors} day=${s.day}`;
      });
    await it('B-' + tag + '-04', 'POST /api/stats/hit → 200，total 恰好 +1，today/visitors ≥ 1',
      `curl -s -X POST ${base}/api/stats/hit -H 'Content-Type: application/json' -d '{}'`, async () => {
        const r = await call('/api/stats/hit', { method: 'POST', body: {} });
        must(r.status === 200, `应回 200（实测 ${r.status}）`
          + '：415 说明 nginx 没把 content-type 传过去，429 说明本机已被限流（等一分钟重跑）', r);
        const before = (g0.body && g0.body.stats && g0.body.stats.total) || 0;
        must(r.body.stats.total === before + 1, `total 必须恰好 +1（${before} → ${r.body.stats.total}）`, r.body.stats);
        must(r.body.stats.today >= 1, 'today 必须 ≥ 1', r.body.stats);
        must(r.body.stats.visitors >= 1, 'visitors 必须 ≥ 1', r.body.stats);
        return `total ${before} → ${r.body.stats.total}；today=${r.body.stats.today} visitors=${r.body.stats.visitors}`;
      });
    await it('B-' + tag + '-05', 'GET /api/stats/hit → 405 + Allow: POST；缺 content-type → 415',
      `curl -s -i ${base}/api/stats/hit`, async () => {
        const g = await call('/api/stats/hit');
        must(g.status === 405 && (g.headers.get('allow') || '').includes('POST'),
          'GET hit → 405 + Allow: POST', g);
        const p = await call('/api/stats/hit', { method: 'POST' });
        must(p.status === 415 && p.body.error.code === 'UNSUPPORTED_MEDIA_TYPE',
          '缺 content-type → 415 UNSUPPORTED_MEDIA_TYPE', p);
        return '405 + Allow: POST；415 UNSUPPORTED_MEDIA_TYPE';
      });
  });

  if (ROWS.some((r) => r.id === 'B-' + tag + '-01' && !r.pass)) {
    notApplicable('B-' + tag + '-SKIP', `在线入口 ${base} 的闭环 / 失败路径 / 限流 / 库核对：本轮跳过`,
      `（因为 B-${tag}-01 未通过：${base}/api/auth/me 不是 200）`,
      '入口不可达或尚未部署时这些断言没有意义 —— 跳过并如实标注，而不是把它们记成十几个失败。'
      + '部署后直接重跑本命令：node blog-enter/server/tests/verify-public-live.mjs --base ' + base);
    return { base, cookieA: '', cookieB: '', commentA: null, commentB: null, slug: '', sessionJar: [] };
  }

  await group(`线上 ${base}：注册 → 登录 → 发评论 → 列表 → 删除 → 退出`, async () => {
    if (ROWS.some((r) => r.group.startsWith(`线上 ${base}：连通性`) && !r.pass)) {
      throw new AbortGroup('连通性/me 前置失败，线上闭环未执行');
    }

    const regA = await call('/api/auth/register', { method: 'POST', body: { username: USER_A, email: EMAIL_A, password: PW_A } });
    await it('B-' + tag + '-10', '注册 A → 201 + user + Set-Cookie（p3_uid 属性齐全）',
      `curl -s -i -X POST ${base}/api/auth/register -H 'Content-Type: application/json' -d '{"username":"${USER_A}",...}'`, () => {
        must(regA.status === 201, `应回 201（实测 ${regA.status}）`, regA);
        must(regA.body.user && regA.body.user.username === USER_A, 'user.username 必须回填', regA.body);
        const c = regA.setCookies.find((x) => /^p3_uid=/.test(x)) || '';
        must(/^p3_uid=[0-9a-f]{64}/.test(c) && /HttpOnly/.test(c) && /SameSite=Lax/.test(c) && /Max-Age=2592000/.test(c)
          && /Path=\/api/.test(c),
        'Set-Cookie 必须是 p3_uid=64hex + Path=/api + HttpOnly + SameSite=Lax + Max-Age=2592000（契约 §0.5）', c);
        must(!/password_hash|password_algo|live-password/.test(regA.text), '响应体不得含口令/口令列', regA.text);
        return `HTTP 201 id=${regA.body.user.id} ${c.split(';').slice(1).join(';').trim()}`;
      });
    cookieA = need(regA.sessionCookie, '注册 A 没拿到 cookie');
    sessionJar.push(cookieA);

    const loginA = await call('/api/auth/login', { method: 'POST', body: { user: USER_A, password: PW_A } });
    await it('B-' + tag + '-11', '登录 A（用户名）→ 200 + 新会话 cookie（会话 id 与注册时的不同）',
      `curl -s -i -X POST ${base}/api/auth/login -d '{"user":"${USER_A}","password":"…"}'`, () => {
        must(loginA.status === 200, `应回 200（实测 ${loginA.status}）`, loginA);
        must(loginA.body.user.id === regA.body.user.id, '必须是同一个账号', loginA.body);
        must(loginA.sessionCookie && loginA.sessionCookie !== cookieA,
          '登录必须换发新的会话 id（防会话固定）', `reg=${cookieA.slice(0, 12)} login=${loginA.sessionCookie.slice(0, 12)}`);
        return `HTTP 200 新会话 ${loginA.sessionCookie.split('=')[1].slice(0, 10)}… ≠ 注册会话`;
      });
    sessionA = loginA.sessionCookie;
    sessionJar.push(sessionA);
    const meA = await call('/api/auth/me', { cookie: sessionA });
    await it('B-' + tag + '-12', 'GET /api/auth/me（带会话）→ 200 + 本人 + email 只出现在"本人"响应里',
      `curl -s -b 'p3_uid=…' ${base}/api/auth/me`, () => {
        must(meA.status === 200 && meA.body.user && meA.body.user.id === regA.body.user.id, 'me 必须认出会话', meA);
        must(meA.body.user.email === EMAIL_A, '本人的 me 必须带自己的 email', meA.body.user);
        must(!/password_hash|password_algo/.test(meA.text), '不得出现口令列', meA.text);
        return `HTTP 200 user=${meA.body.user.username} email 仅本人可见`;
      });

    const emailLogin = await call('/api/auth/login', { method: 'POST', body: { user: EMAIL_A, password: PW_A } });
    await it('B-' + tag + '-13', '登录 A（邮箱）→ 200（user 字段接受邮箱）',
      `curl -s -X POST ${base}/api/auth/login -d '{"user":"${EMAIL_A}",...}'`, () => {
        must(emailLogin.status === 200, '邮箱登录必须成功', emailLogin);
        return 'HTTP 200';
      });
    if (emailLogin.sessionCookie) sessionJar.push(emailLogin.sessionCookie);

    const postA = await call('/api/comments', { method: 'POST', body: { slug: SLUG, content: CONTENT_TAG + ' A 的第一条评论' }, cookie: sessionA });
    await it('B-' + tag + '-14', 'A 发评论 → 201 + comment 形状正确 + 作者是自己',
      `curl -s -X POST ${base}/api/comments -b 'p3_uid=…' -d '{"slug":"${SLUG}","content":"…"}'`, () => {
        must(postA.status === 201, `应回 201（实测 ${postA.status}）`, postA);
        must(postA.body.comment.author.id === regA.body.user.id, 'author.id 必须是本人', postA.body.comment);
        must(postA.body.comment.parent_id === null, 'parent_id 必须是 null', postA.body.comment);
        must(JSON.stringify(Object.keys(postA.body.comment).sort()) === '["author","content","created_at","id","parent_id"]',
          '评论键集合必须与契约一致', Object.keys(postA.body.comment));
        return `HTTP 201 id=${postA.body.comment.id}`;
      });
    commentA = postA.body && postA.body.comment ? postA.body.comment.id : null;

    const list1 = await call('/api/comments?slug=' + encodeURIComponent(SLUG));
    await it('B-' + tag + '-15', '未登录也能读列表，且能看到刚发的评论；全文无 password_hash / email',
      `curl -s '${base}/api/comments?slug=${SLUG}'`, () => {
        must(list1.status === 200, '列表必须 200（未登录可读）', list1);
        must(list1.body.comments.some((c) => c.id === commentA), '刚发的评论必须可见', list1.body.comments);
        ['password_hash', 'password_algo', '"email"', 'user_id', '"status"'].forEach((n) => {
          must(!list1.text.includes(n), `不得出现 ${n}`, list1.text);
        });
        must(!list1.text.includes('t16v.example'), '评论列表不得出现邮箱', list1.text);
        return `HTTP 200 ${list1.body.comments.length} 条，含 id=${commentA}，无敏感字段`;
      });

    const mineA = await call('/api/comments/mine', { cookie: sessionA });
    await it('B-' + tag + '-16', 'GET /api/comments/mine（带会话）→ 只含自己的评论 + slug',
      `curl -s -b 'p3_uid=…' ${base}/api/comments/mine`, () => {
        must(mineA.status === 200, 'mine 必须 200', mineA);
        const mine = mineA.body.comments.find((c) => c.id === commentA);
        must(mine && mine.slug === SLUG, 'mine 必须含这条评论并带 slug', mineA.body.comments);
        return `HTTP 200 含 id=${commentA} slug=${SLUG}`;
      });

    const regB = await call('/api/auth/register', { method: 'POST', body: { username: USER_B, email: EMAIL_B, password: PW_B } });
    await it('B-' + tag + '-17', '注册第二个账号 B → 201 + cookie（用于跨账号越权验证）',
      `curl -s -X POST ${base}/api/auth/register -d '{"username":"${USER_B}",...}'`, () => {
        must(regB.status === 201, `应回 201（实测 ${regB.status}：429 说明本机 IP 的注册窗口已用满）`, regB);
        return `HTTP 201 id=${regB.body.user.id}`;
      });
    cookieB = need(regB.sessionCookie, '注册 B 没拿到 cookie');
    sessionJar.push(cookieB);
    const loginB = await call('/api/auth/login', { method: 'POST', body: { user: USER_B, password: PW_B } });
    await it('B-' + tag + '-17b', 'B 登录 → 200（第二个账号拿到独立会话）',
      `curl -s -X POST ${base}/api/auth/login -d '{"user":"${USER_B}",...}'`, () => {
        must(loginB.status === 200, 'B 登录必须成功', loginB);
        must(loginB.sessionCookie && loginB.sessionCookie !== regB.sessionCookie, '必须换发新会话', '');
        return `HTTP 200 新会话 ${loginB.sessionCookie.split('=')[1].slice(0, 10)}…`;
      });
    if (loginB.sessionCookie) { cookieB = loginB.sessionCookie; sessionJar.push(cookieB); }

    const postB = await call('/api/comments', { method: 'POST', body: { slug: SLUG, content: CONTENT_TAG + ' B 的评论（给越权测试当靶子）' }, cookie: cookieB });
    await it('B-' + tag + '-18', 'B 发评论 → 201',
      `curl -s -X POST ${base}/api/comments -b 'p3_uid=…B' -d '{"slug":"${SLUG}","content":"…"}'`, () => {
        must(postB.status === 201, '应回 201', postB);
        return `HTTP 201 id=${postB.body.comment.id}`;
      });
    commentB = postB.body && postB.body.comment ? postB.body.comment.id : null;

    const cross = await call('/api/comments/' + commentB, { method: 'DELETE', headers: { 'content-type': 'application/json' }, cookie: sessionA });
    await it('B-' + tag + '-19', '★ 跨账号：A 删 B 的评论 → 403 FORBIDDEN',
      `curl -s -X DELETE ${base}/api/comments/${commentB} -b 'p3_uid=…A'`, () => {
        must(cross.status === 403, `必须 403（实测 ${cross.status}）`, cross);
        must(cross.body.error.code === 'FORBIDDEN', 'code 必须是 FORBIDDEN', cross.body);
        return `HTTP 403 FORBIDDEN`;
      });

    const stillThere = await call('/api/comments?slug=' + encodeURIComponent(SLUG));
    await it('B-' + tag + '-20', '★ 越权被拒后 B 的评论仍然存在（列表里还在）',
      `curl -s '${base}/api/comments?slug=${SLUG}'`, () => {
        must(stillThere.body.comments.some((c) => c.id === commentB), '目标评论必须还在', stillThere.body.comments);
        return `列表仍含 id=${commentB}`;
      });

    const anon = await call('/api/comments/' + commentB, { method: 'DELETE', headers: { 'content-type': 'application/json' } });
    await it('B-' + tag + '-21', '★ 未登录删评论 → 401 UNAUTHENTICATED，且评论仍在',
      `curl -s -X DELETE ${base}/api/comments/${commentB}（不带 cookie）`, async () => {
        must(anon.status === 401, `必须 401（实测 ${anon.status}）`, anon);
        must(anon.body.error.code === 'UNAUTHENTICATED', 'code 必须是 UNAUTHENTICATED', anon.body);
        const l = await call('/api/comments?slug=' + encodeURIComponent(SLUG));
        must(l.body.comments.some((c) => c.id === commentB), '目标评论必须还在', l.body.comments);
        return `HTTP 401 UNAUTHENTICATED；评论仍在`;
      });

    const fake = await call('/api/comments/' + commentB, { method: 'DELETE', headers: { 'content-type': 'application/json' }, cookie: 'p3_uid=' + 'f'.repeat(64) });
    await it('B-' + tag + '-22', '伪造 cookie 删评论 → 401（不认伪造会话）',
      `curl -s -X DELETE ${base}/api/comments/${commentB} -b 'p3_uid=ffff…'`, () => {
        must(fake.status === 401, '伪造 cookie 必须 401', fake);
        return 'HTTP 401';
      });

    const delOwn = await call('/api/comments/' + commentA, { method: 'DELETE', headers: { 'content-type': 'application/json' }, cookie: sessionA });
    await it('B-' + tag + '-23', 'A 删自己的评论 → 200 {ok:true,deleted:id}',
      `curl -s -X DELETE ${base}/api/comments/${commentA} -b 'p3_uid=…A'`, () => {
        must(delOwn.status === 200 && delOwn.body.deleted === commentA, '必须 200 + deleted:id', delOwn);
        return `HTTP 200 deleted=${commentA}`;
      });

    const list2 = await call('/api/comments?slug=' + encodeURIComponent(SLUG));
    await it('B-' + tag + '-24', '删后列表不可见（软删）；B 的评论仍在',
      `curl -s '${base}/api/comments?slug=${SLUG}'`, () => {
        const ids = list2.body.comments.map((c) => c.id);
        must(!ids.includes(commentA), '删掉的评论必须消失', ids);
        must(ids.includes(commentB), 'B 的评论必须还在', ids);
        return `列表=${ids.join(',')}`;
      });

    const delAgain = await call('/api/comments/' + commentA, { method: 'DELETE', headers: { 'content-type': 'application/json' }, cookie: sessionA });
    await it('B-' + tag + '-25', '再删一次 → 404 NOT_FOUND（软删后按不存在处理）',
      `curl -s -X DELETE ${base}/api/comments/${commentA} -b 'p3_uid=…A'`, () => {
        must(delAgain.status === 404 && delAgain.body.error.code === 'NOT_FOUND', '必须 404 NOT_FOUND', delAgain);
        return 'HTTP 404 NOT_FOUND';
      });

    const logout = await call('/api/auth/logout', { method: 'POST', body: {}, cookie: sessionA });
    await it('B-' + tag + '-26', '登出 → 200 {ok:true,destroyed:true} + 清 cookie',
      `curl -s -i -X POST ${base}/api/auth/logout -b 'p3_uid=…A' -d '{}'`, () => {
        must(logout.status === 200 && logout.body.ok === true && logout.body.destroyed === true, '必须 200 + destroyed:true', logout);
        const c = logout.setCookies.find((x) => /^p3_uid=/.test(x)) || '';
        must(/Max-Age=0/.test(c) && /HttpOnly/.test(c) && /SameSite=Lax/.test(c) && /Path=\/api/.test(c), '清 cookie 属性必须一致（含 Path=/api，契约 §0.5）', c);
        return `HTTP 200 destroyed=true；${c}`;
      });

    const afterLogout = await call('/api/comments/' + commentB, { method: 'DELETE', headers: { 'content-type': 'application/json' }, cookie: sessionA });
    await it('B-' + tag + '-27', '★ 退出后再删 → 401（旧会话已失效）',
      `curl -s -X DELETE ${base}/api/comments/${commentB} -b 'p3_uid=…（已登出）'`, () => {
        must(afterLogout.status === 401, `必须 401（实测 ${afterLogout.status}）`, afterLogout);
        return 'HTTP 401';
      });

    const meAfter = await call('/api/auth/me', { cookie: sessionA });
    await it('B-' + tag + '-28', '退出后 /api/auth/me → 200 + user:null',
      `curl -s -b 'p3_uid=…' ${base}/api/auth/me`, () => {
        must(meAfter.status === 200 && meAfter.body.user === null, '必须 200 + user:null', meAfter);
        return 'HTTP 200 user=null';
      });
  });

  await group(`线上 ${base}:失败路径（不可区分的登录失败 / 415 / 404 / 405 / OPTIONS）`, async () => {
    const noUser = await call('/api/auth/login', { method: 'POST', body: { user: MARKER + 'nobody-' + RUN_ID, password: 'wrong-password-1' } });
    const badPw = await call('/api/auth/login', { method: 'POST', body: { user: USER_A, password: 'wrong-password-1' } });
    await it('B-' + tag + '-30', '登录失败不可区分：不存在的用户 vs 口令错误 → 状态码/code/message 完全一致',
      `curl -s -X POST ${base}/api/auth/login -d '{"user":"…","password":"wrong-password-1"}'`, () => {
        must(noUser.status === 401 && badPw.status === 401, '两者都必须 401', { noUser: noUser.status, badPw: badPw.status });
        must(noUser.body.error.code === badPw.body.error.code && noUser.body.error.message === badPw.body.error.message,
          '两路响应必须逐字节一致（账号枚举预言机）', { noUser: noUser.body, badPw: badPw.body });
        must(badPw.body.error.code === 'INVALID_CREDENTIALS', 'code 必须是 INVALID_CREDENTIALS', badPw.body);
        must(!/password_hash|password_algo/.test(badPw.text), '失败体不得含口令列', badPw.text);
        return `两者均 401 INVALID_CREDENTIALS "${badPw.body.error.message}"`;
      });

    const noCt = await call('/api/auth/login', { method: 'POST', body: { user: USER_A, password: PW_A }, contentType: null });
    await expectFail('B-' + tag + '-31', '登录不带 Content-Type: application/json → 415',
      `curl -s -X POST ${base}/api/auth/login -d '{...}' -H 'Content-Type: text/plain'`, noCt, 415, 'UNSUPPORTED_MEDIA_TYPE');

    const nf = await call('/api/definitely-not-here');
    await expectFail('B-' + tag + '-32', '未知路径 → 404 NOT_FOUND', `curl -s ${base}/api/definitely-not-here`, nf, 404, 'NOT_FOUND');
    const m405 = await call('/api/auth/login');
    await it('B-' + tag + '-33', '路径存在但方法不对 → 405 + Allow 头',
      `curl -s -i ${base}/api/auth/login（GET）`, () => {
        must(m405.status === 405, '必须 405', m405);
        must((m405.headers.get('allow') || '').includes('POST'), 'Allow 必须含 POST', m405.headers.get('allow'));
        return `HTTP 405 Allow: ${m405.headers.get('allow')}`;
      });
    const opt = await call('/api/comments', { method: 'OPTIONS' });
    await it('B-' + tag + '-34', 'OPTIONS /api/comments → 204 + Allow，且无 CORS 头',
      `curl -s -i -X OPTIONS ${base}/api/comments`, () => {
        must(opt.status === 204, '必须 204', opt);
        must(!opt.headers.get('access-control-allow-origin'), '不得发 ACAO', opt.headers.get('access-control-allow-origin'));
        return `HTTP 204 Allow: ${opt.headers.get('allow')}`;
      });
  });

  await group(`线上 ${base}:登出本轮其余会话（让"库里不再有活会话"可核对）`, async () => {
    await it('B-' + tag + '-29', '逐个登出本轮下发过的每一个会话 cookie → 每个都回 200（已失效的 destroyed:false 也算对）',
      `for c in <本轮所有 p3_uid>; do curl -s -X POST ${base}/api/auth/logout -b "$c" -d '{}'; done`, async () => {
        const out = [];
        for (const c of sessionJar) {
          const r = await call('/api/auth/logout', { method: 'POST', body: {}, cookie: c });
          must(r.status === 200, '登出必须回 200（绝不因为"没登录"回 401）', r);
          must(typeof r.body.destroyed === 'boolean', 'destroyed 必须是布尔', r.body);
          out.push(r.body.destroyed ? 'true' : 'false');
        }
        return `登出 ${sessionJar.length} 个会话：destroyed=[${out.join(',')}]`;
      });
  });

  if (!SKIP_RATE_LIMIT) {
    await group(`线上 ${base}:限流（错误口令连打 → 429 + Retry-After）`, async () => {
      await it('B-' + tag + '-40', '★ 同一 IP 连打错误口令 → 触发 429 + Retry-After，且响应体无口令哈希/邮箱',
        `for i in $(seq 1 15); do curl -s -o /dev/null -w '%{http_code}\\n' -X POST ${base}/api/auth/login -H 'Content-Type: application/json' -d '{"user":"${USER_A}","password":"wrong-password-1"}'; done`, async () => {
          const codes = [];
          let limited = null;
          for (let i = 1; i <= 15; i += 1) {
            const r = await call('/api/auth/login', { method: 'POST', body: { user: USER_A, password: 'wrong-password-1' } });
            codes.push(r.status);
            if (r.status !== 429) {
              must(r.status === 401, `第 ${i} 次应是 401（实测 ${r.status}）`, r);
            } else {
              limited = r;
              break;
            }
          }
          must(limited !== null, `连打 15 次仍未触发 429（状态序列 ${codes.join(',')}）—— 限流没生效或被绕过`, codes.join(','));
          must(limited.body.error.code === 'RATE_LIMITED', 'code 必须是 RATE_LIMITED', limited.body);
          const ra = limited.headers.get('retry-after');
          must(ra && /^\d+$/.test(ra) && Number(ra) > 0, '必须带 Retry-After（秒）', ra);
          must(!/password_hash|password_algo/.test(limited.text), '429 响应体不得含口令列', limited.text);
          must(!/t16v\.example/.test(limited.text), '429 响应体不得含邮箱', limited.text);
          say(`       ⚠ 本机 IP 已被登录限流封锁：Retry-After=${ra} 秒（等 1 小时或按报告里的解锁 SQL 清理）`);
          return `状态序列 ${codes.join(',')}；429 Retry-After=${ra}`;
        });

      await it('B-' + tag + '-41', '触发后再打一次仍是 429（不会因为"又试一次"就放行）',
        `curl -s -i -X POST ${base}/api/auth/login -d '{"user":"${USER_A}","password":"wrong-password-1"}'`, async () => {
          const r = await call('/api/auth/login', { method: 'POST', body: { user: USER_A, password: 'wrong-password-1' } });
          must(r.status === 429, '必须持续 429', r);
          return `HTTP 429 Retry-After=${r.headers.get('retry-after')}`;
        });
    });
  } else {
    await it('B-' + tag + '-40', '★ 限流 429（--skip-rate-limit 已跳过）',
      '（跳过）', () => { must(false, '本轮用 --skip-rate-limit 跳过了限流验证', 'skipped'); });
  }

  /* ---------- 数据库行数与接口行为一致性 ---------- */
  await group(`线上 ${base}:数据库行数与接口行为一致`, async () => {
    if (!HAS_SQL) {
      notApplicable('B-' + tag + '-50', 'DB 行数核对（users/comments/sessions 与接口行为一致）',
        '需要 --ssh <user@host> 或 --sql-local',
        '没有提供 SQL 通道；--shim 自检（内存 store）与未给通道的线上跑法都无法核对库内行数。'
        + '真验收必须带通道重跑：--base <url> --ssh root@<host>');
      return;
    }
    try {
      /* 所有拼进 SQL 的字符串都过 sqlStr()（见上面 sqlEscape 的说明：
         这条通道没法用绑定参数，所以至少要真转义，不能裸拼）。 */
      const users = sqlScalar(`SELECT COUNT(*) FROM users WHERE username LIKE ${sqlStr(USER_A + '%')} OR username LIKE ${sqlStr(USER_B + '%')};`);
      const rows = runSql(`SELECT username, LEFT(password_hash, 21) FROM users WHERE username IN (${sqlStr(USER_A)},${sqlStr(USER_B)});`);
      const approved = sqlScalar(`SELECT COUNT(*) FROM comments WHERE slug = ${sqlStr(SLUG)} AND status='approved';`);
      const deleted = sqlScalar(`SELECT COUNT(*) FROM comments WHERE slug = ${sqlStr(SLUG)} AND status='deleted';`);
      const sessionsLeft = sqlScalar(`SELECT COUNT(*) FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username IN (${sqlStr(USER_A)},${sqlStr(USER_B)});`);
      await it('B-' + tag + '-50', '库里恰好多了 2 个本轮用户，口令列是 pbkdf2 哈希（不是明文）',
        `mysql -N -e "SELECT username,LEFT(password_hash,21) FROM users WHERE username IN (${sqlStr(USER_A)},${sqlStr(USER_B)})"`, () => {
          must(users === 2, '本轮用户行数必须是 2', users);
          /* 前缀从 §4.0 的轮数来：S5 之后是 600000（`pbkdf2-sha256$600000$` → 左 21 字符是 `pbkdf2-sha256$600000`）。
             不要写死 "2100"：轮数再上调时这里会假红。 */
          must(rows.includes('pbkdf2-sha256$'), 'password_hash 必须是 pbkdf2-sha256$<iterations>$…', rows.trim());
          must(/pbkdf2-sha256\$\d{4,}/.test(rows), 'password_hash 必须带轮数（自描述串）', rows.trim());
          must(!rows.includes('live-password-'), '库里绝不能出现明文口令', rows.trim());
          return `users=2；hash 前缀 ${String(rows).split('\n')[0].split('\t')[1] || '?'}…`;
        });
      await it('B-' + tag + '-51', '库内评论行数与接口行为一致：slug 下 approved=1 / deleted=1（软删保留行）',
        `mysql -N -e "SELECT status,COUNT(*) FROM comments WHERE slug=${sqlStr(SLUG)} GROUP BY status"`, () => {
          must(approved === 1, 'approved 必须恰好 1 条（B 的评论还在）', approved);
          must(deleted === 1, 'deleted 必须恰好 1 条（A 的是软删，行仍在）', deleted);
          return `approved=${approved} deleted=${deleted}`;
        });
      await it('B-' + tag + '-52', '退出后会话行已从库里删除（sessions 无残留）',
        `mysql -N -e "SELECT COUNT(*) FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.username IN (${sqlStr(USER_A)},${sqlStr(USER_B)})"`, () => {
          must(sessionsLeft === 0, '登出必须删掉会话行', sessionsLeft);
          return `sessions 残留 ${sessionsLeft} 行`;
        });
    } catch (err) {
      await it('B-' + tag + '-50', 'DB 行数核对（SQL 通道失败）',
        'ssh/mysql 查询', () => { must(false, 'SQL 通道执行失败', String((err && err.message) || err)); });
    }
  });

  return { base, cookieA, sessionA, cookieB, commentA, commentB, slug: SLUG, users: [USER_A, USER_B], sessionJar };
};

const cleanupLive = async (info) => {
  const tag = info.base.replace(/^https?:\/\//, '').replace(/\W+/g, '_');
  await group(`线上 ${info.base}:自清理（删掉本轮测试数据，脚本可重复执行）`, async () => {
    if (KEEP_DATA) {
      notApplicable('B-clean-' + tag, '自清理（--keep-data 已明确跳过）', '（跳过）',
        '本轮带 --keep-data，测试数据保留在库里供人工查看');
      return;
    }
    /* 1) API 侧：把自己还活着的评论软删掉 */
    await it('B-clean-' + tag + '-api', 'API 侧清理：软删本轮自己的评论',
      `DELETE ${info.base}/api/comments/<本轮 id>`, async () => {
        const left = [];
        for (const id of [info.commentA, info.commentB]) {
          if (!id) continue;
          const r = await makeCaller(info.base)('/api/comments/' + id, { method: 'DELETE', headers: { 'content-type': 'application/json' }, cookie: info.cookieB });
          left.push(`${id}:${r.status}`);
        }
        return left.join(' ') || '无';
      });

    /* 2) SQL 侧：删掉本轮用户行（外键级联带走会话与评论） */
    const sql = [
      `SELECT COUNT(*) FROM users WHERE username LIKE ${sqlStr(MARKER + '%')};`,
      `DELETE FROM comments WHERE slug LIKE ${sqlStr(CONTENT_TAG + '%')} OR content LIKE ${sqlStr('%' + CONTENT_TAG + '%')};`,
      `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE ${sqlStr(MARKER + '%')});`,
      `DELETE FROM users WHERE username LIKE ${sqlStr(MARKER + '%')};`,
      `DELETE FROM auth_throttle WHERE action='login';`,
      `SELECT COUNT(*) FROM users WHERE username LIKE ${sqlStr(MARKER + '%')};`
    ].join('\n');
    if (!HAS_SQL) {
      notApplicable('B-clean-' + tag + '-sql', 'SQL 侧清理：删除本轮用户/评论（外键级联）+ 清零登录限流',
        `ssh <host> mysql -N -B p3blog <<'SQL'\n${sql}\nSQL`,
        '没有提供 SQL 通道：用户行删不掉（接口没有删用户的能力）。请手工执行上面这段 SQL 完成清理。');
      return;
    }
    await it('B-clean-' + tag + '-sql', 'SQL 侧清理：删除本轮用户/评论（外键级联）+ 清零登录限流，并验证残留为 0',
      `ssh <host> mysql -N -B p3blog <<'SQL'\n${sql}\nSQL`, () => {
        const out = runSql(sql);
        const lines = String(out).trim().split('\n').map((l) => l.trim()).filter(Boolean);
        const last = Number(lines[lines.length - 1]);
        must(last === 0, '清理后本轮用户残留必须为 0', String(out).trim());
        return `清理前计数 ${lines[0]} → 复查残留 ${last}`;
      });
  });
};

/* ------------------------------------------------------------
   7. main
   ------------------------------------------------------------ */
const main = async () => {
  say('============================================================');
  say('t16 独立验证：公开登录 / 注册 / 评论');
  say(`模式=${MODE} node=${process.version} 本轮标记=${MARKER}`);
  say(`仓库=${REPO_DIR}`);
  say('============================================================');

  const started = Date.now();

  if (MODE === 'local' || MODE === 'static') await runStaticChecks();
  if (MODE === 'local') {
    const deps = await localDeps();
    await runLocalStatic();
    await runLocalEndpoints(deps);
  } else if (MODE === 'skeleton') {
    await runSkeletonE2E();
  } else {
    /* --shim：在本进程里起一个内存 store 的公开服务，让"线上那段代码路径"
       在部署之前就能被自检一遍（注册→登录→跨账号 403→429→登出）。
       真跑线上时不要用它。 */
    if (SHIM) {
      const deps = await localDeps();
      const stores = makeMemoryStores(deps);
      const shimApp = await deps.createPublicApp({ port: 0, log: false, stores, publicOrigins: ['http://127.0.0.1'] });
      await new Promise((r) => shimApp.server.listen(0, '127.0.0.1', r));
      const shimPort = shimApp.server.address().port;
      shimApp.setPort(shimPort);
      const shimBase = 'http://127.0.0.1:' + shimPort;
      BASES.unshift(shimBase);
      say(`\n[shim] 自检用的公开服务已在本进程启动：${shimBase}（内存 store，仅本地）`);
    }
    for (const base of BASES) {
      let info = null;
      try {
        info = await runLive(base);
      } catch (err) {
        if (err instanceof AbortGroup) {
          record({
            id: '—', criterion: `在线入口 ${base} 的闭环未完成`, command: `curl -s ${base}/api/auth/me`,
            expected: '服务已部署且可达', actual: err.message, pass: false
          });
        } else {
          record({
            id: '—', criterion: `在线入口 ${base} 执行异常`, command: `node … --base ${base}`,
            expected: '脚本正常跑完', actual: String((err && err.stack) || err), pass: false
          });
        }
        /* 闭环中断也要尽量清掉本轮已写入的数据（清理用的是前缀匹配，安全） */
        info = { base, cookieB: '', commentA: null, commentB: null, slug: '', sessionJar: [] };
      }
      if (info) await cleanupLive(info);
    }
  }

  const pass = ROWS.filter((r) => r.pass && !r.na).length;
  const na = ROWS.filter((r) => r.na).length;
  const fail = ROWS.filter((r) => !r.pass).length;
  say('\n============================================================');
  say(`合计 ${ROWS.length} 项：PASS ${pass} / FAIL ${fail} / NA ${na}（失败形状断言累计 ${SHAPE_CHECKED} 条）`);
  say(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (fail) {
    say('\n失败项（含最小复现命令）：');
    ROWS.filter((r) => !r.pass).forEach((r) => {
      say(`  · ${r.id} ${r.criterion}`);
      say(`    复现: ${r.command}`);
      say(`    实测: ${trunc(r.actual, 240)}`);
    });
  }
  say('============================================================');

  if (OUT_PATH) {
    const md = ['| id | 判据 | 命令 | 实测 | 结果 |', '|---|---|---|---|---|']
      .concat(ROWS.map((r) => `| ${r.id} | ${r.criterion.replace(/\|/g, '\\|')} | \`${r.command.replace(/\|/g, '\\|')}\` | ${r.actual.replace(/\|/g, '\\|')} | ${r.na ? '不适用' : (r.pass ? '通过' : '**失败**')} |`))
      .join('\n');
    writeFileSync(OUT_PATH, md + '\n', 'utf8');
    say(`报告已写入 ${OUT_PATH}`);
  }

  process.exit(fail ? 1 : 0);
};

main().catch((err) => {
  console.error('验证脚本自身异常：', err);
  process.exit(2);
});
