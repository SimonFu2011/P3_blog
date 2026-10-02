#!/usr/bin/env bash
# ============================================================
# 宝塔面板服务器引导 —— 需要 root
# ------------------------------------------------------------
# 与 deploy/bin/blog-bootstrap.sh 的区别（**不要混用**）：
#   · 不装 apt 版 nginx —— 宝塔自己编译的 nginx 在 /www/server/nginx，
#     再装一个系统 nginx 会抢 80 端口、让面板的网站功能失灵。
#   · 不装 certbot —— 证书在面板里点（网站 → SSL → Let's Encrypt）。
#   · 不改主配置 —— 站点规则追加进"伪静态"，面板重新生成主配置时不会丢。
#
# 前置条件（面板里先做完）：
#   网站 → 添加站点，PHP 版本选「纯静态」，不要创建数据库和 FTP。
#
# 用法（在服务器上，root）——给这个站点的**任意一个**域名都行：
#   DOMAIN=simonfu.xin bash /srv/blog/repo/deploy/bin/blog-bootstrap-bt.sh
#   DOMAIN=43.108.100.116 bash /srv/blog/repo/deploy/bin/blog-bootstrap-bt.sh
#
# 站点根目录与伪静态文件名**由脚本自己去 vhost 里查**，不需要你记得
# 宝塔建站时"第一个域名"填的是什么（它决定这两者的命名）。
# ============================================================
set -euo pipefail

BT_NGINX=/www/server/nginx/sbin/nginx
BT_VHOST_DIR=/www/server/panel/vhost/nginx
BT_REWRITE_DIR=/www/server/panel/vhost/rewrite

# 用来定位站点的名字：给 SITE_NAME 或 DOMAIN 都行，填该站点的任一域名。
LOOKUP="${SITE_NAME:-${DOMAIN:-}}"

DEPLOY_USER="${DEPLOY_USER:-blog}"
REPO_DIR="${REPO_DIR:-/srv/blog/repo}"
BRANCH="${BRANCH:-main}"
WEB_ROOT_EXPLICIT="${WEB_ROOT:-}"

[ "$(id -u)" -eq 0 ] || { echo "请用 root 执行（sudo）" >&2; exit 1; }
[ -n "$LOOKUP" ]     || { echo "必须指定 SITE_NAME 或 DOMAIN，例如 DOMAIN=simonfu.xin" >&2; exit 1; }

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*" >&2; }

# ------------------------------------------------------------
# 0. 环境自检
# ------------------------------------------------------------
[ -d /www/server/panel ] || { echo "没找到宝塔面板（/www/server/panel）。若你不是宝塔环境，请用 deploy/DEPLOY.md 那套。" >&2; exit 1; }
[ -x "$BT_NGINX" ]       || { echo "没找到宝塔的 nginx：$BT_NGINX" >&2; exit 1; }

# ------------------------------------------------------------
# 0.5 自动识别站点
# ------------------------------------------------------------
# 宝塔用"添加站点时填的第一个域名"命名：
#   · vhost 配置   /www/server/panel/vhost/nginx/<第一个域名>.conf
#   · 伪静态文件   /www/server/panel/vhost/rewrite/<第一个域名>.conf
#   · 站点根目录   /www/wwwroot/<第一个域名>
# 从外部（或从面板列表）看不出第一个域名是什么，猜错会把文件发到错误目录，
# 所以这里直接去 vhost 里查：找到 server_name 含 $LOOKUP 的那个站点，读它的 root。
DETECTED_ROOT=""
DETECTED_NAME=""

detect_site() {
  local conf line tok root name
  [ -d "$BT_VHOST_DIR" ] || return 1
  for conf in "$BT_VHOST_DIR"/*.conf; do
    [ -f "$conf" ] || continue
    # 逐个 token 精确比对，不用正则 —— 避免把带点的 IP 当通配符匹配。
    while IFS= read -r line; do
      for tok in $line; do
        [ "$tok" = "$LOOKUP" ] || continue
        root=$(sed -nE 's/^[[:space:]]*root[[:space:]]+([^;]+);.*/\1/p' "$conf" | head -1)
        name=$(basename "$conf" .conf)
        if [ -n "$root" ] && [ -d "$root" ]; then
          DETECTED_ROOT="$root"
          DETECTED_NAME="$name"
          return 0
        fi
      done
    done < <(sed -nE 's/^[[:space:]]*server_name[[:space:]]+([^;]*);.*/\1/p' "$conf")
  done
  return 1
}

if detect_site; then
  REWRITE_NAME="$DETECTED_NAME"
  WEB_ROOT="${WEB_ROOT_EXPLICIT:-$DETECTED_ROOT}"
else
  REWRITE_NAME="$LOOKUP"
  WEB_ROOT="${WEB_ROOT_EXPLICIT:-/www/wwwroot/$LOOKUP}"
  warn "没在 $BT_VHOST_DIR 里找到 server_name 含「$LOOKUP」的站点。"
  warn "如果站点还没在面板里建好，请先建站再重跑本脚本。"
  warn "现在按根目录 $WEB_ROOT 继续（伪静态文件名按 $REWRITE_NAME.conf）。"
fi

log "站点：$REWRITE_NAME    根目录：$WEB_ROOT"

[ -d "$WEB_ROOT" ] || {
  cat >&2 <<EOF

站点目录不存在：$WEB_ROOT

请先在面板里建站：
  网站 → 添加站点 → 域名一行一个，把这个站点的域名都填上
  （例如 43.108.100.116、simonfu.xin、www.simonfu.xin）
  → PHP 版本选「纯静态」→ 不建数据库/FTP
建完再重跑本脚本。也可以用 WEB_ROOT=/path 手工指定根目录。
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

log "安装 /usr/local/bin/blog-publish（含本机路径包装器）"
install -d -m 755 /usr/local/lib/p3blog
install -m 755 "$REPO_DIR/deploy/bin/blog-publish.sh" /usr/local/lib/p3blog/blog-publish.sh

# 真实脚本保持与仓库逐字节一致，本机路径放进这个生成出来的包装器里。
# 否则直接跑 `ssh blog@host blog-publish`（不带环境变量）会退回脚本里的
# 通用默认值 /var/www/blog，在宝塔机器上必然报 "mkdir: /var/www: Permission denied"。
cat > /usr/local/bin/blog-publish <<WRAPPER
#!/usr/bin/env bash
# 本文件由 deploy/bin/blog-bootstrap-bt.sh 生成，固定本机的仓库与站点路径。
# 临时覆盖照样可以用环境变量，例如：WEB_ROOT=/tmp/x blog-publish
REPO_DIR="\${REPO_DIR:-$REPO_DIR}"
WEB_ROOT="\${WEB_ROOT:-$WEB_ROOT}"
BRANCH="\${BRANCH:-$BRANCH}"
export REPO_DIR WEB_ROOT BRANCH
exec /usr/local/lib/p3blog/blog-publish.sh "\$@"
WRAPPER
chmod 755 /usr/local/bin/blog-publish

# ------------------------------------------------------------
# 4. 站点目录权限：保持面板期望的 www:www，同时让 blog 能发布
#    · chown www:www —— 面板的文件管理、权限检查都按这个来
#    · 目录 2775（setgid + 组写）—— blog 在 www 组里，能创建/替换文件
#    · 文件 664 —— nginx 能读即可
#    · **跳过 .user.ini**：宝塔给它加了 chattr +i（immutable 属性），
#      连 root 都 chown/chmod 不了，会以 "Operation not permitted" 中断脚本。
#      它是 PHP 的 open_basedir 配置，纯静态站点完全用不到，不该去动它。
# ------------------------------------------------------------
log "设置 $WEB_ROOT 权限（www:www，目录 2775；跳过 immutable 的 .user.ini）"
chown www:www "$WEB_ROOT"
find "$WEB_ROOT" -mindepth 1 ! -name '.user.ini' -exec chown www:www {} +
find "$WEB_ROOT" -type d -exec chmod 2775 {} +
find "$WEB_ROOT" -type f ! -name '.user.ini' -exec chmod 664 {} +

# 断言：发布用户必须真的能写这个目录，否则后面的 rsync 会失败
if ! sudo -u "$DEPLOY_USER" test -w "$WEB_ROOT"; then
  echo "发布用户 $DEPLOY_USER 对 $WEB_ROOT 没有写权限 —— 检查它是否在 www 组、目录是否为 2775" >&2
  exit 1
fi

# ------------------------------------------------------------
# 5. 把站点规则追加进"伪静态"（幂等：已有标记就跳过）
# ------------------------------------------------------------
VHOST_CONF="$BT_VHOST_DIR/$REWRITE_NAME.conf"
REWRITE_FILE="$BT_REWRITE_DIR/$REWRITE_NAME.conf"
SNIPPET="$REPO_DIR/deploy/bt/nginx-locations.conf"
MARKER="# ==== P3_blog 规则开始"

# 规则必须放在面板自带 location 之前才生效（nginx 正则 location 先出现先匹配）。
# 伪静态文件正是 include 在 server 块最前端的，所以放这里；若这个 vhost 没
# include 它，规则会静默失效（posts.js 会被面板默认规则缓存 12 小时）——必须查。
if [ -f "$VHOST_CONF" ] && ! grep -qF "vhost/rewrite/$REWRITE_NAME.conf" "$VHOST_CONF"; then
  warn "$VHOST_CONF 里没有 include 伪静态文件，规则可能不生效。"
  warn "请在面板里：网站 → $REWRITE_NAME → 设置 → 伪静态 → 随便保存一次，再重跑本脚本。"
fi

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

配置校验失败。请打开面板：网站 → $REWRITE_NAME → 设置 → 伪静态，
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
服务器侧完成。现在是 HTTP 可访问状态（IP 和域名都能打开，
域名解析生效之前只有 IP 可用）。

1) 面板 → 网站 → $REWRITE_NAME → 设置 → 伪静态
   确认能看到「P3_blog 规则开始 / 结束」那一段。

2) 域名解析生效后（域名要先完成实名认证、解除 clientHold，再加 A 记录），
   面板 → 网站 → $REWRITE_NAME → SSL → Let's Encrypt
   → 勾选域名 → 申请 → 打开「强制 HTTPS」。
   域名没就绪前不要去点，Let's Encrypt 会失败并触发速率限制。

以后发布（本地 git push 完，在本地 Windows 上执行）：
   ssh $DEPLOY_USER@43.108.100.116 blog-publish

站点：      $REWRITE_NAME
站点根目录：$WEB_ROOT
发布源：    $REPO_DIR
日志：      面板 → 网站 → $REWRITE_NAME → 日志，或 /www/wwwlogs/$REWRITE_NAME.log
============================================================
EOF
