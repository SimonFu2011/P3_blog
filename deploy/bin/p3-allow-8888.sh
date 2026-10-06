#!/usr/bin/env bash
# ============================================================
# p3-allow-8888 —— 维护宝塔面板（8888）的访问白名单
# ------------------------------------------------------------
# 背景：本机没有可用的防火墙管理器（firewalld 被宝塔停掉并禁用了），
# 所以端口限制落在 iptables 上，规则由 p3-firewall.service 在开机时恢复。
# 其中 8888 只允许「本机 + 白名单 IP」，白名单里的 IP 是**写死的** ——
# 你的家宽出口 IP 一变，就打不开面板了。这个脚本就是用来改它的。
#
# 用法（在服务器上以 root 执行）：
#   p3-allow-8888                 # 显示当前白名单与 8888 的规则
#   p3-allow-8888 add             # 把"当前 SSH 来源 IP"加进白名单
#   p3-allow-8888 add 1.2.3.4     # 加指定 IP
#   p3-allow-8888 del 1.2.3.4     # 移除指定 IP
#   p3-allow-8888 reset           # 只保留本机回环（最严）
#
# 提示：不方便的时候其实不需要它 —— 用 SSH 隧道最省事：
#   ssh -L 8888:127.0.0.1:8888 root@<服务器>
#   然后本机浏览器开 http://127.0.0.1:8888
# 回环流量永远被放行，与白名单无关。
# ============================================================
set -euo pipefail

RULES=/etc/p3blog/iptables.rules
[ -f "$RULES" ] || { echo "找不到 $RULES（p3-firewall 的快照）" >&2; exit 1; }

list_allow() {
  # `iptables -S INPUT` 的一行形如：
  #   -A INPUT -s 112.11.0.238/32 -p tcp -m tcp --dport 8888 -j ACCEPT
  # 空格分词后：$1=-A $2=INPUT $3=-s $4=<IP>/32 —— 所以取 $4。
  iptables -S INPUT | awk '/--dport 8888 -j ACCEPT/ && /-s / {print $4}' | sed 's#/32$##' | sort -u
}

show() {
  echo "当前 8888 放行的来源 IP（不含回环）："
  list_allow | sed 's/^/  /'
  echo ""
  echo "8888 相关规则："
  iptables -S INPUT | grep 8888 | sed 's/^/  /'
  echo ""
  echo "本机（服务器自己）通过回环访问不受此限制。"
}

save_snapshot() {
  iptables-save > "$RULES"
  chmod 600 "$RULES"
  echo "  快照已更新（重启后恢复的就是它）"
}

cmd="${1:-show}"

case "$cmd" in
  show|"")
    show
    ;;

  add)
    ip="${2:-}"
    if [ -z "$ip" ]; then
      ip="$(echo "${SSH_CLIENT:-}" | awk '{print $1}')"
      [ -n "$ip" ] || { echo "取不到当前 SSH 来源 IP，请显式指定：p3-allow-8888 add 1.2.3.4" >&2; exit 2; }
      echo "使用当前 SSH 来源 IP：$ip"
    fi
    case "$ip" in
      *[!0-9.]*) echo "看起来不是 IPv4：$ip" >&2; exit 2 ;;
    esac
    if iptables -C INPUT -s "$ip" -p tcp --dport 8888 -j ACCEPT 2>/dev/null; then
      echo "  $ip 已经在白名单里"
    else
      iptables -I INPUT 1 -s "$ip" -p tcp --dport 8888 -j ACCEPT
      echo "  已放行 $ip 访问 8888"
    fi
    # 同时也放行该 IP 的整体访问，避免它被后面的规则误伤
    iptables -C INPUT -s "$ip" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -s "$ip" -j ACCEPT
    save_snapshot
    echo ""
    show
    ;;

  del)
    ip="${2:-}"
    [ -n "$ip" ] || { echo "用法：p3-allow-8888 del 1.2.3.4" >&2; exit 2; }
    while iptables -C INPUT -s "$ip" -p tcp --dport 8888 -j ACCEPT 2>/dev/null; do
      iptables -D INPUT -s "$ip" -p tcp --dport 8888 -j ACCEPT
    done
    while iptables -C INPUT -s "$ip" -j ACCEPT 2>/dev/null; do
      iptables -D INPUT -s "$ip" -j ACCEPT
    done
    echo "  已移除 $ip"
    save_snapshot
    echo ""
    show
    ;;

  reset)
    for ip in $(list_allow); do
      while iptables -C INPUT -s "$ip" -p tcp --dport 8888 -j ACCEPT 2>/dev/null; do
        iptables -D INPUT -s "$ip" -p tcp --dport 8888 -j ACCEPT
      done
      while iptables -C INPUT -s "$ip" -j ACCEPT 2>/dev/null; do
        iptables -D INPUT -s "$ip" -j ACCEPT
      done
      echo "  已移除 $ip"
    done
    save_snapshot
    echo "  现在只有回环（本机）能访问 8888 —— 用 SSH 隧道访问面板。"
    ;;

  *)
    echo "用法：p3-allow-8888 [show|add [IP]|del IP|reset]" >&2
    exit 2
    ;;
esac
