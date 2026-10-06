# 方案 D：把管理后台放到云服务器上，做到「改完即上线」

> **这份文档是自包含的。** 下一个会话不需要之前对话的上下文，照着阶段 0→6 执行即可。
> 每一步都有验证命令和期望结果；代码改动按**函数名 + 锚点代码**定位（`PLAN-ADMIN-REMOTE.md`
> 用的是行号，那份的行号对应 commit `a081b03`，本仓库此后已有改动，行号会漂）。
>
> **执行前必须读第 3 节（风险）与 6.1（最关键的那个改动）。**
> 与 `deploy/PLAN-ADMIN-REMOTE.md`（方案 C）的关系：目标相同，但**前置条件与
> 数据落地方式不同**。方案 C 假设站点还没上线、并沿用 `git push` → `blog-publish`
> 的发布链路；实测站点已经上线、域名仍不可用，且要做到"实时"，那条链路太慢。
> 本方案以实测现状为准，是方案 C 的**替代品，不是补充**。照着做，不要两份都做。

---

## 1. 实测现状（本方案的全部前提，2026 年内实测）

| # | 事实 | 怎么测出来的 | 对本方案的影响 |
| --- | --- | --- | --- |
| 1 | 站点**已经上线**：`http://43.108.100.116/` 返回真正的个人站首页 | `web_fetch http://43.108.100.116/` → 200 + 站点标题 | 方案 C 里"还没建站"的记录已过期；发布链路本身是通的 |
| 2 | **443 没有监听**，即**没有 HTTPS** | `Test-NetConnection 43.108.100.116 -Port 443` → False | cookie 的 `Secure` 属性、`SameSite=None` 都不能用（见 6.1） |
| 3 | **域名仍不可用**：`simonfu.xin` NXDOMAIN | `Resolve-DnsName simonfu.xin -Type A -Server 8.8.8.8` → DNS name does not exist | 短期只能走 **IP + HTTP**；"IP 之上签证书"在公共 CA 那里走不通 |
| 4 | `8848` **不可达**（从公网） | `Test-NetConnection ... -Port 8848` → False | 服务端还没跑起来，或只绑了回环（这是预期状态） |
| 5 | **宝塔面板 8888 对公网开放** | `Test-NetConnection ... -Port 8888` → True | ⚠️ **先把这条堵掉再做别的**（见 3.1） |
| 6 | SSH 22 通；本机 `~/.ssh/known_hosts` 里有 `43.108.100.116`，但 `~/.ssh/config` 只配了 github | 读 `C:\Users\Simon\.ssh\config` | 你手工能 SSH 上去；**我（agent）连不上**，第 4 节的命令要么你跑，要么先配免密 |
| 7 | 仓库远端是 `https://github.com/SimonFu2011/P3_blog.git`，部署用户 `blog` | `deploy/bin/blog-bootstrap-bt.sh` 第 145 行 | 服务器已有的用户与路径 |
| 8 | 站点根目录由伪静态文件名推断：`/www/wwwroot/<第一个域名>` | 同上，第 52–53、83–89 行 | 建站时若第一个域名填的是 IP，根目录就是 `/www/wwwroot/43.108.100.116` —— 先探测确认 |
| 9 | 发布用户 `blog` 在 `www` 组里，站点根目录 `www:www` + `2775`（setgid） | 同上，第 170–185 行（脚本还带一条 `test -w` 自检） | `sudo -u blog blog-publish` 能写站点根目录 —— **实时发布靠的就是这条** |

> 第 1 条最重要：**站点已经能公开访问了**，所以本方案不是"从零上线"，
> 而是"把已经能用的本地写作工具，安全地接到已经上线的站点上"。

---

## 2. 目标：一句话与一张图

**一句话**：在浏览器里打开 `http://<站点>/_admin/`，输入口令，改文章、发文章，
**保存即生效**（刷新公开页面就能看到），不需要再回本地、不需要再敲 `blog-publish`。

```
Internet ──HTTP(80)──> 宝塔 nginx
                        │
                        ├── /  , /index.html …      → 静态站点 /www/wwwroot/<站点>   （不动，性能与缓存策略不变）
                        │
                        ├── /_admin/  ─┐
                        └── /api/     ─┴──proxy──> 127.0.0.1:8848
                                                     dev-server.mjs（systemd，User=blog）
                                                       ├── 写 blog-enter/js/posts.js
                                                       ├── 写 blog-enter/img/uploads/
                                                       └── 保存后自动跑 blog-publish（rsync 到站点根）
```

三条硬约束（都是现有设计里刻意的选择，本方案不推翻）：

1. **Node 永远只绑 `127.0.0.1`**。`resolveConfig` 里 `host` 写死，没有"顺手绑 0.0.0.0"的开关。
2. **管理页与 `/server/` 源码不发布到站点根目录**。发布脚本本来就排除它们，nginx 伪静态里那三条 404 是第二道防线 —— 反代之后它们**仍然必须保留**（见 7.1）。
3. **公开站点的路径不进 Node 进程**。只有 `/_admin/` 与 `/api/` 走反代，静态内容仍由 nginx 直接发。

---

## 3. 先说清楚代价与必须先做的事

### 3.1 【先做】关掉公网上的宝塔面板 8888

`8888` 现在对全世界开放。宝塔面板是**公网最常见的入侵入口**之一：面板一旦被拿到，
等于服务器 root。这件事与本方案无关，但风险等级高于本方案本身，**先处理它**：

```bash
# 在服务器上（或面板里操作，二者其一）
# 方案一：只允许你自己的出口 IP（最省事）
#   面板 → 安全 → 面板端口设置 → 授权域名/IP 白名单 → 填你的家宽/公司出口 IP
# 方案二：换端口 + 关掉公网（如果只在家用）
#   面板 → 设置 → 面板端口 → 改成随机高位端口
#   云安全组：删除 8888 的入方向规则
#   需要时用 SSH 隧道访问面板：
#     ssh -L 8888:127.0.0.1:8888 root@43.108.100.116
#     然后本机浏览器开 http://127.0.0.1:8888
```

验证：`Test-NetConnection 43.108.100.116 -Port 8888` 必须变成 **False**（或只对你的 IP 为 True）。

### 3.2 认下"纯 HTTP"这件事

在域名恢复、证书签发之前，管理页与口令**都在明文链路上**：

| 后果 | 说明 |
| --- | --- |
| 口令会被中间人看到 | 路径上的任何一跳（运营商、公共 WiFi、跳板机）都能读到 `POST /api/login` 的正文 |
| 会话 cookie 会被劫持 | HTTP 下 cookie 不能加 `Secure`；拿到 cookie 就等于拿到写权限，直到会话过期 |
| 内容会被篡改 | 中间人可以改你发出去的文章，你本地看到的是改过的版本 |

**因此**：本方案在纯 HTTP 阶段只推荐用于"临时、你的网络可信"的场景，且必须：
口令 ≥ 24 位随机串、登录限流、fail2ban、会话空闲超时调到 **2 小时以内**（见 6.1）。
**长期做法仍是把域名与证书弄好**（第 9 节），届时把 `--public-origin https://…` 一改，
`Secure` cookie 自动生效，风险回到可接受水平。

### 3.3 管理面从"本机"变成"公网可达"

| 变化 | 后果 | 本方案的应对 |
| --- | --- | --- |
| 出现口令爆破面 | 现有退避是**每 IP 内存计数、上限 30 秒、重启清零**，挡不住分布式猜测 | nginx `limit_req` + fail2ban（7.3）+ 24 位随机口令 |
| 攻击面扩大到全世界 | 管理页任何 XSS / 依赖问题 ≈ 内容写权限 | 保留现有 CSP（`security.ADMIN_CSP`）、令牌机制、正文 HTML 白名单校验 |
| 服务进程成为常驻写者 | 本地与服务端同时编辑会撞 | 已有乐观锁（版本号不符 → 409），见 6.5；再约定"服务器优先" |
| 本机其他进程可直连 8848 | 反代后对端恒为回环，"只允许回环"这道闸失效 | 共享密钥 `X-Admin-Proxy-Secret`（6.4） |

**好消息**：文章正文在保存时就过 `lib/validate.mjs`（`<script>`、事件属性、`javascript:` 一律拒），
所以即使拿到写权限，也不能直接往页面里塞任意 JS。

---

## 4. 阶段 0：前置核对（不改任何东西）

```bash
# 在服务器上执行。逐条记下结果，第 3、4、5 条决定后面能不能做。
ssh root@43.108.100.116

# 1) 站点根目录到底是哪个（第 1 节第 8 条）
ls -ld /www/wwwroot/*/ | head
grep -rn "root " /www/server/panel/vhost/nginx/*.conf | head
#   期望：找到 root 指向的那个目录，记为 WEB_ROOT

# 2) 仓库与发布链路还在不在
ls -d /srv/blog/repo/.git && sudo -u blog git -C /srv/blog/repo log -1 --oneline
which blog-publish && sudo -u blog test -w <WEB_ROOT> && echo "blog 可写站点根目录"
#   期望：打印 commit，且输出"blog 可写站点根目录"
#   若不可写：博客引导脚本的 2775/setgid 前提被面板改过，需重新 chown/chmod（见 10.3）

# 3) 有没有 Node（宝塔引导脚本只装 git/rsync/sudo，Node 要另装）
node --version 2>/dev/null || echo "没有 Node —— 必须先装"
#   期望：v18 以上。没有就装：
#     dnf module install -y nodejs:20/common     # Alibaba Cloud Linux / RHEL 系
#     或面板 → 软件商店 → Node.js 版本管理器 → 装 20 LTS

# 4) 有没有 systemd（有就能做常驻，没有就退回到 9.2 的 SSH 隧道方案）
systemctl --version | head -1

# 5) 密码学与限流组件
openssl version && nginx -v 2>&1 | head -1
ls /www/server/nginx/sbin/nginx    # 宝塔自带的 nginx 在这里，不在 /usr/sbin

# 6) 现状基线：站点 8 个公开路径先记下来，出问题好对比
for u in / /index.html /archive.html /article.html /about.html /404.html; do
  printf '%-16s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1$u)"; done
#   期望：全 200
```

**这一步不要动**：`/www/server/panel/vhost/rewrite/<站点>.conf` 里现有的规则。
阶段 3 只做**增改**（先备份）。

---

## 5. 阶段 1：让服务常驻（先只在本机验证，不碰 nginx）

先证明"能当服务跑"，再谈暴露。

```bash
# 0) 在服务器上备份当前状态（出事好回退）
cd /srv/blog/repo
sudo -u blog git status --short          # 期望：干净
sudo -u blog git log -1 --oneline
sudo -u blog git switch -c feat/live-admin    # 用分支隔离本次改动

# 1) 设口令（≥24 位随机串，随机生成，别用有语义的短语）
openssl rand -base64 24                   # 记下来，放进你的密码管理器
sudo -u blog node /srv/blog/repo/blog-enter/server/dev-server.mjs \
     --set-pass --pass '<刚才生成的串>'
#   期望：口令已设置（PBKDF2-SHA256 哈希存在 .admin/passphrase.json，不存明文）
```

`/etc/systemd/system/p3-admin.service`：

```ini
[Unit]
Description=P3_blog admin server (loopback-only, proxied by BT nginx)
After=network.target

[Service]
Type=simple
User=blog
Group=blog
WorkingDirectory=/srv/blog/repo
# 阶段 2 的代码改完后，这里再加 --remote / --public-origin / --trust-proxy / --proxy-secret-file
ExecStart=/usr/bin/node /srv/blog/repo/blog-enter/server/dev-server.mjs --port 8848
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
# 仓库要能写（posts.js / 备份 / 回收站）；站点根目录要能写（实时发布走 blog-publish 的 rsync）
ReadWritePaths=/srv/blog/repo /www/wwwroot
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

> `ReadWritePaths` 里的 `/www/wwwroot` 按第 4 节探测到的实际 `WEB_ROOT` 收窄，
> 能写成 `/www/wwwroot/43.108.100.116` 就不要写整个 `/www/wwwroot`。
> `node` 路径用 `which node` 的真实结果（宝塔装的常在 `/www/server/nodejs/vXX/bin/node`）。

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now p3-admin
journalctl -u p3-admin -n 20 --no-pager
#   期望：看到 "posts.js 解析通过：N 篇，…，版本 <hash>"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8848/_admin/   # 期望 200
sudo ss -lntp | grep 8848        # 期望 127.0.0.1:8848，**不是** 0.0.0.0:8848
```

---

## 6. 阶段 2：必须改的代码

改之前先确认在 `feat/live-admin` 分支上。下面每条都给出**锚点**（现有代码长什么样），
按锚点找位置，不要信行号。

### 6.1 【最关键】"已解锁"从"进程全局"改成"每客户端会话"

**现状（真实缺陷）**。`createApp` 里的这段：

```js
let unlocked = !(await auth.hasPassphrase(cfg.runtimeDir));
const unlock = () => { unlocked = true; };
```

于是：

1. 你在公网上登录一次 → `unlocked = true`（**整个进程**）；
2. 此后**任何人**请求 `GET /api/session`，都会拿到令牌 —— `on('GET', '/api/session', state)`
   返回的对象里直接带着 `token: session.token`；
3. 拿到令牌就能 `POST/PUT/DELETE` 写文章。

也就是说：**口令门一旦被你自己打开，就对全世界永久打开**，直到进程重启。
本地单用户场景下这无所谓；公网暴露下这是致命的。

**改法（推荐 A）**：

* 新增 `POST /api/login` 成功后的 `sessionId`：`crypto.randomUUID()`，用
  `Set-Cookie: admin_sid=<id>; HttpOnly; SameSite=Strict; Path=/` 下发。
  `Secure` 只在 `--public-origin https://…` 时加（HTTP 阶段加了浏览器直接不存，见 3.2）。
* 把 `unlocked` 从"布尔"改成 `sessions: Map<sessionId, { ip, createdAt, lastSeen }>`，
  空闲超时默认 **2 小时**（纯 HTTP 阶段）/ 12 小时（HTTPS 之后），带滑动续期。
* `ctx.unlocked` 按**该请求携带的 cookie**判定；取不到就是未解锁。
* `GET /api/session` 只在**当前请求已解锁**时返回 `token`，否则 `token: null`。
* 新增 `POST /api/logout`：删除该 `sessionId`，并回一个过期 cookie。
* `/_admin/token.js` 的判定同样换成"按 cookie 判定"（现在用的是全局 `unlocked`）。

**验收（必须做，别只看代码）**：两个不同的 cookie jar——

```bash
# A 登录
curl -s -c /tmp/a.jar -X POST http://127.0.0.1:8848/api/login \
     -H 'content-type: application/json' -d '{"passphrase":"<口令>"}'
# B（不带任何 cookie）必须拿不到令牌
curl -s http://127.0.0.1:8848/api/session | grep -o '"token":[^,}]*'   # 期望 "token":null
# B 的写请求必须被拒
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8848/api/posts \
     -H 'content-type: application/json' -d '{}'                        # 期望 401/403
```

### 6.2 远端模式下所有 `/api/*` 都要过解锁闸（含 GET）

**现状**。`handle()` 里这段：

```js
if (req.method !== 'GET') {
  if (path === '/api/login') { … } else {
    const gate = await auth.hasPassphrase(cfg.runtimeDir);
    if (gate && !unlocked) throw new HttpError(401, …);
    auth.requireToken(req, session);
    …
```

只有非 GET 才检查。于是未认证的 `GET /api/posts` 能读到**全部文章** ——
`store.clean()` 会保留 `isDraft` 与**完整 `body`**，所以**没发布的草稿是全文泄露**，
不只是标题。`/api/backups`、`/api/images`、`/api/git`、`/api/posts/one` 同样无认证。

**改法**：新增 `cfg.remote` 开关。`remote` 为真时，**所有** `/api/*`（除 `/api/login`）
都先过解锁闸；写操作再过令牌。本地模式行为**完全不变**（这样现有 48 项测试的语义不动）。

### 6.3 Host / Origin 白名单可配置

**现状**。`lib/security.mjs` 里：

```js
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
export const assertHost = (req, port) => { … if (!LOOPBACK.has(name)) throw new HttpError(403, 'host not allowed'); … };
export const assertSameOrigin = (req, port) => { … if (!LOOPBACK.has(host)) throw new HttpError(403, 'cross-origin request rejected'); … };
```

反代之后，浏览器发来的 `Host` 与 `Origin` 是真实站点（IP 或域名），会被 403。

**改法**：把 `LOOPBACK` 换成"允许集合 + 允许的 Origin 前缀"，由配置注入；
**默认值与现在完全一致**。

```js
// security.mjs：新增工厂，保留现有 guard 作为默认特例
export const makeGuard = ({ allowedHosts = LOOPBACK, allowedOrigins = null, proxySecret = null } = {})
  => (req, ctx) => { … };
export const guard = makeGuard();     // 行为不变
```

* `allowedHosts` = 回环名 ∪ `cfg.publicHosts`（CLI 给出的 IP 与域名）。
* 端口校验要放宽成"**端口不属于允许集合时才拒**"：反代场景 `Host: 43.108.100.116`
  无端口（现状已放行）、带 `:443`（HTTPS 后）都必须放行。
* `allowedOrigins` = 精确前缀集合，例如 `http://43.108.100.116`、`https://simonfu.xin`。
  给了 `allowedOrigins` 就只认它；**不要**为了省事放行任意 Origin。
* `proxySecret` 非空时，要求 `X-Admin-Proxy-Secret` 完全匹配，否则 403（见 6.4）。

### 6.4 信任反代：共享密钥 + 真实客户端 IP

反代后 `req.socket.remoteAddress` 恒为 `127.0.0.1`，于是：

* `isLoopbackPeer` 恒真 → **本机任何进程**（含被入侵的低权限服务）都能直连 8848 拿写权限；
* `ctx.ip`（`ip: (req.socket && req.socket.remoteAddress) || 'local'`）恒为 `127.0.0.1`
  → 口令失败退避与日志**全部失效**。

**改法**：

1. nginx 注入 `X-Admin-Proxy-Secret: <随机值>`（见 7.2）；应用启动时读
   `/etc/p3blog/proxy-secret`，**不匹配就 403**。这样即使本机其他进程知道端口也进不来。
2. `ctx.ip` 在 `--trust-proxy` 时取 `X-Forwarded-For` 的**最后一段**
   （nginx 用 `$proxy_add_x_forwarded_for` 追加真实 IP），否则保持 `remoteAddress`。
3. 密钥文件权限 `600 root:blog`，只在 `--proxy-secret-file` 指定时启用。

```bash
# 生成密钥（在服务器上）
sudo install -d -m 750 -o root -g blog /etc/p3blog
openssl rand -hex 32 | sudo tee /etc/p3blog/proxy-secret >/dev/null
sudo chown root:blog /etc/p3blog/proxy-secret && sudo chmod 600 /etc/p3blog/proxy-secret
```

### 6.5 远端模式强制要求口令，并且**保存即发布**

**5.1 强制口令**。`main()` 里现在只"提示"设口令：

```js
if (!needPass) {
  console.log('  提示：想再加一道本机口令锁：');
```

远端模式下必须**拒绝启动**（放在 `createApp` 之前）：

```js
if (cfg.remote && !(await auth.hasPassphrase(cfg.runtimeDir))) {
  console.error('远端模式必须设置口令：--set-pass --pass "…"');
  process.exit(4);
}
```

**5.2 保存即发布（"实时"的关键）**。`writePosts()` 已经集中处理"落盘 + 备份"，
在它成功返回前追加一步即可，**不要**散落在每个路由里：

```js
// writePosts(...) 末尾，成功写回之后
if (cfg.autoPublish) await publishToWebRoot();     // 见下
```

`publishToWebRoot()` 以 `blog` 身份跑既有的 `blog-publish`（它做 rsync 到站点根目录）：

```js
const { execFile } = await import('node:child_process');
const publishToWebRoot = () => new Promise((resolve, reject) => {
  execFile('/usr/local/bin/blog-publish', { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) { log('自动发布失败（内容已保存，可手工重跑 blog-publish）：', stderr || err.message); return resolve(); }
    log('已发布：' + String(stdout).trim().split('\n').pop());
    resolve();
  });
});
```

* **失败不阻塞保存**：内容已经安全落盘，发布失败只记日志（这一点很重要 ——
  rsync 失败不该让你以为文章没保存）。管理页上给个"上次发布失败"的提示更好。
* **参数以数组传、不过 shell**：沿用 `lib/git.mjs` 里已有的做法。
* **同一时刻只跑一个 rsync**：加个模块级的 `let publishing = null` 做串行化，
  连续保存两次不要并发 rsync 同一个目录。
* `--auto-publish` 作为开关，本地模式不开（本地没装 `blog-publish`）。

> 为什么不做"直接把 nginx 根目录指到仓库里的 `blog-enter/`"：那样 `server/`、
> `admin/`、`.admin/`、测试文件会**和站点同处一个目录**，安全全靠 nginx 那几条 404
> 规则兜着 —— 面板每次改站点设置都可能重生成主配置。rsync 出去一份**只有公开产物**
> 的目录，才是把边界放在文件系统上而不是配置里（这也是原设计的思路，见
> `blog-publish.sh` 里 "什么算公开产物" 的定义）。

### 6.6 SIGTERM 已经在处理，但补两处

`main()` 末尾已有 `process.on('SIGTERM', shutdown)`，**不需要再加**。
但远端常驻要补：

* `server.close()` 之后清掉会话清理定时器（否则 `setTimeout`/`setInterval` 会让进程不退出）；
* 启动时打印**监听地址与是否远端模式**，方便 `journalctl` 一眼确认没暴露在 0.0.0.0。

### 6.7 新增 CLI 参数（加在 `main()` 现有的 `value()/flag()` 体系里）

| 参数 | 作用 |
| --- | --- |
| `--remote` | 远端模式：强制口令；所有 `/api/*` 需解锁（6.2） |
| `--public-host <IP 或域名>` | 可重复；加入 Host 白名单（6.3） |
| `--public-origin <http(s)://…>` | 可重复；加入 Origin 白名单，同时决定 cookie 是否加 `Secure`（6.1、6.3） |
| `--session-idle <分钟>` | 会话空闲超时，默认 120（HTTP）/ 720（HTTPS） |
| `--trust-proxy` | 从 `X-Forwarded-For` 取客户端 IP（6.4） |
| `--proxy-secret-file <路径>` | 校验 nginx 注入的密钥（6.4） |
| `--auto-publish` | 保存后自动跑 `blog-publish`（6.5.2） |
| `--publish-cmd <路径>` | 覆盖发布命令，默认 `/usr/local/bin/blog-publish` |

### 6.8 测试必须同步改（否则等于把判据删了）

新建 `blog-enter/server/tests/remote-mode.test.mjs`（**不要**改 `api.test.mjs` 里
现有的语义，那 48 项是"本地模式不变"的保证）：

| # | 用例 | 期望 |
| --- | --- | --- |
| 1 | `--public-host 43.108.100.116` 下 `Host: 43.108.100.116` + 正确密钥 | 放行 |
| 2 | 同上但**不带** `X-Admin-Proxy-Secret` | **403**（证明本机进程也进不来） |
| 3 | `Origin: http://43.108.100.116` | 放行；`Origin: http://evil.example` → 403 |
| 4 | 远端模式未设口令 | 进程退出码 **4** |
| 5 | **6.1 的核心验收**：A 登录后，B 的 `GET /api/session` → `token: null` |
| 6 | 远端模式下未解锁 `GET /api/posts` | **401**（草稿不再泄露） |
| 7 | 本地模式（无 `--remote`）下既有行为 | 与改动前**完全一致** |

`api.test.mjs` 里这几条断言的是"回环边界"，改了白名单后必须**继续成立**：
`Host: evil.example` → 403；`Host: 127.0.0.1:1`（端口不符）→ 403；
`Origin: http://evil.example` → 403；`Sec-Fetch-Site: cross-site` → 403。

```bash
node blog-enter/server/tests/run-all.mjs      # 48 项 + 新增，必须全绿
```

---

## 7. 阶段 3：宝塔 nginx 反代 + 加固

改的是 `/www/server/panel/vhost/rewrite/<站点>.conf`（就是面板里的"伪静态"）。
**这个文件被 include 在 server 块最前面**，所以既能放 `location`，也能放 server 级指令；
而且**面板重新生成主配置时不会覆盖它**。改前先备份：

```bash
cp -a /www/server/panel/vhost/rewrite/<站点>.conf{,.bak-$(date +%F)}
```

### 7.1 必须先删掉一条现在生效的规则

为堵暴露加的这条，会跟反代直接冲突：

```nginx
location ^~ /_admin/ { return 404; }      # ← 删掉它
location ^~ /admin/  { return 404; }      # ← 保留！
location ^~ /server/ { return 404; }      # ← 保留！
location ~* \.(mjs|cjs)$ { return 404; }  # ← 保留！
```

`/admin/`（无下划线）与 `/server/` 的 404 **必须保留**：管理页文件与本地服务代码
**不发布到站点根目录**，这几条是"万一有人拷进去了"的第二道防线。

### 7.2 反代块

```nginx
# ---- 管理页与接口：只反代这两个前缀，站点其余部分仍是纯静态 ----
location ^~ /_admin/ {
    proxy_pass http://127.0.0.1:8848;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Admin-Proxy-Secret "<把 /etc/p3blog/proxy-secret 的内容粘这里>";
    proxy_read_timeout 30s;
    expires -1;
    add_header X-Robots-Tag "noindex, nofollow" always;
}

location ^~ /api/ {
    proxy_pass http://127.0.0.1:8848;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Admin-Proxy-Secret "<同上>";
    client_max_body_size 12m;     # 图片上传走这个前缀
    proxy_read_timeout 60s;
}
```

> ⚠️ **`add_header` 不继承**：伪静态文件底部那三条安全头
> （nosniff / X-Frame-Options / Referrer-Policy）在**同一个 server 块**里；
> 只要上面这两个 location 里出现一条 `add_header`，server 级那三条就**全部作废**。
> 二选一：① 在这两个 location 里把三条安全头重写一遍；② 干脆不写 `add_header`，
> 只用 `expires` 做缓存控制。**这是本项目已经踩过一次的坑**（`deploy/bt/nginx-locations.conf`
> 第 36–42 行专门写了注释），别踩第二次。

### 7.3 登录限流（`limit_req_zone` 必须写在 `http{}`）

宝塔的 http 级指令在 `/www/server/nginx/conf/nginx.conf`：

```nginx
limit_req_zone $binary_remote_addr zone=admin_login:10m rate=10r/m;
```

然后在伪静态里给登录接口单独收口：

```nginx
location = /api/login {
    limit_req zone=admin_login burst=3 nodelay;
    limit_req_status 429;
    proxy_pass http://127.0.0.1:8848;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Admin-Proxy-Secret "<同上>";
}
```

### 7.4 fail2ban

```ini
# /etc/fail2ban/jail.d/p3-admin.conf
[p3-admin]
enabled  = true
port     = http,https
filter   = p3-admin
logpath  = /www/wwwlogs/<站点>.log
maxretry = 5
findtime = 600
bantime  = 3600
```

```ini
# /etc/fail2ban/filter.d/p3-admin.conf
[Definition]
failregex = ^<HOST> .* "(POST|GET) /api/login .*" (401|429)
```

应用侧退避（`lib/auth.mjs` 里每 IP、上限 30s、内存态）作为**第二层**，别当主力。

### 7.5 生效与自检

```bash
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
```

### 7.6 把 systemd 的启动参数补齐（6.7 的参数就位之后）

```ini
ExecStart=/usr/bin/node /srv/blog/repo/blog-enter/server/dev-server.mjs \
  --port 8848 --remote \
  --public-host 43.108.100.116 \
  --public-origin http://43.108.100.116 \
  --session-idle 120 \
  --trust-proxy --proxy-secret-file /etc/p3blog/proxy-secret \
  --auto-publish
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart p3-admin
journalctl -u p3-admin -n 30 --no-pager
```

> 域名与证书就绪后，只需在这里**追加** `--public-host simonfu.xin --public-host www.simonfu.xin`
> 与 `--public-origin https://simonfu.xin`（`--public-origin` 一旦是 https，cookie 自动带 `Secure`），
> 然后 `restart`。代码不用再改。

---

## 8. 阶段 4：验收清单

**A. 认证边界（最关键）**

```bash
S=http://43.108.100.116

# 1) 未登录：拿不到令牌
curl -s $S/api/session | grep -o '"token":[^,}]*'                 # 期望 "token":null
# 2) 未登录：读不到文章（含草稿全文）
curl -s -o /dev/null -w '%{http_code}\n' $S/api/posts             # 期望 401
# 3) 未登录：写不了
curl -s -o /dev/null -w '%{http_code}\n' -X POST $S/api/posts \
     -H 'content-type: application/json' -d '{}'                  # 期望 401
# 4) 伪造 Host（DNS rebinding）
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example' $S/api/posts   # 期望 403
# 5) 【6.1 核心】A 登录后，另一个客户端仍拿不到令牌
curl -s -c /tmp/a.jar -X POST $S/api/login -H 'content-type: application/json' \
     -d '{"passphrase":"<口令>"}'                                  # 期望 ok
curl -s $S/api/session | grep -o '"token":[^,}]*'                  # 期望 "token":null
# 6) 本机直连 8848（绕过 nginx，缺密钥）
sudo -u blog curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8848/_admin/   # 期望 403
# 7) 登录限流
for i in $(seq 1 15); do curl -s -o /dev/null -w '%{http_code} ' -X POST $S/api/login \
     -H 'content-type: application/json' -d '{"passphrase":"wrong"}'; done; echo   # 期望很快出现 429
```

**B. 公开站点未被影响**（与第 4 节第 6 条的基线逐条对比）

```bash
for u in / /index.html /archive.html /article.html /about.html /404.html /css/style.css /js/posts.js; do
  printf '%-22s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' $S$u)"; done   # 期望全 200
curl -s -o /dev/null -w '%{http_code}\n' $S/admin/                  # 期望 404
curl -s -o /dev/null -w '%{http_code}\n' $S/server/dev-server.mjs   # 期望 404
curl -s -o /dev/null -w '%{http_code}\n' $S/ADMIN.md                # 期望 404
curl -sI $S/js/posts.js | grep -i cache-control                     # 期望 max-age 很短（5 分钟级）
```

**C. 功能回归（本机跑）**

```bash
node blog-enter/server/tests/run-all.mjs            # 全绿
node blog-enter/server/dev-server.mjs               # 本地模式行为与改动前完全一致
node blog-enter/server/tests/verify-admin-ui.mjs    # 需要本地起服务 + Chrome
```

**D. 端到端「保存即上线」**（本方案的真正验收）

1. 浏览器开 `http://43.108.100.116/_admin/`，输入口令；
2. 新建一篇文章，填标题/正文，**保存**；
3. **不要**跑任何命令，直接在另一个标签页刷新 `http://43.108.100.116/archive.html`
   → 新文章应该在列表里（`posts.js` 缓存 5 分钟，若没出现等一会或强刷）；
4. 打开详情页 → 正文与图片正常；
5. 在管理页删掉它 → 刷新 → 列表恢复；
6. 服务器上 `sudo -u blog git -C /srv/blog/repo status --short` → **应该看到 posts.js 被改动**
   （说明服务器成了写入方，见 8.5）。

**E. 两边同时编辑不再互相覆盖**（已有乐观锁，确认它还在）

管理页 A 打开某篇文章 → 管理页 B 也打开同一篇 → A 保存成功 → B 保存
→ B 应该收到 **409**（"posts.js 在别处被改动过…请刷新后重试"），而不是静默覆盖。

---

## 9. 阶段 5：写入方与版本控制（想清楚再决定）

服务器现在**能写 `posts.js`** 了。`blog-publish` 里是：

```bash
git fetch --prune origin
git checkout -q -B "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"
```

**危险**：`git reset --hard` 会把你**刚在服务器上写的文章硬回退掉**。
所以 6.5.2 的自动发布**只跑 rsync 那一段**，还是根本不该跑 `blog-publish`？

两条路，**必须选一条并写进文档**：

### 9.1 推荐：服务器改为"先 commit，再同步"

把 `blog-publish.sh` 改成：

1. 有未提交改动时，**先 `git add` + `git commit`**（`posts.js` 与 `img/uploads/`），
   提交信息里带上"web 管理页"字样；
2. 删掉 `git reset --hard`，改为 `git fetch && git merge --ff-only origin/$BRANCH`：
   没有本地提交时就是快进；**有本地提交时不覆盖**，改为先 push（需要写权限，见下）
   或直接报错让人处理；
3. rsync 那一段保持不变。

服务器要能 push，需要一把**有写权限的 Deploy Key**：

```bash
sudo -u blog ssh-keygen -t ed25519 -f /home/blog/.ssh/id_ed25519 -N ''
sudo cat /home/blog/.ssh/id_ed25519.pub
# 贴到 GitHub 仓库 → Settings → Deploy keys → Add，并勾选 "Allow write access"
sudo -u blog ssh -T git@github.com    # 可能需要 ssh.github.com:443（见本机 ~/.ssh/config 的写法）
```

之后本地机器只做 `git pull`（当作只读备份/预览），**服务器是唯一写入方**。
这是"两边都能写必然冲突"的解法。

### 9.2 备选：本轮不碰 git 工作流

自动发布只做 rsync；服务器上的改动**不提交**。代价：
`git status` 常年是脏的，某天你手工跑一次 `blog-publish` 就会**丢掉服务器上的文章**。

> 如果选这条，**至少**把 `blog-publish.sh` 里的 `git reset --hard` 删掉，改成
> "有本地未提交改动就停下来报错"。别把它留在那里当定时炸弹。

### 9.3 别忘了改文档

`blog-enter/ADMIN.md` 第 3 节现在写着"管理页只存在于本地进程，静态发布时没有它们"
以及"**没做的**：没有把管理页做成带登录的后台"。本方案让这两句话变成假话。
实施的同时**必须更新这一节**：写清新的边界（公网可达 + 每客户端会话 + 代理密钥）、
纯 HTTP 阶段的风险、以及"服务器是唯一写入方"这个前提。
否则下一个人（包括未来的你）会照着错误的威胁模型做判断。

---

## 10. 阶段 6：回滚

### 10.1 五分钟回到"管理页不在公网"

```bash
sudo systemctl disable --now p3-admin
cp -a /www/server/panel/vhost/rewrite/<站点>.conf.bak-<日期> \
      /www/server/panel/vhost/rewrite/<站点>.conf
# 若备份不可用，手工把这条加回去（恢复成"管理页不存在于网络"的状态）：
#   location ^~ /_admin/ { return 404; }
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
```

复验：`http://43.108.100.116/_admin/` → **404**，公开站点 8 个路径全 200。

### 10.2 代码回滚

```bash
cd /srv/blog/repo && sudo -u blog git switch main && sudo -u blog git branch -D feat/live-admin
# 重启前先确认 systemd 里没有再引用新参数（否则会以"未知参数"启动失败）
```

### 10.3 内容回滚

| 场景 | 做法 |
| --- | --- |
| 刚保存完发现写错了 | 管理页「备份 / 图片 / 日志」→ 选上一份 → 恢复（`.admin/backups/`，滚动 20 份） |
| 误删了文章 | 内容在 `.admin/trash/`，把 JSON 字段粘回管理页 |
| 服务器上被 live 后台改乱了 | `sudo -u blog git -C /srv/blog/repo checkout -- blog-enter/js/posts.js`（前提：9.1 还没做 commit） |
| 站点根目录被 rsync 弄脏 | 重新 `sudo -u blog blog-publish`（它会 `--delete` 对齐） |
| `blog` 突然写不了站点根目录 | 面板改站点设置可能重置属主：`chown -R www:www <WEB_ROOT> && find <WEB_ROOT> -type d -exec chmod 2775 {} +`，并确认 `blog` 在 `www` 组里（`id blog`） |

---

## 11. 更省事的等价方案：SSH 隧道（**推荐先拿它跑通**）

如果目的只是"出门也能写文章"，**在 6.1/6.2/6.3/6.4 全部跳过**的前提下，
今天就能用，且**不新增任何公网攻击面**：

```powershell
# 本地开隧道（服务器上 dev-server 已由阶段 1 常驻）
ssh -L 8848:127.0.0.1:8848 blog@43.108.100.116
# 然后浏览器开 http://127.0.0.1:8848/_admin/
```

**为什么一行代码都不用改**：请求从隧道进来，对本机而言对端仍是回环、`Host` 仍是
`127.0.0.1`，现有三道闸（对端 / Host / 同源）**全部满足**。

| 维度 | SSH 隧道 | 方案 D（本方案主体） |
| --- | --- | --- |
| 公网攻击面 | **零**（8848 不出网） | 有一个管理面（需限流 + fail2ban + 强口令） |
| 手机/平板能用吗 | 需要 SSH 客户端（Android 有 Termux/JuiceSSH） | 任何浏览器 |
| 代码改动 | 无 | 6.1–6.7（约 300–400 行 + 测试） |
| "保存即上线" | 仍需 6.5.2 那一步（或手工 `blog-publish`） | 同 |
| HTTPS 依赖 | 不需要 | 纯 HTTP 阶段是已知弱点（3.2） |

> **建议的执行顺序**：先做阶段 1 + 6.5.2（这两步让"隧道方案"完整可用，
> 且它们是本方案两个主体方案共同的地基），**先跑通隧道**；确认好用之后，
> 再决定要不要花 6.1–6.4 的工夫把它变成"任意浏览器可达"。

---

## 12. 域名与证书（把 3.2 的弱点彻底消掉）

`simonfu.xin` 现在 NXDOMAIN。恢复它需要（**不在本方案范围内，但要记着**）：

```powershell
# 1) 阿里云 → 域名 → 域名列表 → 看 simonfu.xin 的状态提示（是否仍是 clientHold / 未实名）
# 2) 云解析加两条 A 记录
#    @    A    43.108.100.116    600
#    www  A    43.108.100.116    600
Resolve-DnsName simonfu.xin -Type A -Server 8.8.8.8       # 期望 43.108.100.116
```

```bash
# 3) 服务器上让 nginx 认这个域名（宝塔 → 网站 → 设置 → 域名管理 → 添加）
#    注意：站点根目录**不要**因为加域名而改变
# 4) 面板 → SSL → Let's Encrypt → 勾选 simonfu.xin + www → 申请 → 强制 HTTPS
curl -I https://simonfu.xin/                              # 期望 200
```

证书就绪后：`--public-origin https://simonfu.xin` 一加，cookie 自动带 `Secure`，
`--session-idle` 可以放回 720（12 小时），3.2 那张表的风险回到可接受水平。

---

## 13. 执行顺序总表（照这个顺序做）

| 序 | 做什么 | 对应章节 | 卡点 |
| --- | --- | --- | --- |
| 1 | 关掉公网 8888 | 3.1 | **先做这个** |
| 2 | 前置核对（尤其：有没有 Node、站点根目录是哪个） | 4 | 没 Node 就先装 |
| 3 | 设口令、起 systemd、本机验证 | 5 | |
| 4 | 改代码：6.5.2（保存即发布）+ 6.7 里 `--auto-publish` | 6.5.2、6.7 | 这步让隧道方案立刻可用 |
| 5 | 用 SSH 隧道（11 节）**先跑通**，确认好用 | 11 | 不需要改认证代码 |
| 6 | 决定要不要做"任意浏览器可达" | 6.1–6.4、6.8 | 要动认证边界，测试必须同步 |
| 7 | 反代 + 限流 + fail2ban | 7 | 注意 `add_header` 不继承的坑 |
| 8 | 全套验收 | 8 | A/B/D/E 一条都不能省 |
| 9 | 决定写入方（9.1 还是 9.2），改 `blog-publish.sh` 并**改 ADMIN.md** | 9 | 不改就是定时炸弹 |
| 10 | （有空时）域名 + 证书 | 12 | 消掉纯 HTTP 的风险 |

---

## 14. 附：为什么不用"最省事"的那种做法

「把 `blog-enter/admin/` 拷进站点根目录，加一个前端密码框」——**这是纯粹的假安全**：

1. 静态站点没有服务端，密码校验只能在 JS 里做，`view-source` 就能绕过；
2. 写接口不存在，页面根本存不了文章（管理端需要 `/api/*`，那是 Node 进程提供的）；
3. 一旦拷进去，`posts.js`（含草稿）与整个后台 UI 一起对外可读 —— **这不是假设**：
   本项目就发生过一次，`/blog-enter/admin/` 与 `/blog-enter/server/dev-server.mjs`
   曾被公网直接下载，已清理并在 nginx 上补了 `/_admin/` 的 404 兜底
   （见 `PLAN-ADMIN-REMOTE.md` 第 13 节与 `blog-publish.sh` 第 50–58 行那段注释）。

所以要么走本方案（真有一个服务端进程 + 反向代理 + 真认证），
要么走第 11 节的 SSH 隧道（管理面根本不进公网）。

---

## 15. 附：本方案涉及的文件

| 路径 | 角色 |
| --- | --- |
| `blog-enter/server/dev-server.mjs` | 服务入口；改 6.1/6.2/6.5/6.6/6.7 |
| `blog-enter/server/lib/security.mjs` | 对端/Host/Origin/代理密钥判定；改 6.3/6.4 |
| `blog-enter/server/lib/auth.mjs` | 会话、口令哈希、失败退避；改 6.1 |
| `blog-enter/server/tests/remote-mode.test.mjs` | **新增**，6.8 的 7 条判据 |
| `blog-enter/server/tests/api.test.mjs` | **不改语义**，只确认既有断言仍成立 |
| `blog-enter/ADMIN.md` | 第 3 节必须随边界变化改写（9.3） |
| `/etc/systemd/system/p3-admin.service` | 服务器上新增（阶段 1、7.6） |
| `/www/server/panel/vhost/rewrite/<站点>.conf` | 宝塔伪静态，反代与限流（阶段 3） |
| `/etc/p3blog/proxy-secret` | 反代共享密钥，`600 root:blog`（6.4） |
| `/etc/fail2ban/jail.d/p3-admin.conf` | 登录爆破封禁（7.4） |
| `deploy/bin/blog-publish.sh` | 9 节：去掉 `git reset --hard`，改"先 commit 再同步" |
| `deploy/PLAN-ADMIN-REMOTE.md` | 方案 C，**被本方案取代**；保留作历史记录 |
