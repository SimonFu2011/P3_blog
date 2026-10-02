/* ============================================================
   git 操作（白名单）
   ------------------------------------------------------------
   管理页上的"提交"按钮需要一个能跑 git 的地方。这里的三条纪律：

     · 子命令走**白名单**，参数只以数组形式传递（spawn 不过 shell），
       所以提交信息里就算有 `"`、`;`、`$(...)` 也伤不到任何东西。
     · 路径永远是仓库内固定的几条（js/posts.js 与 img/uploads），
       不接受调用方传任意路径。
     · 每个命令都有超时与输出上限：git 卡住不能拖住整个服务。
   ============================================================ */
import { spawn } from 'node:child_process';
import { HttpError, safeJoin } from './util.mjs';

const ALLOWED = new Set(['status', 'add', 'commit', 'rev-parse', 'log', 'diff', 'ls-files']);
const TIMEOUT_MS = 15000;
const MAX_OUTPUT = 256 * 1024;

/**
 * 跑一条 git 命令。**永不 reject**：git 不存在、被环境策略挡住（受限沙箱里
 * spawn 会 EPERM）、超时、非零退出，统统变成 {code:-1, out:'', err}。
 *
 * 这一点很重要：git 只是"方便按钮"，不是功能前提。
 * 它不可用时，管理页应该照常能改文章，只是"提交"那块显示"当前环境用不了 git"，
 * 而不是让 /api/session 直接 500 —— 一个可选能力把核心能力带崩是最典型的
 * 依赖倒置。
 */
const run = (args, cwd) => new Promise((resolve) => {
  if (!ALLOWED.has(args[0])) {
    resolve({ code: -1, out: '', err: 'git 子命令不在白名单里：' + args[0] });
    return;
  }
  let child;
  try {
    child = spawn('git', args, {
      cwd,
      windowsHide: true,
      /* 关键：不继承环境里可能存在的 GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE，
         否则一个被污染的环境就能让"提交"提交到别处去。 */
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        COMSPEC: process.env.COMSPEC,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LANG: 'C.UTF-8'
      }
    });
  } catch (err) {
    resolve({ code: -1, out: '', err: 'git 无法启动：' + err.message });
    return;
  }

  let out = '';
  let errOut = '';
  let settled = false;
  const done = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };

  const timer = setTimeout(() => {
    try { child.kill(); } catch { /* 已经退了 */ }
    done({ code: -1, out, err: 'git 超时（' + TIMEOUT_MS + 'ms）：' + args[0] });
  }, TIMEOUT_MS);

  const cap = (chunk, which) => {
    if (which === 'out') out = (out + chunk).slice(0, MAX_OUTPUT);
    else errOut = (errOut + chunk).slice(0, MAX_OUTPUT);
  };
  if (child.stdout) child.stdout.on('data', (d) => cap(d.toString('utf8'), 'out'));
  if (child.stderr) child.stderr.on('data', (d) => cap(d.toString('utf8'), 'err'));

  child.on('error', (err) => done({ code: -1, out, err: 'git 执行失败：' + err.message }));
  child.on('close', (code) => done({ code, out, err: errOut }));
});

/* 一次进程内缓存"这个目录到底能不能用 git"：
   受限环境下每次请求都去试一次 spawn 既慢又会在日志里刷 500 噪声。 */
const repoCache = new Map();

/** 是不是一个可用的 git 仓库；用不了就 false（而不是抛错） */
export const isRepo = async (cwd) => {
  if (repoCache.has(cwd)) return repoCache.get(cwd);
  const r = await run(['rev-parse', '--is-inside-work-tree'], cwd);
  const usable = r.code === 0 && /true/.test(r.out);
  repoCache.set(cwd, usable);
  return usable;
};

/** 明确的"git 不可用"结果，供路由层原样返回 */
const UNAVAILABLE = {
  repo: false,
  available: false,
  branch: '',
  commits: null,
  dirty: [],
  dirtyCount: 0,
  clean: true,
  reason: '当前环境里 git 不可用（未安装、或进程被策略限制）'
};

export const status = async (cwd) => {
  if (!(await isRepo(cwd))) return Object.assign({}, UNAVAILABLE);
  const branchRes = await run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const countRes = await run(['rev-list', '--count', 'HEAD'], cwd);
  const statusRes = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);

  const entries = statusRes.out.split('\0').filter(Boolean).map((line) => ({
    code: line.slice(0, 2),
    path: line.slice(3)
  }));

  return {
    repo: true,
    available: true,
    branch: branchRes.code === 0 ? branchRes.out.trim() : '',
    commits: countRes.code === 0 ? Number(countRes.out.trim()) : null,
    dirty: entries.slice(0, 200),
    dirtyCount: entries.length,
    clean: entries.length === 0
  };
};

/** 最近若干条提交（只读，用于管理页展示"上次提交了什么"） */
export const log = async (cwd, n) => {
  const count = Math.max(1, Math.min(20, Number(n) || 5));
  const r = await run(['log', '--pretty=format:%h%x1f%ad%x1f%s', '--date=short', '-' + count], cwd);
  if (r.code !== 0) return [];
  return r.out.split('\n').filter(Boolean).map((line) => {
    const [hash, date, subject] = line.split('\x1f');
    return { hash, date, subject };
  });
};

/**
 * 提交指定路径。msg 只作为 -m 的参数（不过 shell）；
 * 路径必须落在仓库内 —— safeJoin 会挡住 "..\.." 这类。
 */
export const commit = async (cwd, repoRoot, relPaths, msg) => {
  const message = String(msg || '').trim().slice(0, 200) || 'chore(blog-enter): 更新文章';
  if (/[\r\n]/.test(message)) throw new HttpError(422, '提交信息不能包含换行');

  if (!(await isRepo(cwd))) {
    throw new HttpError(503, '当前环境里 git 不可用，请改在终端里手动 git add / git commit');
  }

  const paths = (relPaths || []).map((p) => safeJoin(repoRoot, p));
  if (!paths.length) throw new HttpError(422, '没有要提交的路径');

  const add = await run(['add', '--'].concat(paths), cwd);
  if (add.code !== 0) throw new HttpError(500, 'git add 失败：' + (add.err || add.out).trim());

  /* 先看有没有东西被暂存：没有的话 git commit 会以非 0 退出，
     但那不是错误，只是"没变化"。 */
  const staged = await run(['diff', '--cached', '--name-only'], cwd);
  if (!staged.out.trim()) {
    return { ok: false, reason: 'no-changes', detail: '没有检测到需要提交的改动' };
  }

  const res = await run(['commit', '-m', message], cwd);
  if (res.code !== 0) {
    throw new HttpError(500, 'git commit 失败：' + (res.err || res.out).trim().slice(0, 400));
  }
  const hash = await run(['rev-parse', '--short', 'HEAD'], cwd);
  return {
    ok: true,
    hash: hash.out.trim(),
    message,
    files: staged.out.split('\n').filter(Boolean).slice(0, 100)
  };
};

export const openInEditorHint = (cwd) => '在 ' + cwd + ' 下执行 git push 即可发布';
