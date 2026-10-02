/* ============================================================
   备份与回收站
   ------------------------------------------------------------
   写 posts.js 之前**一定**先备份一份旧文件。
   这不是"锦上添花的保险"，而是这个方案能放心自动改写源码的前提：
   任何一次写坏都能在 .admin/backups/ 里找回上一版，与 git 互为冗余
   （git 只保护已提交的内容，未提交的改动只有这里能救）。

   删除文章不真删：搬进 .admin/trash/，误删可以直接复制回去。
   ============================================================ */
import { mkdir, readdir, stat, copyFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { stamp, safeJoin } from './util.mjs';

export const BACKUP_KEEP = 20;

export const ensureDirs = async (runtimeDir) => {
  await mkdir(join(runtimeDir, 'backups'), { recursive: true });
  await mkdir(join(runtimeDir, 'trash'), { recursive: true });
};

/**
 * 备份一个文件。返回备份路径（没成功也不抛 —— 备份失败不该让保存流程
 * 直接崩掉，但调用方会拿到 null 并据此提示，见 server 里的处理）。
 */
export const backupFile = async (runtimeDir, file, tag) => {
  try {
    const dir = join(runtimeDir, 'backups');
    await mkdir(dir, { recursive: true });
    const name = (tag || 'posts') + '-' + stamp() + '.js';
    const dest = safeJoin(dir, name);
    await copyFile(file, dest);
    return dest;
  } catch {
    return null;
  }
};

/** 滚动保留最近 BACKUP_KEEP 份（按文件名里的时间戳排序，后缀带 tag） */
export const rotateBackups = async (runtimeDir, tag) => {
  try {
    const dir = join(runtimeDir, 'backups');
    const prefix = (tag || 'posts') + '-';
    const files = (await readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith('.js'));
    files.sort();
    const excess = files.slice(0, Math.max(0, files.length - BACKUP_KEEP));
    for (const f of excess) {
      try { await unlink(join(dir, f)); } catch { /* 被占用就下次再说 */ }
    }
    return { kept: files.length - excess.length, removed: excess.length };
  } catch {
    return { kept: 0, removed: 0 };
  }
};

/** 列出备份（新的在前），带大小与时间 */
export const listBackups = async (runtimeDir, tag) => {
  const dir = join(runtimeDir, 'backups');
  const prefix = (tag || 'posts') + '-';
  try {
    const files = (await readdir(dir)).filter((f) => f.startsWith(prefix));
    files.sort().reverse();
    const out = [];
    for (const f of files) {
      const st = await stat(join(dir, f));
      out.push({ name: f, bytes: st.size, at: st.mtime.toISOString() });
    }
    return out;
  } catch {
    return [];
  }
};

/**
 * 把一篇文章的源码搬进回收站。
 * 文件名里带上 slug 与时间戳，方便人肉找回。
 */
export const trashContent = async (runtimeDir, slug, content) => {
  const dir = join(runtimeDir, 'trash');
  await mkdir(dir, { recursive: true });
  const name = stamp() + '-' + String(slug).replace(/[^a-z0-9-]/gi, '_') + '.js';
  const dest = safeJoin(dir, name);
  await writeFile(dest, content, { mode: 0o600 });
  return dest;
};

export const listTrash = async (runtimeDir) => {
  const dir = join(runtimeDir, 'trash');
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.js'));
    files.sort().reverse();
    const out = [];
    for (const f of files) {
      const st = await stat(join(dir, f));
      out.push({ name: f, bytes: st.size, at: st.mtime.toISOString() });
    }
    return out;
  } catch {
    return [];
  }
};
