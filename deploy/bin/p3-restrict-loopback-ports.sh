#!/usr/bin/env bash
# ============================================================
# p3-restrict-loopback-ports —— 给"只该在本机访问的端口"加防火墙兜底
# ------------------------------------------------------------
# 背景（审计 S7）：3306 / 8360 / 8848 / 8849 / 8850 这几个端口，
# 目前**全部**只绑 127.0.0.1（实测 ss -lntp），所以外网打不到。但这份"不可达"
# 完全押在两件事上：
#   1) mysqld 的 bind-address=127.0.0.1（/etc/my.cnf）
#   2) 各应用自己的启动硬校验（例如 public-server 拒绝非回环 --listen，exit 4）
# 任何一次配置漂移（面板里点一下"开放 3306"、手工起一个绕过 systemd 的实例、
# 改错 my.cnf）都会立刻把它们暴露到公网，而防火墙不会拦 —— 因为
# iptables 策略是 ACCEPT，且没有任何针对这些端口的规则。
#
# 这个脚本补上"第二条独立机制"：即便绑定漂了，包也进不来。
#
# 用法（在服务器上以 root 执行）：
#   p3-restrict-loopback-ports            # 加规则（幂等）
#   p3-restrict-loopback-ports --check    # 只检查现状，不改
#   p3-restrict-loopback-ports --remove   # 移除本脚本加的规则
#
# ⚠️ 三条不许踩的线（踩了会打断正在用的东西）：
#   1) **必须 append（-A），不能 insert（-I）**。面板 8888 的白名单规则由
#      p3-allow-8888.sh 用 `-I INPUT 1` 插在最前面；如果本脚本也插到最前，
#      DROOP 会排到白名单 ACCEPT 之前 —— 你自己的面板就进不去了。
#   2) **必须先放行回环**。3306/8849/8850 的正经访问全走 127.0.0.1
#      （nginx → 8850、p3-admin → 8849、应用 → 3306）。回环放行必须在 DROP 之前，
#      否则会把自己人挡在门外。
#   3) **必须放行已建立连接**（-m state --state ESTABLISHED,RELATED）。
#      nginx 与后端之间的长连接、正在跑的 SSH 会话都靠它。缺这条，
#      脚本执行的那一瞬间会把现有连接打断（SSH 掉线最吓人）。
# 这三条合起来的效果：新进来的、非回环的、目标是这几个端口的包被丢掉，
# 其余一律照旧（本脚本**不**改默认策略，也不动任何既有规则）。
# ============================================================
set -euo pipefail

RULES=/etc/p3blog/iptables.rules
PORTS='3306,8360,8848,8849,8850'
LO_CHAIN='P3_LOOPBACK_PORTS'          # 自定义链：便于整段移除，不污染 INPUT

need_root() {
  [ "$(id -u)" = "0" ] || { echo "请以 root 执行" >&2; exit 1; }
}

show_state() {
  echo "== 当前这些端口的监听情况 =="
  ss -lntp 2>/dev/null | grep -E ':(3306|8360|8848|8849|8850)\b' || echo "  （无监听）"
  echo ""
  echo "== INPUT 里与本脚本相关的规则 =="
  iptables -S INPUT | grep -E 'P3_LOOPBACK_PORTS' || echo "  （尚未加入）"
  iptables -S "$LO_CHAIN" 2>/dev/null | sed 's/^/  /' || echo "  （自定义链不存在）"
}

save_snapshot() {
  iptables-save > "$RULES"
  chmod 600 "$RULES"
  echo "  快照已更新：$RULES（p3-firewall.service 开机恢复的就是它）"
}

add_rules() {
  # 自定义链：把三条规则放进去，INPUT 只引用一次。
  # 这样做的好处是"移除"= 删一条引用 + 清空链，不会误删别人的规则。
  if ! iptables -L "$LO_CHAIN" -n >/dev/null 2>&1; then
    iptables -N "$LO_CHAIN"
    echo "  新建链 $LO_CHAIN"
  fi
  iptables -F "$LO_CHAIN"

  # ① 回环放行（必须在 DROP 之前）
  iptables -A "$LO_CHAIN" -i lo -j RETURN
  # ② 已建立/相关连接放行（保护 nginx 长连接与当前 SSH 会话）
  iptables -A "$LO_CHAIN" -m state --state ESTABLISHED,RELATED -j RETURN
  # ③ 其余打到这几个端口的包：丢掉，不回复（DROP 而不是 REJECT：
  #    不给扫描者"端口存在"的信号）
  iptables -A "$LO_CHAIN" -p tcp -m multiport --dports "$PORTS" -j DROP
  # ④ 本链只管这几个端口之外的东西一律返回给 INPUT 继续走
  iptables -A "$LO_CHAIN" -j RETURN

  # INPUT 里只引用一次，且用 **-A 追加**（见文件头第 1 条：绝不能 -I）
  if ! iptables -S INPUT | grep -q -- "-j $LO_CHAIN"; then
    iptables -A INPUT -j "$LO_CHAIN"
    echo "  INPUT 已追加引用 -> $LO_CHAIN"
  else
    echo "  INPUT 已有引用（幂等，跳过）"
  fi

  save_snapshot
  echo ""
  echo "== 加规则后 =="
  show_state
  echo ""
  echo "== 自检（下面 4 条应全部符合预期）=="
  echo "  1) 本机经回环访问 8850 仍应通："
  curl -s -o /dev/null -w '     127.0.0.1:8850/api/auth/me -> %{http_code}\n' \
    http://127.0.0.1:8850/api/auth/me || echo "     （服务未起，502/000 也可接受）"
  echo "  2) 3306 经回环仍应通："
  (timeout 3 bash -c 'cat < /dev/null > /dev/tcp/127.0.0.1/3306' \
    && echo "     127.0.0.1:3306 TCP 可连 ✓") || echo "     127.0.0.1:3306 TCP 连不上 ✗（回环放行没生效？）"
  echo "  3) 面板 8888 的白名单规则必须仍在（顺序在白名单之后）："
  iptables -S INPUT | grep 8888 | sed 's/^/     /' || echo "     （没有 8888 规则）"
  echo "  4) 公网侧应打不到这些端口（从**另一台机器**验证，本机回环测不出来）："
  echo "     nc -vz 43.108.100.116 8850   # 期望：超时或 refused，不是 succeeded"
}

remove_rules() {
  # 先删 INPUT 里的引用，再清空并删掉自定义链
  while iptables -S INPUT | grep -q -- "-j $LO_CHAIN"; do
    iptables -D INPUT -j "$LO_CHAIN"
  done
  if iptables -L "$LO_CHAIN" -n >/dev/null 2>&1; then
    iptables -F "$LO_CHAIN"
    iptables -X "$LO_CHAIN"
    echo "  已删除链 $LO_CHAIN 与 INPUT 里的引用"
  else
    echo "  链不存在，无需删除"
  fi
  save_snapshot
}

need_root
case "${1:-}" in
  --check)
    show_state
    ;;
  --remove)
    remove_rules
    ;;
  "")
    show_state
    echo ""
    echo "== 开始加规则 =="
    add_rules
    ;;
  *)
    echo "用法：p3-restrict-loopback-ports [--check|--remove]" >&2
    exit 2
    ;;
esac
