# 方案 C：把管理页放到公网（本地工具 → 可用 HTTPS 访问的后台）

> **这份文档是自包含的。** 下一个会话不需要之前对话的上下文，照着阶段 0→6 执行即可。
> 每一步都有验证命令和期望结果；代码改动精确到文件、函数与行号（行号以
> commit `a081b03` 为准，改动前先 `git log -1` 核对）。
>
> **执行前必须读第 3 节（风险）和第 6.1 节（最关键的那个改动）。**
> 现状下直接把服务暴露到公网，任何人都能在你登录后拿到写权限。

---

## 1. 结论与硬依赖

目标：`https://<域名>/_admin/` 打开管理页，在任何机器上都能写文章。

**硬依赖（缺一个都做不了，先逐条核对）：**

| # | 依赖 | 当前状态 | 验证命令 |
| --- | --- | --- | --- |
| 1 | 域名解析生效 | ❌ `simonfu.xin` 仍是 `clientHold`/NXDOMAIN | `Resolve-DnsName simonfu.xin -Type A -Server 8.8.8.8` |
| 2 | HTTPS 证书可用 | ❌ 443 无监听 | `curl -I https://simonfu.xin/` |
| 3 | 服务器装 Node.js ≥ 18 | ❌ 服务器上还没有 Node | `node --version` |
| 4 | 服务器能**写** GitHub（阶段 4 用） | ❌ 目前只有只读公开 clone | `ssh -T git@github.com` |

> **第 1 条是硬阻断。** 在域名解析生效并签好证书之前不要开始——
> 明文 HTTP 上的管理后台，口令与会话令牌在链路上裸奔，等于没有认证。
> 若只想"先能远程写"，请改做第 11 节的 VPN/隧道方案（不需要域名）。

---

## 2. 目标架构

```
Internet ──HTTPS──> nginx（宝塔自带，443）
                      │
                      ├── /                     → 静态站点 /www/wwwroot/43.108.100.116（不动）
                      ├── /_admin/  ─┐
                      └── /api/     ─┴─proxy──> 127.0.0.1:8848
                                                  dev-server.mjs（systemd，User=blog）
                                                    ├── 写 blog-enter/js/posts.js
                                                    ├── 写 blog-enter/img/uploads/
                                                    └── git add/commit（阶段 4 加 push）
```

要点：

* **只有 `/_admin/` 和 `/api/` 走反代**，公开站点仍由 nginx 直接发静态文件（性能、缓存策略都不变）。
* **Node 永远只绑 `127.0.0.1`**（`resolveConfig` 里 `host` 写死，`dev-server.mjs:88`）。不要为了省事改成 `0.0.0.0`——那会绕过 `security.guard` 的对端判定。
* 管理页的文件（`blog-enter/admin/`）**不发布到站点根目录**，只由 Node 进程按白名单读（`ADMIN_ASSETS`，`dev-server.mjs:73`）。

---

## 3. 先说清楚放弃了什么

项目原本的设计（`blog-enter/ADMIN.md` 第 3 节）是「本机文件系统 + git 权限」当边界，
并明确写了不做带登录的后台，理由是"纯静态站点前端做鉴权是假安全"。方案 C 改变这个边界，
代价要认：

| 变化 | 后果 |
| --- | --- |
| 管理页从"不存在于网络"变成"公网可达" | 出现**口令爆破面**。现有退避是**每 IP 内存计数、上限 30 秒、重启即清零**，挡不住分布式猜测 |
| 攻击面从"本机"扩大到"全世界" | 任何 admin 页 XSS / 依赖漏洞都直接等于**内容写权限** |
| 服务进程成为常驻写者 | 服务器仓库从"只读镜像"变成"可写工作副本"，两边同时编辑会产生 git 冲突 |

**因此阶段 3 的加固不是可选项**，至少要选一个：**mTLS 客户端证书 / IP 白名单 / VPN**。
只靠口令，等同于把一个弱限流的登录页挂到公网。

**减轻风险的好消息**：文章正文 HTML 在保存时就过 `lib/validate.mjs`（脚本标签、事件属性、
`javascript:` 一律拒），所以拿到写权限也不能直接塞任意 JS 进页面。

---

## 4. 阶段 0：前置条件

```bash
# 1) 域名与证书（在域名实名认证通过、clientHold 解除之后）
Resolve-DnsName simonfu.xin -Type A -Server 8.8.8.8     # 期望 43.108.100.116
# 面板 → 网站 → 43.108.100.116 → SSL → Let's Encrypt → 申请 → 强制 HTTPS
curl -I https://simonfu.xin/                            # 期望 200

# 2) 服务器装 Node（Alibaba Cloud Linux 3 / RHEL 系）
sudo dnf module list nodejs
sudo dnf module install -y nodejs:20/common             # 或 NodeSource 源装 22
node --version                                          # 期望 v20.x / v22.x

# 3) 确认现有站点没被这一步影响
curl -sI http://43.108.100.116/ | head -1                # 期望 200
```

**这一步不要动**：`/www/server/panel/vhost/rewrite/43.108.100.116.conf` 里现有的规则
（挡 admin/server、缓存、404）。阶段 3 只做**增改**。

---

## 5. 阶段 1：让服务以 systemd 常驻（先只在本机验证）

先不改代码，确认"能当服务跑"。

`/etc/systemd/system/p3-admin.service`：

```ini
[Unit]
Description=P3_blog admin server (local-only bind, proxied by nginx)
After=network.target

[Service]
Type=simple
User=blog
Group=blog
WorkingDirectory=/srv/blog/repo
# 注意：这里只加 --port，代码改动在阶段 2 之后才加 --remote / --public-host 等参数
ExecStart=/usr/bin/node /srv/blog/repo/blog-enter/server/dev-server.mjs --port 8848
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=/srv/blog/repo
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now p3-admin
journalctl -u p3-admin -n 20 --no-pager          # 期望看到"posts.js 解析通过：N 篇"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8848/_admin/   # 期望 200
sudo ss -lntp | grep 8848                        # 期望只监听 127.0.0.1:8848，不是 0.0.0.0
```

> 服务用 `User=blog`：它必须能写 `/srv/blog/repo`（仓库已属主 `blog:blog`）。
> `.admin/` 运行时目录在仓库内且已 gitignore，无需额外处理。

---

## 6. 阶段 2：必须改的代码

改之前先备份分支：`git switch -c feat/remote-admin`。

### 6.1 【最关键】解锁状态从"进程全局"改成"每客户端"

**现状（真实缺陷）**：`dev-server.mjs:118` 是 `let unlocked = false`，`unlock()` 把整个
**进程**置为已解锁。于是：

1. 你在公网上登录一次 → `unlocked = true`；
2. 此后**任何人**请求 `GET /api/session`，都会拿到 `token`（`dev-server.mjs:233`
   `token: unlocked ? session.token : null`）；
3. 拿到令牌就能 `POST/PUT/DELETE` 写文章。

也就是说：**口令门一旦被你自己打开，就对全世界永久打开**，直到进程重启。
本地单用户场景下这无所谓，公网暴露下这是致命的。

改法（二选一，推荐 A）：

* **A. 真正的会话 cookie**：`POST /api/login` 成功后生成 `sessionId`，用
  `HttpOnly; Secure; SameSite=Strict; Path=/` 的 cookie 下发；`unlocked` 从
  "进程布尔"改成 `sessions: Map<sessionId, {ip, ua, createdAt, lastSeen}>`。
  所有 `/_admin/*` 与 `/api/*` 都按**该请求携带的 cookie** 判定，取不到就是未解锁。
  `GET /api/session` 只在**当前请求已解锁**时返回令牌。
  cookie 需要 `Secure`，所以这一条依赖阶段 0 的 HTTPS。
* **B. 按 IP 解锁**（改动小，但 NAT/移动网络下会互相影响）：`unlockedIps: Set<string>`，
  用 `ctx.ip`（见 6.4）判定。

同时：会话要有空闲超时（建议 12 小时）与显式登出接口 `POST /api/logout`。

**验收**：用两个不同来源（或两个 cookie jar）验证——A 登录后，B 的
`GET /api/session` 必须返回 `token: null`，B 的写请求必须 401/403。

### 6.2 远端模式下所有 `/api/*` 都要过解锁闸（含 GET）

**现状**：只有非 GET 才检查解锁与令牌（`dev-server.mjs:547`）。于是未认证的
`GET /api/posts` 能读到**全部文章**——`lib/posts-store.mjs:479` 的 `clean()` 会保留
`isDraft` 与**完整 `body`**，所以**没发布的草稿是全文泄露**，不只是标题。
`GET /api/backups`、`GET /api/images`、`GET /api/git` 同样无认证。

改法：新增 `cfg.remote` 开关。`remote` 为真时，**所有** `/api/*`（除 `/api/login`）
都先过解锁闸；写操作再过令牌。本地模式保持现状（这样现有 48 项测试的语义不变）。

### 6.3 Host / Origin 白名单可配置

`lib/security.mjs:22` 的 `LOOPBACK` 集合是模块常量，`assertHost`（:45）与
`assertSameOrigin`（:56）都只认回环主机名。反代后浏览器发来的 `Host` 与 `Origin`
是真实域名，会被 403。

改法：把 `LOOPBACK` 换成"允许集合"，由配置注入：

```js
// security.mjs：新增参数，默认值与现在完全一致（=不改变本地行为）
export const makeGuard = ({ allowedHosts = LOOPBACK, proxySecret = null } = {}) => (req, ctx) => { ... };
// 保留现有 export const guard 不动，作为 allowedHosts = LOOPBACK 的特例
```

* `allowedHosts` = 回环名 ∪ `cfg.publicHosts`（CLI/环境变量给出，例如 `simonfu.xin`、`www.simonfu.xin`）。
* 端口校验（:50）在反代场景要放宽：`Host: simonfu.xin` 无端口 → 现状已放行；
  若带 `:443` 也要放行，改成"端口不属于允许集合时才拒"。
* `Origin` 必须是 `https://<允许的 host>`；`Referer` 同。**不要**为了省事放行任意 Origin。

### 6.4 信任反代：共享密钥 + 真实客户端 IP

反代后 `req.socket.remoteAddress` 恒为 `127.0.0.1`，于是：

* `isLoopbackPeer` 恒真 → **本机任何进程（含被入侵的低权限服务）都能直连 8848**；
* `ctx.ip`（`dev-server.mjs:496`）恒为 `127.0.0.1` → 退避计数与日志全部失效。

改法：

1. nginx 注入 `X-Admin-Proxy-Secret: <随机值>`（见阶段 3），应用启动时读
   `/etc/p3blog/proxy-secret`，**不匹配就 403**。这样即使本机其他进程知道端口也进不来。
2. `ctx.ip` 在 `trustProxy` 时取 `X-Forwarded-For` 最后一段（nginx 用
   `$proxy_add_x_forwarded_for` 追加真实 IP），否则保持 `remoteAddress`。
3. 密钥文件权限 `600 root:blog`，只在 `--proxy-secret-file` 指定时启用。

### 6.5 远端模式强制要求口令

`dev-server.mjs:648` 目前只"提示"设口令。远端模式下必须**拒绝启动**：

```js
if (cfg.remote && !(await auth.hasPassphrase(cfg.runtimeDir))) {
  console.error('远端模式必须设置口令：--set-pass --pass "..."');
  process.exit(4);
}
```

### 6.6 SIGTERM 优雅退出

`dev-server.mjs:659` 只挂了 `SIGINT`。systemd 停服务发的是 `SIGTERM`，加上：
`process.on('SIGTERM', shutdown)`（并确保 `server.close()` 后清掉定时器）。

### 6.7 新增 CLI 参数（都在 `main()` 的 `value()/flag()` 体系里加）

| 参数 | 作用 |
| --- | --- |
| `--remote` | 打开远端模式：强制口令；所有 `/api/*` 需解锁（6.2） |
| `--public-host simonfu.xin` | 可重复；加入 Host/Origin 白名单（6.3） |
| `--trust-proxy` | 启用 X-Forwarded-For 取客户端 IP（6.4） |
| `--proxy-secret-file /etc/p3blog/proxy-secret` | 校验 nginx 注入的密钥（6.4） |

### 6.8 测试必须同步改（否则等于把判据删了）

`blog-enter/server/tests/api.test.mjs` 里这几条断言的是"回环边界"，加了白名单后要确认它们**仍然成立**：

| 位置 | 用例 | 期望 |
| --- | --- | --- |
| :232 | `Host: evil.example` → 403 | **必须继续 403**（白名单是精确匹配，不是通配） |
| :246 | `Host: 127.0.0.1:1`（端口不符）→ 403 | 继续 403 |
| :271 | `Origin: http://evil.example` → 403 | 继续 403 |
| :280 | `Sec-Fetch-Site: cross-site` → 403 | 继续 403 |

**新增用例**（新建 `tests/remote-mode.test.mjs`）：

1. `--public-host simonfu.xin` 下 `Host: simonfu.xin` + 正确密钥 → 放行；
2. 同上但**不带** `X-Admin-Proxy-Secret` → **403**（证明本机进程也进不来）；
3. `Origin: https://simonfu.xin` → 放行；`Origin: https://evil.example` → 403；
4. 远端模式未设口令 → 进程退出码 4；
5. **6.1 的验收**：A 登录后，B 的 `GET /api/session` 返回 `token: null`；
6. 远端模式下 `GET /api/posts` 未解锁 → 401；
7. 本地模式（无 `--remote`）下所有既有行为不变。

```bash
node blog-enter/server/tests/run-all.mjs      # 48 项 + 新增，必须全绿
```

---

## 7. 阶段 3：nginx 反代 + 加固

改的是 `/www/server/panel/vhost/rewrite/43.108.100.116.conf`（就是现在的伪静态文件）。
**这个文件被 include 在 server 块最前面**，所以既能放 `location`，也能放 server 级指令
（`ssl_verify_client` 等），而且**面板重新生成主配置时不会丢**。改前先备份：

```bash
cp -a /www/server/panel/vhost/rewrite/43.108.100.116.conf{,.bak}
```

### 7.1 必须先删掉一条现在生效的规则

上一轮为了堵暴露加的这条，会跟反代直接冲突：

```nginx
location ^~ /_admin/ { return 404; }      # ← 删掉它
```

`location ^~ /admin/ { return 404; }`（无下划线）**保留**。

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
    add_header Cache-Control "no-store" always;
    add_header X-Robots-Tag  "noindex, nofollow" always;
}

location ^~ /api/ {
    proxy_pass http://127.0.0.1:8848;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Admin-Proxy-Secret "<同上>";
    # 图片上传走这个前缀，放大请求体上限
    client_max_body_size 12m;
    proxy_read_timeout 60s;
}
```

> **注意 `add_header` 不继承**：本站既有规则里 server 级有三条安全头
> （nosniff / X-Frame-Options / Referrer-Policy）。上面两个 location 里出现了
> `add_header`，会**作废 server 级的那三条**。要么在这两个 location 里把三条安全头
> 重写一遍，要么改用 `expires`/`more_set_headers` 之外的手段。这是本文件里
> 已经记录过的坑，别踩第二次。

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
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Admin-Proxy-Secret "<同上>";
}
```

### 7.4 加固层（**至少选一个**）

**选项 A：mTLS 客户端证书**（推荐，只影响管理路径）

```nginx
# 生成自签 CA 与客户端证书（在本地或服务器上做都可以，私钥只留在你的设备上）
openssl req -x509 -newkey rsa:4096 -nodes -days 3650 -keyout admin-ca.key -out admin-ca.crt -subj "/CN=p3-admin-ca"
openssl req -newkey rsa:4096 -nodes -keyout client.key -out client.csr -subj "/CN=simon-laptop"
openssl x509 -req -in client.csr -CA admin-ca.crt -CAkey admin-ca.key -CAcreateserial -out client.crt -days 1095
```

伪静态里追加：

```nginx
ssl_client_certificate /etc/p3blog/admin-ca.crt;   # server 级，放这里没问题
ssl_verify_client      optional;                   # 只有管理路径强制
location ^~ /_admin/ { if ($ssl_client_verify != SUCCESS) { return 403; } ... }
location ^~ /api/    { if ($ssl_client_verify != SUCCESS) { return 403; } ... }
```

浏览器导入 `client.crt` + `client.key`（转成 .p12 更好）后即可访问；没有证书的人连
登录页都看不到（比口令更硬的边界）。

**选项 B：IP 白名单**（最省事，适合家宽/固定出口 IP）

```nginx
location ^~ /_admin/ { allow 1.2.3.4; allow 10.0.0.0/8; deny all; ... }
location ^~ /api/    { allow 1.2.3.4; allow 10.0.0.0/8; deny all; ... }
```

> 家宽 IP 会变；变了要改配置。手机流量下用不了。

**选项 C：VPN**（见第 11 节，本质是回到"本机访问"）

### 7.5 口令与封禁

* 口令用 24 位以上随机串（`openssl rand -base64 24`），别用有语义的短语；
* `fail2ban` 盯 nginx 日志里的 401/429：

```ini
# /etc/fail2ban/jail.d/p3-admin.conf
[p3-admin]
enabled  = true
port     = http,https
filter   = p3-admin
logpath  = /www/wwwlogs/43.108.100.116.log
maxretry = 5
findtime = 600
bantime  = 3600
```

```ini
# /etc/fail2ban/filter.d/p3-admin.conf
[Definition]
failregex = ^<HOST> .* "(POST|GET) /api/login .*" (401|429) 
```

* 应用侧退避（`lib/auth.mjs:117`，每 IP、上限 30s、内存态）作为第二层，别当主力。

### 7.6 生效与自检

```bash
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
```

---

## 8. 阶段 4：发布工作流改造（服务器变成唯一写入方）

**为什么必须改**：`blog-publish` 现在做 `git reset --hard origin/main`
（`deploy/bin/blog-publish.sh:29-30`）。你在 Web 管理页写的东西一旦 commit，
下次发布就会被**硬回退掉**。

**推荐：服务器当唯一写入方**（两边都能写必然产生冲突，不如只留一个）

```
Web 管理页（任何地方） → 服务器仓库 commit → push 到 GitHub
                                              ↓
                                     本地机器只做 git pull（当作只读备份/预览）
```

改动点：

1. `blog-publish.sh`：`git reset --hard` 改成
   `git fetch && git merge --ff-only origin/main`；有本地提交时**不要**覆盖，
   改为先把本地提交 push 上去（或直接报错让人处理）。
2. 服务器要能 push GitHub：加一把**有写权限**的 Deploy Key，
   或 `git config credential.helper store` + PAT（后者会在磁盘留明文，不推荐）。
   `sudo -u blog ssh-keygen -t ed25519 -f /home/blog/.ssh/id_ed25519`，
   公钥贴到仓库 Deploy keys 并**勾选 Allow write access**。
3. 管理页的「提交到 git」在服务器上要能 push。当前设计是"只 commit，push 你自己做"
   （`ADMIN.md` 第 1 节），远端模式下这个前提不成立——需要给 `lib/git.mjs` 的白名单
   子命令加 `push`，或在 `blog-publish` 里补一步。
4. `posts.js` 的并发保护已有：过期版本号 → 409（`ADMIN.md` 第 4 节）。
   服务器唯一写入后这条更重要，别绕过。

**如果你坚持两边都写**：本地编辑前必须 `git pull --rebase`，服务器每次保存都会
commit+push；冲突了在本地解决。这条路的失败模式是"某天忘了 pull，push 被拒/产生
合并冲突，posts.js 这种大文件手工合并极易出错"。

---

## 9. 阶段 5：验收清单

**A. 认证边界（最关键）**

```bash
# 1) 未带客户端证书（用 mTLS 时）：管理页不可见
curl -sI https://simonfu.xin/_admin/ | head -1                  # 期望 403

# 2) 未登录：拿不到令牌
curl -s https://simonfu.xin/api/session                          # 期望 "token":null
# 3) 未登录：读不到文章（含草稿）
curl -s -o /dev/null -w '%{http_code}\n' https://simonfu.xin/api/posts   # 期望 401
# 4) 未登录：写不了
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://simonfu.xin/api/posts \
     -H 'content-type: application/json' -d '{}'                 # 期望 401
# 5) 伪造 Host（DNS rebinding）
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example' https://43.108.100.116/api/posts  # 期望 403
# 6) 【6.1 的核心验收】A 登录后，另一个客户端仍拿不到令牌
curl -s -c /tmp/a.jar -X POST https://simonfu.xin/api/login -d '{"passphrase":"..."}' -H 'content-type: application/json'
curl -s https://simonfu.xin/api/session | grep -o '"token":[^,]*'   # 期望 "token":null
# 7) 本机直连 8848（绕过 nginx，缺密钥）
sudo -u blog curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8848/_admin/   # 期望 403
# 8) 登录限流
for i in $(seq 1 15); do curl -s -o /dev/null -w '%{http_code} ' -X POST https://simonfu.xin/api/login -d '{"passphrase":"wrong"}' -H 'content-type: application/json'; done; echo  # 期望很快出现 429
```

**B. 公开站点未被影响**

```bash
for u in / /index.html /archive.html /article.html /about.html /404.html /css/style.css /js/posts.js; do
  printf '%-22s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' https://simonfu.xin$u)"; done
# 期望全 200
curl -s -o /dev/null -w '%{http_code}\n' https://simonfu.xin/admin/            # 期望 404
curl -s -o /dev/null -w '%{http_code}\n' https://simonfu.xin/server/dev-server.mjs  # 期望 404
curl -sI https://simonfu.xin/js/posts.js | grep -i cache-control               # 期望 max-age=300
```

**C. 功能回归（本机跑）**

```bash
node blog-enter/server/tests/run-all.mjs        # 全绿
node blog-enter/server/dev-server.mjs           # 本地模式行为与改动前完全一致
node blog-enter/server/tests/verify-admin-ui.mjs  # 需要本地起服务 + Chrome
```

**D. 端到端**：Web 管理页新建一篇文章 → 保存 → 提交 → 发布 → 公网可见；
再删掉它，确认 `posts.js` 只变动那一篇（区间替换没有波及别的文章）。

---

## 10. 阶段 6：回滚

```bash
sudo systemctl disable --now p3-admin
# 伪静态恢复
cp -a /www/server/panel/vhost/rewrite/43.108.100.116.conf.bak \
      /www/server/panel/vhost/rewrite/43.108.100.116.conf
# 把 location ^~ /_admin/ { return 404; } 加回去（恢复成"管理页不在公网"的状态）
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
# 代码
cd /srv/blog/repo && git switch main && git branch -D feat/remote-admin
```

回滚后必须复验：`https://simonfu.xin/_admin/` → 404，公开站点 8 个路径全 200。

---

## 11. 更省事的等价方案（如果目的只是"出门也能写"）

方案 C 要动代码、要动工作流、要长期维护一个公网登录面。若你的真实需求只是
"不在家时也能写文章"，下面这条路**今天就能用、且不新增任何公网攻击面**：

**WireGuard / Tailscale**：服务器只听 VPN 内网地址，管理页绑定 VPN 网卡，
公网完全不暴露。Tailscale 尤其省事：两台机器各装一个 client，`tailscale ip` 拿到
内网地址，`http://<tailscale-ip>:8848/_admin/` 直接用（此时才需要代码支持
`--public-host <tailscale-ip>` 与 `--host` 绑定，其余同 6.3/6.4，但不需要域名、
不需要 mTLS、不需要限流与 fail2ban）。

**SSH 隧道**（零新装件）：服务器上跑着 `dev-server.mjs`（`User=blog`），
本地 `ssh -L 8848:127.0.0.1:8848 blog@43.108.100.116`，然后浏览器开
`http://127.0.0.1:8848/_admin/`。此路径下**代码只需 6.1/6.2 那个默认关闭的
`--remote` 开关之外的两处**：其实一行代码都不用改——因为请求从隧道进来，
对端仍是回环、Host 仍是 127.0.0.1，现有三道闸全部满足。

> 也就是说：**SSH 隧道方案下，阶段 2 的代码改动全部可以跳过**，
> 只需要阶段 1（systemd）+ 阶段 4（工作流）。这是性价比最高的做法。

---

## 12. 别忘了改文档

`blog-enter/ADMIN.md` 第 3 节现在写着"管理页只存在于本地进程，静态发布时没有它们"
以及"没做的：没有把管理页做成带登录的后台"。方案 C 让这两句话变成假话。
**实施 C 的同时必须更新这一节**（写清新的边界、加固层、以及"服务器是唯一写入方"
这个前提），否则下一个人（包括未来的你）会照着错误的威胁模型做判断。

---

## 13. 附：为什么不用"最省事"的那种做法

「把 `blog-enter/admin/` 拷进站点根目录，加一个前端密码框」——**这是纯粹的假安全**：

1. 静态站点没有服务端，密码校验只能在 JS 里做，`view-source` 就能绕过；
2. 写接口不存在，页面根本存不了文章（管理端需要 `/api/*`，那是 Node 进程提供的）；
3. 一旦拷进去，`posts.js`（含草稿）与整个后台 UI 一起对外可读——**这不是假设**：
   本项目就发生过一次，`/blog-enter/admin/` 与 `/blog-enter/server/dev-server.mjs`
   曾被公网直接下载，已清理并在 nginx 上补了 `/_admin/` 的 404 兜底。

所以要么走方案 C（真有一个服务端进程 + 反向代理 + 真认证），要么走第 11 节的
隧道/VPN（管理面根本不进公网）。
