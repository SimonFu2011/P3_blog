#!/usr/bin/env bash
# ============================================================
# 修仓库属主（含 .git）
# ------------------------------------------------------------
# 为什么需要它：
#   服务器上的 git 命令如果以 **root** 身份跑过（排查、reset、手工提交），
#   就会在 .git/objects 下留下 root 拥有的目录与对象。之后管理页保存触发的
#   自动提交是以 **blog** 身份跑的，它要在那些目录里创建新对象 ——
#   而目录是 root:root 755，写不进去：
#
#     error: insufficient permission for adding an object to
#            repository database .git/objects
#
#   症状很误导：文章其实**已经存进工作区**（保存返回 200），只是提交失败 →
#   工作区变脏 → 发布被"脏就报错"闸门拒绝 → **用户以为保存成功了但站点没变**。
#
# 用法（服务器上 root）：
#   bash /srv/blog/repo/deploy/bin/fix-repo-ownership.sh
#   # 只检查不改：
#   CHECK_ONLY=1 bash .../fix-repo-ownership.sh
# ============================================================
set -euo pipefail

REPO_DIR="${REPO_DIR:-/srv/blog/repo}"
OWNER="${OWNER:-blog}"
CHECK_ONLY="${CHECK_ONLY:-0}"

[ -d "$REPO_DIR/.git" ] || { echo "找不到仓库：$REPO_DIR" >&2; exit 1; }

echo "仓库：$REPO_DIR    期望属主：$OWNER"
echo ""
echo "不属于 $OWNER 的文件（前 10 个）："
find "$REPO_DIR" ! -user "$OWNER" 2>/dev/null | head -10 | sed 's/^/  /'
n="$(find "$REPO_DIR" ! -user "$OWNER" 2>/dev/null | wc -l)"
echo "  合计：$n 个"

if [ "$n" = "0" ]; then
  echo ""
  echo "已经干净，无需修改。"
  exit 0
fi

if [ "$CHECK_ONLY" = "1" ]; then
  echo ""
  echo "（CHECK_ONLY=1，只检查不修改）"
  exit 1
fi

echo ""
echo "修属主中…"
chown -R "$OWNER:$OWNER" "$REPO_DIR"
echo "  剩余不属于 $OWNER 的：$(find "$REPO_DIR" ! -user "$OWNER" 2>/dev/null | wc -l) 个"

echo ""
echo "复验：以 $OWNER 身份能否提交"
sudo -u "$OWNER" bash -c "cd '$REPO_DIR' && git status --porcelain >/dev/null" \
  && echo "  ✓ git 可用" || echo "  ✗ git 仍不可用"
