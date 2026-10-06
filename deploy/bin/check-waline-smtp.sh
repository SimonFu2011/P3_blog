#!/usr/bin/env bash
# ============================================================
# 把"发信"验通 —— 方案 E 第 5 节那一步的脚本版
# ------------------------------------------------------------
# 跑法（服务器上）：
#     bash deploy/bin/check-waline-smtp.sh            # 只验连接 + 登录
#     bash deploy/bin/check-waline-smtp.sh you@qq.com # 再真发一封测试信
#
# 为什么顺序不能反：`waline.env` 里一旦填上 SMTP_*，Waline 就自动要求
# 邮箱验证码；发不出信 = **谁也评论不了**。所以必须先把这一步验通，
# 再动 LOGIN=force。
#
# 它只读 /etc/p3blog/waline.env，不改任何东西。
# ============================================================
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ENV_FILE="${ENV_FILE:-/etc/p3blog/waline.env}"
APP_DIR="${APP_DIR:-/srv/waline/app}"
TO="${1:-}"

[ -r "$ENV_FILE" ] || { echo "读不到 $ENV_FILE（要用 root）" >&2; exit 1; }

# ⚠️ 不要 `source` 这个文件：里面像 SITE_NAME=SIMON 的个人站 这种带空格的值
#    会被 bash 当成命令执行。逐个取值。
get() { grep -E "^$1=" "$ENV_FILE" | head -n 1 | cut -d= -f2- ; }

SMTP_SERVICE="$(get SMTP_SERVICE)"
SMTP_HOST="$(get SMTP_HOST)"
SMTP_PORT="$(get SMTP_PORT)"
SMTP_SECURE="$(get SMTP_SECURE)"
SMTP_USER="$(get SMTP_USER)"
SMTP_PASS="$(get SMTP_PASS)"
SENDER_EMAIL="$(get SENDER_EMAIL)"
SENDER_NAME="$(get SENDER_NAME)"

echo "=== 当前配置（口令只显示长度）==="
printf '  %-14s %s\n' SMTP_SERVICE "${SMTP_SERVICE:-（未设）}"
printf '  %-14s %s\n' SMTP_HOST "${SMTP_HOST:-（未设）}"
printf '  %-14s %s\n' SMTP_PORT "${SMTP_PORT:-（未设）}"
printf '  %-14s %s\n' SMTP_SECURE "${SMTP_SECURE:-（未设）}"
printf '  %-14s %s\n' SMTP_USER "${SMTP_USER:-（未设）}"
printf '  %-14s %s\n' SMTP_PASS "$([ -n "$SMTP_PASS" ] && echo "已设置（${#SMTP_PASS} 位）" || echo "（未设）")"
printf '  %-14s %s\n' SENDER_EMAIL "${SENDER_EMAIL:-（未设）}"
printf '  %-14s %s\n' SENDER_NAME "${SENDER_NAME:-（未设）}"
echo

if [ -z "$SMTP_SERVICE" ] && [ -z "$SMTP_HOST" ]; then
  echo "还没配 SMTP_*，Waline 现在发不出任何邮件（邮箱验证码也就没开）。" >&2
  echo "配法见 blog-enter/ADMIN.md 第 8 节；别只填 SMTP_USER/PASS。" >&2
  exit 2
fi
if [ -z "$SMTP_USER" ] || [ -z "$SMTP_PASS" ]; then
  echo "SMTP_USER / SMTP_PASS 还缺一个 —— 两个都要填（QQ/163/Outlook 都用"授权码/应用密码"，不是登录密码）。" >&2
  exit 2
fi

echo "=== 交给 nodemailer 去验 ==="
SMTP_SERVICE="$SMTP_SERVICE" SMTP_HOST="$SMTP_HOST" SMTP_PORT="$SMTP_PORT" \
SMTP_SECURE="$SMTP_SECURE" SMTP_USER="$SMTP_USER" SMTP_PASS="$SMTP_PASS" \
SENDER_EMAIL="$SENDER_EMAIL" SENDER_NAME="$SENDER_NAME" TO="$TO" APP_DIR="$APP_DIR" \
node - <<'JS'
const path = require('node:path');
const nm = require(path.join(process.env.APP_DIR, 'node_modules/nodemailer'));
let services = {};
try { services = require(path.join(process.env.APP_DIR, 'node_modules/nodemailer/dist/well-known/services.json')); } catch { /* 版本差异，忽略 */ }

const { SMTP_SERVICE, SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SENDER_EMAIL, SENDER_NAME, TO } = process.env;

const cfg = SMTP_SERVICE
  ? { service: SMTP_SERVICE }
  : { host: SMTP_HOST, port: Number(SMTP_PORT || 587), secure: SMTP_SECURE && SMTP_SECURE !== 'false' };
cfg.auth = { user: SMTP_USER, pass: SMTP_PASS };

/* 提醒一个真会踩的坑：设了 SMTP_SERVICE 时，SMTP_HOST/PORT/SECURE **全部被忽略**，
   端口由 nodemailer 的预设决定。这里把预设查出来打印，免得两边配置打架还不知道。 */
if (SMTP_SERVICE) {
  const hit = Object.entries(services).find(([k, v]) =>
    k.toLowerCase() === SMTP_SERVICE.toLowerCase() ||
    (v.aliases || []).some((a) => a.toLowerCase() === SMTP_SERVICE.toLowerCase()));
  if (hit) {
    console.log('  service 预设：' + hit[0] + ' -> ' + hit[1].host + ':' + hit[1].port +
      '（secure=' + (hit[1].secure === true) + '）');
    if (SMTP_HOST) console.log('  ⚠️ 你还设了 SMTP_HOST=' + SMTP_HOST + '，它**不会生效**（service 优先）');
  } else {
    console.log('  ⚠️ nodemailer 不认识 service="' + SMTP_SERVICE + '"，会用默认值（大概率连不上）');
  }
}

const from = SENDER_EMAIL && SENDER_NAME ? `"${SENDER_NAME}" <${SENDER_EMAIL}>` : SMTP_USER;
const t = nm.createTransport(cfg);

const explain = (err) => {
  const msg = String((err && err.message) || err);
  const code = (err && err.code) || '';
  console.log('  失败：' + code + ' ' + msg);
  if (/535|Invalid login|Authentication unsuccessful|Username and Password not accepted/i.test(msg))
    console.log('  → 账号或口令不对。QQ/163 必须用"授权码"，Outlook 必须用"应用密码"，都不是登录密码。');
  if (/5\.7\.30|Basic authentication is not supported/i.test(msg))
    console.log('  → Exchange Online 已经停用 SMTP 基本认证（2026-04-30 起彻底停）。这条路对 Waline 走不通：'
      + '它只支持"用户名+密码"，不支持 OAuth。换个人邮箱或第三方推送服务。');
  if (/5\.7\.8|Client host rejected|relay/i.test(msg))
    console.log('  → 服务商不允许这台服务器直接投递。换 SMTP 服务商，或做发件人验证。');
  if (/ETIMEDOUT|ESOCKET|ECONNREFUSED|ENOTFOUND|Greeting never received/i.test(msg))
    console.log('  → 网络/端口问题。阿里云默认封 25，必须用 465（SSL）或 587（STARTTLS）。');
  if (/self signed|CERT|wrong version number/i.test(msg))
    console.log('  → TLS 模式不对：465 配 SMTP_SECURE=true，587 配 SMTP_SECURE=false。');
};

(async () => {
  try {
    await t.verify();
    console.log('  ✅ 连接 + 登录都通过了');
  } catch (err) {
    console.log('  ❌ verify 没过');
    explain(err);
    process.exit(1);
  }

  if (!TO) {
    console.log('  （没给收件地址，跳过真发信。要发：bash deploy/bin/check-waline-smtp.sh 你的邮箱）');
    process.exit(0);
  }

  try {
    const info = await t.sendMail({
      from,
      to: TO,
      subject: '【SIMON 的个人站】发信测试',
      text: '如果你看到这封，说明 Waline 的验证码邮件能发出来。\n'
        + '接下来可以把 LOGIN 改成 force（见 blog-enter/ADMIN.md 第 8.3 节）。\n',
    });
    console.log('  ✅ 已投递给 ' + TO + '（' + (info.messageId || '') + '）');
    console.log('  提醒：收件箱里没看到就先翻垃圾箱 —— 个人邮箱发验证码被丢垃圾箱是常态。');
  } catch (err) {
    console.log('  ❌ 连接过了但发信失败');
    explain(err);
    process.exit(1);
  }
})();
JS
