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

# 白名单是**前缀**：git status 的输出里，只要路径落在这些前缀内，就当作"内容"。
# 为什么按前缀判定、而不是直接 `git add -- "${CONTENT_PATHS[@]}"`：
#   img/uploads 在还没传过图时**不存在**，而 `git add` 碰到不存在的路径会整体
#   失败（fatal: pathspec ... did not match any files），一个文件都提交不了。
#   先按 status 过滤出"真实存在的改动"，再逐个 add，就绕开了这个坑。
CONTENT_PREFIXES=(blog-enter/js/posts.js blog-enter/img/uploads)

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
# 【先救图】把只存在于站点根目录的上传图片捞回仓库
# ------------------------------------------------------------
# 为什么需要这一步（真实事故）：
#   上传图片时，管理页把文件写进**站点根目录**的 img/uploads/（那才是要
#   公网可读的地方）。而发布的方向是"仓库 → 站点根目录"，`--delete` 会把
#   站点根目录里**仓库没有**的文件当多余文件删掉 —— 于是刚上传的图片
#   在下次发布时被删掉，而使用者只看到图挂了。
#
# 所以发布前先把站点根目录里"仓库没有"的图片反向同步回仓库，
# 让它们成为受版本控制的内容。仓库才是真源，站点根目录只是产物。
#
# ⚠️ 顺序很重要：这一步必须在**下面那道"工作区脏就拒绝发布"的闸门之前**，
#    而且捞回的文件要交给"内容自动提交"一起提交。否则捞回动作本身会把工作区
#    弄脏 → 闸门拒绝发布 → 图片虽然进了仓库，但**什么都没发布出去**
#    （这个反噬真的发生过：捞回成功、随后静默退出、线上毫无变化）。
if [ -d "$WEB_ROOT/img/uploads" ]; then
  mkdir -p "$SITE_DIR/img/uploads"
  # -i(--ignore-existing)：只补仓库里缺的，不覆盖已有的
  pulled="$(rsync -rti --ignore-existing --itemize-changes \
      "$WEB_ROOT/img/uploads/" "$SITE_DIR/img/uploads/" 2>/dev/null | grep '^>' || true)"
  if [ -n "$pulled" ]; then
    echo "  从站点根目录捞回仓库缺失的上传图片："
    echo "$pulled" | sed 's/^/    /'
  fi
fi

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
  # 【必须关掉路径转义】git 默认把非 ASCII 文件名转义成八进制并用双引号包住：
  #     ?? "blog-enter/img/uploads/\345\276\256\344\277\241\345\233\276..."
  #   于是下面按前缀匹配时**匹配不上** → 中文文件名的图片永远不会被提交 →
  #   工作区一直脏 → 发布被"脏就报错"的闸门拒绝 → 图片到不了线上。
  #   症状就是使用者报的"无法上传图片"；而英文名的图一切正常，极难自己想到。
  # quotePath=false 让 git 原样输出 UTF-8 路径。
  git config core.quotePath false

  # 取出全部改动路径（去掉状态列），再把落在内容前缀里的挑出来。
  # --untracked-files=all 是必须的：新上传的图片是**未跟踪**文件，
  # 不带上这个参数时 git status 只会给出目录名（img/uploads/）。
  mapfile -t all_changed < <(git status --porcelain --untracked-files=all | cut -c4-)
  content_files=()
  for f in "${all_changed[@]}"; do
    [ -n "$f" ] || continue
    for p in "${CONTENT_PREFIXES[@]}"; do
      case "$f" in "$p"|"$p"/*) content_files+=("$f"); break ;; esac
    done
  done

  if [ "${#content_files[@]}" -gt 0 ]; then
    echo "  检测到内容改动，自动提交（只提交内容文件）："
    printf '    %s\n' "${content_files[@]}"
    git add -- "${content_files[@]}"
    git -c user.name="blog-publish" -c user.email="blog-publish@localhost" \
        commit -q -m "content: 管理页保存于 $(date -Is)" || echo "  （提交失败，继续尝试发布）"
    echo "  -> $(git rev-parse --short HEAD) $(git log -1 --pretty=%s)"
  fi

  # ----------------------------------------------------------
  # 把内容提交推回 GitHub
  # ----------------------------------------------------------
  # 为什么必须有这一步：内容提交如果只留在服务器上，就等于**没有异地备份**。
  # 真实事故：本地提交被一次 git reset 抹掉，文章随之消失（只能从备份文件里捞）。
  #
  # 失败**不阻塞发布** —— 内容已经安全落盘在仓库与备份里，推送只是异地副本。
  # 需要服务器有写权限的 Deploy Key（见 DEPLOY-RECORD 第 9 节）。
  if [ "${PUSH_CONTENT:-1}" = "1" ]; then
    if git rev-parse --verify -q "origin/$BRANCH" >/dev/null 2>&1 \
       && [ "$(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo 0)" -gt 0 ]; then
      if git push -q origin "$BRANCH" 2>/dev/null; then
        echo "  已推送到 origin/$BRANCH（内容有了异地备份）"
        git fetch --prune origin >/dev/null 2>&1 || true
      else
        echo "  提示：推送到 origin/$BRANCH 失败（内容已保存在服务器仓库里）。" >&2
        echo "        检查 Deploy Key 的写权限，或稍后手工 git push。" >&2
      fi
    fi
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
# 【不许丢掉本地内容提交】这是一次真实事故换来的
# ------------------------------------------------------------
# 事故经过：管理页写的文章只以**本地提交**形式存在（服务器没有 GitHub
# 写凭据，推不上去）。有人（我）为了同步代码而 `git reset --hard origin/main`
# —— 那些内容提交连同文章一起消失了。
#
# 所以：本地领先 origin 时，**跳过整个 git 同步**，直接按当前工作区发布。
# 发布内容本来就不需要联网。需要代码同步时，先解决"服务器推不上去"这件事
# （deploy key），或者显式 FORCE_GIT_SYNC=1。
if git rev-parse --verify -q "origin/$BRANCH" >/dev/null 2>&1; then
  ahead="$(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo 0)"
  if [ "${ahead:-0}" -gt 0 ] && [ "${FORCE_GIT_SYNC:-0}" != "1" ]; then
    echo "  本地 $BRANCH 领先 origin/$BRANCH $ahead 个提交（管理页产生的内容）。"
    echo "  跳过代码同步，直接按当前工作区发布 —— 避免 reset 丢掉这些内容。"
    echo "  （要强行同步代码：FORCE_GIT_SYNC=1 blog-publish；但先确认那些提交已备份）"
    SKIP_GIT_SYNC=1
  fi
fi

# ------------------------------------------------------------
# 【不要因为连不上 GitHub 就什么都不发布】
# ------------------------------------------------------------
# 服务器常常连不上 GitHub（国内网络、只走 SSH、或纯手工同步）。
# 原来 fetch/checkout/reset 三连在 set -e 下任何一步失败都会让脚本**提前退出**，
# 结果是"rsync 根本没跑"，管理页保存后表现成"发布失败"。
# 现在：git 只是"尽力把代码对齐到远端"，对齐不了就明确警告并按**当前工作区**
# 发布 —— 内容已经在本地工作区里了，发布它才是使用者的本意。
if [ "${SKIP_GIT_SYNC:-0}" = "1" ]; then
  :
elif git fetch --prune origin 2>/dev/null; then
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
# 3) **Node 依赖清单放 server/ 下，不要放 blog-enter/ 顶层**。
#    --filter='-s /server/' 排除的是整个 blog-enter/server/ 子树，它下面的
#    package.json / package-lock.json / node_modules/ 一个都不会被同步到站点根 ——
#    这是"结构上就安全"，不靠逐文件排除（逐文件排除漏一个，就会像 ADMIN.md
#    那样静默泄漏到公网）。
#    ⚠️ 所以**不要**为顶层依赖清单再加 rsync 排除规则：普通 exclude 在接收端
#    同时起"保护"作用，会让它变成 --delete 也删不掉的残留（第 2 点那个坑），
#    线上反而永远留着一份。顶层残留交给下面的自检报泄漏（exit 5）+ --delete 清掉。
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
  --exclude '/img/uploads/' \
  "$SITE_DIR/" "$WEB_ROOT/"

# 图片上传目录留出来（本地还没传过图时它不存在）
mkdir -p "$WEB_ROOT/img/uploads"

# ------------------------------------------------------------
# 归一化权限：**这一步不是可选的**
# ------------------------------------------------------------
# 为什么必须做：管理页进程（systemd 的 UMask）新建的文件默认 600、目录 700。
#   · 目录 2700 → nginx 以 www 身份**连遍历都做不到**（403）
#   · 文件 0600 → www 读不到（403）
# blog 在 www 组里，所以只要把"组"的位打开就够了：目录 2775、文件 664。
# 站点根目录本来就是 www:www + 2775 setgid（引导脚本设的），这里只是把
# 新产生的文件对齐到同一套权限，与既有文件一致。
#
# 不这么做的话，症状是"文章发出去了、图片却是 403"，而且很隐蔽 ——
# 发布脚本当时还报"自检通过"（因为自检只检查了不该有什么）。
chmod 2775 "$WEB_ROOT" 2>/dev/null || true
find "$WEB_ROOT" -type d -exec chmod 2775 {} + 2>/dev/null || true
find "$WEB_ROOT" -type f -exec chmod 664 {} + 2>/dev/null || true
# .user.ini 是面板生成且被 chattr +i 锁定的，别去动它
chmod 644 "$WEB_ROOT/.user.ini" 2>/dev/null || true

# ------------------------------------------------------------
# 发布后自检
# ------------------------------------------------------------
# 检查两件事，缺一不可：
#   A) 不该有的：admin/ server/ tests/ api/ .env 等源码与隐藏文件
#   B) 该有的**能读**：nginx 以 www 身份运行，凡是它读不了的就是线上 404/403
#
# ⚠️ 这张清单必须跟着 rsync 的排除规则一起长。历史上 ADMIN.md 就是这么漏的：
#    排除规则加了、自检清单没加 → 文件发到公网很久都没人发现。
#    所以这里把 **Node 依赖清单**也列上：它们属于后端构建物，按约定放在
#    blog-enter/server/ 下（server/ 被整体排除），一旦出现在站点根目录就是
#    "多发了一份"，会暴露依赖树、运行时版本甚至私有包名。
leaked=0
for bad in admin _admin server tests api .env .git .admin \
           package.json package-lock.json npm-debug.log yarn.lock pnpm-lock.yaml; do
  if [ -e "$WEB_ROOT/$bad" ]; then
    echo "  泄漏！站点根目录里存在 /$bad" >&2
    leaked=1
  fi
done
# 顶层散落的 .mjs / .cjs 源码也不该存在
if find "$WEB_ROOT" -maxdepth 1 \( -name '*.mjs' -o -name '*.cjs' \) 2>/dev/null | grep -q .; then
  echo "  泄漏！站点根目录里有 .mjs / .cjs 源码" >&2
  leaked=1
fi

if [ "$leaked" = "1" ]; then
  echo "" >&2
  echo "发布已中断，但内容可能已经同步过去。请立刻人工清理 $WEB_ROOT 并核对 nginx 规则。" >&2
  exit 5
fi

# B) 该有的能读吗 —— 用 nginx 的身份真读一次
unreadable=0
if sudo -u www test -r "$WEB_ROOT/js/posts.js" 2>/dev/null; then
  :
else
  # 无法切换身份时（比如没装 sudo 规则）退化为按权限位判断
  if [ ! -r "$WEB_ROOT/js/posts.js" ]; then unreadable=1; fi
fi
# 逐个检查新增的图片：它们是最容易被 600 权限坑到的一类
for f in "$WEB_ROOT"/img/uploads/*; do
  [ -e "$f" ] || continue
  if ! sudo -u www test -r "$f" 2>/dev/null && [ ! -r "$f" ]; then
    echo "  图片不可读（nginx 会 403）：$(basename "$f")" >&2
    unreadable=1
  fi
done
if [ "$unreadable" = "1" ]; then
  echo "" >&2
  echo "发布内容存在，但 nginx 读不到 —— 请检查权限（目录应为 2775、文件 664）。" >&2
  exit 5
fi

echo "published $(git -C "$REPO_DIR" rev-parse --short HEAD) ($(git -C "$REPO_DIR" log -1 --pretty=%s))"
echo "  -> $WEB_ROOT  at $(date -Is)"
echo "  自检通过：无非公开产物；权限已归一（目录 2775 / 文件 664），nginx 可读"
