#!/usr/bin/env bash
# 在服务器上安装 Node.js（官方 tarball）
# 用途：Waline 评论系统 + 站点后台（dev-server.mjs）
#
# 为什么是 22 而不是 20：@waline/vercel 的 engines 是
#   "^20.19.0 || ^22.12.0 || ^24.0.0"
# 20.18.1 看着是 20.x 却**不满足**（差一个小版本），装完才发现要重来。
# dnf 只给到 nodejs:13 / nodejs:16，太旧，所以直接取官方 tarball。
# 幂等：已装同版本则跳过
set -euo pipefail

NODE_VER="v22.12.0"
ARCH="linux-x64"
PREFIX="/usr/local"
TARBALL="node-${NODE_VER}-${ARCH}.tar.xz"
MIRROR_PRIMARY="https://nodejs.org/dist"
MIRROR_FALLBACK="https://mirrors.aliyun.com/nodejs-release"

echo "==> 1/4 已有 node 检查"
if command -v node >/dev/null 2>&1; then
  cur="$(node --version)"
  echo "    已存在 node $cur"
  if [ "$cur" = "$NODE_VER" ]; then
    echo "    版本一致，跳过安装"
    SKIP_INSTALL=1
  fi
fi

if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  echo "==> 2/4 下载 Node $NODE_VER"
  cd /tmp
  rm -f "$TARBALL"
  if ! curl -fsSL --max-time 300 -O "$MIRROR_PRIMARY/$NODE_VER/$TARBALL"; then
    echo "    官方源失败，改用阿里云镜像"
    curl -fsSL --max-time 300 -O "$MIRROR_FALLBACK/$NODE_VER/$TARBALL"
  fi
  ls -lh "$TARBALL"

  echo "==> 3/4 解包到 $PREFIX"
  tar -xJf "$TARBALL" -C /usr/local --strip-components=1 \
      --exclude='CHANGELOG.md' --exclude='LICENSE' --exclude='README.md'
  echo "    node: $(node --version)   npm: $(npm --version)"
  rm -f /tmp/node-v*.tar.xz
fi

echo "==> 4/4 结果"
command -v node; command -v npm
node --version; npm --version
echo "NODE_INSTALL_DONE"
