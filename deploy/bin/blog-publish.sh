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

# ------------------------------------------------------------
# 【安全闸】发了草稿就别发站点
# ------------------------------------------------------------
# 为什么这条是必须的，而不是"比较讲究"：
#   草稿的可见性判据是「?preview= 的值等于这篇的 slug」（见 js/article.js）。
#   而 slug 就写在**已发布的** js/posts.js 里 —— 任何人 curl 一下
#   /js/posts.js 就能拿到草稿的 slug，然后
#       /article.html?slug=<草稿>&preview=<草稿>
#   把全文读走。这不是"权限检查写错了"，而是**草稿本身不该出现在公开产物里**。
#
# 所以这里在发布前硬拦一道。想发就把那篇的「草稿」取消掉（管理页里能关）。
#
# 临时想跳过（例如用户明确知道自己在做什么，或要 publish 一份自己的备份）：
#   SKIP_DRAFT_CHECK=1 blog-publish
if [ "${SKIP_DRAFT_CHECK:-0}" != "1" ]; then
  draft_count="$(grep -cE "isDraft[[:space:]]*:[[:space:]]*true" "$SITE_DIR/js/posts.js" 2>/dev/null || true)"
  draft_count="${draft_count:-0}"
  if [ "${draft_count:-0}" -gt 0 ]; then
    echo "拒绝发布：js/posts.js 里有 $draft_count 篇标记为草稿的文章。" >&2
    echo "" >&2
    echo "  草稿必须留在你自己的机器上，不能进公开产物 —— 它的 slug 就在这份" >&2
    echo "  posts.js 里，任何人拿到 slug 就能用 ?preview=<slug> 读到全文。" >&2
    echo "" >&2
    echo "  处理：在管理页里把这几篇的「草稿」取消（或先删掉），再发布。" >&2
    echo "  确认要强行发布：SKIP_DRAFT_CHECK=1 blog-publish" >&2
    exit 4
  fi
fi

cd "$REPO_DIR"

# ------------------------------------------------------------
# 【防丢数据】服务器上不留"未提交的改动"被静默回退
# ------------------------------------------------------------
# 原来这里是 git reset --hard origin/$BRANCH —— 如果有人在服务器上（比如通过
# 公网管理页）改过 posts.js，这条会把改动**无声地丢掉**。现在改成：
#   · 工作区脏 → 明确报错，让人决定（提交 / 丢弃 / 手工处理）
#   · 干净 → 只做快进合并，绝不 reset
if [ -n "$(git status --porcelain)" ]; then
  echo "拒绝发布：$REPO_DIR 的工作区有未提交的改动。" >&2
  git status --short >&2
  echo "" >&2
  echo "  这些改动会被 git reset --hard 丢掉，所以先决定怎么处理：" >&2
  echo "    · 想保留   → git add -A && git commit -m \"...\"  然后重跑" >&2
  echo "    · 想丢弃   → git checkout -- .                   然后重跑" >&2
  exit 3
fi

git fetch --prune origin
# 只快进，不 reset：本地分支落后就前进，分叉或领先就报错让人看
git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH" "origin/$BRANCH"
if ! git merge --ff-only "origin/$BRANCH" >/dev/null 2>&1; then
  echo "拒绝发布：本地 $BRANCH 无法快进到 origin/$BRANCH（有本地提交或已分叉）。" >&2
  echo "  先在服务器上看 git log --oneline --graph --all，人工处理。" >&2
  exit 3
fi

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
# 两个踩过的坑，改法都写在下面：
#
# 1) **不要用 -a**。-a 含 -p -o -g，rsync 会去改站点目录（属主 www，不是
#    blog）的权限与属组；发布用户不是属主 → "chgrp ...: Operation not
#    permitted" 并以 exit 23 结束。这里只同步内容与文件时间，权限靠站点
#    目录的 setgid + umask 自然继承。
#
# 2) ***.md 必须用 "-s" 修饰符**（sender-side only）。普通 --exclude 在
#    接收端同时起"保护"作用：文件不上传，但也不许删。于是历史遗留的
#    ADMIN.md 永远删不掉，它所在的目录也就永远删不掉 —— 实测报
#    "cannot delete non-empty directory: blog-enter"，而那个目录里正好
#    残留着一份管理端文档、可被公网直接读取。-s 让排除规则只作用于发送端。
# ------------------------------------------------------------
rsync -rlt --omit-dir-times --delete \
  --filter='-s /server/' \
  --filter='-s /admin/' \
  --filter='-s /tests/' \
  --filter='-s /api/' \
  --filter='-s *.md' \
  --exclude '.admin/' \
  --exclude '.git*' \
  --exclude '.user.ini' \
  --exclude '.well-known/' \
  "$SITE_DIR/" "$WEB_ROOT/"

# 图片上传目录留出来（本地还没传过图时它不存在）
mkdir -p "$WEB_ROOT/img/uploads"

echo "published $(git -C "$REPO_DIR" rev-parse --short HEAD) ($(git -C "$REPO_DIR" log -1 --pretty=%s))"
echo "  -> $WEB_ROOT  at $(date -Is)"
