/* ============================================================
   共享工具 —— 路径约束 / 原子写 / 文件哈希 / 常量时间比较
   ------------------------------------------------------------
   这个文件里的每个函数都是为了回答同一个问题：
   "这个来自 HTTP 请求的字符串，会不会被用来拼一条文件路径？"
   凡是会拼路径的地方，都必须走 here() / assertInside()，
   不接受任何"调用方自己保证"。

   约定：本站零依赖，只用 node: 内置模块。
   ============================================================ */
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { open, rename, unlink, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

/* ------------------------------------------------------------
   路径
   ------------------------------------------------------------ */

/** 把若干片段拼成绝对路径（不做校验，仅拼接） */
export const here = (...parts) => resolve(...parts);

/**
 * 断言 child 落在 root 之内（含等于），否则抛错。
 * 用 path.relative 判断而不是 startsWith：后者会被
 *   root = 'D:\\DS\\blog-enter'、child = 'D:\\DS\\blog-enter-evil'
 * 这种前缀相同、实际是兄弟目录的路径骗过去。
 */
export const assertInside = (root, child) => {
  const r = resolve(root);
  const c = resolve(child);
  const rel = relative(r, c);
  if (rel === '') return c;
  if (rel.startsWith('..') || rel.split(sep)[0] === '..' || /^[A-Za-z]:/.test(rel)) {
    throw new HttpError(403, 'path escapes root');
  }
  return c;
};

/** 安全拼路径：join + 越界断言，一步到位 */
export const safeJoin = (root, ...parts) => assertInside(root, join(root, ...parts));

/* ------------------------------------------------------------
   错误
   ------------------------------------------------------------ */

/** 带 HTTP 状态码的错误。路由层只认这个类型，其余一律 500 且不外泄细节。 */
export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (extra) this.extra = extra;
  }
}

/* ------------------------------------------------------------
   哈希 / 比较
   ------------------------------------------------------------ */

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * 常量时间字符串比较。
 * 先各自 sha256 再比 —— 这样长度不同也不会因为 timingSafeEqual 抛错，
 * 而且比较耗时与两者长度无关。
 */
export const safeEqual = (a, b) => {
  const ha = createHash('sha256').update(String(a), 'utf8').digest();
  const hb = createHash('sha256').update(String(b), 'utf8').digest();
  return timingSafeEqual(ha, hb);
};

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('hex');

/* ------------------------------------------------------------
   文件读写
   ------------------------------------------------------------ */

/** 原子写：写同目录临时文件 → fsync → rename 覆盖。失败时原文件不受影响。 */
export const writeFileAtomic = async (file, data) => {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + randomToken(4) + '.tmp';
  let fh = null;
  try {
    fh = await open(tmp, 'wx', 0o600);
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = null;
    await rename(tmp, file);
  } catch (err) {
    if (fh) { try { await fh.close(); } catch { /* 已经坏了，忽略 */ } }
    try { await unlink(tmp); } catch { /* 临时文件可能没建成 */ }
    throw err;
  }
};

/** 读文件，不存在返回 null（不把 ENOENT 混进真正的错误里） */
export const readFileOrNull = async (file) => {
  try { return await readFile(file, 'utf8'); }
  catch (err) { if (err && err.code === 'ENOENT') return null; throw err; }
};

/** 时间戳，用于备份/垃圾桶文件名：2026-02-14T09-31-07-123Z */
export const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-');

/* ------------------------------------------------------------
   杂项
   ------------------------------------------------------------ */

/** 每行加前缀，用于生成带缩进的源码 */
export const indent = (text, pad) => String(text).split('\n').map((l) => (l ? pad + l : l)).join('\n');

/** 字节数友好显示 */
export const human = (n) => {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
};

/** 结构化深拷贝（只处理 JSON 可表达的值，够用且没有意外） */
export const clone = (v) => JSON.parse(JSON.stringify(v));
