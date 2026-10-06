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

# "内容"文件的白名单：只有这些会被自动提交。
# 代码（dev-server.mjs / blog-publish.sh 等）不在此列 —— 那些改动应该由人
# review 后提交，不该被一个由 HTTP 请求触发的自动流程吞掉。
#
# 必须是**数组**：git 的 pathspec 参数是分开传的。写成
#   CONTENT_PATHS="a b"
#   git status --porcelain -- "$CONTENT_PATHS"
# 会把 "a b" 当成**一个**路径（含空格），永远匹配不到任何文件 ——
# 于是自动提交被静默跳过，发布又因为"工作区脏"被拒。这个坑踩过一次。
CONTENT_PATHS=(blog-enter/js/posts.js blog-enter/img/uploads)

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
# 【内容先落提交】让"保存即上线"真的能跑通
# ------------------------------------------------------------
# 背景：管理页保存时**只写文件，不提交**（服务器的 git 身份/凭据不该被一个
# HTTP 进程持有）。而下面那道"工作区脏就拒绝发布"的闸门是必须的 —— 它能防住
# `git reset`/`checkout` 把服务器上的改动无声丢掉。
# 两者撞在一起的结果是：每次保存后自动发布都会以"工作区脏"失败。
#
# 所以中间这一步必须有：**把"内容"文件自动提交**，让工作区变干净。
# 只提交内容（posts.js 与上传的图片）—— 代码文件（dev-server.mjs 等）保持
# "脏就报错"，那些应该由人 review 后再提交，不该被一个自动流程吞掉。
if [ "${AUTO_COMMIT_CONTENT:-1}" = "1" ]; then
  content_changed="$(git status --porcelain -- "${CONTENT_PATHS[@]}" 2>/dev/null || true)"
  if [ -n "$content_changed" ]; then
    echo "  检测到内容改动，自动提交（只提交内容文件）："
    echo "$content_changed" | sed 's/^/    /'
    git add -- "${CONTENT_PATHS[@]}"
    git -c user.name="blog-publish" -c user.email="blog-publish@localhost" \
        commit -q -m "content: 管理页保存于 $(date -Is)" || echo "  （提交失败，继续尝试发布）"
    echo "  -> $(git rev-parse --short HEAD) $(git log -1 --pretty=%s)"
  fi
fi

# ------------------------------------------------------------
# 【防丢数据】服务器上不留"未提交的改动"被静默回退
# ------------------------------------------------------------
# 原来这里是 git reset --hard origin/$BRANCH —— 如果有人在服务器上（比如通过
# 公网管理页）改过 posts.js，这条会把改动**无声地丢掉**。现在改成：
#   · 工作区脏 → 明确报错，让人决定（提交 / 丢弃 / 手工处理）
#   · 干净 → 只做快进合并，绝不 reset
if [ -n "$(git status --porcelain)" ]; then
  echo "拒绝发布：$REPO_DIR 的工作区有未提交的改动（且不在内容文件白名单里）。" >&2
  git status --short >&2
  echo "" >&2
  echo "  这些改动会被 git reset 丢掉，所以先决定怎么处理：" >&2
  echo "    · 想保留   → git add -A && git commit -m \"...\"  然后重跑" >&2
  echo "    · 想丢弃   → git checkout -- .                   然后重跑" >&2
  echo "    · 是内容   → 把它们加进本脚本的 CONTENT_PATHS 白名单" >&2
  exit 3
fi

# ------------------------------------------------------------
# 【不要因为连不上 GitHub 就什么都不发布】
# ------------------------------------------------------------
# 服务器常常连不上 GitHub（国内网络、只走 SSH、或纯手工同步）。
# 原来 fetch/checkout/reset 三连在 set -e 下任何一步失败都会让脚本**提前退出**，
# 结果是"rsync 根本没跑"，管理页保存后表现成"发布失败"。
# 现在：git 只是"尽力把代码对齐到远端"，对齐不了就明确警告并按**当前工作区**
# 发布 —— 内容已经在本地工作区里了，发布它才是使用者的本意。
if git fetch --prune origin 2>/dev/null; then
  # 只快进，不 reset：本地分支落后就前进，分叉或领先就报错让人看
  git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH" "origin/$BRANCH" 2>/dev/null || true
  if git merge --ff-only "origin/$BRANCH" >/dev/null 2>&1; then
    echo "  git: 已对齐到 origin/$BRANCH（$(git rev-parse --short HEAD)）"
  else
    echo "  警告：本地 $BRANCH 无法快进到 origin/$BRANCH（有本地提交或已分叉）。" >&2
    echo "        按当前工作区继续发布（git log --oneline --graph --all 可看原因）。" >&2
  fi
else
  echo "  警告：取不到 origin/$BRANCH（网络或凭据问题）。" >&2
  echo "        按当前工作区继续发布（即 $REPO_DIR 里现有的内容）。" >&2
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

# ------------------------------------------------------------
# 发布后自检：不该出现在站点根目录的东西，一个都不许有
# ------------------------------------------------------------
# 为什么要有这一步：rsync 的排除清单是**黑名单**，它保证"这些不被上传"，
# 但保证不了"站点根目录里没有它们的旧副本"，也挡不住有人手工拷进去、
# 或者改了名字的版本（admin-old/、server.bak/）。
# 这个项目就发生过管理页与 dev-server.mjs 被公网直接下载的事故。
# 所以发布完**主动验一遍**，不通过就大声报错（exit 5），别等下次才发现。
leaked=0
for bad in admin _admin server tests api .env .git .admin; do
  if [ -e "$WEB_ROOT/$bad" ]; then
    echo "  泄漏！站点根目录里存在 /$bad" >&2
    leaked=1
  fi
done
# 顶层散落的 .mjs / .cjs 源码也不该存在
if find "$WEB_ROOT" -maxdepth 1 -name '*.mjs' -o -maxdepth 1 -name '*.cjs' 2>/dev/null | grep -q .; then
  echo "  泄漏！站点根目录里有 .mjs / .cjs 源码" >&2
  leaked=1
fi
if [ "$leaked" = "1" ]; then
  echo "" >&2
  echo "发布已中断，但内容可能已经同步过去。请立刻人工清理 $WEB_ROOT 并核对 nginx 规则。" >&2
  exit 5
fi

echo "published $(git -C "$REPO_DIR" rev-parse --short HEAD) ($(git -C "$REPO_DIR" log -1 --pretty=%s))"
echo "  -> $WEB_ROOT  at $(date -Is)"
echo "  自检通过：站点根目录无 admin/ server/ tests/ api/ .env 等非公开产物"
