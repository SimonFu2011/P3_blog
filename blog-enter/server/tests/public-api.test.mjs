/* ============================================================
   公开服务单元 / 接口测试（t14）
   ------------------------------------------------------------
   三条纪律，缺一条这个文件就不合格：

   1) **不碰真实数据库**。本机没有 MySQL，而且即使有，单元测试依赖外部
      服务就会变成"看环境脸色"的测试。所以这里：
        · 纯函数（口令哈希、输入校验、错误映射、限流算术、SQL 片段构造）
          直接测；
        · 数据层的 SQL 用**假 db 句柄**断言"参数化 + WHERE 条件写对了"
          （这是"越权在服务端判定"能被自动化验证的唯一位置）；
        · HTTP 层用**内存假 store** 注入，走真实 http.Server 打真实请求。
      真库连通性由 t16 在服务器上用真账号验。

   2) **不用 node:test 的 runner**。`node --test` 会给每个测试文件 spawn
      一个子进程并走管道，而受限沙箱禁止子进程用管道（EPERM）—— 这是
      本仓库 server/tests/harness.mjs 开头就写明的既有约定，其它 6 个测试
      文件也都是这么做的。这里沿用同一套 harness（node:assert 断言，
      收集与执行都在当前进程内）：
        node blog-enter/server/tests/public-api.test.mjs
        node --test blog-enter/server/tests/public-api.test.mjs   # 同样能跑
      后者在受限沙箱里会报 spawn EPERM（环境限制，不是测试失败）；
      在正常机器上两种跑法结果一致。

   3) **不打印任何凭据**。用例里出现的口令都是明确的假口令；
      数据库环境变量一律用假值，跑完还原。
   ============================================================ */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import http from 'node:http';

import { createHarness, isMain } from './harness.mjs';

import * as pw from '../lib/public/passwords.mjs';
import * as httpLib from '../lib/public/http.mjs';
import * as dbMod from '../lib/public/db.mjs';
import * as userstore from '../lib/public/userstore.mjs';
import * as commentstore from '../lib/public/commentstore.mjs';

const H = createHarness('公开服务 (t14)');

/* ============================================================
   一、口令哈希（passwords.mjs）
   ============================================================ */

H.test('hashPassword：格式为 algo$iter$salt_b64$key_b64，盐 16 字节、密钥 32 字节', async () => {
  const { hash, algo, iterations } = await pw.hashPassword('correct-horse-battery');
  assert.equal(algo, 'pbkdf2-sha256');
  /* 从常量取而不是写死数字：轮数**会**随安全建议上调（S5 就是 210000→600000）。
     写死数字的结果是"上调一次、测试红一次"，然后很容易被顺手改成"跑绿优先"。 */
  assert.equal(iterations, pw.ITERATIONS);
  assert.ok(pw.ITERATIONS >= 600_000, '当前建议下限 600000（OWASP PBKDF2-HMAC-SHA256）');
  /* 别名必须与主常量同值：PBKDF2_ITER 是给审计/部署 verify 按字面量读源码用的，
     两处数字漂开会让"验过了"和"实际跑的"不一致。 */
  assert.equal(pw.PBKDF2_ITER, pw.ITERATIONS, 'PBKDF2_ITER 与 ITERATIONS 必须同值');
  const parts = hash.split('$');
  assert.equal(parts.length, 4, '存储串必须是 4 段自描述格式');
  assert.equal(parts[0], 'pbkdf2-sha256');
  assert.equal(parts[1], String(pw.ITERATIONS), '第 2 段必须是本次派生的实际轮数');
  const salt = Buffer.from(parts[2], 'base64');
  const key = Buffer.from(parts[3], 'base64');
  assert.equal(salt.length, 16);
  assert.equal(key.length, 32);
  assert.ok(!hash.includes('correct-horse-battery'), '存储串里绝不能出现明文');
});

H.test('hashPassword：同一盐 + 同一口令 → 同一哈希（可复现），换盐则不同', async () => {
  const salt = Buffer.alloc(16, 7);
  const a = await pw.hashPassword('s3cret-pass', { salt });
  const b = await pw.hashPassword('s3cret-pass', { salt });
  const c = await pw.hashPassword('s3cret-pass');
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash, '随机盐必须让两次哈希不同');
});

H.test('verifyPassword：正确口令通过、错误口令不通过', async () => {
  const { hash } = await pw.hashPassword('let-me-in-please');
  assert.equal(await pw.verifyPassword('let-me-in-please', hash), true);
  assert.equal(await pw.verifyPassword('let-me-in-pleasE', hash), false);
  assert.equal(await pw.verifyPassword('', hash), false);
  assert.equal(await pw.verifyPassword(null, hash), false);
});

H.test('verifyPassword：存储串损坏时返回 false，绝不抛错', async () => {
  /* 为什么必须"不抛错"：登录失败要走统一的 401 文案。让一行坏数据
     变成 500，响应体本身就泄露了"这个用户名存在"。 */
  for (const bad of [null, undefined, '', 'not-a-hash', 'a$b$c', 'pbkdf2-sha256$x$$',
    'argon2id$210000$AAAA$AAAA', 'pbkdf2-sha256$210000$AAAA', 'pbkdf2-sha256$0$AAAA$AAAA',
    'pbkdf2-sha256$99999999$AAAA$AAAA']) {
    assert.equal(await pw.verifyPassword('whatever', bad), false, '损坏输入应返回 false：' + String(bad));
  }
});

H.test('parseHash：只认自描述格式，段数/算法/轮数不符一律 null', () => {
  const good = ['pbkdf2-sha256', '210000', Buffer.alloc(16, 1).toString('base64'), Buffer.alloc(32, 2).toString('base64')].join('$');
  const ok = pw.parseHash(good);
  assert.equal(ok.algo, 'pbkdf2-sha256');
  assert.equal(ok.iterations, 210000);
  assert.equal(ok.salt.length, 16);
  assert.equal(ok.key.length, 32);
  for (const bad of [null, undefined, '', 'not-a-hash', 'a$b$c', 'pbkdf2-sha256$210000$onlythree',
    'argon2id$210000$c2FsdA==$a2V5', 'pbkdf2-sha256$abc$c2FsdA==$a2V5', 'pbkdf2-sha256$0$c2FsdA==$a2V5',
    'pbkdf2-sha256$99999999$c2FsdA==$a2V5', 'pbkdf2-sha256$210000$$a2V5']) {
    assert.equal(pw.parseHash(bad), null, '应返回 null：' + String(bad));
  }
});

H.test('dummyVerify：用户不存在时也跑一次等价耗时的 PBKDF2（耗时对齐）', async () => {
  const { hash } = await pw.hashPassword('benchmark-pass');
  const t0 = process.hrtime.bigint();
  await pw.dummyVerify('benchmark-pass');
  const dummyMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const t1 = process.hrtime.bigint();
  await pw.verifyPassword('benchmark-pass', hash);
  const realMs = Number(process.hrtime.bigint() - t1) / 1e6;
  /* 两者必须同量级（都做完了 210000 轮）。给一个宽松但有效的界：
     假校验不能比真校验快 5 倍以上 —— 那正是账号枚举的时间侧信道。 */
  assert.ok(dummyMs * 5 > realMs, '假校验太快会形成时间侧信道：dummy=' + dummyMs.toFixed(1) + 'ms real=' + realMs.toFixed(1) + 'ms');
  assert.ok(dummyMs > 1, '假校验必须真的做了一次 PBKDF2（实测 ' + dummyMs.toFixed(1) + 'ms）');
});

H.test('checkAgainstUser：无用户行 / 未激活 / 未知算法都走假校验并返回 false', async () => {
  const { hash } = await pw.hashPassword('real-pass-1234');
  const row = { password_hash: hash, password_algo: 'pbkdf2-sha256', status: 'active' };
  assert.equal(await pw.checkAgainstUser('real-pass-1234', row), true);
  assert.equal(await pw.checkAgainstUser('real-pass-1234', null), false);
  assert.equal(await pw.checkAgainstUser('x', null), false);
  assert.equal(await pw.checkAgainstUser('real-pass-1234', { password_hash: hash, password_algo: 'argon2id' }), false);
  assert.equal(await pw.checkAgainstUser('real-pass-1234', { password_hash: null }), false);
});

H.test('assertPasswordShape：8–200 位边界', () => {
  assert.throws(() => pw.assertPasswordShape('1234567'), /至少 8/);
  assert.equal(pw.assertPasswordShape('12345678'), '12345678');
  assert.equal(pw.assertPasswordShape('x'.repeat(200)), 'x'.repeat(200));
  assert.throws(() => pw.assertPasswordShape('x'.repeat(201)), /太长/);
  assert.throws(() => pw.assertPasswordShape(''), /不能为空/);
});

/* ============================================================
   二、输入校验（http.mjs）
   ============================================================ */

H.test('validateUsername：3-20 位 [A-Za-z0-9_]，去首尾空白', () => {
  assert.equal(httpLib.validateUsername('  simon_07  '), 'simon_07');
  assert.equal(httpLib.validateUsername('abc'), 'abc');
  assert.equal(httpLib.validateUsername('a'.repeat(20)), 'a'.repeat(20));
  for (const bad of ['ab', 'a'.repeat(21), '有中文', 'has space', 'has-dash', 'dot.name', '', null, 123]) {
    assert.throws(() => httpLib.validateUsername(bad), (e) => e.code === 'INVALID_USERNAME', '应拒绝：' + JSON.stringify(bad));
  }
});

H.test('validateEmail：格式校验 + 转小写', () => {
  assert.equal(httpLib.validateEmail('  Me@Example.COM '), 'me@example.com');
  assert.equal(httpLib.validateEmail('a.b+c@sub.domain.cn'), 'a.b+c@sub.domain.cn');
  for (const bad of ['no-at', 'a@b', 'a@b.', '@b.com', 'a b@c.com', '', null, 'a@' + 'x'.repeat(200) + '.com']) {
    assert.throws(() => httpLib.validateEmail(bad), (e) => e.code === 'INVALID_EMAIL', '应拒绝：' + String(bad));
  }
});

H.test('validateContent：去首尾空白后 1–2000 字符', () => {
  assert.equal(httpLib.validateContent('  你好 <b>世界</b>  '), '你好 <b>世界</b>');
  assert.equal(httpLib.validateContent('x'.repeat(2000)), 'x'.repeat(2000));
  assert.throws(() => httpLib.validateContent('   '), (e) => e.code === 'INVALID_CONTENT');
  assert.throws(() => httpLib.validateContent('x'.repeat(2001)), (e) => e.code === 'INVALID_CONTENT');
  /* 内容原样保留 HTML 字符：转义是渲染层的事（两层都做会双重转义） */
  assert.equal(httpLib.validateContent('<script>alert(1)</script>'), '<script>alert(1)</script>');
});

H.test('validateSlug：去掉首尾空白，拒绝空白与控制字符', () => {
  assert.equal(httpLib.validateSlug('  mysql-57-notes  '), 'mysql-57-notes');
  assert.equal(httpLib.validateSlug('中文-slug'), '中文-slug');
  assert.throws(() => httpLib.validateSlug(''), (e) => e.code === 'INVALID_SLUG');
  assert.throws(() => httpLib.validateSlug('a b'), (e) => e.code === 'INVALID_SLUG');
  assert.throws(() => httpLib.validateSlug('a\u0000b'), (e) => e.code === 'INVALID_SLUG');
  assert.throws(() => httpLib.validateSlug('x'.repeat(201)), (e) => e.code === 'INVALID_SLUG');
});

H.test('validateParentId / validateCommentId：只接受正整数，挡住注入形态', () => {
  assert.equal(httpLib.validateParentId(undefined), null);
  assert.equal(httpLib.validateParentId(null), null);
  assert.equal(httpLib.validateParentId(''), null);
  assert.equal(httpLib.validateParentId(0), null);
  assert.equal(httpLib.validateParentId('12'), 12);
  assert.equal(httpLib.validateParentId(12), 12);
  /* 0 / '0' 当"没有父评论"（表单里"不选"常这么传），而不是 422 */
  assert.equal(httpLib.validateParentId('0'), null);
  assert.equal(httpLib.validateParentId(0), null);
  for (const bad of ['abc', '1; DROP TABLE comments', '-1', '1.5', '1e3', ' 1,2', {}]) {
    assert.throws(() => httpLib.validateParentId(bad), (e) => e.code === 'INVALID_PARENT', '应拒绝：' + JSON.stringify(bad));
  }
  assert.equal(httpLib.validateCommentId('7'), 7);
  for (const bad of ['mine', '0', '-3', '1 OR 1=1', '1/2', '']) {
    assert.throws(() => httpLib.validateCommentId(bad), (e) => e.code === 'NOT_FOUND', '应拒绝：' + JSON.stringify(bad));
  }
});

H.test('classifyLoginId：含 @ 当邮箱（转小写），否则当用户名', () => {
  assert.deepEqual(httpLib.classifyLoginId('Alice'), { kind: 'username', value: 'Alice' });
  assert.deepEqual(httpLib.classifyLoginId(' A@B.com '), { kind: 'email', value: 'a@b.com' });
  assert.throws(() => httpLib.classifyLoginId(''), (e) => e.code === 'BAD_REQUEST');
});

/* ============================================================
   三、错误码映射与响应形状（http.mjs）
   ============================================================ */

H.test('statusForCode：契约里的映射逐条对上，未知 code 落到 500', () => {
  const expect = {
    BAD_REQUEST: 400, INVALID_JSON: 400, INVALID_USERNAME: 422, INVALID_EMAIL: 422,
    INVALID_PASSWORD: 422, INVALID_CONTENT: 422, INVALID_SLUG: 422, INVALID_PARENT: 422,
    UNAUTHENTICATED: 401, INVALID_CREDENTIALS: 401, FORBIDDEN: 403, NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405, USERNAME_TAKEN: 409, EMAIL_TAKEN: 409, BODY_TOO_LARGE: 413,
    UNSUPPORTED_MEDIA_TYPE: 415, RATE_LIMITED: 429, INTERNAL: 500, DB_UNAVAILABLE: 503
  };
  for (const [code, status] of Object.entries(expect)) {
    assert.equal(httpLib.statusForCode(code), status, code);
  }
  assert.equal(httpLib.statusForCode('SOMETHING_NEW'), 500, '未知 code 必须落到 500 而不是 200');
});

H.test('失败响应形状恒为 {ok:false,error:{code,message}}（顶层只有两个键）', () => {
  for (const code of Object.keys(httpLib.ERROR_CODES)) {
    const body = httpLib.errorBody(code, '示例');
    assert.deepEqual(Object.keys(body), ['ok', 'error']);
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message']);
    assert.equal(body.ok, false);
  }
});

H.test('sendError：HttpError 用自己的状态码；非 HttpError 一律 500 且不泄露细节', () => {
  const made = [];
  const fakeRes = () => {
    const r = {
      writableEnded: false,
      headers: null, status: 0, body: null,
      writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
      end(body) { this.writableEnded = true; this.body = body; return this; }
    };
    made.push(r);
    return r;
  };

  const r1 = fakeRes();
  httpLib.sendError(r1, httpLib.fail('INVALID_EMAIL', '邮箱格式不正确'));
  assert.equal(r1.status, 422);
  assert.deepEqual(JSON.parse(r1.body), { ok: false, error: { code: 'INVALID_EMAIL', message: '邮箱格式不正确' } });

  const r2 = fakeRes();
  httpLib.sendError(r2, new httpLib.ApiError('FORBIDDEN', '只能删除自己的评论'));
  assert.equal(r2.status, 403);

  /* 驱动原始错误绝不能被发出去 */
  const r3 = fakeRes();
  const drv = new Error("ER_DUP_ENTRY: Duplicate entry 'simon' for key 'uk_users_username'");
  drv.code = 'ER_DUP_ENTRY';
  httpLib.sendError(r3, drv, { log: () => {} });
  assert.equal(r3.status, 500);
  assert.deepEqual(JSON.parse(r3.body), { ok: false, error: { code: 'INTERNAL', message: '服务器内部错误' } });
  assert.ok(!r3.body.includes('uk_users_username'), '响应体不得出现库结构细节');

  /* 库不可用 → 503 而不是 500 */
  const r4 = fakeRes();
  const down = new Error('connect ECONNREFUSED 127.0.0.1:3306');
  down.code = 'ECONNREFUSED';
  httpLib.sendError(r4, down, { log: () => {}, dbUnavailable: dbMod.isDbDown(down) });
  assert.equal(r4.status, 503);
  assert.equal(JSON.parse(r4.body).error.code, 'DB_UNAVAILABLE');
});

H.test('securityHeaders：nosniff + no-referrer + no-store 恒在，且不覆盖调用方给的头', () => {
  const hd = httpLib.securityHeaders({ 'content-type': 'application/json' });
  assert.equal(hd['x-content-type-options'], 'nosniff');
  assert.equal(hd['referrer-policy'], 'no-referrer');
  assert.equal(hd['cache-control'], 'no-store');
  assert.equal(hd['x-frame-options'], 'DENY');
  assert.equal(hd['content-type'], 'application/json');
});

H.test('ApiError 继承 HttpError，且带上机器可读的 code', () => {
  const e = httpLib.fail('INVALID_PARENT', '要回复的评论不存在');
  assert.ok(e instanceof httpLib.HttpError);
  assert.equal(e.status, 422);
  assert.equal(e.code, 'INVALID_PARENT');
  assert.equal(e.name, 'ApiError');
});

/* ============================================================
   四、路由此表与优先级（http.mjs）
   ============================================================ */

H.test('findRoute：静态段优先于参数段（/api/comments/mine 不会被 :id 吃掉）', () => {
  const routes = [
    httpLib.route({ method: 'GET', path: '/api/comments/:id', handler: () => ({}) }),
    httpLib.route({ method: 'GET', path: '/api/comments/mine', handler: () => ({}) })
  ];
  /* 故意把 :id 注册在前，验证"不依赖注册顺序" */
  const mine = httpLib.findRoute(routes, 'GET', '/api/comments/mine');
  assert.equal(mine.route.path, '/api/comments/mine');
  const one = httpLib.findRoute(routes, 'GET', '/api/comments/12');
  assert.equal(one.route.path, '/api/comments/:id');
  assert.equal(one.params.id, '12');
});

H.test('findRoute：路径命中但方法不对 → 返回 allowed（供 405 用）', () => {
  const routes = [
    httpLib.route({ method: 'POST', path: '/api/auth/login', handler: () => ({}) }),
    httpLib.route({ method: 'DELETE', path: '/api/comments/:id', handler: () => ({}) })
  ];
  const a = httpLib.findRoute(routes, 'GET', '/api/auth/login');
  assert.equal(a.route, null);
  assert.deepEqual(a.allowed, ['POST']);
  const b = httpLib.findRoute(routes, 'GET', '/api/nope');
  assert.deepEqual(b.allowed, []);
});

/* ============================================================
   五、限流算术（http.mjs）
   ============================================================ */

H.test('限流窗口：窗口内第 max 次仍放行，第 max+1 次拒绝并给 Retry-After', () => {
  let now = 1_000_000;
  const rl = httpLib.createRateLimiter({ now: () => now });
  const cfg = httpLib.RATE_LIMITS['auth.login'];
  assert.equal(cfg.max, 10, '契约冻结的登录阈值是每 IP 15 分钟 10 次');
  for (let i = 1; i <= cfg.max; i += 1) {
    const r = rl.check('auth.login', 'ip:1.2.3.4');
    assert.equal(r.allowed, true, '第 ' + i + ' 次应放行');
    assert.equal(r.remaining, cfg.max - i);
  }
  const blocked = rl.check('auth.login', 'ip:1.2.3.4');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSec, Math.ceil(cfg.blockMs / 1000));
  /* 别的 IP 不受影响：限流的键是每 IP */
  assert.equal(rl.check('auth.login', 'ip:5.6.7.8').allowed, true);
  /* 窗口过去后恢复：必须等**封禁窗口**（blockMs）走完，而不只是窗口长度 ——
     封禁期间连正确口令都拒，这正是"猜对一次也重置不了计数"的实现方式。 */
  now += cfg.blockMs + 1000;
  assert.equal(rl.check('auth.login', 'ip:1.2.3.4').allowed, true);
  /* 只走过 windowMs（还封着）时仍然拒绝 */
  now -= cfg.blockMs + 1000;
  now += cfg.windowMs + 1000;
  assert.equal(rl.check('auth.login', 'ip:1.2.3.4').allowed, false, '封禁窗口内即使过了窗口长度也必须继续拒');
});

H.test('限流键隔离：同一 IP 的不同 action 各算各的', () => {
  let now = 0;
  const rl = httpLib.createRateLimiter({ now: () => now });
  for (let i = 0; i < httpLib.RATE_LIMITS['auth.register'].max; i += 1) rl.check('auth.register', 'ip:1.1.1.1');
  assert.equal(rl.check('auth.register', 'ip:1.1.1.1').allowed, false);
  assert.equal(rl.check('auth.login', 'ip:1.1.1.1').allowed, true, '注册被限不该把登录一起熔断');
});

H.test('rate.assert：抛 RATE_LIMITED 且带 retryAfterSec（供 Retry-After 头）', () => {
  const now = 0;
  const rl = httpLib.createRateLimiter({ now: () => now, limits: { 'x.y': { windowMs: 1000, max: 1, blockMs: 5000 } } });
  rl.assert('x.y', 'k');
  let thrown = null;
  try { rl.assert('x.y', 'k'); } catch (e) { thrown = e; }
  assert.ok(thrown, '第二次应抛错');
  assert.equal(thrown.code, 'RATE_LIMITED');
  assert.equal(thrown.status, 429);
  assert.equal(thrown.extra.retryAfterSec, 5);
});

H.test('限流内存不会无限增长：超上限时淘汰最旧的键', () => {
  const now = 0;
  const rl = httpLib.createRateLimiter({ now: () => now, maxKeys: 20, limits: { a: { windowMs: 60_000, max: 3, blockMs: 1000 } } });
  for (let i = 0; i < 60; i += 1) rl.check('a', 'ip:' + i);
  assert.ok(rl.size() <= 40, '键数量应该有上限，实际 ' + rl.size());
});

/* ============================================================
   六、SQL 参数化与授权判定（假 db 句柄）
   ============================================================ */

/** 假 db：记录 SQL 与参数，返回预设结果。用来断言"SQL 长什么样"。 */
const fakeDb = (handler) => {
  const calls = [];
  return {
    calls,
    execute: async (sql, params) => {
      calls.push({ sql, params });
      return handler(sql, params, calls.length - 1);
    },
    query: async (sql, params) => {
      calls.push({ sql, params });
      return handler(sql, params, calls.length - 1);
    }
  };
};

const hasPlaceholder = (sql, params) => (sql.match(/\?/g) || []).length === params.length;

H.test('userstore：findUserByLogin 按 kind 走两条等值 SQL，全参数化', async () => {
  const db = fakeDb(() => [[], null]);
  await userstore.findUserByLogin(db, 'username', 'Alice');
  assert.match(db.calls[0].sql, /WHERE username = \? LIMIT 1/);
  assert.deepEqual(db.calls[0].params, ['Alice']);
  assert.ok(hasPlaceholder(db.calls[0].sql, db.calls[0].params));

  await userstore.findUserByLogin(db, 'email', 'a@b.com');
  assert.match(db.calls[1].sql, /WHERE email = \? LIMIT 1/);
  assert.deepEqual(db.calls[1].params, ['a@b.com']);
  /* 不手工 LOWER()：那会让唯一索引失效 */
  assert.ok(!/LOWER\(/i.test(db.calls[1].sql));
  /* 不 SELECT *：否则 password_hash 会跟着行对象到处流 */
  assert.ok(!/SELECT \*/i.test(db.calls[0].sql));
});

H.test('userstore：写入的会话 id 是令牌的 SHA-256，不是令牌本身', async () => {
  const db = fakeDb(() => [{ insertId: 1, affectedRows: 1 }, null]);
  const { id: token, expiresAt } = await userstore.createSession(db, { id: 42 }, { ip: '1.2.3.4', ua: 'UA', maxAgeDays: 30 });
  assert.equal(token.length, 64, '原始令牌 32 字节 → 64 字符十六进制');
  assert.match(token, /^[0-9a-f]{64}$/);
  const sql = db.calls[0].sql;
  const params = db.calls[0].params;
  assert.match(sql, /INSERT INTO sessions \(id, user_id, expires_at, ip, ua\) VALUES \(\?, \?, \?, \?, \?\)/);
  assert.ok(hasPlaceholder(sql, params));
  assert.equal(params[0], createHash('sha256').update(token).digest('hex'), '库里存的必须是摘要');
  assert.notEqual(params[0], token, '库里绝不能存原始令牌');
  assert.equal(params[1], 42);
  assert.match(String(expiresAt), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'expires_at 是 DATETIME 字符串');

  /* 校验：同样先摘要再按主键查 */
  db.calls.length = 0;
  const db2 = fakeDb((sql) => (/FROM sessions/.test(sql) ? [[{
    session_id: createHash('sha256').update(token).digest('hex'), user_id: 42, expires_at: expiresAt,
    last_seen: expiresAt, id2: 42, username: 'simon', email: 'a@b.com', avatar: null, role: 'user',
    status: 'active', u_created_at: new Date()
  }], null] : [{ affectedRows: 1 }, null]));
  const s = await userstore.resolveSession(db2, token);
  assert.equal(s.user.username, 'simon');
  assert.equal(db2.calls[0].params[0], createHash('sha256').update(token).digest('hex'));
  assert.match(db2.calls[0].sql, /expires_at > \?/, '过期判断必须在 SQL 里做');
  assert.match(db2.calls[0].sql, /u\.status = 'active'/, '被禁用的账号必须立刻失去所有会话');
  /* 销毁会话同样按摘要删 */
  db2.calls.length = 0;
  await userstore.destroySession(db2, token);
  assert.match(db2.calls[0].sql, /DELETE FROM sessions WHERE id = \?/);
  assert.equal(db2.calls[0].params[0], createHash('sha256').update(token).digest('hex'));
});

H.test('userstore：唯一键冲突被翻译成 USERNAME_TAKEN / EMAIL_TAKEN，而不是 500', () => {
  const dupUser = Object.assign(new Error("Duplicate entry 'simon' for key 'uk_users_username'"), { code: 'ER_DUP_ENTRY', errno: 1062 });
  const dupEmail = Object.assign(new Error("Duplicate entry 'a@b.com' for key 'uk_users_email'"), { code: 'ER_DUP_ENTRY', errno: 1062 });
  assert.equal(userstore.translateUserConflict(dupUser, { username: 'simon', email: 'a@b.com' }), 'USERNAME_TAKEN');
  assert.equal(userstore.translateUserConflict(dupEmail, { username: 'x', email: 'a@b.com' }), 'EMAIL_TAKEN');
  /* 不是唯一键冲突 → 不翻译（宁可 500，也不要给出错误的"已被占用"提示） */
  assert.equal(userstore.translateUserConflict(new Error('syntax error'), {}), null);
});

H.test('commentstore：列表只取 approved，参数化，带上作者与 parent_id', async () => {
  const db = fakeDb(() => [[], null]);
  await commentstore.listComments(db, 'some-slug');
  const c0 = db.calls[0];
  assert.match(c0.sql, /FROM comments c INNER JOIN users u ON u\.id = c\.user_id/);
  assert.match(c0.sql, /WHERE c\.slug = \? AND c\.status = 'approved'/);
  assert.match(c0.sql, /ORDER BY c\.created_at ASC, c\.id ASC/);
  assert.deepEqual(c0.params, ['some-slug', commentstore.LIST_LIMIT]);
  assert.ok(hasPlaceholder(c0.sql, c0.params));

  await commentstore.listCommentsByUser(db, 7);
  const c1 = db.calls[1];
  assert.match(c1.sql, /WHERE c\.user_id = \? AND c\.status = 'approved'/);
  assert.match(c1.sql, /ORDER BY c\.created_at DESC, c\.id DESC/);
  assert.deepEqual(c1.params, [7, commentstore.MINE_LIMIT]);
});

H.test('commentstore：插入评论前用 SQL 校验 parent_id 属于同一 slug 且 approved', async () => {
  const seen = [];
  const db = fakeDb((sql, params) => {
    seen.push({ sql, params });
    if (/SELECT id FROM comments/.test(sql)) return [[{ id: 12 }], null];
    if (/^INSERT INTO comments/.test(sql)) return [{ insertId: 99, affectedRows: 1 }, null];
    if (/FROM comments c INNER JOIN/.test(sql)) return [[{ id: 99, user_id: 7, username: 'simon', parent_id: 12, content: 'hi', created_at: new Date(), avatar: null, slug: 's' }], null];
    return [[], null];
  });
  await commentstore.createComment(db, { slug: 's', userId: 7, parentId: 12, content: 'hi' });
  const check = seen.find((c) => /SELECT id FROM comments/.test(c.sql));
  assert.ok(check, '必须有一次父评论校验查询');
  assert.match(check.sql, /WHERE id = \? AND slug = \? AND status = 'approved'/);
  assert.deepEqual(check.params, [12, 's']);
  const ins = seen.find((c) => /^INSERT INTO comments/.test(c.sql));
  assert.match(ins.sql, /INSERT INTO comments \(slug, user_id, parent_id, content\) VALUES \(\?, \?, \?, \?\)/);
  assert.deepEqual(ins.params, ['s', 7, 12, 'hi']);

  /* 父评论不存在 / 不属于同一篇 → INVALID_PARENT（而不是写进去） */
  const db2 = fakeDb(() => [[], null]);
  await assert.rejects(
    () => commentstore.createComment(db2, { slug: 's', userId: 7, parentId: 999, content: 'hi' }),
    (e) => e.code === 'INVALID_PARENT'
  );
  assert.ok(!db2.calls.some((c) => /^INSERT INTO comments/.test(c.sql)), '校验失败时绝不能插入');
});

H.test('commentstore：软删在 UPDATE 的 WHERE 里判权（非作者且非 admin → affectedRows 0）', async () => {
  /* 非 admin：WHERE 必须带 user_id */
  const db = fakeDb(() => [{ affectedRows: 1 }, null]);
  const ok = await commentstore.markCommentDeleted(db, 12, { byUserId: 7, byRole: 'user' });
  assert.equal(ok, true);
  assert.match(db.calls[0].sql, /UPDATE comments SET status = 'deleted' WHERE id = \? AND user_id = \?/);
  assert.deepEqual(db.calls[0].params, [12, 7]);
  assert.match(db.calls[0].sql, /status <> 'deleted'/, '已经删过的行不该再算成功');

  /* 别人来删：数据库说 0 行 → 上层据此给 403 */
  const db2 = fakeDb(() => [{ affectedRows: 0 }, null]);
  assert.equal(await commentstore.markCommentDeleted(db2, 12, { byUserId: 8, byRole: 'user' }), false);
  assert.deepEqual(db2.calls[0].params, [12, 8]);

  /* admin：WHERE 不带 user_id（可以删别人的） */
  const db3 = fakeDb(() => [{ affectedRows: 1 }, null]);
  assert.equal(await commentstore.markCommentDeleted(db3, 12, { byUserId: 1, byRole: 'admin' }), true);
  assert.match(db3.calls[0].sql, /WHERE id = \? AND status <> 'deleted'/);
  assert.deepEqual(db3.calls[0].params, [12]);

  /* 软删只改状态，绝不 DELETE 行（子回复的 parent_id 不能悬空） */
  for (const c of [...db.calls, ...db3.calls]) {
    assert.ok(/^UPDATE comments SET status = 'deleted'/.test(c.sql), '必须是软删 UPDATE：' + c.sql);
    assert.ok(!/^\s*DELETE\b/i.test(c.sql), '不能是物理删除：' + c.sql);
  }
});

H.test('commentstore：commentForDelete 不过滤 status（让上层能区分 404 与已删）', async () => {
  const db = fakeDb(() => [[{ id: 5, slug: 's', user_id: 7, parent_id: null, status: 'deleted' }], null]);
  const row = await commentstore.commentForDelete(db, 5);
  assert.equal(row.status, 'deleted');
  assert.match(db.calls[0].sql, /WHERE c\.id = \? LIMIT 1/);
  /* 这一句不按 status 过滤 —— 否则已软删的行会变成"不存在"，
     上层就分不清 404（真没有）与"已经有了但被删了"。 */
  assert.ok(!/status\s*(=|<>)/.test(db.calls[0].sql), '这一句不该过滤 status：' + db.calls[0].sql);
});

H.test('userstore：限流计数是单条 upsert，失败退避写进 gate_until', async () => {
  const db = fakeDb(() => [{ affectedRows: 1 }, null]);
  await userstore.noteThrottleFailure(db, '1.2.3.4', 'login', { maxFails: 10, gateMs: 3_600_000 });
  const c = db.calls[0];
  assert.match(c.sql, /INSERT INTO auth_throttle \(ip, action, fails, gate_until\) VALUES \(\?, \?, 1, NULL\)/);
  assert.match(c.sql, /ON DUPLICATE KEY UPDATE/, '必须是单条原子 upsert，不能先查再写');
  assert.match(c.sql, /fails = fails \+ 1/);
  assert.match(c.sql, /IF\(fails >= \?/);
  assert.match(c.sql, /INTERVAL \? SECOND/);
  assert.deepEqual(c.params, ['1.2.3.4', 'login', 10, 3600]);
  assert.equal((c.sql.match(/ON DUPLICATE KEY UPDATE/g) || []).length, 1);

  db.calls.length = 0;
  await userstore.throttleState(db, '1.2.3.4', 'login', { maxFails: 10, windowMs: 900_000 });
  assert.match(db.calls[0].sql, /SELECT fails, gate_until FROM auth_throttle WHERE ip = \? AND action = \? LIMIT 1/);
  assert.deepEqual(db.calls[0].params, ['1.2.3.4', 'login']);
});

H.test('userstore：审计日志只写最小信息，且失败不影响认证结果', async () => {
  const db = fakeDb(() => [{ affectedRows: 1 }, null]);
  const ok = await userstore.writeAuthLog(db, { userId: 7, ip: '1.2.3.4', action: 'login', ok: true, detail: 'ok' });
  assert.equal(ok, true);
  assert.match(db.calls[0].sql, /INSERT INTO auth_log \(user_id, ip, action, ok, detail\) VALUES \(\?, \?, \?, \?, \?\)/);
  assert.deepEqual(db.calls[0].params, [7, '1.2.3.4', 'login', 1, 'ok']);

  /* 审计表写不进去（比如权限/磁盘）时不能把登录一起搞挂 */
  const dead = { execute: async () => { throw new Error('auth_log gone'); } };
  assert.equal(await userstore.writeAuthLog(dead, { action: 'login', ok: false }), false);
  /* detail 会被截断到列宽（VARCHAR(255)） */
  const db2 = fakeDb(() => [{ affectedRows: 1 }, null]);
  await userstore.writeAuthLog(db2, { action: 'login', ok: false, detail: 'x'.repeat(400) });
  assert.equal(db2.calls[0].params[4].length, 255);
});

H.test('userstore：清理过期会话是参数化的批量 DELETE', async () => {
  const db = fakeDb(() => [{ affectedRows: 3 }, null]);
  const n = await userstore.purgeExpiredSessions(db, 100);
  assert.equal(n, 3);
  assert.match(db.calls[0].sql, /DELETE FROM sessions WHERE expires_at <= \? LIMIT \?/);
  assert.equal(db.calls[0].params.length, 2);
  assert.match(String(db.calls[0].params[0]), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

/* ============================================================
   七、数据库配置（db.mjs）
   ============================================================ */

const ALL_DB_KEYS = ['P3_DB_HOST', 'P3_DB_PORT', 'P3_DB_NAME', 'P3_DB_USER', 'P3_DB_PASSWORD'];

H.test('readDbConfig：缺任一变量都抛错，并指名缺了哪几个', () => {
  const full = { P3_DB_HOST: '127.0.0.1', P3_DB_PORT: '3306', P3_DB_NAME: 'p3blog', P3_DB_USER: 'p3app', P3_DB_PASSWORD: 'x' };
  const cfg = dbMod.readDbConfig(full);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 3306);
  assert.equal(cfg.database, 'p3blog');
  assert.equal(cfg.user, 'p3app');
  assert.equal(cfg.sessionMaxAgeDays, 30);

  for (const key of ALL_DB_KEYS) {
    const partial = Object.assign({}, full);
    delete partial[key];
    assert.throws(() => dbMod.readDbConfig(partial), (e) => {
      assert.match(e.message, new RegExp(key), '错误信息必须点出缺的是 ' + key);
      return true;
    }, '缺 ' + key + ' 时必须拒绝');
  }
  /* 空白也算缺 */
  assert.throws(() => dbMod.readDbConfig(Object.assign({}, full, { P3_DB_PASSWORD: '   ' })), /P3_DB_PASSWORD/);
  /* 端口非法 */
  assert.throws(() => dbMod.readDbConfig(Object.assign({}, full, { P3_DB_PORT: 'abc' })), /P3_DB_PORT/);
  assert.throws(() => dbMod.readDbConfig(Object.assign({}, full, { P3_DB_PORT: '70000' })), /P3_DB_PORT/);
  /* 绝不回退默认口令/root：缺了就抛，不返回任何配置 */
  assert.throws(() => dbMod.readDbConfig({}), /P3_DB_HOST/);
});

H.test('missingDbEnv：只报变量名，不报值', () => {
  const missing = dbMod.missingDbEnv({ P3_DB_HOST: '127.0.0.1' });
  assert.deepEqual(missing.sort(), ['P3_DB_NAME', 'P3_DB_PASSWORD', 'P3_DB_PORT', 'P3_DB_USER']);
  assert.deepEqual(dbMod.missingDbEnv({}), ALL_DB_KEYS);
});

H.test('safeDbSummary：绝不回显口令', () => {
  const cfg = dbMod.readDbConfig({ P3_DB_HOST: '127.0.0.1', P3_DB_PORT: '3306', P3_DB_NAME: 'p3blog', P3_DB_USER: 'p3app', P3_DB_PASSWORD: 'super-secret-value' });
  const s = dbMod.safeDbSummary(cfg);
  const json = JSON.stringify(s);
  assert.ok(!json.includes('super-secret-value'), '摘要里不得出现口令');
  assert.equal(s.password, '(已设置，不显示)');
});

H.test('createPool：显式传全部字段、不读 option file、关掉多语句', async () => {
  const captured = [];
  const fakeMysql = {
    createPool: (opts) => {
      captured.push(opts);
      return { query: async () => [[], null], execute: async () => [[], null], end: async () => {} };
    }
  };
  const cfg = dbMod.readDbConfig({ P3_DB_HOST: '10.0.0.1', P3_DB_PORT: '3307', P3_DB_NAME: 'p3blog', P3_DB_USER: 'p3app', P3_DB_PASSWORD: 'pw' });
  const pool = await dbMod.createPool(cfg, { mysql: fakeMysql });
  const o = captured[0];
  assert.equal(o.host, '10.0.0.1');
  assert.equal(o.port, 3307);
  assert.equal(o.user, 'p3app');
  assert.equal(o.password, 'pw');
  assert.equal(o.database, 'p3blog');
  assert.equal(o.connectionLimit, 5, '连接池上限 5（5.7 单机内存有限）');
  assert.equal(o.multipleStatements, false, '公开面不需要多语句，开着等于放大注入面');
  assert.equal(o.namedPlaceholders, false, '只用 ? 一种占位符');
  assert.equal(o.dateStrings[0], 'DATETIME');
  assert.equal(o.timezone, 'Z');
  /* 不设 socketPath / defaultsFile：必须走 TCP，且不读 /etc/my.cnf 的 [client] */
  assert.equal(o.socketPath, undefined);
  assert.equal(o.defaultsFile, undefined);
  assert.ok(pool);
});

H.test('isDbDown / isDupEntry：把"库挂了"和"我们写错了"分开', () => {
  assert.equal(dbMod.isDbDown(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), true);
  assert.equal(dbMod.isDbDown(Object.assign(new Error('x'), { code: 'ER_ACCESS_DENIED_ERROR' })), true);
  assert.equal(dbMod.isDbDown(Object.assign(new Error('x'), { code: 'ER_BAD_FIELD_ERROR' })), false);
  assert.equal(dbMod.isDbDown(null), false);
  assert.equal(dbMod.isDupEntry(Object.assign(new Error('x'), { code: 'ER_DUP_ENTRY' })), true);
  assert.equal(dbMod.isDupEntry(Object.assign(new Error('x'), { errno: 1062 })), true);
  assert.equal(dbMod.isDupEntry(new Error('x')), false);
});

H.test('时间工具：DATETIME 字符串是 UTC 的固定格式（可比字符串）', () => {
  const t = new Date(Date.UTC(2026, 1, 14, 9, 31, 7));
  assert.equal(dbMod.toDbDateTime(t), '2026-02-14 09:31:07');
  assert.equal(dbMod.dbDateTimeInDays(30, t), '2026-03-16 09:31:07');
  assert.match(dbMod.dbNow(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

/* ============================================================
   八、接口测试（内存假 store + 真实 HTTP）
   ============================================================ */
import { createPublicApp } from '../public-server.mjs';
import * as srvMod from '../public-server.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

/** 内存假 store：模拟 t14 数据层的行为（含 sha256 摘要那一步 + 软删语义） */
const memoryStores = () => {
  const users = new Map();
  const sessions = new Map();
  const comments = new Map();
  const throttle = new Map();
  const authLog = [];
  let nextUserId = 1;
  let nextCommentId = 1;
  const state = { users, sessions, comments, throttle, authLog };

  const toRow = (u) => Object.assign({}, u);
  const userFields = (uid) => {
    const u = users.get(uid) || {};
    return { username: u.username || '', avatar: u.avatar == null ? null : u.avatar };
  };
  const stores = {
    mode: 'memory',
    users, sessions, comments, throttle, authLogRows: authLog,
    /* 落库限流被调用了几次（注册语义回归闸用） */
    throttleFailures: 0,
    async health() { return 'up'; },
    async resolveSession(token) {
      const rec = sessions.get(sha256(token));
      if (!rec) return null;
      if (new Date(rec.expiresAt).getTime() <= Date.now()) { sessions.delete(sha256(token)); return null; }
      const u = users.get(rec.userId);
      if (!u) return null;
      return { sessionId: sha256(token), expiresAt: rec.expiresAt, user: toRow(u) };
    },
    async createSession(user, { ip, ua } = {}) {
      const token = 'tk' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
      const full = token.length === 66 ? token.slice(0, 64) : (token + '0'.repeat(64)).slice(0, 64);
      sessions.set(sha256(full), { userId: user.id, ip, ua, expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() });
      return { id: full, expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() };
    },
    async destroySession(token) { return sessions.delete(sha256(token)); },
    async findUserByLogin(kind, value) {
      for (const u of users.values()) {
        if (kind === 'email' && String(u.email).toLowerCase() === String(value).toLowerCase()) return toRow(u);
        if (kind === 'username' && u.username === value) return toRow(u);
      }
      return null;
    },
    async checkPassword(plain, row) {
      /* 与 passwords.mjs 同语义：没有行也要"跑一次"，这里用固定代价代替 */
      if (!row) return false;
      const { hashPassword, verifyPassword } = pw;
      if (typeof row.__plain === 'string') return row.__plain === plain;
      if (row.password_hash) return verifyPassword(plain, row.password_hash);
      return false;
    },
    async createUser({ username, email, password }) {
      for (const u of users.values()) {
        if (u.username === username || String(u.email).toLowerCase() === String(email).toLowerCase()) {
          /* 像真驱动那样报出撞的索引名：数据层靠它把冲突翻译成 409 而不是 500 */
          const dupUser = u.username === username;
          const e = new Error('Duplicate entry for key ' + (dupUser ? "'uk_users_username'" : "'uk_users_email'"));
          e.code = 'ER_DUP_ENTRY';
          e.errno = 1062;
          throw e;
        }
      }
      const { hash, algo } = await pw.hashPassword(password);
      const u = { id: nextUserId++, username, email, password_hash: hash, password_algo: algo, avatar: null, role: 'user', status: 'active', created_at: new Date() };
      users.set(u.id, u);
      const safe = Object.assign({}, u);
      delete safe.password_hash;
      delete safe.password_algo;
      return { user: Object.assign({ __plain: password }, safe) };
    },
    async listComments(slug) {
      return [...comments.values()]
        .filter((c) => c.slug === slug && c.status === 'approved')
        .sort((a, b) => (a.created_at - b.created_at) || (a.id - b.id))
        .map((c) => Object.assign({}, c, userFields(c.user_id)));
    },
    async listCommentsByUser(userId) {
      return [...comments.values()]
        .filter((c) => c.user_id === userId && c.status === 'approved')
        .sort((a, b) => (b.created_at - a.created_at) || (b.id - a.id))
        .map((c) => Object.assign({}, c, userFields(c.user_id)));
    },
    async createComment({ slug, userId, parentId, content }) {
      if (parentId != null) {
        const p = comments.get(parentId);
        if (!p || p.slug !== slug || p.status !== 'approved') throw httpLib.fail('INVALID_PARENT', '要回复的评论不存在或不属于这篇文章');
      }
      const id = nextCommentId++;
      const c = { id, slug, user_id: userId, parent_id: parentId == null ? null : parentId, content, status: 'approved', created_at: new Date() };
      comments.set(id, c);
      return Object.assign({}, c, userFields(userId));
    },
    async commentForDelete(id) { return comments.get(id) || null; },
    async markCommentDeleted(id, { byUserId, byRole }) {
      const c = comments.get(id);
      if (!c || c.status === 'deleted') return false;
      if (byRole !== 'admin' && Number(c.user_id) !== Number(byUserId)) return false;
      c.status = 'deleted';
      return true;
    },
    /* 落库限流：形状与真实现一致 */
    async authThrottleState(ip, action, policy) {
      const rec = throttle.get(ip + '|' + action);
      if (!rec) return { fails: 0, waitMs: 0, gated: false };
      if (rec.gateUntil > Date.now()) return { fails: rec.fails, waitMs: rec.gateUntil - Date.now(), gated: true };
      throttle.delete(ip + '|' + action);
      return { fails: 0, waitMs: 0, gated: false };
    },
    async authThrottleFailure(ip, action, policy) {
      /* 计数落库调用次数：注册限流语义的回归闸要看这个（见下面那条用例） */
      stores.throttleFailures += 1;
      const key = ip + '|' + action;
      const rec = throttle.get(key) || { fails: 0, gateUntil: 0 };
      rec.fails += 1;
      if (rec.fails >= (policy.maxFails || 10)) rec.gateUntil = Date.now() + (policy.gateMs || 3_600_000);
      throttle.set(key, rec);
      return true;
    },
    async authThrottleSuccess(ip, action) { return throttle.delete(ip + '|' + action); },
    /* authLog 是**函数**（CONTRACT §4 的接口就是 authLog(entry)），
       记录落到 stores.authLogRows 里供断言。别忘了 shape：写成数组会被
       `ctx.services.authLog(...)` 调用时炸成 TypeError。 */
    async authLog(entry) { authLog.push(entry); return true; },
    authLogRows: authLog,
    async close() {}
  };

  return stores;
};

const withServer = async (fn, { stores, origins } = {}) => {
  const s = stores || memoryStores();
  const app = await createPublicApp({ port: 0, log: false, stores: s, publicOrigins: origins || ['http://127.0.0.1'] });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  app.setPort(port);
  const base = 'http://127.0.0.1:' + port;
  const call = async (path, opts = {}) => {
    /* 只在真的带 body 时才加 content-type：无 body 的 POST 带上它会命中
       "写接口必须 application/json" 这条闸 —— 那是契约要求的行为，
       测试装置不该把它变成一个假故障。 */
    const o = Object.assign({}, opts);
    o.headers = Object.assign({}, opts.headers || {});
    if (o.body !== undefined && !Object.keys(o.headers).some((k) => k.toLowerCase() === 'content-type')) {
      o.headers['content-type'] = 'application/json';
    }
    const res = await fetch(base + path, o);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, headers: res.headers, body, text, cookie: res.headers.get('set-cookie') };
  };
  try {
    return await fn({ app, base, port, call, stores: s });
  } finally {
    app.server.close();
    await app.close();
  }
};

const registerUser = async (call, username, email, password) => {
  const r = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, email, password }) });
  /* Set-Cookie 只取 name=value 部分（其余是属性），这样可以直接回填进 Cookie 头 */
  const cookie = r.cookie ? r.cookie.split(';')[0] : '';
  return { r, cookie };
};

H.test('接口：注册成功 201 + 建会话 + Set-Cookie 属性齐全', async () => {
  await withServer(async ({ call, stores }) => {
    const { r, cookie } = await registerUser(call, 'simon', 'me@example.com', 'a-good-password');
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.user.username, 'simon');
    assert.equal(r.body.user.role, 'user');
    assert.equal(r.body.user.email, 'me@example.com');
    assert.ok(!('password_hash' in r.body.user), '响应里不能有口令哈希');
    assert.ok(!('password' in r.body.user));
    assert.ok(!r.text.includes('a-good-password'), '响应体不能回显口令');
    assert.ok(/^p3_uid=/.test(cookie), '必须下发 p3_uid');
    /* 【S2 回归闸】Path 必须是 /api，不能是 /。
       Path=/ 会把会话 cookie 交给同源上的任何第三方应用（它们能从服务端读到这个头，
       HttpOnly 无效）。前端所有请求都只打 /api/*，所以收窄是零功能代价的。 */
    assert.match(r.cookie, /Path=\/api(;|$)/, 'cookie 作用域必须收窄到 /api，实际：' + r.cookie);
    assert.ok(!/Path=\/;/.test(r.cookie) && !/Path=\/$/.test(r.cookie), '不得是 Path=/');
    assert.match(r.cookie, /HttpOnly/);
    assert.match(r.cookie, /SameSite=Lax/);
    assert.match(r.cookie, /Max-Age=2592000/);
    assert.ok(!/Secure/.test(r.cookie), 'http origin 下不能带 Secure（否则浏览器不存）');
    /* 库里存的是哈希，不是明文；轮数取当前常量（S5 起为 600000） */
    const row = [...stores.users.values()][0];
    assert.ok(row.password_hash.startsWith('pbkdf2-sha256$' + pw.ITERATIONS + '$'),
      '实际前缀：' + String(row.password_hash).slice(0, 30));
    assert.ok(!row.password_hash.includes('a-good-password'));
    /* 会话也建了 */
    assert.equal(stores.sessions.size, 1);
    /* 审计留下了记录（且不含口令）。注意读的是 authLogRows（记录），
       stores.authLog 是那个**函数**本身。 */
    assert.ok(stores.authLogRows.length >= 1, '应至少写了一条审计（实际 ' + stores.authLogRows.length + '）');
    assert.equal(stores.authLogRows[0].action, 'register');
    assert.equal(stores.authLogRows[0].ok, true);
    assert.ok(!JSON.stringify(stores.authLogRows).includes('a-good-password'), '审计里绝不能有口令');
  });
});

H.test('接口：启动时用新参数注入 fake store（mine 也走真实路由）', async () => {
  await withServer(async ({ call }) => {
    const before = await call('/api/comments/mine');
    assert.equal(before.status, 401);
    assert.equal(before.body.error.code, 'UNAUTHENTICATED');
  });
});

H.test('接口：https origin → cookie 带 Secure', async () => {
  await withServer(async ({ call }) => {
    const { r } = await registerUser(call, 'simon', 'me@example.com', 'a-good-password');
    assert.match(r.cookie, /Secure/);
  }, { origins: ['https://blog.example.com'] });
});

H.test('接口：注册字段校验 —— 用户名/邮箱/口令各自的错误码', async () => {
  await withServer(async ({ call }) => {
    const cases = [
      [{ username: 'ab', email: 'a@b.com', password: '12345678' }, 422, 'INVALID_USERNAME'],
      [{ username: 'ok_user', email: 'not-an-email', password: '12345678' }, 422, 'INVALID_EMAIL'],
      [{ username: 'ok_user', password: '12345678' }, 422, 'INVALID_EMAIL'],
      [{ username: 'ok_user', email: 'a@b.com', password: 'short' }, 422, 'INVALID_PASSWORD']
    ];
    for (const [body, status, code] of cases) {
      const r = await call('/api/auth/register', { method: 'POST', body: JSON.stringify(body) });
      assert.equal(r.status, status, JSON.stringify(body));
      assert.equal(r.body.error.code, code, JSON.stringify(body));
      assert.deepEqual(Object.keys(r.body).sort(), ['error', 'ok']);
      /* 校验失败不能把口令回显出来 */
      assert.ok(!r.text.includes('12345678') && !r.text.includes('short'), '错误响应里不得包含口令');
    }
  });
});

H.test('接口：注册限流语义（回归闸，勿改）—— 校验失败不计入落库计数、只计失败、成功清零', async () => {
  /* 这是审计 S4 裁决后的**回归闸**：注册阈值恒为 5 次/小时 + 封禁 1 小时，
     且「校验失败不计入落库计数」。历史上这里漂成过"每次调用都计数 + 收紧到 3 次"，
     后果是正常用户填错两次表单就被挡在门外。
     本用例用真实 HTTP + 假 store 观察 authThrottleFailure 的调用次数。 */
  const limit = httpLib.RATE_LIMITS['auth.register'];
  assert.equal(limit.max, 5, '内存那道上限恒为 5');
  assert.equal(limit.windowMs, 60 * 60 * 1000, '窗口 1 小时');

  await withServer(async ({ call, stores, app }) => {
    /* ① 连续 5 次请求体校验失败（用户名 2 位）→ 全部 422，
       且**一次都不该写 auth_throttle**（校验失败在落库计数之外）。
       ⚠️ 只打 5 次：内存那道闸是"每 IP 每小时 5 次请求"（它按**请求**计数，
       设计如此，见 RATE_LIMITS 注释）；第 6 次会命中 429，那是内存闸的正常行为，
       不是落库计数被消耗。本用例要证明的是**落库**那道不被校验失败消耗。 */
    for (let i = 0; i < 5; i += 1) {
      const r = await call('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username: 'ab', email: `x${i}@t.example`, password: 'a-good-password' })
      });
      assert.equal(r.status, 422, '第 ' + (i + 1) + ' 次校验失败仍应是 422，实际 ' + r.status);
      assert.equal(r.body.error.code, 'INVALID_USERNAME');
    }
    assert.equal(stores.throttleFailures, 0, '校验失败不得计入落库计数（实际 ' + stores.throttleFailures + ' 次）');
    assert.equal(stores.throttle.size, 0, 'auth_throttle 里不该有任何注册记录');

    /* ② 真正的失败（用户名冲突 409）**才**累加落库计数。
       先清掉内存那道闸：它按"每 IP 每小时 5 次**请求**"计数（设计如此），
       上面 5 次已经把窗口用满；本用例要观察的是**落库**那一道，不是内存闸。 */
    app.rate.reset();
    /* 先用一个新名字注册成功（建立冲突源，也顺便证明合法请求没被挡） */
    const first = await call('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 't21vdiag', email: 'first@t.example', password: 'a-good-password' })
    });
    assert.equal(first.status, 201, '填错 5 次之后换合法用户名必须还能注册成功：'
      + first.status + ' ' + JSON.stringify(first.body));
    assert.ok(/^p3_uid=/.test(String(first.cookie)), '注册成功应下发会话 cookie');
    assert.equal(stores.throttleFailures, 0, '成功路径不写落库计数');
    assert.equal(stores.throttle.size, 0, '成功还会清零该 IP 的注册失败计数');

    /* 再用同一用户名 + 不同邮箱 → 唯一键冲突，这才是"真正的失败" */
    app.rate.reset();
    const dup = await call('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 't21vdiag', email: 'other@t.example', password: 'a-good-password' })
    });
    assert.equal(dup.status, 409, '实际 ' + dup.status + ' ' + JSON.stringify(dup.body));
    assert.equal(stores.throttleFailures, 1, '只有真的走到创建用户且失败才计数（实际 ' + stores.throttleFailures + '）');
    assert.equal(stores.throttle.size, 1);
  });
});

H.test('接口：注册阈值恒为 5 次/小时 + 封禁 1 小时（防止再被收紧）', () => {
  const lim = httpLib.RATE_LIMITS['auth.register'];
  assert.equal(lim.max, 5, '内存道上限恒为 5');
  assert.equal(lim.windowMs, 60 * 60 * 1000, '窗口恒为 1 小时');
  assert.equal(lim.blockMs, 60 * 60 * 1000, '封禁恒为 1 小时');

  const pol = srvMod.THROTTLE_POLICY.register;
  assert.equal(pol.maxFails, 5, '落库道 maxFails 恒为 5');
  assert.equal(pol.gateMs, 60 * 60 * 1000, '落库道封禁恒为 1 小时');

  /* 且**不存在**审核开关（S9 本轮不做）—— 这个参数一旦回来，
     新评论就会从公开列表静默消失，属于行为变更，必须重新过契约。 */
  const src = readFileSync(fileURLToPath(new URL('../public-server.mjs', import.meta.url)), 'utf8');
  assert.ok(!/comments-hold-for-review/.test(src), '不得引入评论审核开关');
});

H.test('静态闸 N2：验证脚本里的 SQL 不得裸拼模板串（必须过 sqlStr/sqlEscape）', () => {
  /* 审计 N2：tests/verify-public-live.mjs 用 `LIKE '${MARKER}%'` 这种裸拼。
     那条 SQL 走的通道是 `ssh … mysql <<'SQL'`，**没法**用绑定参数（不像 mysql2 的 ?），
     所以正确做法是把每个字符串过一遍真转义；本闸防止有人再写回裸拼写法。
     判据：任何 SQL 关键字附近的 `${…}` 都必须包在 sqlStr(…) 里。 */
  const f = readFileSync(fileURLToPath(new URL('./verify-public-live.mjs', import.meta.url)), 'utf8');
  const offenders = [];
  f.split('\n').forEach((line, i) => {
    /* 必须像"真的 SQL"：含 SELECT…FROM / DELETE FROM / UPDATE…SET / INSERT INTO。
       只看到 `DELETE /api/comments/…` 这种是 HTTP 方法的展示串，不是 SQL。 */
    const looksSql = /\bSELECT\b[\s\S]*\bFROM\b/.test(line) || /\bDELETE\s+FROM\b/.test(line)
      || /\bUPDATE\s+\w+\s+SET\b/.test(line) || /\bINSERT\s+INTO\b/.test(line);
    if (!looksSql) return;
    /* 判定"这个插值是否被 sqlStr(…) 包着"：直接看 `${` 之后是不是紧跟 `sqlStr(`。
       这是最不容易出错的一种判据 —— 不需要算匹配长度，也不会被正则前瞻里的花括号影响。 */
    const re = /\$\{/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const after = line.slice(m.index + 2, m.index + 2 + 7);
      if (after !== 'sqlStr(') offenders.push((i + 1) + ': ' + line.trim().slice(0, 110));
    }
  });
  assert.deepEqual(offenders, [], 'SQL 里的插值必须包在 sqlStr(…) 中：\n' + offenders.join('\n'));
  assert.ok(/const sqlStr = /.test(f), 'verify-public-live.mjs 必须定义 sqlStr()');
  assert.ok(/const sqlEscape = /.test(f), 'verify-public-live.mjs 必须定义 sqlEscape()');
});

H.test('接口：注册每一次调用都要成功（前几次校验失败不该把合法用户挡住）', async () => {
  await withServer(async ({ call, stores }) => {
    /* 先来 2 次填错表单（真实用户最常见的形态），再来一次合法注册 —— 必须 201 */
    for (let i = 0; i < 2; i += 1) {
      const bad = await call('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username: 'ab', email: `y${i}@t.example`, password: 'a-good-password' })
      });
      assert.equal(bad.status, 422);
    }
    const ok = await call('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 't21user', email: 'ok@t.example', password: 'a-good-password' })
    });
    assert.equal(ok.status, 201, '填错两次之后合法注册必须成功：' + JSON.stringify(ok.body));
    assert.ok(/^p3_uid=/.test(String(ok.cookie)));
    assert.equal(stores.throttleFailures, 0, '整条路径都不该写落库计数');
  });
});

H.test('接口：用户名/邮箱冲突 → 409（不是 500），且两种冲突可区分', async () => {
  await withServer(async ({ call, stores }) => {
    await registerUser(call, 'simon', 'me@example.com', 'a-good-password');
    /* 同一个用户名、不同邮箱 */
    const dupUser = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'simon', email: 'other@example.com', password: 'a-good-password' }) });
    assert.equal(dupUser.status, 409);
    assert.equal(dupUser.body.error.code, 'USERNAME_TAKEN');
    assert.ok(!/uk_users_|ER_DUP|Duplicate/i.test(dupUser.text), '不得泄露库结构');
    /* 不同用户名、同一个邮箱 */
    const dupMail = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'other', email: 'me@example.com', password: 'a-good-password' }) });
    assert.equal(dupMail.status, 409);
    assert.equal(dupMail.body.error.code, 'EMAIL_TAKEN');
    assert.equal(stores.users.size, 1, '冲突时不能建出第二行');
  });
});

H.test('接口：登录成功 / 失败文案不可区分 / 会话可解析', async () => {
  await withServer(async ({ call }) => {
    await registerUser(call, 'simon', 'me@example.com', 'a-good-password');
    const good = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ user: 'simon', password: 'a-good-password' }) });
    assert.equal(good.status, 200);
    assert.equal(good.body.user.username, 'simon');
    const cookie = good.cookie.split(';')[0];

    const me = await call('/api/auth/me', { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, 'simon');
    assert.equal(me.body.db, 'up', '真库模式下 db 必须是 up');
    assert.equal(me.body.session_max_age_days, 30);

    /* 邮箱也能当登录名 */
    const byMail = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ user: 'ME@EXAMPLE.COM', password: 'a-good-password' }) });
    assert.equal(byMail.status, 200);

    /* 账号枚举：不存在的用户 vs 错口令 → 完全相同的响应 */
    const miss = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ user: 'nobody', password: 'a-good-password' }) });
    const wrong = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ user: 'simon', password: 'wrong-password' }) });
    assert.equal(miss.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(miss.text, wrong.text, '两种失败的响应体必须逐字节相同');
    assert.equal(miss.body.error.code, 'INVALID_CREDENTIALS');
  });
});

H.test('接口：未登录时 me 返回 200 + user:null（不是 401）', async () => {
  await withServer(async ({ call }) => {
    const r = await call('/api/auth/me');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.user, null);
    assert.ok('user' in r.body, 'user 键必须存在（否则前端判断会分叉）');
  });
});

H.test('接口：登出销毁会话并清 cookie；登出后 me 回到 null', async () => {
  await withServer(async ({ call, stores }) => {
    const { cookie } = await registerUser(call, 'simon', 'me@example.com', 'a-good-password');
    assert.equal(stores.sessions.size, 1);
    const out = await call('/api/auth/logout', { method: 'POST', headers: { cookie }, body: '{}' });
    assert.equal(out.status, 200);
    assert.equal(out.body.destroyed, true);
    assert.match(out.cookie, /Max-Age=0/);
    assert.equal(stores.sessions.size, 0, '登出必须真删库里的会话');
    const me = await call('/api/auth/me', { headers: { cookie } });
    assert.equal(me.body.user, null);
    /* 未登录登出也回 200（不能把用户卡在"退不出去"） */
    const again = await call('/api/auth/logout', { method: 'POST', body: '{}' });
    assert.equal(again.status, 200);
    assert.equal(again.body.destroyed, false);
  });
});

H.test('接口：发评论需要登录，成功后列表升序可见，且白名单字段齐备', async () => {
  await withServer(async ({ call }) => {
    const anon = await call('/api/comments', { method: 'POST', body: JSON.stringify({ slug: 's1', content: 'hi' }) });
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error.code, 'UNAUTHENTICATED');

    const { cookie } = await registerUser(call, 'simon', 'me@example.com', 'a-good-password');
    const c1 = await call('/api/comments', { method: 'POST', headers: { cookie }, body: JSON.stringify({ slug: 's1', content: '  第一条  ' }) });
    assert.equal(c1.status, 201);
    assert.equal(c1.body.comment.content, '第一条');
    assert.equal(c1.body.comment.parent_id, null);
    assert.equal(c1.body.comment.author.username, 'simon');
    const c2 = await call('/api/comments', { method: 'POST', headers: { cookie }, body: JSON.stringify({ slug: 's1', content: '回复', parent_id: c1.body.comment.id }) });
    assert.equal(c2.status, 201);
    assert.equal(c2.body.comment.parent_id, c1.body.comment.id);

    const list = await call('/api/comments?slug=s1');
    assert.equal(list.status, 200);
    assert.equal(list.body.comments.length, 2);
    assert.ok(list.body.comments[0].id < list.body.comments[1].id, '必须升序（父先于回复）');
    for (const c of list.body.comments) {
      assert.deepEqual(Object.keys(c).sort(), ['author', 'content', 'created_at', 'id', 'parent_id']);
      assert.deepEqual(Object.keys(c.author).sort(), ['avatar', 'id', 'username']);
    }
    assert.ok(!/password_hash|password_algo|"email"|"user_id"/.test(list.text), '列表响应不得含敏感列');

    /* 缺 slug / 超长内容 / 非法 parent_id */
    const noSlug = await call('/api/comments', { method: 'POST', headers: { cookie }, body: JSON.stringify({ content: 'hi' }) });
    assert.equal(noSlug.body.error.code, 'INVALID_SLUG');
    const long = await call('/api/comments', { method: 'POST', headers: { cookie }, body: JSON.stringify({ slug: 's1', content: 'x'.repeat(2001) }) });
    assert.equal(long.body.error.code, 'INVALID_CONTENT');
    const badParent = await call('/api/comments', { method: 'POST', headers: { cookie }, body: JSON.stringify({ slug: 's1', content: 'hi', parent_id: 'abc' }) });
    assert.equal(badParent.body.error.code, 'INVALID_PARENT');
    /* 父评论属于别的文章 → 数据层拒绝 */
    const orphan = await call('/api/comments', { method: 'POST', headers: { cookie }, body: JSON.stringify({ slug: 'other', content: 'hi', parent_id: c1.body.comment.id }) });
    assert.equal(orphan.status, 422);
    assert.equal(orphan.body.error.code, 'INVALID_PARENT');
  });
});

H.test('接口：删除评论 —— 删自己 200、删别人 403、软删后列表不再返回、未登录 401', async () => {
  await withServer(async ({ call, stores }) => {
    const a = await registerUser(call, 'alice', 'alice@example.com', 'alice-password');
    const b = await registerUser(call, 'bob', 'bob@example.com', 'bob-password-1');
    const c = await call('/api/comments', { method: 'POST', headers: { cookie: a.cookie }, body: JSON.stringify({ slug: 's1', content: 'alice 的评论' }) });
    const id = c.body.comment.id;

    /* 未登录 → 401 */
    assert.equal((await call('/api/comments/' + id, { method: 'DELETE' })).status, 401);
    /* bob 删 alice 的 → 403，且评论仍在 */
    const forbidden = await call('/api/comments/' + id, { method: 'DELETE', headers: { cookie: b.cookie } });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'FORBIDDEN');
    assert.equal(stores.comments.get(id).status, 'approved', '越权删除不能改动数据');
    assert.equal((await call('/api/comments?slug=s1')).body.comments.length, 1);
    /* alice 删自己的 → 200 */
    const okDel = await call('/api/comments/' + id, { method: 'DELETE', headers: { cookie: a.cookie } });
    assert.equal(okDel.status, 200);
    assert.equal(okDel.body.deleted, id);
    /* 软删（不是物理删）且列表不再返回 */
    assert.equal(stores.comments.get(id).status, 'deleted');
    assert.equal(stores.comments.size, 1, '必须是软删，行还在');
    assert.equal((await call('/api/comments?slug=s1')).body.comments.length, 0);
    /* 再删一次 → 404 */
    assert.equal((await call('/api/comments/' + id, { method: 'DELETE', headers: { cookie: a.cookie } })).status, 404);
    /* 不存在的 id / 非法 id */
    assert.equal((await call('/api/comments/99999', { method: 'DELETE', headers: { cookie: a.cookie } })).status, 404);
    assert.equal((await call('/api/comments/mine', { method: 'DELETE', headers: { cookie: a.cookie } })).status, 404);
  });
});

H.test('接口：我的评论（mine）—— 只返回自己的、含 slug、路由不被 :id 抢走', async () => {
  await withServer(async ({ call }) => {
    const a = await registerUser(call, 'alice', 'alice@example.com', 'alice-password');
    const b = await registerUser(call, 'bob', 'bob@example.com', 'bob-password-1');
    await call('/api/comments', { method: 'POST', headers: { cookie: a.cookie }, body: JSON.stringify({ slug: 's1', content: 'a1' }) });
    await call('/api/comments', { method: 'POST', headers: { cookie: b.cookie }, body: JSON.stringify({ slug: 's2', content: 'b1' }) });

    const anon = await call('/api/comments/mine');
    assert.equal(anon.status, 401, 'mine 必须要求登录');
    const mine = await call('/api/comments/mine', { headers: { cookie: a.cookie } });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.comments.length, 1);
    assert.equal(mine.body.comments[0].content, 'a1');
    assert.equal(mine.body.comments[0].slug, 's1');
    assert.ok(!/password_hash|"email"/.test(mine.text));
  });
});

H.test('接口：登录限流落库 —— 第 11 次失败后 429 并带 Retry-After', async () => {
  await withServer(async ({ call, stores }) => {
    await registerUser(call, 'simon', 'me@example.com', 'a-good-password');
    let last = null;
    for (let i = 0; i < 11; i += 1) {
      last = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ user: 'simon', password: 'wrong-password' }) });
    }
    assert.equal(last.status, 429);
    assert.equal(last.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(last.headers.get('retry-after')) > 0, '429 必须带 Retry-After');
    /* 熔断生效时，连正确口令也拒（否则"猜对一次就重置计数"） */
    const goodButGated = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ user: 'simon', password: 'a-good-password' }) });
    assert.equal(goodButGated.status, 429);
    /* 计数确实落到 store（auth_throttle 语义） */
    assert.ok(stores.throttle.size > 0);
  });
});

H.test('接口：失败响应形状统一（顶层只有 ok 与 error）', async () => {
  await withServer(async ({ call, port }) => {
    const raws = [
      await call('/api/nope'),
      await call('/api/comments'),
      await call('/api/comments?slug='),
      await call('/api/auth/logout', { method: 'GET' }),
      await call('/api/auth/login', { method: 'POST', body: '{bad json' }),
      await call('/api/auth/login', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })
    ];
    for (const r of raws) {
      assert.equal(r.body.ok, false, JSON.stringify(r.body));
      assert.deepEqual(Object.keys(r.body), ['ok', 'error']);
      assert.deepEqual(Object.keys(r.body.error).sort(), ['code', 'message']);
    }
    assert.equal(raws[0].status, 404);
    assert.equal(raws[1].status, 422, '缺 slug → 422 INVALID_SLUG');
    assert.equal(raws[1].body.error.code, 'INVALID_SLUG');
    assert.equal(raws[2].status, 422);
    assert.equal(raws[3].status, 405);
    assert.equal(raws[4].body.error.code, 'INVALID_JSON');
    assert.equal(raws[5].body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
    /* 405 要带 Allow */
    assert.match(String(raws[3].headers.get('allow')), /POST/);
    void port;
  });
});

H.test('接口：来源判定 —— 跨源 Origin / 伪造 Host 一律 403', async () => {
  await withServer(async ({ port }) => {
    const cross = await fetch('http://127.0.0.1:' + port + '/api/auth/me', { headers: { origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);
    /* fetch 不允许自定义 Host，用裸 http 打 */
    const rebind = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/auth/me', method: 'GET', setHost: false, headers: { host: 'evil.example' } }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(rebind.status, 403);
    assert.equal(JSON.parse(rebind.body).error.code, 'FORBIDDEN');
  });
});

H.test('接口：请求体上限 1MB → 客户端真的收到 413 JSON（S6 回归闸）', async () => {
  await withServer(async ({ call, port, stores }) => {
    /* 先登录：请求体的读取发生在**授权之后**（顺序是从便宜到贵），
       未登录的 1MB 请求体根本没被读，直接 401 返回。 */
    const { cookie } = await registerUser(call, 'simon', 'me@example.com', 'a-good-password');
    assert.equal(stores.users.size, 1, '前置条件：注册已建号');
    const big = JSON.stringify({ slug: 's1', content: 'x'.repeat(1024 * 1024 + 4096) });

    /* 【这条断言的来历（审计 S6）】原来实现在判超限的同一 tick 里 req.destroy()，
       于是契约承诺的 413 JSON **永远送不到客户端**（curl 只看到
       "Empty reply from server"）。当时的测试用"连接被 reset 也算通过"的宽容分支
       掩盖了这一点 —— 那个分支已删除：现在**必须**读到 413 与结构化错误体，
       否则这条用例失败。实现侧改成 req.pause() + 发完响应后在 finish 里 socket.end()。 */
    const r = await rawSend(port, 'POST', '/api/comments',
      { host: '127.0.0.1:' + port, cookie, 'content-type': 'application/json' }, big);

    assert.equal(r.status, 413, '必须收到 413，而不是连接被重置');
    assert.equal(JSON.parse(r.body).error.code, 'BODY_TOO_LARGE');
    assert.equal(JSON.parse(r.body).ok, false);
    assert.equal(String(r.headers.connection), 'close', '发完 413 后要明确关连接');
  });
});

/* ============================================================
   九、启动路径：配置缺失必须拒绝启动
   ============================================================ */

const clearDbEnv = () => {
  const saved = {};
  for (const k of ALL_DB_KEYS.concat(['P3_SESSION_MAX_AGE_DAYS'])) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return saved;
};
const restoreEnv = (saved) => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};

H.test('启动：缺 P3_DB_* 时 createPublicApp 抛错并指名缺失项（绝不静默降级）', async () => {
  const saved = clearDbEnv();
  try {
    await assert.rejects(
      () => createPublicApp({ port: 0, log: false }),
      (e) => {
        assert.match(e.message, /缺少数据库配置/);
        assert.match(e.message, /P3_DB_HOST/);
        assert.match(e.message, /P3_DB_PASSWORD/);
        return true;
      }
    );
  } finally { restoreEnv(saved); }
});

H.test('启动：显式 --allow-degraded（骨架模式）才允许无库运行', async () => {
  const saved = clearDbEnv();
  try {
    const app = await createPublicApp({ port: 0, log: false, allowDegraded: true });
    assert.equal(app.mode, 'skeleton');
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const port = app.server.address().port;
    app.setPort(port);
    const me = await (await fetch('http://127.0.0.1:' + port + '/api/auth/me')).json();
    assert.equal(me.ok, true);
    assert.equal(me.user, null);
    assert.equal(me.db, 'down', '骨架模式必须自报 db=down，不能假装库是好的');
    const reg = await fetch('http://127.0.0.1:' + port + '/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'abc', email: 'a@b.com', password: '12345678' })
    });
    assert.equal(reg.status, 503);
    assert.equal((await reg.json()).error.code, 'DB_UNAVAILABLE');
    app.server.close();
    await app.close();
  } finally { restoreEnv(saved); }
});

H.test('模块载入：public-server.mjs 不 import 管理面（隔离边界）', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const self = fileURLToPath(new URL('../public-server.mjs', import.meta.url));
  const src = readFileSync(self, 'utf8');
  /* 只看真正的 import 语句（注释里出现"不 import dev-server.mjs"是允许的，
     而且那句注释正是这条约束的说明书）。 */
  const imports = src.split('\n').filter((l) => /^\s*(import|const\s+\w+\s*=\s*await\s+import)/.test(l));
  for (const line of imports) {
    assert.ok(!/dev-server/.test(line), '不得 import dev-server.mjs：' + line);
    assert.ok(!/lib\/auth\.mjs/.test(line), '不得 import 管理面 auth.mjs：' + line);
    assert.ok(!/posts-store/.test(line), '不得 import 文章存储：' + line);
  }
  /* 动态载入只允许我们自己的数据层 */
  assert.match(src, /new URL\('\.\/lib\/public\/store\.mjs', import\.meta\.url\)/);
  assert.ok(!/\.admin/.test(src.replace(/--allow-degraded/g, '')), '不得引用管理面运行时目录');
});

/* ============================================================
   十、代理信任与反代密钥（--trust-proxy / --proxy-secret-file）
   ------------------------------------------------------------
   这三态是 captain 追加的硬约束：开了 --trust-proxy 之后客户端 IP 来自
   X-Forwarded-For，而本机任何进程都能伪造它 —— 于是限流可被逐个假 IP 绕过，
   审计日志记假 IP。所以"没密钥 = 不信任 XFF"，而不是"没密钥 = 照样信任"。
   ============================================================ */

/** 取一次请求里服务端**实际采纳**的客户端 IP（由审计日志反查，不改产品代码） */
const observedIp = async (storesForIp) => {
  const rows = storesForIp.authLogRows;
  const last = rows[rows.length - 1];
  return last && last.ip;
};

/** 裸 HTTP 请求：需要自定义 Host / X-Forwarded-For / 精确控制方法时用它 */
const rawSend = (port, method, path, headers, body) => new Promise((resolve, reject) => {
  const payload = body == null ? null : Buffer.from(String(body), 'utf8');
  const h = Object.assign({}, headers);
  if (payload) h['content-length'] = String(payload.length);
  const req = http.request({ host: '127.0.0.1', port, path, method, setHost: false, headers: h }, (res) => {
    let out = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { out += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: out, headers: res.headers, cookie: res.headers['set-cookie'] }));
  });
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

const rawGet = (port, path, headers) => rawSend(port, 'GET', path, headers, null);

const RAW_HOST = (port) => ({ host: '127.0.0.1:' + port });

H.test('代理：无密钥时 --trust-proxy 被强制关闭，伪造 XFF 不被采纳', async () => {
  const stores = memoryStores();
  const app = await createPublicApp({
    port: 0, log: false, stores,
    trustProxy: true,          /* 调用方想要信任代理 */
    proxySecret: null,         /* 但没有密钥 */
    publicOrigins: ['http://127.0.0.1']
  });
  assert.equal(app.trustProxy, false, '没有密钥必须强制关闭代理信任');
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  app.setPort(port);
  try {
    /* 伪造 XFF：服务端应当忽略它，客户端 IP 仍记直连对端。
       用 POST /api/auth/logout（回 200 且**不需要登录**），它会写一条
       auth_log —— 于是我们能从审计里反查服务端实际采纳的 IP。 */
    const r = await rawSend(port, 'POST', '/api/auth/logout', Object.assign(RAW_HOST(port), {
      'x-forwarded-for': '203.0.113.77',
      'content-type': 'application/json'
    }), '{}');
    assert.equal(r.status, 200);
    const ip = await observedIp(stores);
    assert.equal(ip, '127.0.0.1', 'XFF 必须被忽略，实际记到的是 ' + ip);
    assert.notEqual(ip, '203.0.113.77');
  } finally {
    app.server.close();
    await app.close();
  }
});

H.test('代理：给了密钥 → 每个请求都要带正确密钥头，否则 403（且不说明原因）', async () => {
  const SECRET = 'a'.repeat(64);
  const stores = memoryStores();
  const app = await createPublicApp({
    port: 0, log: false, stores,
    trustProxy: true, proxySecret: SECRET,
    publicOrigins: ['http://127.0.0.1']
  });
  assert.equal(app.trustProxy, true, '有密钥时代理信任才生效');
  assert.equal(app.proxySecretConfigured, true);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  app.setPort(port);
  try {
    /* 不带密钥头 → 403 */
    const missing = await rawGet(port, '/api/auth/me', RAW_HOST(port));
    assert.equal(missing.status, 403);
    assert.equal(JSON.parse(missing.body).error.code, 'FORBIDDEN');
    /* 错密钥 → 403 */
    const wrong = await rawGet(port, '/api/auth/me', Object.assign(RAW_HOST(port), { 'x-admin-proxy-secret': 'b'.repeat(64) }));
    assert.equal(wrong.status, 403);
    /* 差一个字符也不行（定长比较，不是前缀匹配） */
    const near = await rawGet(port, '/api/auth/me', Object.assign(RAW_HOST(port), { 'x-admin-proxy-secret': SECRET.slice(0, 63) + 'b' }));
    assert.equal(near.status, 403);
    /* 正确密钥 → 放行 */
    const ok = await rawGet(port, '/api/auth/me', Object.assign(RAW_HOST(port), { 'x-admin-proxy-secret': SECRET }));
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).ok, true);
    /* 有密钥（= 已证明请求经过我们的 nginx）时 XFF 才被采纳，且只取最后一段 ——
       前几段是客户端自己写的，nginx 用 $proxy_add_x_forwarded_for 把真实对端
       追加在**最后**。这里用一次 register（会写 auth_log）来观察生效 IP。 */
    const reg = await rawSend(port, 'POST', '/api/auth/register', Object.assign(RAW_HOST(port), {
      'x-admin-proxy-secret': SECRET,
      'x-forwarded-for': '198.51.100.9, 203.0.113.77',
      'content-type': 'application/json'
    }), JSON.stringify({ username: 'proxied_user', email: 'p@example.com', password: 'a-good-password' }));
    assert.equal(reg.status, 201, reg.body);
    const ip = await observedIp(stores);
    assert.equal(ip, '203.0.113.77', 'XFF 只取最后一段（前段可伪造），实际 ' + ip);
    assert.match(String(reg.cookie), /^p3_uid=/, '注册成功时应下发会话 cookie');
  } finally {
    app.server.close();
    await app.close();
  }
});

H.test('代理：密钥文件缺失 / 为空 → CLI 拒绝启动（真实子进程）', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { join } = await import('node:path');
  const serverPath = fileURLToPath(new URL('../public-server.mjs', import.meta.url));
  const missing = join(fileURLToPath(new URL('.', import.meta.url)), 'no-such-proxy-secret-file-' + process.pid);
  const run = spawnSync(process.execPath, [serverPath, '--proxy-secret-file', missing], { encoding: 'utf8', timeout: 20000 });
  if (run.error && run.error.code === 'EPERM') {
    /* 受限沙箱禁止 spawn（见 harness.mjs 开头）。这是环境限制，不是被测行为失败；
       在正常机器上这段断言会真的执行。 */
    return;
  }
  assert.notEqual(run.status, 0, '读不到密钥文件必须拒绝启动');
  assert.match(String(run.stderr), /拒绝启动/);
  assert.match(String(run.stderr), /反代密钥/);
});

H.test('代理：CLI 的 --proxy-secret-file 解析存在，且与 --trust-proxy 同风格', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../public-server.mjs', import.meta.url)), 'utf8');
  assert.match(src, /value\('proxy-secret-file', ''\)/, '必须有 --proxy-secret-file 参数');
  assert.match(src, /flag\('trust-proxy'\)/);
  /* 密钥校验必须复用 lib/security.mjs（不要自己写一遍比较）：
     它在 http.mjs 的 assertPublicOrigin 里被调用。 */
  const httpSrc = readFileSync(fileURLToPath(new URL('../lib/public/http.mjs', import.meta.url)), 'utf8');
  assert.match(httpSrc, /security\.assertProxySecret\(req, o\.proxySecret\)/, '密钥校验必须走 lib/security.mjs');
  assert.ok(!/timingSafeEqual/.test(httpSrc), '不要在 http.mjs 里另写一套密钥比较');
  /* 密钥不能不 trim（编辑器/echo 常带尾换行） */
  assert.match(src, /readFile\(secretFile, 'utf8'\)\)\.trim\(\)/);
  /* 平台配置里是 --proxy-secret-file，不能写成 --proxy-secret */
  assert.ok(!/--proxy-secret[^-]/.test(src.replaceAll('--proxy-secret-file', '')), '参数名不要只写一半');
});

H.test('代理：告警文案必须说清"忽略了 XFF"（t17 会按它核）', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../public-server.mjs', import.meta.url)), 'utf8');
  assert.match(src, /警告：指定了 --trust-proxy 但没有 --proxy-secret-file/);
  assert.match(src, /X-Forwarded-For 一律忽略/);
  assert.match(src, /客户端 IP 取直连对端/);
  assert.match(src, /代理信任已\*\*强制关闭\*\*/);
});

/* ============================================================ */

/* 直接执行（node <file>）时用本进程内的 harness 跑完并给出退出码。
   `node --test` 下同样成立：runner 只判定"这个文件退出码是否为 0"。 */
if (isMain(import.meta.url)) {
  const r = await H.run();
  process.exit(r.fail ? 1 : 0);
}
