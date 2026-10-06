# 方案 E：评论区（Waline 自建 + 邮箱验证）

> ## ✅ 执行状态（2026-10-06）：**已上线，但只走完了前半程**
>
> 服务端、nginx、前端都跑起来了，实际部署记录见 `DEPLOY-RECORD.md` 第 8 节，
> 安装脚本是 `deploy/bin/install-waline.sh`（幂等）。
>
> **当前是「匿名可评 + 先审后发」**（`LOGIN=disable`），
> 本方案选的「邮箱验证码」还**没开** —— 它要等 SMTP 授权码。
>
> **本文件下面有五处是错的/漏的，照抄会踩**（细节见 `DEPLOY-RECORD.md` §8.2）：
>
> 1. **§4 漏了一步**：SQLite 必须先放官方 `assets/waline.sqlite` 结构文件，
>    空库**不会**自建表 —— 读写全是 `no such table: wl_Comment`。
> 2. **§4.4 只提醒没解决**：Waline 默认监听 `0.0.0.0`，实测确实是 `*:8360`。
>    光看 `ss` 不够，得在 `vanilla.js` 旁边放 `config.js` 把 host 钉成回环。
> 3. **§6.1 的 `proxy_pass` 写错了**：结尾少了 URI，会把
>    `/comments/api/comment` 原样转上去 → 404（Waline 的接口前缀是 `/api/`）。
>    另外那里应该用 `X-Forwarded-For $remote_addr` **覆盖**，而不是 append。
> 4. **§6.1 只反代 `/comments/api/` 会漏路由**：Waline 还有 `/verification`
>    （**邮件里的验证链接就指这里**）、`/token` 等根级路由。要**整段**反代
>    `/comments/`，客户端静态资源挪到 `/comments-assets/`（否则被一起转走 → 404）。
> 5. **§8.3 的隧道方案有个坑**：`/ui/` 页面里的 `window.serverURL` 是 Waline 用
>    `SERVER_URL` 拼的绝对地址，隧道里点登录会把**口令 POST 到公网明文地址**上。
>    要对 `src/middleware/dashboard.js` 做一行 patch，让它跟当前地址走。
>
> 还有一条本方案没预见到、真浏览器跑出来才发现的：**客户端默认会去 unpkg
> 拉表情包**（`@waline/emojis`），所以 `init` 里要写 `emoji: false`
> （或把表情包也自托管）。
>
> 建议做法：**别照着下面的文件重头做一遍**，看 `DEPLOY-RECORD.md` §8 + 安装脚本。

> **自包含。** 前提是 `deploy/PLAN-ADMIN-LIVE.md`（方案 D）已经在跑：服务器上有 Node、
> nginx 反代 `/api/` 到 `127.0.0.1:8848`。评论系统**独立**于那套后台，但共用同一套 nginx。
>
> **执行第 3 节之前不要动手。** 那里有一个路由冲突会让你的管理后台直接失效。
>
> 站位：`article.html` 第 94–120 行的占位块与第 118 行的 `#commentsMount` 挂载点已经存在，
> `pages.css` 第 977–1036 行、`prose-light.css` 第 274–300 行的 `.comments*` 样式也已经写好。
> 本方案是**把挂载点接上**，不是从零做。

---

## 1. 定下来的选择

| 项 | 选择 | 含义 |
| --- | --- | --- |
| 评论系统 | **Waline**（`@waline/vercel` 服务端 + `@waline/client` v3） | 自建，数据在自己服务器上 |
| 数据库 | SQLite（`SQLITE_PATH` + `JWT_TOKEN`） | 无需另装数据库，一个文件 |
| 游客身份 | **邮箱验证码** | 靠配 SMTP 自动开启（见 2.1） |
| 发信 | 个人邮箱 SMTP（QQ / 163 授权码） | 免费，但有量限制与进垃圾箱的风险 |
| 评论图片上传 | **关闭** | 服务器磁盘压力最小；要图片就贴图床链接 |
| 离线（`file://`） | 接受看不到评论 | 评论区必须联网，见 4.3 |

---

## 2. 两条必须先理解的事实

### 2.1 "邮箱验证"不是一个开关，而是配 SMTP 的副作用

Waline 文档里**没有** `ENABLE_EMAIL_VERIFICATION` 这个变量。原文是这样的：

> 配置邮件服务相关变量后，用户注册会增加**邮箱验证码确认**相关的操作，用来防止恶意的注册。
> —— [Waline 服务端环境变量 · 邮件](https://waline.js.org/reference/server/env.html)

也就是说：**你一旦配好 `SMTP_*`，邮箱验证码流程就自动生效了**，不需要额外开关。
反过来说，如果 SMTP 配错，**验证码发不出去 = 谁也评论不了**。所以第 5 节的
"先验证发信能通"是硬步骤，不能跳。

需要的邮件变量（[来源同上](https://waline.js.org/reference/server/env.html)）：

| 变量 | 说明 |
| --- | --- |
| `SMTP_SERVICE` | 服务商名；与下面的 HOST/PORT **任选其一** |
| `SMTP_HOST` / `SMTP_PORT` | 自己指定时用 |
| `SMTP_USER` / `SMTP_PASS` | 用户名 / 密码（**QQ、163 必须用"授权码"，不是登录密码**） |
| `SMTP_SECURE` | 是否 SSL |
| `SENDER_NAME` / `SENDER_EMAIL` | 发件人显示名与地址 |
| `AUTHOR_EMAIL` | 博主邮箱，接新评论通知 |

### 2.2 Waline 的 API 叫 `/api/`，和你现在的后台**同名**

这是本方案最大的坑。方案 D 里的 nginx 规则是：

```nginx
location ^~ /api/ { proxy_pass http://127.0.0.1:8848; ... }   # 博客后台
```

Waline 服务端的接口**也叫 `/api/`**。如果把它挂在**站点根路径**上，两者会抢同一个
`location`，结果是**管理后台直接不可用**（或者评论全部 404），取决于谁先匹配。

**解法：把 Waline 挂在 `/comments/` 子路径下**，它的接口自然变成 `/comments/api/…`：

```
/comments/          ← Waline 客户端（评论 UI）
/comments/api/…     ← Waline 服务端接口
/comments/ui/       ← Waline 管理后台
/api/…              ← 博客管理后台（8848，不动）
/_admin/            ← 博客管理页（8848，不动）
```

这样两个 `/api` 互不干扰。但有一条**必须同时保证**：

> ⚠️ **发布到站点根目录的产物里，绝不能出现顶层 `/api/` 目录。**
> 否则 nginx 的 `location ^~ /api/` 会把请求交给 8848（博客后台），而 8848 找不到那些
> 静态文件 → 404。`blog-publish.sh` 的排除清单要**再加一条 `--exclude '/api/'` 兜底**。

用 URL 前缀区分两套服务不是最好看，但它是**零代码改动**的方案。想更干净（用
`comments.example.com` 子域）就得先有域名 —— 而你现在的域名还是 NXDOMAIN。

---

## 3. 阶段 0：先探测，别急着装

```bash
ssh root@43.108.100.116

# 1) 磁盘还剩多少 —— Waline 的 node_modules 约 150–250MB，SQLite 随评论增长
df -h /                      # 剩 < 2GB 就先扩容，别硬上

# 2) Node 版本（Waline v3 要 Node 18+；方案 D 已经装过就跳过）
node --version

# 3) 有没有 Docker —— 有的话优先用它，能绕开 SQLite 原生模块的编译问题
docker --version 2>/dev/null || echo "没有 Docker"

# 4) 【关键】确认 8360 端口空着，且这个端口**不要**在云安全组/面板里放行
ss -lntp | grep 8360 || echo "8360 空闲"
#   Waline 只监听回环，由 nginx 反代进去。放行到公网 = 绕过 nginx 的限流与日志。

# 5) 确认现有后台还正常（方案 D 的成果）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8848/_admin/    # 期望 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/api/session     # 期望 200
```

---

## 4. 阶段 1：部署 Waline 服务端

### 4.1 目录与数据（重要：数据放仓库外面）

```bash
sudo install -d -m 750 -o blog -g blog /srv/waline/data
```

> ⚠️ **【方案漏掉的一步】SQLite 必须先放官方结构文件。**
> Waline 的 SQLite **不会自己建表**：数据库文件是空的（0 字节或只有文件头），
> 任何读写都返回 `{"errno":500,"errno":..., "no such table: wl_Comment"}`。
> 官方文档「多数据库服务支持 · SQLite」明确要求先下载
> [`assets/waline.sqlite`](https://github.com/walinejs/waline/blob/main/assets/waline.sqlite)
> 放到 `$SQLITE_PATH/waline.sqlite`。实测：24KB，里面是 `wl_Comment` /
> `wl_Counter` / `wl_Users` 三张表的建表语句。
> 装之前**校验一下内容**（`strings waline.sqlite | grep 'CREATE TABLE "wl_Comment"'`），
> 免得把一个失败的下载当成功。

数据目录**必须放在 `/srv/blog/repo` 之外**。理由：`blog-publish.sh` 里是
`rsync --delete`，而它同步的是 `blog-enter/`；`.admin/` 就吃过这个亏
（见 `blog-publish.sh` 第 40–44 行的注释）。SQLite 文件放仓库里，迟早被
`--delete` 或某次 `git reset --hard` 弄没。

### 4.2 方式 A：Docker（推荐，能绕开原生编译）

```yaml
# /srv/waline/docker-compose.yml
services:
  waline:
    image: lizheming/waline:latest
    container_name: waline
    restart: always
    # 只绑回环：nginx 从本机反代进来，不对公网暴露
    ports:
      - "127.0.0.1:8360:8360"
    volumes:
      - /srv/waline/data:/app/data
    environment:
      TZ: Asia/Shanghai
      # ---- 站点 ----
      SITE_NAME: 'SIMON 的个人站'
      SITE_URL: 'http://43.108.100.116'
      SERVER_URL: 'http://43.108.100.116/comments'
      # ---- 安全（两项都填，不带协议前缀！）----
      SECURE_DOMAINS: '43.108.100.116'
      JWT_TOKEN: '<openssl rand -hex 32 生成的随机串>'
      # ---- 数据库 ----
      SQLITE_PATH: '/app/data'
      # ---- 评论策略 ----
      LOGIN: 'force'            # 必须登录/验证后才能评论
      COMMENT_AUDIT: 'true'     # 新评论先审后显示（邮箱验证之外的第二道）
      IPQPS: '60'               # 同 IP 发评论间隔（秒）
      AKISMET_KEY: '70542d86693e'   # 默认值，保持开启；不想要就设 false
      # ---- 邮件（第 5 节验证通过后再填真值）----
      SMTP_SERVICE: 'QQ'
      SMTP_USER: 'you@qq.com'
      SMTP_PASS: '<SMTP 授权码>'
      SMTP_SECURE: 'true'
      SENDER_NAME: 'SIMON 的个人站'
      SENDER_EMAIL: 'you@qq.com'
      AUTHOR_EMAIL: 'you@qq.com'
      # ---- 图片上传（你选的"关闭"）----
      # 这是**客户端**的事，服务端没有开关：不传 imageUploader 回调，评论框就没有
      # 上传按钮。服务端不要装任何图床/上传相关依赖。
      # ---- 头像：默认走 Cloudflare Workers，国内经常加载不出来 ----
      # 见 6.2，建议换成国内可达的 Gravatar 镜像或 DISABLE 掉
```

```bash
cd /srv/waline && docker compose up -d
docker compose logs -f waline | head -40     # 期望看到服务在 8360 起监听、数据库已连接
```

### 4.3 方式 B：不用 Docker（`node` 直接跑）

```bash
sudo install -d -m 750 -o blog -g blog /srv/waline/app
sudo -u blog bash -c 'cd /srv/waline/app && npm init -y && npm install @waline/vercel'
sudo -u blog node /srv/waline/app/node_modules/@waline/vercel/vanilla.js
#   环境变量用下面的 systemd 片段注入
```

> ⚠️ **这条路的已知风险**：SQLite 驱动可能是原生模块（需要 `python3` / `make` / `g++`
> 编译，或已有预编译包）。装完**必须**先手工跑一次确认能连上数据库；报
> `gyp ERR!` / `prebuild` 之类的错，就装 `dnf install -y python3 make gcc-c++`
> 再重试，或者改用 Docker。**别等 systemd 起来才发现它一直在重启。**

`/etc/systemd/system/p3-waline.service`（方式 B 用；方式 A 由 Docker 托管）：

```ini
[Unit]
Description=Waline comment server (loopback-only)
After=network.target

[Service]
Type=simple
User=blog
Group=blog
WorkingDirectory=/srv/waline/app
EnvironmentFile=/etc/p3blog/waline.env        # 权限 600 root:blog，放上面那些环境变量
ExecStart=/usr/bin/node /srv/waline/app/node_modules/@waline/vercel/vanilla.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=/srv/waline/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now p3-waline
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8360/    # 期望 200 或 302
```

### 4.4 Waline 默认监听所有网卡（两种方式都要注意）

Docker 那行 `127.0.0.1:8360:8360` 已经限住了。方式 B 要确认：

```bash
ss -lntp | grep 8360     # 期望 127.0.0.1:8360；若是 0.0.0.0:8360，Waline 就绕过 nginx 裸奔了
```

> ⚠️ **【实测：这里光"注意"是不够的】** 方式 B 下默认就是 `*:8360`（thinkjs
> 默认 `host` 为空 = 监听所有网卡）。光看一眼 `ss` 不会让它变成回环，得真去改：
> 在 `vanilla.js` 旁边放一个 `config.js`，导出 `{ host: '127.0.0.1', port: 8360 }` ——
> `vanilla.js` 在 `instance.run()` 之后会 `require('./config.js')` 并逐项
> `think.config(k, v)`（`run()` 里起服务是异步的，所以这个顺序来得及生效）。
>
> ⚠️ 这个文件放在 `node_modules/` 里，**重新 `npm install` 会把它删掉** ——
> 装完要重跑 `deploy/bin/install-waline.sh`，或者把这件事记进自己的部署清单。
>
> 顺带：确认云安全组/面板防火墙里 **8360 从未被放行**。它只该被 nginx 从本机访问。

---

## 5. 阶段 2：先把"发信"验通，再接前端

**顺序不能反。** 邮箱验证开启后发不出信 = 评论功能整体不可用。

### 5.1 拿 SMTP 授权码

| 邮箱 | 位置 | 注意 |
| --- | --- | --- |
| QQ 邮箱 | 设置 → 账户 → POP3/SMTP 服务 → 开启 → 生成**授权码** | 授权码 ≠ 登录密码；`SMTP_SERVICE: QQ`，端口 465/`SMTP_SECURE: true` |
| 163 邮箱 | 设置 → POP3/SMTP/IMAP → 开启 → 新增授权码 | 同样用授权码 |

阿里云服务器**默认封 25 端口**，所以必须走 465（SSL）或 587（STARTTLS）。
`SMTP_SERVICE: 'QQ'` 时 Waline 会自动用 QQ 的标准端口，是最省事的写法。

### 5.2 验证发信

```bash
# 方式 A（Docker）：直接在容器里用 nodemailer 试一发
docker compose exec waline node -e '
const nodemailer = require("nodemailer");
const t = nodemailer.createTransport({ service: "QQ", auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
t.verify().then(() => console.log("SMTP 连接 OK")).catch(e => { console.error("SMTP 失败:", e.message); process.exit(1); });
'
```

更实在的验证：**在浏览器里走一遍完整流程**（第 7 节阶段 4 的第 1 条）——
输入邮箱 → 收验证码 → 填验证码 → 发评论。收到信才算通。

### 5.3 送达率（个人 SMTP 的真实代价）

用个人邮箱发验证码，被丢进垃圾箱是常态。缓解手段：

* `SENDER_NAME` / `SENDER_EMAIL` 与 `SMTP_USER` 一致；
* 邮件主题别带"验证码""免费"之类的敏感词；
* 让收件人把发件地址加白名单（在评论区上方写一句提示）；
* **如果超过 1/3 的验证码进垃圾箱，就换邮件推送服务**（SendGrid / 阿里云邮件推送 /
  腾讯云 SES），按量付费，配置只是把 `SMTP_SERVICE` 换成 `SMTP_HOST` + `SMTP_PORT`。

---

## 6. 阶段 3：nginx 反代（这里决定成败）

改 `/www/server/panel/vhost/rewrite/<站点>.conf`，改前备份：

```bash
cp -a /www/server/panel/vhost/rewrite/<站点>.conf{,.bak-comments-$(date +%F)}
```

### 6.1 加 Waline 反代

**放在现有的 `location ^~ /api/` 之前或之后都可以**，因为 `/comments/` 与 `/api/`
是不同的前缀，不会冲突 —— 但**绝不能**把 Waline 挂在 `/` 或 `/api/` 上（第 2.2 节）。

```nginx
# ---- Waline 评论服务：挂在 /comments/ 下，接口自然是 /comments/api/ ----
# ⚠️ proxy_pass 结尾的 /api/ **不能省**（本方案原文写的就是省掉的那版，实测 404）：
#    Waline 的接口前缀是 /api/。带 URI 时 nginx 才会用 /api/ 替换掉匹配到的
#    /comments/api/ 前缀；不带 URI 就把 /comments/api/comment 原样转上去，
#    Waline 那边找不到 → 404。
# ⚠️ X-Forwarded-For 用 $remote_addr 覆盖，不要用 $proxy_add_x_forwarded_for：
#    thinkjs 开了 proxy=true，会取 XFF 当客户端 IP。append 的话攻击者自带一个
#    XFF 就能伪造 IP，把 Waline 的 IPQPS 限流整条绕过去。
location ^~ /comments/api/ {
    proxy_pass http://127.0.0.1:8360/api/;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    # 评论提交与验证码的请求体很小，但别用默认 1m 卡住长评论
    client_max_body_size 1m;
    proxy_read_timeout 60s;
}
```

> **还有一条本方案没想到的**：客户端的 `waline.js` / `waline.css` 是自托管在
> **站点里的**（`blog-enter/comments/`），所以这里只能反代 `/comments/api/` 与
> `/comments/ui/`，**绝不能整段 `^~ /comments/`** —— 整段反代会把那两个静态文件
> 也送给 Waline，结果 404。完整的、实际在用的那段规则见
> `deploy/bt/nginx-locations.conf` 的 `P3_comments` 段。

**不要**在这个 location 里写 `add_header`。同一个 server 块里已经有三条安全头
（nosniff / X-Frame-Options / Referrer-Policy），nginx 的 `add_header` **不继承**：
只要某个 location 出现一条，server 级那三条就全部作废。这个坑
`deploy/bt/nginx-locations.conf` 第 36–42 行专门写过，别踩第二次。

### 6.2 头像代理（国内必改）

Waline 的 `AVATAR_PROXY` 默认是 `https://avatar.75cdn.workers.dev` —— 一个
Cloudflare Workers 地址，**国内经常加载不出来**，表现是评论区一片灰色占位。
三选一：

```nginx
# ① 直接用国内可达的 Gravatar 镜像（改服务端环境变量）
GRAVATAR_STR: 'https://cdn.v2ex.com/gravatar/{{mail|md5}}'
AVATAR_PROXY: 'false'        # 关掉代理，信不过第三方就选这个
```

② 有域名和证书之后，自己在 nginx 上反代 Gravatar；
③ 什么都不做 —— 头像不显示，评论内容照常（**不阻塞**，可以最后再管）。

### 6.3 评论接口单独限流（与后台登录分开）

`limit_req_zone` 必须写在 `http{}`（宝塔的 `/www/server/nginx/conf/nginx.conf`）：

```nginx
limit_req_zone $binary_remote_addr zone=comment_post:10m rate=20r/m;
limit_req_zone $binary_remote_addr zone=comment_code:10m rate=6r/m;   # 验证码更严
```

```nginx
# 发验证码：最容易被刷，单独收口
location = /comments/api/comment  {
    limit_req zone=comment_post burst=5 nodelay;
    limit_req_status 429;
    proxy_pass http://127.0.0.1:8360;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

> 验证码接口的具体路径随 Waline 版本可能变化，**先在浏览器开发者工具里看真实的
> 请求路径**（Network 面板，点"获取验证码"时打出去的那一条），再照着写 `location =`。
> 别照抄网上的旧路径。

### 6.4 生效与自检

```bash
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
```

```bash
# 【最关键的一条】确认后台没被评论系统的 /api 抢走
curl -s -o /dev/null -w '%{http_code}\n' http://43.108.100.116/api/session      # 期望 200
curl -s -o /dev/null -w '%{http_code}\n' http://43.108.100.116/_admin/          # 期望 200
# 评论服务自己通
curl -s -o /dev/null -w '%{http_code}\n' http://43.108.100.116/comments/        # 期望 200
# 公开站点没受影响
for u in / /archive.html /article.html; do
  printf '%-18s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' http://43.108.100.116$u)"; done   # 全 200
```

---

## 7. 阶段 4：接前端

### 7.1 客户端资源**不要**用 CDN（推荐自托管）

Waline 官方推荐 CDN 引入（[通过 CDN 导入 Waline](https://waline.js.org/cookbook/import/cdn.html)）：

```html
<link rel="stylesheet" href="https://unpkg.com/@waline/client@v3/dist/waline.css" />
<script type="module">
  import { init } from 'https://unpkg.com/@waline/client@v3/dist/waline.js';
  init({ el: '#commentsMount', serverURL: 'http://43.108.100.116/comments' });
</script>
```

但这与本站"双击 HTML 就能跑、零外部依赖"的定位冲突：**unpkg 在国内不稳定**，
一旦它挂了，评论区就是一片空白 —— 而且是运行时才失败，你本地测不出来。
所以建议自托管：把 `waline.js` / `waline.css` 下载到

```
blog-enter/comments/waline.js
blog-enter/comments/waline.css
```

然后从本地路径引入。代价是 Waline 升级要手动换文件；收益是**没有第三方运行时依赖**，
而且 `blog-publish.sh` 会自然把它们发布出去（只要别被排除规则拦掉）。

> 其它可选资源：`pageview.js`（浏览量）、`comment.js`（评论数）。
> 想在首页/归档页显示"评论数"，再额外引入 `comment.js`（Gzip < 1KB）。

### 7.2 只加载 Waline 客户端资源，初始化交给 `article.js`

`article.html` 的改动有三处：给评论区加 `hidden`、加一个**只负责加载不负责判断**
的模块脚本、再加一个补时序的兜底脚本（第 7.2.1 节的 ④）。

```html
<!-- article.html：评论区加 hidden（理由见 7.2.1） -->
<section class="comments" id="comments" hidden aria-labelledby="commentsTitle">
  ...
  <div id="commentsMount" data-comments-slot="waline"></div>
</section>
```

```html
<!-- article.html：放在现有那几个 defer 脚本之后 -->
<script type="module">
  /* 只做两件事：备好客户端资源、暴露一个 init 函数。
     **不判断文章是否存在** —— 那个判断归 article.js（见 7.2.1）。 */
  if (!location.protocol.startsWith('http')) {
    // file:// 下评论区无法工作（跨域），给个说明而不是红色报错
    document.getElementById('commentsMount').innerHTML =
      '<p class="cb-title">离线查看</p>' +
      '<p>当前是直接打开本地文件，评论区需要联网才能加载。</p>';
  } else {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'comments/waline.css';
    document.head.appendChild(link);
    const { init } = await import('./comments/waline.js');
    window.initComments = (slug) => init({
      el: '#commentsMount',
      serverURL: 'http://43.108.100.116/comments',
      path: '/article.html?slug=' + slug,   // ← 见 7.3，必须与 URL 严格一致
      lang: 'zh-CN',
      login: 'force',                        // 与服务端 LOGIN=force 对齐
      requiredMeta: ['nick', 'mail'],        // 昵称与邮箱必填（邮箱验证的前提）
      imageUploader: false,                  // 关掉上传入口；不要提供上传回调
      search: false                          // 表情包搜索会请求外部服务，关掉更干净
    });
  }
</script>
```

> **实测补一条**：这段 `init` 里还要加 `emoji: false`。Waline 客户端的表情选项卡
> 默认去 `https://unpkg.com/@waline/emojis@1.1.0/...` 拉数据 —— 真浏览器跑
> `verify-comments-live.mjs` 时，网络面板里就有这条外部请求。与"本站零外部运行时
> 依赖"冲突，所以关掉了；要开就把表情包一起自托管（见 `blog-enter/comments/README.md`）。

> 用 `<script type="module">` 的好处：它自带 `defer` 语义，且顶层 `await import()`
> 可用。自托管路径是 `comments/waline.js`（相对本文档）；若改用 CDN，就把路径换成
> `https://unpkg.com/@waline/client@v3/dist/waline.js` —— 但见 7.1 的提醒。

### 7.2.1 【顺带修一个真实缺陷】文章不存在时评论区会赖着不走

看 DOM 结构：`article.html` 里评论区（第 94 行）是 `#articleShell` **之外**的兄弟节点。
而 `js/article.js` 的 `showNotFound()`（第 70–111 行）只做了：

```js
const showNotFound = (slug) => {
  const shell = $('#articleShell');
  if (shell) shell.hidden = true;      // ← 只藏了正文壳
  …
```

**它没有藏评论区。** 所以现在访问一个不存在的 slug，你会看到"这篇文章不存在"的提示，
下面紧跟着一个空的评论区 —— 打开线上 `article.html?slug=瞎写的` 就能复现。
接上 Waline 之后这个缺陷会被放大：不存在的 slug 也会去拉评论、甚至能发评论。

修在三处，都很小：

```html
<!-- ① article.html：评论区默认 hidden，避免脚本没跑起来时露出一片空白 -->
<section class="comments" id="comments" hidden aria-labelledby="commentsTitle">
```

```js
/* ② js/article.js，showNotFound() 里，紧随 shell.hidden = true 之后 */
const cm = $('#comments');
if (cm) cm.hidden = true;
```

```js
/* ③ js/article.js，render() 第 228–229 行那段 shell.hidden = false 旁边 */
const shell = $('#articleShell');
if (shell) shell.hidden = false;

const cm = $('#comments');
if (cm) {
  cm.hidden = false;                                  // 正文渲染成功才放开评论区
  if (window.initComments) window.initComments(post.slug);
}
```

```html
<!-- ④ article.html：紧跟在上面那个模块脚本之后，兜住"模块加载比 article.js 慢" -->
<script>
  // 模块脚本 <script type="module"> 天生 defer；而 article.js 也是 defer 且排在它前面。
  // 于是 article.js 执行时，window.initComments 很可能还没赋值 —— 直接调用会静默不生效。
  // 这里在 DOM 就绪后补一次检查，把这段落差补上。
  document.addEventListener('DOMContentLoaded', () => {
    const a = window.Article;
    if (a && a.slug && window.initComments) window.initComments(a.slug);
  }, { once: true });
</script>
```

> `window.Article` 是 `article.js` 第 236 行留给自动化验证的读取点
> （`{ slug, viaAlias, post }`），这里正好复用：只有文章真的渲染成功了它才会被赋值。
> ④ 那条检查因此天然是"文章存在才初始化"。
>
> 加了这个兜底，③ 里的 `window.initComments(post.slug)` 其实变成了"快路径"（模块已经
> 加载完时立刻初始化，不等 DOMContentLoaded）；两条路径都以 `init()` 只被调用一次
> 为前提 —— 若担心重复，把 ③ 那次调用删掉，只留 ④ 这条即可，行为一样正确。

**为什么把初始化也放进 `article.js`**：它已经用同一套逻辑（含 `aliases` 旧地址跳转）
把"这篇文章到底存不存在"判定过一遍了；评论脚本再判一次，两处判定迟早不一致
（比如别名跳转的场景）。**让 `article.js` 当唯一的判定者**，评论脚本只负责
"资源备好 + 提供一个 init"。

### 7.3 `path` 必须与公开 URL 严格一致

Waline 用 `path` 把评论和文章绑定。**默认取 `location.pathname + location.search`**。
本站的文章地址是 `article.html?slug=xxx`，所以：

* 如果你用 `location.href` 派生，`file://` 下与 `http://` 下会得到**不同**的 path，
  评论就会"在不同的地址下看起来丢了"。**显式写死 `path`**，别依赖默认值。
* 改文章 `slug` 时，`posts.js` 会自动往 `aliases` 里记旧地址（见 `ADMIN.md` 第 1 节），
  **但 Waline 那边的评论不会跟着走** —— 旧地址的评论会留在旧 path 上。
  改名后要手工在 Waline 后台把评论的 `path` 改过来，或者接受"改名 = 评论清零"。

### 7.4 离线时的表现（已在 7.2 的脚本里处理）

`file://` 下 `serverURL` 指向 `http://43.108.100.116` 属于跨域，Waline 请求必然失败，
评论区会变成一片红色报错。你选了"接受离线看不到评论"，所以 7.2 那段模块脚本一开头
就用 `location.protocol.startsWith('http')` 截住了，直接写一句友好说明，
**不初始化 Waline、不产生任何网络请求**。不需要额外代码。

同时清理占位文案：

* 删掉 `article.html` 第 88–120 行的占位说明块里那些"这里将是评论列表与输入框…"
  的文字（第 100–116 行）；
* 改掉第 97 行的 `<span class="section-note">占位</span>`（改成空，或写"Waline"）；
* 第 113–116 行的 `.comments-skel` 骨架屏可以留着当加载占位，也可以删。

---

## 8. 阶段 5：Waline 管理后台与两套登录

### 8.1 入口与首个管理员

```
http://43.108.100.116/comments/ui/
```

**第一个注册的账号自动成为管理员**（Waline 的约定）。所以顺序是：

1. 先把 `/comments/ui/` **只在你能访问的时候**打开（或临时用 nginx IP 白名单锁住，
   见 8.3），
2. 用你自己的邮箱注册（这一步也会走邮箱验证码），
3. **确认它变成管理员**之后，再放开访问。

> ⚠️ 如果先放开、又没及时注册，**任何人抢注第一个账号就是管理员** —— 等于拿到你
> 全部评论的删除权与新评论审核权。这一步别拖。

### 8.2 你会有两套互不相通的登录

| | 博客管理页 | Waline 管理后台 |
| --- | --- | --- |
| 地址 | `/_admin/` | `/comments/ui/` |
| 认证 | 方案 D 的会话 cookie + 口令 | Waline 自己的邮箱 + 密码 |
| 管什么 | 文章（`posts.js`）、图片、备份 | 评论、审核队列、用户、黑名单 |

这是**两套独立系统**的真实代价，别指望统一登录。至少在 `ADMIN.md` 里写清楚
"评论在另一个后台管"，否则半年后你会忘了。

### 8.3 建议给 `/comments/ui/` 加一层限制

管理后台不需要对全世界开放。用 nginx 限一下（家宽出口 IP）：

```nginx
location ^~ /comments/ui/ {
    allow 1.2.3.4;          # 你的出口 IP
    allow 127.0.0.1;
    deny all;
    proxy_pass http://127.0.0.1:8360;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

或者配 SSH 隧道访问（**零新装件，推荐**，和方案 D 第 11 节一个思路）：

```powershell
ssh -L 8360:127.0.0.1:8360 blog@43.108.100.116
# 然后本机开 http://127.0.0.1:8360/ui/
```

---

## 9. 阶段 6：验收清单

**A. 路由没被抢（最关键）**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://43.108.100.116/api/session    # 200（博客后台）
curl -s -o /dev/null -w '%{http_code}\n' http://43.108.100.116/_admin/        # 200（管理页）
curl -s -o /dev/null -w '%{http_code}\n' http://43.108.100.116/comments/      # 200（评论服务）
curl -s http://43.108.100.116/comments/api/comment?path=/article.html | head -c 200
#   期望：返回评论列表的 JSON（可能是 {"errno":0,...}），不是 404 HTML
```

**B. 公开站点未受影响**

```bash
for u in / /index.html /archive.html /article.html /about.html /404.html /js/posts.js; do
  printf '%-20s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' http://43.108.100.116$u)"; done
#   期望全 200
curl -s http://43.108.100.116/article.html | grep -c comments/waline    # 期望 ≥1
#   注意：文章页的正文与页面本身必须是"零外部请求"的，除了 /comments/ 那一块
```

**B2. 7.2.1 那个缺陷已修（接评论之前就该先过这一条）**

```bash
# 存在的文章：评论区是可见的
curl -s 'http://43.108.100.116/article.html?slug=water-entry' | grep -c 'id="comments"'
# 用浏览器打开确认：正常的文章评论区出现，地址栏里 slug 是瞎写时评论区**不出现**
#   浏览器打开 http://43.108.100.116/article.html?slug=this-slug-does-not-exist
#   期望：只有"这篇文章不存在"+最近文章，**没有**评论区，也没有对 /comments/ 的请求
#   （开发者工具 Network 面板里确认一下，这条验的是"不初始化"而不只是"看不见"）
```

**C. 端到端评论（真正的验收，用浏览器）**

1. 打开 `http://43.108.100.116/article.html?slug=water-entry`
2. 评论区应显示评论框；填昵称 + 邮箱 → 点"获取验证码"
3. **去邮箱收信**（收不到 → 回第 5 节；进了垃圾箱 → 第 5.3 节）
4. 填验证码 → 发评论
5. **因为 `COMMENT_AUDIT=true`，评论应该处于"待审核"状态**，页面上能看到自己的评论
   但带审核提示；换个浏览器（未登录）看到的就不该有它
6. 进 `/comments/ui/`（或隧道）→ 审核通过
7. 回文章页刷新 → **所有人可见**

**D. 反垃圾与限流**

```bash
# 连续快速发评论，期望出现 429（nginx 层）或 Waline 的 IPQPS 拒绝
for i in $(seq 1 12); do curl -s -o /dev/null -w '%{http_code} ' \
  -X POST http://43.108.100.116/comments/api/comment \
  -H 'content-type: application/json' -d '{"comment":"spam test","nick":"t","mail":"t@example.com","path":"/t"}'; done; echo
```

**E. 图片上传确实关掉了**

在评论区找上传/图片按钮 —— 应该**不存在**（没提供 `imageUploader` 回调）。若存在，
说明客户端配置里漏了 `imageUploader: false`，检查 7.2。这是客户端选项，
**服务端没有对应开关**，所以别去服务端找 `ENABLE_UPLOAD` 之类的变量（不存在）。

**F. 数据落在仓库外面**

```bash
sudo ls -l /srv/waline/data/          # 期望看到 waline.sqlite
sudo -u blog git -C /srv/blog/repo status --short   # 期望：看不到任何数据库文件
```

---

## 10. 回滚

```bash
# 1) 关掉服务
docker compose -f /srv/waline/docker-compose.yml down      # 方式 A
sudo systemctl disable --now p3-waline                     # 方式 B

# 2) 伪静态恢复（撤掉 /comments/ 反代与限流）
cp -a /www/server/panel/vhost/rewrite/<站点>.conf.bak-comments-<日期> \
      /www/server/panel/vhost/rewrite/<站点>.conf
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload

# 3) 前端退回占位状态
git switch main        # 撤掉 7.2 对 article.html 的改动
```

复验：`/api/session` 与 `/_admin/` 仍是 200，`/comments/` 变 404，公开页面全 200。
**评论数据还在 `/srv/waline/data/` 里，别删** —— 将来还能再拉起来。

---

## 11. 上线顺序总表

| 序 | 做什么 | 章节 | 卡点 |
| --- | --- | --- | --- |
| 1 | 探测磁盘 / Node / Docker / 8360 | 3 | 磁盘 < 2GB 先扩容 |
| 2 | 部署 Waline 到 `127.0.0.1:8360`，数据放 `/srv/waline/data` | 4 | 方式 B 要验原生模块 |
| 3 | 配 SMTP，**先验通发信** | 5 | 收不到信 = 评论不可用 |
| 4 | nginx 反代 `/comments/` | 6 | **别放在 `/api/` 或 `/` 上** |
| 5 | 确认后台没被抢走（第 6.4 那三条 curl） | 6.4 | 出错就立刻回滚伪静态 |
| 6 | 前端接 `#commentsMount`，自托管客户端资源；**顺带修 7.2.1 那个缺陷** | 7 | 只在文章存在时初始化 |
| 7 | 抢注管理员账号（第一个注册的就是管理员） | 8.1 | 别拖 |
| 8 | 全套验收 + 端到端发一条评论 | 9 | C 组是真正的验收 |
| 9 | 头像代理、`/comments/ui/` 限流、`ADMIN.md` 补文档 | 6.2、8.3、12 | 可最后做，不阻塞 |

---

## 12. 别忘了改文档

| 文件 | 改什么 |
| --- | --- |
| `blog-enter/ADMIN.md` | 新增一节"评论区"：Waline 在 `/comments/`、**评论在另一个后台管**（`/comments/ui/`）、数据在 `/srv/waline/data/`（不在仓库里）、以及两套登录互不相通 |
| `blog-enter/article.html` | 删掉第 88–120 行的占位说明与第 97 行的"占位"标签；评论区加 `hidden`；加客户端资源加载脚本（7.2） |
| `blog-enter/js/article.js` | **修缺陷**：`showNotFound()` 里藏 `#comments`；`render()` 里放开并调用 `window.initComments`（7.2.1） |
| `deploy/bin/blog-publish.sh` | 加 `--exclude '/api/'` 兜底（第 2.2 节的冲突），并确保 `comments/` 目录**不**被排除 |
| 本文件 | 执行完把第 1 节的选择与实际版本号（`@waline/vercel` 与 `@waline/client` 的具体版本）记下来 |

---

## 13. 附：已知的、你迟早会撞上的事

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 评论区一直转圈 / 一片灰 | unpkg 或头像代理在国内不可达 | 自托管客户端资源（7.1）+ 换头像源（6.2） |
| 验证码收不到 | SMTP 配错，或 QQ/163 用的是登录密码而非授权码 | 第 5 节 |
| 验证码进垃圾箱 | 个人邮箱发信的天然缺陷 | 5.3；长期换邮件推送服务 |
| 评论发出去但别人看不到 | `COMMENT_AUDIT=true`，等着你审 | Waline 后台审核队列 |
| 改了文章 slug，评论"不见了" | Waline 按 `path` 绑定，改名不会迁移评论 | 7.3；后台手工改 path |
| `file://` 下评论区报错 | 跨域限制，无解（浏览器不允许） | 7.4 的友好提示 |
| 服务器磁盘悄悄满了 | SQLite 增长 + 评论若开了上传 | 关闭上传（已选）+ 定期 `df -h` |
| 后台 `/api/` 突然 404 | 发布产物里混进了顶层 `api/` 目录 | 第 2.2 节的排除规则兜底 |

---

## 14. 附：与其它方案的关系

| 文档 | 关系 |
| --- | --- |
| `deploy/PLAN-ADMIN-LIVE.md` | **前置**。本方案假设它的 nginx 反代与 Node 环境已就位 |
| `deploy/PLAN-ADMIN-REMOTE.md` | 历史记录（方案 C），与两者都不冲突，但已被方案 D 取代 |
| `blog-enter/ADMIN.md` | 本方案执行后必须补充"评论区"一节（第 12 节） |
