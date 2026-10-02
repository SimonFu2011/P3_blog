#!/usr/bin/env bash
# ============================================================
# 宝塔面板服务器引导 —— 需要 root
# ------------------------------------------------------------
# 与 deploy/bin/blog-bootstrap.sh 的区别（**不要混用**）：
#   · 不装 apt 版 nginx —— 宝塔自己编译的 nginx 在 /www/server/nginx，
#     再装一个系统 nginx 会抢 80 端口、让面板的网站功能失灵。
#   · 不装 certbot —— 证书在面板里点（网站 → SSL → Let's Encrypt）。
#   · 不改主配置 —— 站点规则贴进"伪静态"，面板重新生成主配置时不会丢。
#
# 前置条件（面板里先做完）：
#   网站 → 添加站点，域名填 simonfu.xin，PHP 版本选「纯静态」，
#   不要创建数据库和 FTP。
#
# 用法（在服务器上，root）：
#   DOMAIN=simonfu.xin bash /srv/blog/repo/deploy/bin/blog-bootstrap-bt.sh
# ============================================================
set -euo pipefail

DOMAIN="${DOMAIN:-}"
DEPLOY_USER="${DEPLOY_USER:-blog}"
REPO_DIR="${REPO_DIR:-/srv/blog/repo}"
WEB_ROOT="${WEB_ROOT:-/www/wwwroot/$DOMAIN}"
BRANCH="${BRANCH:-main}"

BT_NGINX=/www/server/nginx/sbin/nginx
BT_REWRITE_DIR=/www/server/panel/vhost/rewrite

[ "$(id -u)" -eq 0 ] || { echo "请用 root 执行（sudo）" >&2; exit 1; }
[ -n "$DOMAIN" ]     || { echo "必须指定 DOMAIN，例如 DOMAIN=simonfu.xin" >&2; exit 1; }

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# ------------------------------------------------------------
# 0. 环境自检
# ------------------------------------------------------------
[ -d /www/server/panel ] || { echo "没找到宝塔面板（/www/server/panel）。若你不是宝塔环境，请用 deploy/DEPLOY.md 那套。" >&2; exit 1; }
[ -x "$BT_NGINX" ]       || { echo "没找到宝塔的 nginx：$BT_NGINX" >&2; exit 1; }
[ -d "$WEB_ROOT" ] || {
  cat >&2 <<EOF
站点目录不存在：$WEB_ROOT

请先在面板里建站：
  网站 → 添加站点 → 域名 $DOMAIN → PHP 版本选「纯静态」→ 不建数据库/FTP
建完再重跑本脚本。
EOF
  exit 1
}

# ------------------------------------------------------------
# 1. 只装缺的基础命令（git / rsync）
# ------------------------------------------------------------
log "检查 git / rsync"
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y >/dev/null
  apt-get install -y git rsync sudo
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y git rsync sudo
elif command -v yum >/dev/null 2>&1; then
  yum install -y git rsync sudo
else
  echo "认不出包管理器，请手工安装 git 和 rsync" >&2
fi

getent group www >/dev/null || { echo "找不到 www 组，这不像是正常的宝塔环境" >&2; exit 1; }

# ------------------------------------------------------------
# 2. 部署用户
# ------------------------------------------------------------
log "准备用户 $DEPLOY_USER"
id -u "$DEPLOY_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$DEPLOY_USER" 2>/dev/null \
  || useradd -m -s /bin/bash "$DEPLOY_USER"

# 让 blog 能写 www 组的目录（宝塔站点目录固定是 www:www）
usermod -aG www "$DEPLOY_USER"

# ------------------------------------------------------------
# 3. 代码与发布脚本
# ------------------------------------------------------------
if [ ! -d "$REPO_DIR/.git" ]; then
  log "克隆仓库到 $REPO_DIR"
  REPO_PARENT="$(dirname "$REPO_DIR")"
  install -d -m 755 "$REPO_PARENT"
  # 必须归发布用户所有，否则 sudo -u blog git clone 会在父目录上被拒
  chown "$DEPLOY_USER:$DEPLOY_USER" "$REPO_PARENT"
  sudo -u "$DEPLOY_USER" git clone "https://github.com/SimonFu2011/P3_blog.git" "$REPO_DIR"
fi
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$REPO_DIR"

log "安装 /usr/local/bin/blog-publish"
install -m 755 "$REPO_DIR/deploy/bin/blog-publish.sh" /usr/local/bin/blog-publish

# ------------------------------------------------------------
# 4. 站点目录权限：保持面板期望的 www:www，同时让 blog 能发布
#    · chown www:www —— 面板的文件管理、权限检查都按这个来
#    · 目录 2775（setgid + 组写）—— blog 在 www 组里，能创建/替换文件
#    · 文件 664 —— nginx 能读即可
# ------------------------------------------------------------
log "设置 $WEB_ROOT 权限（www:www，目录 2775）"
chown -R www:www "$WEB_ROOT"
find "$WEB_ROOT" -type d -exec chmod 2775 {} +
find "$WEB_ROOT" -type f -exec chmod 664 {} +

# ------------------------------------------------------------
# 5. 把站点规则追加进"伪静态"（幂等：已有标记就跳过）
# ------------------------------------------------------------
REWRITE_FILE="$BT_REWRITE_DIR/$DOMAIN.conf"
SNIPPET="$REPO_DIR/deploy/bt/nginx-locations.conf"
MARKER="# ==== P3_blog 规则开始"

log "写入伪静态规则：$REWRITE_FILE"
install -d -m 755 "$BT_REWRITE_DIR"
if [ ! -f "$REWRITE_FILE" ]; then
  printf '# 宝塔伪静态规则（本文件由面板与 deploy/bin/blog-bootstrap-bt.sh 共同维护）\n' > "$REWRITE_FILE"
fi
if grep -qF "$MARKER" "$REWRITE_FILE"; then
  echo "  已存在 P3_blog 规则，跳过（要更新请先手工删除旧的那一段）"
else
  printf '\n' >> "$REWRITE_FILE"
  cat "$SNIPPET" >> "$REWRITE_FILE"
fi

log "校验 nginx 配置"
if ! "$BT_NGINX" -t; then
  # 最常见的冲突是"可选块"里的 location /：面板主配置可能已经定义过。
  # 自动降级：删掉可选块再试一次，其余规则（挡 admin/server、缓存）都保留。
  if grep -qF '# ---- 可选开始' "$REWRITE_FILE"; then
    echo "  配置冲突，尝试移除可选块（location /）后重试…"
    sed -i '/# ---- 可选开始/,/# ---- 可选结束/d' "$REWRITE_FILE"
  fi
  if ! "$BT_NGINX" -t; then
    cat >&2 <<EOF

配置校验失败。请打开面板：网站 → $DOMAIN → 设置 → 伪静态，
删掉「P3_blog 规则开始」到「P3_blog 规则结束」之间的内容，再重跑本脚本。
最常见的原因是主配置里已经有生效的 error_page 404 —— 那种情况下
删掉片段里的 error_page 那一行即可。
EOF
    exit 1
  fi
  echo "  已移除可选块，配置校验通过"
fi
"$BT_NGINX" -s reload

# ------------------------------------------------------------
# 6. 首次发布
# ------------------------------------------------------------
log "首次发布"
sudo -u "$DEPLOY_USER" env REPO_DIR="$REPO_DIR" WEB_ROOT="$WEB_ROOT" BRANCH="$BRANCH" \
  /usr/local/bin/blog-publish

# ------------------------------------------------------------
# 完成提示
# ------------------------------------------------------------
cat <<EOF

============================================================
服务器侧完成。剩下两件事在浏览器里做：

1) 面板 → 网站 → $DOMAIN → SSL
   → Let's Encrypt → 勾选 $DOMAIN 和 www.$DOMAIN → 申请
   → 打开「强制 HTTPS」
   （申请失败多半是 80 端口没通：先查云厂商安全组 + 面板「安全」页放行 80/443）

2) 面板 → 网站 → $DOMAIN → 设置 → 伪静态
   确认能看到「P3_blog 规则开始 / 结束」那一段。

以后发布（本地 git push 完，在本地 Windows 上执行）：
   ssh $DEPLOY_USER@43.108.100.116 blog-publish

站点根目录：$WEB_ROOT
发布源：    $REPO_DIR
日志：      面板 → 网站 → $DOMAIN → 日志，或 /www/wwwlogs/$DOMAIN.log
============================================================
EOF
