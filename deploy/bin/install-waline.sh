#!/usr/bin/env bash
# ============================================================
# 在服务器上部署 Waline 评论服务（只监听回环）
# ------------------------------------------------------------
# 跑法（服务器上，root）：
#     bash deploy/bin/install-waline.sh
# 幂等：重复执行只会重写 env / systemd unit 并重启，不会动已有评论数据。
#
# 它**不**负责的事（各自有主）：
#   · nginx 反代 /comments/        → deploy/bt/nginx-locations.conf（贴伪静态）
#   · 客户端资源 waline.js / .css  → blog-enter/comments-assets/（随站点发布）
#   · SMTP 授权码                  → 手工填 /etc/p3blog/waline.env，见 ADMIN.md
#
# 两个方案 E 里没写、但实测必须做的事（不做就是 500 / 裸奔）：
#   1) **官方 waline.sqlite 结构文件必须先放好**。Waline 的 SQLite 不会自己建表，
#      空库的表现是查询直接 500 `no such table: wl_Comment`。官方文档
#      "多数据库服务支持 · SQLite" 要求先把 assets/waline.sqlite 放进去。
#   2) **监听地址必须钉死在回环**。Waline(thinkjs) 默认 listen 0.0.0.0，
#      实测 `ss -lntp` 看到的是 `*:8360` —— 那就绕过 nginx 裸奔了。
#      办法是在 vanilla.js 旁边放一个 config.js（vanilla.js 会 require 它）。
#   3) **管理端的 window.serverURL 必须跟着当前地址走**（见第 5 步的 patch），
#      否则经隧道打开后台时，登录口令会被 POST 到公网明文地址上 ——
#      而"走隧道"的全部意义就是不让口令出本机。
#      ⚠️ 重新 npm install @waline/vercel 会删掉上面两处改动，装完要重跑本脚本。
# ============================================================
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WALINE_VERSION="${WALINE_VERSION:-1.43.4}"
APP_DIR="${APP_DIR:-/srv/waline/app}"
DATA_DIR="${DATA_DIR:-/srv/waline/data}"
PKG="$APP_DIR/node_modules/@waline/vercel"
ENV_FILE="${ENV_FILE:-/etc/p3blog/waline.env}"
UNIT_FILE="/etc/systemd/system/p3-waline.service"
PORT="${PORT:-8360}"
SITE_URL_VALUE="${SITE_URL_VALUE:-http://43.108.100.116}"

[ "$(id -u)" = "0" ] || { echo "请用 root 跑（要写 systemd unit 与 /etc/p3blog）" >&2; exit 1; }

echo "== 1. 目录 =="
install -d -m 750 -o blog -g blog "$DATA_DIR"
install -d -m 750 -o blog -g blog "$APP_DIR"
install -d -m 750 -o blog -g blog /srv/waline/.npm

echo "== 2. 安装 @waline/vercel@$WALINE_VERSION =="
if [ -f "$PKG/package.json" ] \
   && [ "$(node -p "require('$PKG/package.json').version" 2>/dev/null)" = "$WALINE_VERSION" ]; then
  echo "  已装 $WALINE_VERSION，跳过 npm install"
else
  [ -f "$APP_DIR/package.json" ] || sudo -u blog env HOME=/srv/waline npm init -y --prefix "$APP_DIR" >/dev/null
  sudo -u blog env HOME=/srv/waline npm_config_cache=/srv/waline/.npm \
    npm install --prefix "$APP_DIR" "@waline/vercel@$WALINE_VERSION" \
    --omit=dev --no-audit --no-fund
fi

echo "== 3. SQLite 结构文件（空库不自建表，必须显式放）=="
DB="$DATA_DIR/waline.sqlite"
tables=0
if [ -s "$DB" ]; then
  tables=$(node -e '
    const D=require(process.argv[1]+"/node_modules/better-sqlite3");
    try{const db=new D(process.argv[2],{readonly:true});console.log(db.prepare("select count(*) c from sqlite_master where type=?").get("table").c);}catch(e){console.log(0);}
  ' "$APP_DIR" "$DB" 2>/dev/null || echo 0)
fi
if [ "${tables:-0}" -gt 0 ]; then
  echo "  库里已有 $tables 张表，不动它（保护评论数据）"
else
  TMP="$(mktemp /tmp/waline-schema-XXXXXX.sqlite)"
  got=0
  for u in \
    "https://raw.githubusercontent.com/walinejs/waline/main/assets/waline.sqlite" \
    "https://cdn.jsdelivr.net/gh/walinejs/waline@main/assets/waline.sqlite" \
    "https://ghproxy.net/https://raw.githubusercontent.com/walinejs/waline/main/assets/waline.sqlite" ; do
    if timeout 40 curl -fsSL -o "$TMP" "$u" && [ "$(stat -c%s "$TMP")" -gt 4096 ]; then
      echo "  取到结构文件：$u（$(stat -c%s "$TMP") 字节）"; got=1; break
    fi
    echo "  这个源不可用：$u"
  done
  [ "$got" = "1" ] || { echo "三个源都拿不到 waline.sqlite，中止（别用空库硬跑）" >&2; exit 1; }
  strings "$TMP" | grep -q 'CREATE TABLE "wl_Comment"' \
    || { echo "拿到的文件里没有建表语句，拒绝安装" >&2; exit 1; }
  install -m 640 -o blog -g blog "$TMP" "$DB"
  rm -f "$TMP"
fi

echo "== 4. 把监听地址钉死在回环 =="
cat > "$PKG/config.js" <<'EOF'
// 由 deploy/bin/install-waline.sh 生成：Waline(thinkjs) 默认监听 0.0.0.0，
// 本机必须只绑回环（否则绕过 nginx 裸奔，限流与日志全部失效）。
// vanilla.js 在 run() 之后会 require 本文件并逐个 think.config(k, v)。
// ⚠️ 重新 npm install @waline/vercel 会删掉它，装完要重跑安装脚本。
module.exports = {
  host: '127.0.0.1',
  port: Number(process.env.PORT || 8360),
  workers: 1,
};
EOF
chown blog:blog "$PKG/config.js"

echo "== 5. patch dashboard.js：管理端 API 跟着当前地址走 =="
# 为什么必须 patch：/ui/ 页面里的 window.serverURL 是 Waline 用 ctx.serverURL
# 拼的，而 SERVER_URL 必须是**公开地址**（邮件里的验证链接要用它）。于是经
# SSH 隧道从 127.0.0.1:8360 打开后台时，管理端会把登录口令 POST 到公网明文
# 地址上 —— 这正是隧道要避免的事。改成从当前地址派生：
#   http://127.0.0.1:8360/ui/  → http://127.0.0.1:8360/api/    （隧道：全程本机）
#   http://host/comments/ui/   → http://host/comments/api/     （经 nginx 也对）
DASH="$PKG/src/middleware/dashboard.js"
if grep -q "new URL('api/'" "$DASH"; then
  echo "  已经 patch 过，跳过"
else
  cp -a "$DASH" "$DASH.orig"
  python3 - "$DASH" <<'PY'
import io, sys
p = sys.argv[1]
t = io.open(p, encoding='utf-8').read()
old = "window.serverURL = '${ctx.serverURL}/api/';"
new = "window.serverURL = new URL('api/', new URL('../', location.href)).href;"
assert old in t, 'dashboard.js 里没有预期的 serverURL 那一行，放弃 patch'
io.open(p, 'w', encoding='utf-8').write(t.replace(old, new, 1))
print('  已 patch')
PY
fi

echo "== 6. 环境变量 $ENV_FILE（保留已有 JWT_TOKEN）=="
# ⚠️ 这个文件里会有人手填的 SMTP 授权码。**已经有 SMTP_* 就不覆盖** ——
#    否则重跑一次安装脚本就把验证码配置抹了，症状是"评论突然又要不了验证码"
#    （或者反过来：SMTP 没了但 LOGIN=force，谁也评论不了）。
ENV_CUSTOMIZED=0
if [ -f "$ENV_FILE" ] && grep -qE '^[[:space:]]*SMTP_[A-Z_]+=' "$ENV_FILE"; then
  ENV_CUSTOMIZED=1
  cp -a "$ENV_FILE" "$ENV_FILE.bak-$(date +%F-%H%M%S)"
  echo "  检测到已填的 SMTP_*：**不覆盖** $ENV_FILE（已另存一份备份）"
  echo "  要重新生成模板：先手动把那些 SMTP_ 行删掉再跑本脚本。"
fi
JWT=""
if [ -f "$ENV_FILE" ]; then
  JWT="$(grep '^JWT_TOKEN=' "$ENV_FILE" | head -n 1 | cut -d= -f2- || true)"
fi
[ -n "$JWT" ] || JWT="$(openssl rand -hex 32)"
if [ "$ENV_CUSTOMIZED" = "0" ]; then
install -m 640 -o root -g blog /dev/null "$ENV_FILE"
cat > "$ENV_FILE" <<EOF
# ============================================================
# Waline 评论服务：由 p3-waline.service 读取
#   改完必须 systemctl restart p3-waline 才生效
#   秘密（JWT_TOKEN / SMTP_PASS）不进仓库
# ============================================================
TZ=Asia/Shanghai

# ---- 站点 ----
SITE_NAME=SIMON 的个人站
SITE_URL=$SITE_URL_VALUE
SERVER_URL=$SITE_URL_VALUE/comments

# ---- 安全 ----
SECURE_DOMAINS=43.108.100.116
JWT_TOKEN=$JWT

# ---- 数据库（在仓库外面：rsync --delete 碰不到它）----
SQLITE_PATH=$DATA_DIR

# ---- 评论策略 ----
# LOGIN=disable：匿名可评 + 先审后发。
# 配好 SMTP（下面那段）之后要改成 force，客户端 article.html 里的 login 也要一起改。
LOGIN=disable
COMMENT_AUDIT=true
IPQPS=60
AKISMET_KEY=70542d86693e

# ---- 头像：默认是 Cloudflare Workers 代理（国内常挂），换成国内可达的镜像 ----
AVATAR_PROXY=false
GRAVATAR_STR=https://cdn.v2ex.com/gravatar/{{mail|md5}}

# ---- 数学公式渲染会去拉 MathJax CDN，关掉（本站零外部运行时依赖）----
MARKDOWN_TEX=false

# ---- 评论后台的 JS 自托管（默认去 unpkg 拿，国内经常加载不出来）----
# 必须是**绝对地址**：后台只能经 SSH 隧道从 127.0.0.1:8360 打开，相对路径会
# 解析到 Waline 自己身上（它没有静态文件路由）→ 404。
WALINE_ADMIN_MODULE_ASSET_URL=$SITE_URL_VALUE/comments-assets/waline-admin.js

# ---- 邮件（邮箱验证码）：填上就自动开启"注册/评论要验证码"----
# 顺序不能反：先验通发信，再开 LOGIN=force。发不出信 = 谁也评论不了。
# 验通的办法：bash deploy/bin/check-waline-smtp.sh [收件邮箱]
#
# QQ / 163（授权码，不是登录密码；465 + SSL）
# SMTP_SERVICE=QQ
# SMTP_USER=you@qq.com
# SMTP_PASS=<SMTP 授权码>
# SMTP_SECURE=true
#
# 个人 outlook.com / hotmail.com（要开两步验证后生成"应用密码"）
# SMTP_SERVICE=Hotmail            # → smtp-mail.outlook.com:587 STARTTLS
# SMTP_USER=you@outlook.com
# SMTP_PASS=<应用密码>
#
# ⚠️ 工作/学校的 Microsoft 365 **不行**：Exchange Online 从 2026-04-30 起
#    全部拒绝 SMTP 基本认证（550 5.7.30），只剩 OAuth，而 Waline 只支持
#    用户名+密码。详见 blog-enter/ADMIN.md 第 8.3.1 节。
#
# ⚠️ 设了 SMTP_SERVICE 时，SMTP_HOST / SMTP_PORT / SMTP_SECURE 一律被忽略。
# SENDER_NAME=SIMON 的个人站
# SENDER_EMAIL=you@qq.com        # 必须与 SMTP_USER 相同
# AUTHOR_EMAIL=you@qq.com        # 博主邮箱，接新评论通知
EOF
chmod 640 "$ENV_FILE"; chown root:blog "$ENV_FILE"
fi

echo "== 7. systemd unit =="
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Waline comment server (loopback-only)
Documentation=https://waline.js.org/
After=network.target

[Service]
Type=simple
User=blog
Group=blog
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=PORT=$PORT
ExecStart=/usr/local/bin/node $PKG/vanilla.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$DATA_DIR
UMask=0027

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable p3-waline >/dev/null 2>&1 || true
systemctl restart p3-waline
sleep 6

echo "== 8. 自检 =="
systemctl is-active p3-waline
echo "--- 监听（必须是 127.0.0.1:$PORT）---"
ss -lntp | grep ":$PORT" || { echo "没有监听 $PORT" >&2; exit 1; }
ss -lntp | grep ":$PORT" | grep -q '127.0.0.1' || { echo "警告：$PORT 不是只绑回环！" >&2; exit 1; }
echo "--- 接口（SECURE_DOMAINS 会拦掉没有来源的请求，所以要带 Referer）---"
curl -s -H "Referer: $SITE_URL_VALUE/article.html" \
  "http://127.0.0.1:$PORT/api/comment?path=/article.html" | head -c 200; echo
echo "--- 数据 ---"
ls -la "$DATA_DIR"
echo
echo "装完了。接下来："
echo "  1) nginx：把 deploy/bt/nginx-locations.conf 的 P3_comments 段贴进伪静态（整段 /comments/），"
echo "     /www/server/nginx/sbin/nginx -t && nginx -s reload"
echo "  2) 客户端：blog-enter/comments-assets/ 随站点发布（sudo -u blog blog-publish）"
echo "  3) 管理员：ssh -L 8360:127.0.0.1:8360 root@43.108.100.116"
echo "     然后本机开 http://127.0.0.1:8360/ui/ → 用户注册"
echo "     —— **第一个注册的账号就是管理员**，先把这一步做完，再删掉伪静态里"
echo "        那段临时的 location = /comments/api/user（它挡着公网注册）"
echo "  注意：npm install @waline/vercel 会删掉本脚本写的 config.js 与 dashboard patch，"
echo "        重装之后要重跑本脚本。"

