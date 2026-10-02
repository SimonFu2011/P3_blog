#!/usr/bin/env bash
# ============================================================
# 云服务器一次性引导（Debian / Ubuntu）—— 需要 root
# ------------------------------------------------------------
# 用法：
#   sudo mkdir -p /srv/blog
#   sudo git clone <你的仓库地址> /srv/blog/repo
#   sudo DOMAIN=blog.example.com \
#        LETSENCRYPT_EMAIL=you@example.com \
#        bash /srv/blog/repo/deploy/bin/blog-bootstrap.sh
#
# 幂等：可以重复执行。LETSENCRYPT_EMAIL 留空则跳过签证书（只起 HTTP）。
# CentOS / 宝塔面板请按 deploy/DEPLOY.md 第 6 节手工做等价操作。
# ============================================================
set -euo pipefail

DOMAIN="${DOMAIN:-}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
DEPLOY_USER="${DEPLOY_USER:-blog}"
REPO_DIR="${REPO_DIR:-/srv/blog/repo}"
WEB_ROOT="${WEB_ROOT:-/var/www/blog}"
BRANCH="${BRANCH:-main}"

[ "$(id -u)" -eq 0 ] || { echo "请用 root 执行（sudo）" >&2; exit 1; }
[ -n "$DOMAIN" ]     || { echo "必须指定 DOMAIN，例如 DOMAIN=blog.example.com" >&2; exit 1; }

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# ------------------------------------------------------------
# 1. 装包
# ------------------------------------------------------------
log "安装 nginx / git / rsync / certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx git rsync sudo ca-certificates curl certbot python3-certbot-nginx

# ------------------------------------------------------------
# 2. 部署用户与目录
# ------------------------------------------------------------
log "准备用户 $DEPLOY_USER 与目录"
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi

install -d -m 755 /srv/blog
mkdir -p "$WEB_ROOT"
chown -R "$DEPLOY_USER:$DEPLOY_USER" /srv/blog
chown -R "$DEPLOY_USER:www-data"     "$WEB_ROOT"
chmod 755 "$WEB_ROOT"

# ------------------------------------------------------------
# 3. 代码（已经手工 clone 过就直接用）
# ------------------------------------------------------------
if [ ! -d "$REPO_DIR/.git" ]; then
  log "仓库不存在，请先手工 clone："
  echo "  sudo -u $DEPLOY_USER git clone <仓库地址> $REPO_DIR"
  exit 1
fi
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$REPO_DIR"
# 让 www-data 能穿过 /srv/blog 读到 web 根目录（read 即可，不需要遍历仓库）
chmod 755 /srv/blog

# ------------------------------------------------------------
# 4. 安装发布脚本
# ------------------------------------------------------------
log "安装 /usr/local/bin/blog-publish"
install -m 755 "$REPO_DIR/deploy/bin/blog-publish.sh" /usr/local/bin/blog-publish

# ------------------------------------------------------------
# 5. nginx 站点
# ------------------------------------------------------------
log "安装 nginx 站点配置（server_name = $DOMAIN）"
install -m 644 "$REPO_DIR/deploy/nginx/blog.conf" /etc/nginx/sites-available/blog.conf
sed -i "s/__DOMAIN__/${DOMAIN//\//\\/}/g" /etc/nginx/sites-available/blog.conf

install -d -m 755 /etc/nginx/sites-enabled
ln -sf /etc/nginx/sites-available/blog.conf /etc/nginx/sites-enabled/blog.conf

# 默认站点会让 server_name 不匹配的请求落到别处，直接关掉
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx

# ------------------------------------------------------------
# 6. 首次发布
# ------------------------------------------------------------
log "首次发布"
sudo -u "$DEPLOY_USER" env REPO_DIR="$REPO_DIR" WEB_ROOT="$WEB_ROOT" BRANCH="$BRANCH" \
  /usr/local/bin/blog-publish

# ------------------------------------------------------------
# 7. 防火墙（只在 ufw 已启用时动它；云安全组请自己放行 80/443）
# ------------------------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  log "放行 ufw: Nginx Full"
  ufw allow 'Nginx Full' >/dev/null
fi

# ------------------------------------------------------------
# 8. HTTPS
# ------------------------------------------------------------
if [ -n "$LETSENCRYPT_EMAIL" ]; then
  log "申请 Let's Encrypt 证书并强制跳转 HTTPS"
  certbot --nginx -d "$DOMAIN" --redirect -n --agree-tos \
          -m "$LETSENCRYPT_EMAIL" --keep-until-expiring
else
  log "跳过证书（未提供 LETSENCRYPT_EMAIL）"
fi

# ------------------------------------------------------------
# 完成
# ------------------------------------------------------------
cat <<EOF

============================================================
完成。自检一遍：

  curl -sI http://$DOMAIN/                         # 期望 200（已签证书则 301 → https）
  curl -sI http://$DOMAIN/admin/                   # 期望 404
  curl -sI http://$DOMAIN/server/dev-server.mjs    # 期望 404
  curl -s  http://$DOMAIN/archive.html | grep -c posts.js   # 期望 >=1

以后发布（本地 push 完在服务器上执行）：

  sudo -u $DEPLOY_USER blog-publish

日志：

  tail -f /var/log/nginx/blog.access.log /var/log/nginx/blog.error.log
============================================================
EOF
