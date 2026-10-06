/* ============================================================
   口令哈希 —— PBKDF2-SHA256（公开面）
   ------------------------------------------------------------
   与管理面（lib/auth.mjs）用的是同一套参数：PBKDF2-SHA256、
   210000 轮、keylen 32、16 字节随机盐。刻意"沿用"而不是"另发明一套"：

     · 同一个站点上存在两套口令算法，只会让"我们的口令怎么存的"
       这个问题有两个答案，而其中一个迟早没人维护；
     · 210000 轮是管理面实测过的值，不是随手写的数字。

   与管理面的**区别**在于存储形态：管理面存 JSON（一个用户一份文件），
   公开面存一列字符串（一行用户一条记录），所以这里用自描述编码：

     pbkdf2-sha256$210000$<salt_b64>$<key_b64>

   自描述的三个好处：
     1) 以后换算法/换轮数时，老记录仍能被解析并校验（users.password_algo
        列是同一意图的备份说明）；
     2) 轮数与盐随记录走，"提高轮数"不需要任何数据迁移；
     3) 它是一列纯文本，不依赖任何编解码约定。

   纪律（写进代码就不靠记性）：
     · 明文口令与哈希**绝不**进日志、绝不进响应体；
     · 比较一律 timingSafeEqual（长度先比，不等就返回 false，
       避免 timingSafeEqual 对不等长抛错）；
     · 用户不存在时也要跑一次等价耗时的哈希 —— 见 dummyVerify()。
   ============================================================ */
import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../util.mjs';

/** 算法标识（与 users.password_algo 默认值一致） */
export const ALGO = 'pbkdf2-sha256';
/**
 * 迭代轮数。
 *
 * 【为什么从 210000 提到 600000】审计 S5：210000 是从管理面沿用下来的值，
 * 而 OWASP 对 PBKDF2-HMAC-SHA256 的现行建议是 600000 —— 库被拖走时，
 * 三倍之差等于把离线破解成本压低三倍。一致性不该把两边都钉在偏低的数值上。
 *
 * 本机实测（Node v24 单线程）：210000 ≈ 40ms、600000 ≈ 108–113ms、
 * 900000 ≈ 160ms、1200000 ≈ 225ms。取 600000 的理由：
 *   · 满足建议下限；
 *   · 服务器（Node v22、单核通常更快）单次校验远低于 300ms 的目标；
 *   · 登录峰值被两道限流（内存窗口 + auth_throttle）压住，CPU 可控。
 *
 * 灰度：轮数写在每一行的自描述串里，所以**改这个常量不需要数据迁移** ——
 * 老记录仍按记录里的轮数校验，成功后由 needsRehash() 判定并回写（rehashPassword）。
 */
export const ITERATIONS = 600_000;
/**
 * `=== ITERATIONS`（同一个值的别名导出）。
 *
 * 为什么两个名字都留：审计与部署侧的 verify 直接按 `PBKDF2_ITER = <数字>`
 * 读源码（t21 契约的 verify 就是这么写的），而这里一直叫 `ITERATIONS`。
 *
 * ⚠️ 这个字面量**必须等于上面 ITERATIONS**：工具的读取方式决定了它只能是字面量，
 * 不能写成 `export const PBKDF2_ITER = ITERATIONS;`（那样正则取到的是标识符、
 * 解析成 0）。所以它是一处**故意保留的重复**——测试里有一条断言把它们钉在一起，
 * 改了上面忘了下面会立刻红。
 */
export const PBKDF2_ITER = 600_000;
/** 派生密钥长度（字节） */
export const KEYLEN = 32;
/** 盐长度（字节） */
export const SALT_BYTES = 16;

const SEP = '$';

const derive = (pass, salt, iter, keylen) => new Promise((resolve, reject) => {
  pbkdf2(pass, salt, iter, keylen, 'sha256', (err, key) => (err ? reject(err) : resolve(key)));
});

/**
 * 生成口令哈希。
 * @param {string} plain 明文口令
 * @param {{ iterations?:number, salt?:Buffer }} [opts] 仅供测试注入固定盐
 * @returns {Promise<{ hash:string, algo:string, iterations:number }>}
 */
export const hashPassword = async (plain, opts = {}) => {
  const text = String(plain == null ? '' : plain);
  const iterations = Number(opts.iterations || ITERATIONS);
  const salt = opts.salt || randomBytes(SALT_BYTES);
  const key = await derive(text, salt, iterations, KEYLEN);
  return {
    hash: [ALGO, iterations, salt.toString('base64'), key.toString('base64')].join(SEP),
    algo: ALGO,
    iterations
  };
};

/**
 * 解析存储串。任何不合格式的输入都返回 null（**不抛错**）：
 * 这一层的调用方是"校验登录"，输错口令不该产生异常分支，
 * 更不该把"这一列坏了"变成 500 里的细节。
 */
export const parseHash = (stored) => {
  if (typeof stored !== 'string' || !stored.length) return null;
  const parts = stored.split(SEP);
  if (parts.length !== 4) return null;
  const [algo, iterRaw, saltB64, keyB64] = parts;
  if (algo !== ALGO) return null;
  const iterations = Number(iterRaw);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return null;
  let salt;
  let key;
  try {
    salt = Buffer.from(saltB64, 'base64');
    key = Buffer.from(keyB64, 'base64');
  } catch { return null; }
  if (!salt.length || !key.length) return null;
  return { algo, iterations, salt, key };
};

/**
 * 校验口令。
 * 存储串不可解析时返回 false（而不是抛错）—— 登录失败应该走
 * "用户名或密码不正确"这条统一路径，不能因为库里有一行坏数据
 * 就把这个账号的存在性暴露出来（500 与 401 的区别本身就是信息）。
 */
export const verifyPassword = async (plain, stored) => {
  const rec = parseHash(stored);
  if (!rec) return false;
  const got = await derive(String(plain == null ? '' : plain), rec.salt, rec.iterations, rec.key.length);
  if (got.length !== rec.key.length) return false;
  return timingSafeEqual(got, rec.key);
};

/** 一个固定的假哈希（盐与密钥都是常量，与任何真实账号无关） */
const DUMMY = [ALGO, ITERATIONS, 'cDMtZHVtbXktc2FsdA==', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='].join(SEP);

/**
 * 假校验：用户不存在 / 账号被禁用时，**照跑一次等价耗时的 PBKDF2** 再返回 false。
 *
 * 为什么必须做这一步：如果"用户不存在"直接 return false，那条路径会比
 * "密码错误"快两个数量级（PBKDF2 600000 轮要一百毫秒上下）。攻击者不用读响应体，
 * 只看响应时间就能把全站的用户名枚举一遍 —— 那样前面"文案不区分"的努力
 * 全部白费。这里跑的是固定盐上的真 PBKDF2，耗时与真校验同量级。
 */
export const dummyVerify = async (plain) => {
  await derive(String(plain == null ? '' : plain), Buffer.from('p3-dummy-salt'), ITERATIONS, KEYLEN);
  return false;
};

/**
 * 统一入口：给一个用户行或 null，返回 true/false。
 * HTTP/数据层都只调这一个，不各自判断"要不要跑假校验"。
 */
export const checkAgainstUser = async (plain, userRow, { stored = null } = {}) => {
  /* stored 允许调用方直接给哈希串（数据层已经取出那一列时省一次解引用） */
  const hash = stored || (userRow && userRow.password_hash) || null;
  if (!userRow || !hash) return dummyVerify(plain);
  const algo = (userRow && userRow.password_algo) || ALGO;
  if (algo !== ALGO) {
    /* 未知算法：不能装作"校验通过"，也不能暴露细节。跑假校验对齐耗时。 */
    return dummyVerify(plain);
  }
  return verifyPassword(plain, hash);
};

/** 参数校验（注册时用）。与 CONTRACT §1.2 一致：8 ≤ 长度 ≤ 200。 */
export const assertPasswordShape = (plain) => {
  if (typeof plain !== 'string' || !plain.length) throw new HttpError(422, '密码不能为空');
  if (plain.length < 8) throw new HttpError(422, '密码至少 8 个字符');
  if (plain.length > 200) throw new HttpError(422, '密码太长了（最多 200 个字符）');
  return plain;
};

/* ------------------------------------------------------------
   灰度升级（S5 的配套）
   ------------------------------------------------------------
   自描述串的好处在这里兑现：提高轮数**不需要**数据迁移。
   老记录用记录里的轮数校验（照旧能登录），成功之后再顺手重算一次并回写。
   ------------------------------------------------------------ */

/**
 * 这条记录是否需要按**当前**参数重算。
 *
 * 只在"已经验过口令"之后调用 —— 它只看参数，不看口令，
 * 所以绝不能拿它当校验结果用（那是把"轮数旧"误解成"口令对"）。
 */
export const needsRehash = (stored, { algo = ALGO, iterations = ITERATIONS } = {}) => {
  const rec = parseHash(stored);
  if (!rec) return false;                 // 坏了不该在这里"顺手修"，交由上层处理
  if (rec.algo !== algo) return true;     // 换了算法
  if (rec.iterations < iterations) return true;   // 轮数偏低
  /* 轮数高于当前值不动它：可能是有意加强过的账号，降回去是倒退。 */
  return false;
};

/**
 * 登录成功后按需重算并回写。
 *
 * @param {string} plain 明文口令（调用方已经用同一份验过一次）
 * @param {string} stored 旧记录
 * @param {(hash:string, algo:string)=>Promise<void>} persist 回写函数（由数据层提供）
 * @returns {Promise<boolean>} 是否发生了回写
 *
 * 回写失败**不影响**登录：用户已经证明了自己是本人，升级是我们的事，
 * 不该因为我们写库失败就把人挡在门外（下次登录再试）。
 */
export const rehashPassword = async (plain, stored, persist) => {
  if (!needsRehash(stored)) return false;
  const { hash, algo } = await hashPassword(plain);
  try {
    await persist(hash, algo);
    return true;
  } catch {
    return false;
  }
};
