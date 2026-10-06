#!/usr/bin/env bash
# ============================================================
# p3-fix-repo-perms —— 收窄仓库权限并建公开服务的专用账号（审计 S3）
# ------------------------------------------------------------
# 背景（评审实测）：/srv/blog/repo 的三个子目录是 **0777**，同机还有 admin、
# springboot 两个可登录账号 → 它们能改写公开服务要加载的 .mjs，再以服务身份执行；
# 而服务原来与 p3-admin 共用 uid `blog`，于是这条路直接连到
# /srv/blog/repo/.admin/passphrase.json（管理口令哈希）与 session.json（管理端令牌）。
#
# 这次修四件事（与 t23 契约的 ①②③④ 一一对应）：
#   ① 目录 2775 / 文件 664，属主保持 **blog:blog**（去掉 0777 的"人人可写"；
#      不做 chown -R root:blog —— 属主本来就是 blog，见下面「为什么属主保持」）
#   ② 建公开服务专用账号 p3public（系统账号、无家目录、nologin）
#   ③ /etc/p3blog/public-proxy-secret 改成 640 root:p3public（后端要能读）
#   ④ 自检：p3public 能读密钥，但**读不到** .admin 里任何东西；且 blog 仍能写（防收窄过头）
#
# 用法（在服务器上以 root 执行；先 --check 看现状）：
#   p3-fix-repo-perms --check
#   p3-fix-repo-perms
#
# 回滚：本脚本把"改之前"的权限打印并写入 /root/p3-perms-rollback-<时间戳>.txt，
#       按那份清单逐条 chmod/chown 回去即可（脚本**不**删任何文件）。
#
# 【为什么目录是 2775 而不是 0755】—— 与 captain 原始指令的一处有意差异，请先读：
# 【为什么是 2775 而不是 0755】—— 已与 captain 定稿，别改回去：
#   契约原文写的是"chmod 0755 目录/0644 文件（去掉 0777）"。0755 确实去掉了
#   "others 可写"，但它是否还能让 blog 写，完全取决于"属主是谁"——脆而不显。
#   PLAN 第 1/2 步**大量**使用 `sudo -u blog git …` / `sudo -u blog npm …`。
#   2775（组可写 + setgid）同时满足两个硬约束，且不依赖属主是谁：
#     · others 不可写 → admin/springboot 这类非属主账号再也不能改写服务代码
#     · 组 blog 可写  → 部署链路（git/npm/发布）照旧能跑
#
# 【为什么属主保持 blog:blog，不做 chown -R root:blog】
#   captain 的 SSH 只读实测：/srv/blog/repo（0755）与 .admin（0700）**本来
#   就是 blog:blog、本来就没问题**；问题只在 blog-enter/ 与 deploy/ 是 0777。
#   所以把属主整体改成 root 是**不必要的变更**：它会把 bin/、img/ 等目录也从 blog
#   挪到 root，凭空多出一层 root 写权限面，却不解决任何实际问题。
#   这里只做两件事：① `chown -R blog:blog`（幂等；若个别文件属主不是 blog 顺带修正）；
#   ② 收窄权限位（目录 2775 / 文件 664）。因为 2775 会把 .admin 一起放开，
#   收窄之后必须**显式把 .admin 复位回 0700 blog:blog**（见 main 的最后一步）。
# ============================================================
set -euo pipefail

REPO=/srv/blog/repo
ETC=/etc/p3blog
ADMIN_DIR="$REPO/.admin"
PUBLIC_USER=p3public
OWNER=blog
SECRET="$ETC/public-proxy-secret"
HEADER="$ETC/public-proxy-header.conf"

DIRMODE=2775
FILEMODE=664
# 【为什么是五位数 00700，而不是四位 0700】—— 这不是风格问题，是**会不会失败**的问题。
#   `chmod` 的位数与"清位"语义绑定：
#     · 三位 `700` / 四位 `0700` / `u=rwx,go=` —— 都只设置"权限位"，**不动** setgid/sticky
#       这类特殊位。于是当目录先前被置成 2775（setgid 已置位）时，这些写法得到的是
#       **2700**，不是 700；
#     · 五位 `00700` 的第一个 0 = "清除 setuid/setgid/sticky"，所以它能给出真正的 700。
#   本例正是前者踩坑：先 `find -type d` 把 .admin 一起置成 2775，再用 `chmod 0700`
#   去清 → 实际停在 2700，而下面 verify_behaviour 要求精确 `700` → 脚本自己 [FAIL] + exit 1。
#   （评审在服务端 coreutils 8.30 上实测四种写法：700/0700/u=rwx,go= 全是 2700，
#     只有 00700 与"再补一次 chmod a-s"能得到 700。）
#   这里用 00700，并在下面复位处**额外补一次 `chmod a-s`** 兜底 —— 两条都做是因为
#   这段代码的读者很可能第一眼看不出"五位 vs 四位"的差别，a-s 让意图自解释。
ADMIN_MODE=00700

failures=0
verdict() { # verdict <名称> <1=通过|0=失败> <失败说明>
  if [ "$2" = "1" ]; then echo "  [PASS] $1"; else echo "  [FAIL] $1（$3）"; failures=$((failures+1)); fi
}

need_root() { [ "$(id -u)" = "0" ] || { echo "请以 root 执行" >&2; exit 1; }; }

snapshot() {
  local out="/root/p3-perms-rollback-$(date +%Y%m%d-%H%M%S).txt"
  {
    echo "# 权限回滚清单（本脚本执行前抓取）：$REPO 与 /etc/p3blog"
    echo "# 逐行：chmod <mode> <path>   /   chown <owner>:<group> <path>"
    find "$REPO" -printf 'chmod %m %p\nchown %u:%g %p\n' 2>/dev/null | sort
    find "$ETC" -printf 'chmod %m %p\nchown %u:%g %p\n' 2>/dev/null | sort
  } > "$out"
  chmod 600 "$out"
  echo "  回滚清单：$out"
}

check() {
  echo "== 仓库顶层（期望 others 不可写）=="
  ls -ld "$REPO"
  ls -ld "$REPO"/blog-enter "$REPO"/deploy "$REPO"/p3-menu 2>/dev/null || true
  echo ""
  echo "== .admin（期望 0700 blog:blog）=="
  ls -ld "$ADMIN_DIR" 2>/dev/null || echo "  （不存在）"
  echo ""
  echo "== 密钥文件（期望 640 root:$PUBLIC_USER）=="
  ls -l "$SECRET" "$HEADER" 2>/dev/null || true
  echo ""
  echo "== 账号 =="
  getent passwd "$PUBLIC_USER" || echo "  $PUBLIC_USER 不存在（需要建）"
  echo ""
  echo "== 行为判据（契约④ + 反向保护；FAIL 会计入退出码）=="
  verify_behaviour
}

# 三条显式行为验证。为什么不能只比 ls 的权限位：
#   权限位是"声明"，而这三条是"行为"。收窄权限有两类翻车方式 ——
#   收不够（凭据仍可读）与收过头（发布流程写不了），
#   两者都只有真的去"以那个身份读/写一次"才能发现。
#   ⚠️ 脚本用不存在的用户执行 sudo -u 会直接报错，所以必须先判账号存在。
verify_behaviour() {
  local u="$PUBLIC_USER"
  if ! id -u "$u" >/dev/null 2>&1; then
    echo "  [SKIP] $u 尚未创建：三条行为验证都跑不了（先 useradd 再复跑本脚本 --check）"
    return 0
  fi

  # ① .admin 必须是 drwx------ blog blog —— 这一条是 S3 的核心资产
  local admin_line
  admin_line="$(ls -ld "$ADMIN_DIR" 2>/dev/null || echo '(missing)')"
  echo "  实测：$admin_line"
  if [ "$(stat -c '%a %U %G' "$ADMIN_DIR" 2>/dev/null)" = "700 $OWNER $OWNER" ]; then
    verdict ".admin 是 700 $OWNER:$OWNER" 1 ""
  else
    verdict ".admin 是 700 $OWNER:$OWNER" 0 "实际：$(stat -c '%a %U %G' "$ADMIN_DIR" 2>/dev/null)"
  fi

  # ② 公开进程必须**读不到** .admin 里的凭据（期望非 0）
  if sudo -u "$u" test -r "$ADMIN_DIR/passphrase.json"; then
    verdict "$u 读不到 .admin/passphrase.json" 0 "居然可读 —— S3 没修好"
  else
    verdict "$u 读不到 .admin/passphrase.json" 1 ""
  fi
  if sudo -u "$u" test -r "$ETC/proxy-secret"; then
    verdict "$u 读不到 /etc/p3blog/proxy-secret" 0 "居然可读 —— 管理面密钥泄漏给公开进程"
  else
    verdict "$u 读不到 /etc/p3blog/proxy-secret" 1 ""
  fi

  # ③ 公开进程**必须能读**代理密钥（否则后端 fail-fast exit 7 起不来）
  if [ -f "$SECRET" ]; then
    if sudo -u "$u" test -r "$SECRET"; then
      verdict "$u 能读 $SECRET（否则服务 exit 7）" 1 ""
    else
      verdict "$u 能读 $SECRET（否则服务 exit 7）" 0 "读不到 —— 检查是否 640 root:$u"
    fi
  else
    echo "  [SKIP] $SECRET 不存在（先做 PLAN 第 4 步）"
  fi

  # ④ 反向保护：blog 必须**仍然能写**仓库——否则发布流程被收窄弄坏
  local w1="$REPO/blog-enter/js/posts.js"
  local w2="$REPO/blog-enter/img/uploads"
  if [ -e "$w1" ]; then
    if sudo -u "$OWNER" test -w "$w1"; then verdict "$OWNER 仍能写 $w1" 1 ""; else verdict "$OWNER 仍能写 $w1" 0 "发布流程会被弄坏（检查目录 $DIRMODE / 文件 $FILEMODE）"; fi
  else
    echo "  [SKIP] $w1 不存在"
  fi
  if [ -e "$w2" ]; then
    if sudo -u "$OWNER" test -w "$w2"; then verdict "$OWNER 仍能写 $w2" 1 ""; else verdict "$OWNER 仍能写 $w2" 0 "图片上传目录不可写"; fi
  else
    echo "  [SKIP] $w2 不存在"
  fi
  if [ -d "$REPO/.git" ]; then
    if sudo -u "$OWNER" test -w "$REPO/.git"; then verdict "$OWNER 仍能写 .git（git 操作可用）" 1 ""; else verdict "$OWNER 仍能写 .git（git 操作可用）" 0 "PLAN 第 1 步的 git 操作会失败"; fi
  fi
}

main() {
  need_root
  echo "== 改动前 =="
  check
  snapshot

  echo ""
  echo "== 开始修正 =="
  # ② 专用账号（幂等）
  if ! id -u "$PUBLIC_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$PUBLIC_USER"
    echo "  已创建系统账号 $PUBLIC_USER"
  else
    echo "  $PUBLIC_USER 已存在（跳过 useradd）"
  fi

  # ① 仓库权限：去掉 others 可写；保持组可写（blog-publish / git 需要）。
  #    属主**写回 blog:blog**（幂等，不改属主归属，见文件头说明）。
  chown -R "$OWNER:$OWNER" "$REPO"
  find "$REPO" -type d -exec chmod "$DIRMODE" {} +
  find "$REPO" -type f -exec chmod "$FILEMODE" {} +
  echo "  仓库：目录 $DIRMODE / 文件 $FILEMODE，属主 $OWNER:$OWNER（去掉 0777 的 others 可写）"

  # .admin 必须保持只有管理面能进（700 blog:blog）——它是 S3 的核心资产。
  # ⚠️ 这一步**必须在**上面的 find -type d 之后：2775 会把 .admin 一起放开，
  #    漏了这一步就等于"修了外圈、把最里面的凭据目录留在组可写"。
  if [ -d "$ADMIN_DIR" ]; then
    chown "$OWNER:$OWNER" "$ADMIN_DIR"
    # 00700（五位）= 清 setuid/setgid/sticky + 权限位 700；0700（四位）清不掉 2775 留下的 setgid。
    chmod "$ADMIN_MODE" "$ADMIN_DIR"
    # 冗余兜底：即使有人把 ADMIN_MODE 改回四位，这一句也能保证特殊位被清掉。
    chmod a-s "$ADMIN_DIR"
    echo "  .admin：$(stat -c '%a' "$ADMIN_DIR") $OWNER:$OWNER（管理面运行时数据，公开进程不可读）"
  fi

  # ③ 密钥文件对 p3public 可读（否则后端 fail-fast exit 7）
  if [ -f "$SECRET" ]; then
    chown root:"$PUBLIC_USER" "$SECRET"
    chmod 640 "$SECRET"
    echo "  密钥：640 root:$PUBLIC_USER"
  else
    echo "  ⚠ $SECRET 不存在 —— 先做 PLAN 第 4 步（openssl rand -hex 32 …）再跑本脚本"
  fi
  # nginx 那份保持 600 root:root（worker 是 www，但由 root master 在解析期读）
  if [ -f "$HEADER" ]; then
    chown root:root "$HEADER"
    chmod 600 "$HEADER"
    echo "  头文件：600 root:root"
  fi

  echo ""
  echo "== 改动后 =="
  failures=0
  check
  echo ""
  echo "== 下一步 =="
  echo "  systemctl restart p3-public && systemctl is-active p3-public"
  echo "  期望：active。若失败且 journal 报密钥读不到 → 检查 SECRET 是否 640 root:$PUBLIC_USER"
  echo "  若 journal 报 SQLITE/权限无关的其它错，见 deploy/DEPLOY-RECORD.md 第 9 节"
  echo ""
  if [ "$failures" -gt 0 ]; then
    echo "== 结论：**FAIL**（$failures 条行为验证未通过）=="
    echo "  把这些行原样贴进 DEPLOY-RECORD，不要手改数字。"
    exit 1
  fi
  echo "== 结论：**PASS**（全部行为验证通过）=="
  echo "  把上面「改动前 / 改动后」两段 ls -ld 与这些 [PASS] 行贴进 DEPLOY-RECORD 第 9 节。"
}

case "${1:-}" in
  # --check 只打印现状、**不修改任何东西**；但它仍然按行为判据给出退出码，
  # 这样 t18 可以在"动手之前"把它当前置闸用（例如确认 p3public 还不存在、
  # 或确认 .admin 已经是 700）。恒 exit 0 的话它就只能看、不能自动化。
  --check) need_root; echo "== 现状 =="; failures=0; check; echo "";
           if [ "$failures" -gt 0 ]; then echo "== --check 结论：FAIL（$failures 条行为验证未通过）=="; exit 1; fi
           echo "== --check 结论：PASS =="; exit 0 ;;
  "") main ;;
  *) echo "用法：p3-fix-repo-perms [--check]" >&2; exit 2 ;;
esac
