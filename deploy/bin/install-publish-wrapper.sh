#!/usr/bin/env bash
# ============================================================
# 安装 / 更新 p3-admin 的发布命令（/usr/local/bin/blog-publish）
# ------------------------------------------------------------
# 为什么需要这一步：引导脚本当初把 blog-publish.sh **复制**到了
# /usr/local/lib/p3blog/，于是仓库里那份改了它也不跟着变。
#     · 仓库里改了 = 没生效
#     · 没生效的那份里还有 git reset --hard = 保存完被静默回退
# 所以这里装一个**指向仓库文件**的包装器，从此"改仓库即生效"。
#
# 用法（服务器上，root）：
#   bash /srv/blog/repo/deploy/bin/install-publish-wrapper.sh
# ============================================================
set -euo pipefail

REPO_DIR="${REPO_DIR:-/srv/blog/repo}"
WEB_ROOT="${WEB_ROOT:-/www/wwwroot/43.108.100.116}"
BRANCH="${BRANCH:-main}"

[ -d "$REPO_DIR/.git" ] || { echo "找不到仓库：$REPO_DIR" >&2; exit 1; }
[ -f "$REPO_DIR/deploy/bin/blog-publish.sh" ] || { echo "找不到发布脚本" >&2; exit 1; }

cat > /usr/local/bin/blog-publish <<WRAPPER
#!/usr/bin/env bash
# 本文件由 deploy/bin/install-publish-wrapper.sh 生成。
# 它**直接执行仓库里那份**，所以改仓库里的 blog-publish.sh 立刻生效
# （旧版是复制到 /usr/local/lib/p3blog/，改了不生效 —— 那是个坑）。
REPO_DIR="\${REPO_DIR:-$REPO_DIR}"
WEB_ROOT="\${WEB_ROOT:-$WEB_ROOT}"
BRANCH="\${BRANCH:-$BRANCH}"
export REPO_DIR WEB_ROOT BRANCH
exec /usr/bin/env bash "$REPO_DIR/deploy/bin/blog-publish.sh" "\$@"
WRAPPER
chmod 755 /usr/local/bin/blog-publish

echo "已安装：/usr/local/bin/blog-publish"
echo "  REPO_DIR   = $REPO_DIR"
echo "  WEB_ROOT   = $WEB_ROOT"
echo "  BRANCH     = $BRANCH"
echo ""
echo "现在它执行的是 $REPO_DIR/deploy/bin/blog-publish.sh（改仓库即生效）。"
