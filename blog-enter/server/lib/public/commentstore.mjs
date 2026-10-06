/* ============================================================
   评论数据层（公开面）
   ------------------------------------------------------------
   三条硬约束在这里落地，每一条都对应一种真实攻击或真实 bug：

   1) **只读 approved**：软删（status='deleted'）与待审（'pending'）
      都不返回。查询固定是
        WHERE slug = ? AND status = 'approved' ORDER BY created_at ASC, id ASC
      正好命中 idx_comments_slug_status_created (slug, status, created_at)：
      左边两列等值、第三列有序 → 过滤与排序一个索引搞定。
      （ASC 与 DESC 走同一个 B-tree，只是扫描方向不同；选 ASC 是为了
       父评论先于回复出现，前端按 parent_id 分层渲染才不会错位。）

   2) **越权在服务端判定**：markCommentDeleted 在 UPDATE 的 WHERE 里
      同时带上 user_id 或 role='admin'，不存在"先查再改"的窗口。
      前端隐藏删除按钮只是体验，不是控制。

   3) **输出白名单在 HTTP 层**（http.mjs 的 publicComment()）：
      这里查什么列都行，但响应体只从固定几个字段构造 —— 所以
      password_hash 与 email 没有机会跟着行数据流出去。
   ============================================================ */
import { fail } from './http.mjs';

/** 一条文章最多返回多少条评论（防止热门文章把整表拉给浏览器） */
export const LIST_LIMIT = 500;
/** 「我的评论」上限 */
export const MINE_LIMIT = 200;

/* 【本轮不做评论审核（审计 S9）】
   schema 的 status ENUM('approved','pending','deleted') 留了 pending 这一档，
   但**没有**任何入口写它 —— 这是刻意的：先审后发需要管理端审核入口，
   本轮没有；而默认把新评论写成 pending 会让它们从公开列表里静默消失
   （用户看到的是"我发了但没显示"），比垃圾评论更糟。
   所以写入状态就是 schema 默认的 'approved'；审核能力与运维动作
   （发现滥用就临时关闭注册、或由 DBA 手工改 status）记录在
   AUDIT-public-login.md 的 S9 条目里。 */


/* 取评论 + 作者：INNER JOIN 是刻意的 —— comments.user_id 非空且有外键，
   不存在"没有作者的评论"，用它顺便证明这一点。 */
const SELECT_BASE = 'SELECT c.id, c.slug, c.user_id, c.parent_id, c.content, c.status, c.created_at, '
  + 'u.username, u.avatar '
  + 'FROM comments c INNER JOIN users u ON u.id = c.user_id ';

/**
 * 按 slug 取已通过的评论（升序：父评论先于它的回复）。
 * 只返回 approved 的行 —— 软删的行不在这里过滤，而是在 SQL 里过滤，
 * 这样"删掉的评论不再出现"是数据库保证的，而不是靠调用方记得再筛一次。
 */
export const listComments = async (db, slug, { limit = LIST_LIMIT } = {}) => {
  const sql = SELECT_BASE
    + "WHERE c.slug = ? AND c.status = 'approved' "
    + 'ORDER BY c.created_at ASC, c.id ASC LIMIT ?';
  const [rows] = await db.execute(sql, [String(slug), Number(limit)]);
  return rows;
};

/**
 * 「我的评论」：按用户取，**降序**（"我最近说了什么"最新在前），另带 slug 用来跳回文章。
 * 只取 approved（软删的与未审核的都不出现；本轮没有 pending 写入路径，见文件头说明）。
 */
export const listCommentsByUser = async (db, userId, { limit = MINE_LIMIT } = {}) => {
  const sql = SELECT_BASE
    + "WHERE c.user_id = ? AND c.status = 'approved' "
    + 'ORDER BY c.created_at DESC, c.id DESC LIMIT ?';
  const [rows] = await db.execute(sql, [Number(userId), Number(limit)]);
  return rows;
};

/**
 * 插入评论。
 *
 * parent_id 的合法性必须在**这里**用 SQL 判定，不能只信请求体：
 * 前端可以传任意 id 过来，其中可能是别的文章下的评论，甚至是已软删的。
 * 校验条件（存在 + approved + 同 slug）三者缺一不可 ——
 * 否则"回复"会变成一种把内容挂到别人文章下的手段。
 */
export const createComment = async (db, { slug, userId, parentId = null, content }) => {
  const s = String(slug);
  const uid = Number(userId);
  const pid = parentId == null ? null : Number(parentId);

  if (pid != null) {
    const [rows] = await db.execute(
      "SELECT id FROM comments WHERE id = ? AND slug = ? AND status = 'approved' LIMIT 1",
      [pid, s]
    );
    if (!rows.length) throw fail('INVALID_PARENT', '要回复的评论不存在或不属于这篇文章');
  }

  /* 不写 status 列：让 schema 的默认值 'approved' 生效（S9 本轮不做审核，见文件头）。
     显式传值反而会多一个"能不能从外部改状态"的入口，不需要。 */
  const sql = 'INSERT INTO comments (slug, user_id, parent_id, content) VALUES (?, ?, ?, ?)';
  const [res] = await db.execute(sql, [s, uid, pid, String(content)]);
  const id = Number(res.insertId);
  const [rows] = await db.execute(SELECT_BASE + 'WHERE c.id = ? LIMIT 1', [id]);
  if (!rows.length) throw fail('DB_UNAVAILABLE', '评论写入后读不回来');
  return rows[0];
};

/**
 * 取一条评论用于删除判定（**含**已软删的行）。
 *
 * 为什么不过滤 status：HTTP 层要靠"这行存在但 status='deleted'"来
 * 区分 404（没有）与"已经有了但你看不到"的幂等语义；而且软删的行
 * 仍然占用 id，直接说"不存在"会让人以为 id 可以复用。
 */
export const commentForDelete = async (db, id) => {
  const sql = 'SELECT c.id, c.slug, c.user_id, c.parent_id, c.status FROM comments c WHERE c.id = ? LIMIT 1';
  const [rows] = await db.execute(sql, [Number(id)]);
  return rows.length ? rows[0] : null;
};

/**
 * 软删评论，**在 UPDATE 的 WHERE 里**完成授权判定。
 *
 * 为什么授权写在 SQL 而不是"先 SELECT 判断、再 UPDATE"：
 * 那两句话之间存在时间窗口（TOCTOU），而且判定逻辑会被复制到每个调用点。
 * 放在 WHERE 里之后，服务端只有一种可能：
 *     rows.affectedRows === 1 → 删成功（说明这行确实是本人的，或者是 admin 在删）
 *     rows.affectedRows === 0 → 没删成（不是本人的行）
 * 于是 HTTP 层的那句 403 就有了不可绕过的依据。
 */
export const markCommentDeleted = async (db, id, { byUserId, byRole } = {}) => {
  const isAdmin = byRole === 'admin';
  const sql = isAdmin
    ? "UPDATE comments SET status = 'deleted' WHERE id = ? AND status <> 'deleted'"
    : "UPDATE comments SET status = 'deleted' WHERE id = ? AND user_id = ? AND status <> 'deleted'";
  const params = isAdmin ? [Number(id)] : [Number(id), Number(byUserId)];
  const [res] = await db.execute(sql, params);
  return Number(res.affectedRows) > 0;
};

/** 某篇文章的评论数（自检与后台治理用；只数 approved） */
export const countComments = async (db, slug) => {
  const [rows] = await db.execute("SELECT COUNT(*) AS n FROM comments WHERE slug = ? AND status = 'approved'", [String(slug)]);
  return Number((rows[0] && rows[0].n) || 0);
};
