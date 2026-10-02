#!/usr/bin/env bash
# ============================================================
# 发布：把仓库里的公开产物同步到 nginx 的根目录
# ------------------------------------------------------------
# 服务器上执行（引导脚本会把它装到 /usr/local/bin/blog-publish）：
#     sudo -u blog blog-publish
#
# 服务器是**只读镜像**：不做本地修改，每次直接对齐 origin/<branch>。
# 想改内容请在本地管理页改完 push，不要在服务器上动文件。
#
# 可用环境变量覆盖：
#   REPO_DIR=/srv/blog/repo   WEB_ROOT=/var/www/blog   BRANCH=main
# ============================================================
set -euo pipefail

REPO_DIR="${REPO_DIR:-/srv/blog/repo}"
WEB_ROOT="${WEB_ROOT:-/var/www/blog}"
BRANCH="${BRANCH:-main}"
SITE_DIR="$REPO_DIR/blog-enter"

[ -d "$REPO_DIR/.git" ]  || { echo "找不到 git 仓库：$REPO_DIR" >&2; exit 1; }
[ -d "$SITE_DIR" ]       || { echo "找不到站点目录：$SITE_DIR" >&2; exit 1; }
command -v rsync >/dev/null || { echo "缺少 rsync" >&2; exit 1; }

cd "$REPO_DIR"

git fetch --prune origin
# -B 把本地分支强制对齐到远端；reset 再兜一次（服务器上不留本地修改）
git checkout -q -B "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"

# mkdir -p 而不是 install -d：站点目录属主是 www，发布用户 blog 无权 chmod 它，
# install -d 会对已存在的目录做 chmod 而以 EPERM 失败。
mkdir -p "$WEB_ROOT"

# ------------------------------------------------------------
# 排除清单 == "什么算公开产物"的定义
#   server/  本地服务（只绑 127.0.0.1）与测试
#   admin/   管理页 UI
#   tests/   测试
#   *.md     文档，含 ADMIN.md
#   .admin/  运行时数据（会话令牌 / 口令哈希 / 备份 / 回收站）
#   .user.ini / .well-known/  —— 面板生成的站点文件与证书续期验证目录，
#                                不属于仓库内容，别让 --delete 抹掉
# --delete 让 web 根目录与仓库严格一致（多余文件会被清掉）。
#
# 权限用 D2775：目录带 setgid 并给组写权限。
#   · 普通 nginx 部署：根目录 blog:www-data，nginx 只读即可；
#   · 宝塔面板部署：根目录必须是 www:www，发布用户 blog 靠 www 组拿到写权限。
#   两种场景下 setgid 都无害，所以统一用这一套。
# ------------------------------------------------------------
rsync -a --delete --chmod=D2775,F644 \
  --exclude '/server/' \
  --exclude '/admin/' \
  --exclude '/tests/' \
  --exclude '*.md' \
  --exclude '.admin/' \
  --exclude '.git*' \
  --exclude '.user.ini' \
  --exclude '.well-known/' \
  "$SITE_DIR/" "$WEB_ROOT/"

# 图片上传目录留出来（本地还没传过图时它不存在）
mkdir -p "$WEB_ROOT/img/uploads"

echo "published $(git -C "$REPO_DIR" rev-parse --short HEAD) ($(git -C "$REPO_DIR" log -1 --pretty=%s))"
echo "  -> $WEB_ROOT  at $(date -Is)"
