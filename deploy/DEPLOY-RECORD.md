# 部署记录：云端后台（2026-10-06 实测）

> 这份是**已完成状态的记录**，不是计划。计划见 `PLAN-ADMIN-LIVE.md`（方案 D）。
> 每条都对应一次实测，命令可直接抄。

---

## 1. 现在是什么状态

| 项 | 值 |
| --- | --- |
| 站点 | `http://43.108.100.116/` 正常，全部页面与资源 200 |
| 站点根目录 | `/www/wwwroot/43.108.100.116`（`www:www`，目录 2775 setgid） |
| 仓库 | `/srv/blog/repo`，`blog:blog`，与 GitHub `main` **一致** |
| 代码版本 | commit `add8ed2`（本机 / 服务器 / GitHub 三方一致） |
| 后台服务 | `p3-admin.service`，`active`，**只监听 `127.0.0.1:8848`** |
| 评论服务 | `p3-waline.service`，`active`，**只监听 `127.0.0.1:8360`**；数据在 `/srv/waline/data/waline.sqlite`（仓库外）；客户端资源自托管在站点 `/comments/` |
| 评论策略 | 现在是「匿名可评 + 先审后发」（`LOGIN=disable` + `COMMENT_AUDIT=true`）。**邮箱验证码还没开** —— 见第 8 节 |
| 认证 | 口令（PBKDF2-SHA256 210k）＋ 每客户端会话 cookie ＋ UA/IP 网段绑定 |
| 反代 | **未开启**。nginx 里 `/_admin/` 仍是 `return 404` |
| 公网暴露面 | `22` 开、`80` 开、`443` 关、**`8848` 不可达**；<br>`8888`（宝塔面板）在 **iptables 层限制为「本机 + 白名单 IP」** |
| SSH 认证 | **仅密钥**（`PasswordAuthentication no`、`PermitRootLogin prohibit-password`、`MaxAuthTries 3`） |
| 入侵防护 | **fail2ban** 已装并在跑（sshd jail：3 次失败 → 封 24 小时） |
| Node | v22.12.0（`/usr/local/bin/node`） |

### 1.1 SSH 与防火墙加固（因正在被爆破而做）

**起因**：`/var/log/secure` 里发现规模化 SSH 爆破 —— 单 IP 24 小时内约 1000 次尝试，
来源轮流出现在 `109.160.32.0/24` 等网段，用户名从 `s10femi`、`frontend`、`SJ05`
等字典里轮换。当时的状态是 `PasswordAuthentication yes` + `PermitRootLogin yes`
+ **没有 fail2ban** —— 也就是说这波爆破**是能够成功的**。

| 动作 | 效果 |
| --- | --- |
| `/etc/ssh/sshd_config` 追加加固段（含回滚说明） | 只剩密钥登录；实测口令登录被拒：`Permission denied (publickey,...)` |
| iptables 丢弃 `109.160.32.0/24` | 该网段直接在内核层被丢 |
| iptables 限制 `8888`：仅回环 + 白名单 | 宝塔面板不再对公网开放 |
| 安装并启用 fail2ban（sshd jail） | 实测爆破从 **92 次/2 分钟 → 3 次/2 分钟** |

**为什么用 iptables 而不是 firewalld**：宝塔面板在 `11:40:15` 把 firewalld 停掉并禁用了
（`disabled`），面板自己管防火墙。所以规则必须落在 iptables 上。持久化用自建单元
`/etc/systemd/system/p3-firewall.service`（开机 `iptables-restore /etc/p3blog/iptables.rules`），
**已验证**：清空规则后 `systemctl reload p3-firewall` 能完整恢复。

**换网络后 8888 打不开怎么办**：白名单里的 IP 是写死的，家宽 IP 变了就进不去面板。

```bash
p3-allow-8888            # 看当前白名单
p3-allow-8888 add        # 把当前 SSH 来源 IP 加进去
p3-allow-8888 add 1.2.3.4
p3-allow-8888 del 1.2.3.4
p3-allow-8888 reset      # 只留回环（最严）
```

**更省事的办法**——回环永远放行，走隧道就不用管白名单：

```powershell
ssh -L 8888:127.0.0.1:8888 root@43.108.100.116
# 本机浏览器开 http://127.0.0.1:8888
```

**回滚 SSH 加固**：删掉 `sshd_config` 里 `===== BEGIN/END hardening =====` 之间的段落，
取消被注释的 `PasswordAuthentication` / `PermitRootLogin` 两行，`systemctl restart sshd`。
改前备份在 `/etc/ssh/sshd_config.bak-2026-10-06-1153`。

> ⚠️ fail2ban 的白名单在 `/etc/fail2ban/jail.d/p3-ignoreip.local`，里面也写了你的出口 IP。
> 换网络后同样要更新，否则可能被自己封掉 —— **这个坑已经踩过一次**：服务器的公网 IP
> 因为"连自己失败"被封了，已解封并加入白名单。

### 为什么反代故意没开

纯 HTTP 下口令与会话 cookie 都明文过网，`Secure` 加不了（加了浏览器直接不存）。
域名 `simonfu.xin` 仍是 NXDOMAIN、443 未监听，签不了证书。
**隧道方案零公网攻击面，且已经可用**，所以默认走隧道；要开公网见第 5 节。

---

## 2. 怎么用（SSH 隧道，推荐）

```powershell
ssh -L 8848:127.0.0.1:8848 root@43.108.100.116
# 浏览器打开 http://127.0.0.1:8848/_admin/，输入口令
```

隧道下浏览器无法自带反代密钥（导航请求不能自定义头），所以 8848 那一层
**不是**后台进程，而是一个会注入密钥并改写 Host 的小反代
（`blog-enter/server/tunnel-proxy.mjs`，由 `p3-admin-proxy.service` 托管）：

```
本地浏览器 → ssh -L 8848 → 127.0.0.1:8848【反代：注入密钥 + 改写 Host】
                               ↓
                         127.0.0.1:8849【后台 node】
```

实测（真实隧道）：管理页 **200**、未登录 `token: null`、未登录读文章 `401`、
站点首页 `200`；而**直连 8849 无密钥一律 403** —— 边界没有被削弱。

> 为什么不用宝塔的 nginx 做这一层：那套是 **OpenResty**，独立配置缺
> `load_module` 与 Lua 环境，启动即失败；沙箱收紧后它连自己的错误日志都写不了。
> 本项目本来就是零依赖 Node，四十行 Node 比迁就它的模块体系更可控。

**保存即上线**：在管理页保存后约 2 秒，公开站点自动更新（实测文章数 8→9→8）。
它由三步组成，缺一不可：

1. 管理页写 `blog-enter/js/posts.js`；
2. `blog-publish` 把**内容文件**自动 commit（只提交 `posts.js` 与 `img/uploads`，
   代码文件仍"脏就报错"，不允许被 HTTP 触发的流程吞掉）；
3. rsync 到站点根目录，然后**自检**站点根目录里没有 `admin/ server/ tests/ api/ .env`。

任何一步失败都会写进 journald，但**保存本身不会失败**（内容已落盘 + 备份）。

---

## 3. 秘密放在哪

| 文件 | 权限 | 说明 |
| --- | --- | --- |
| `/srv/blog/repo/.admin/passphrase.json` | `600 blog:blog` | 口令的 PBKDF2 哈希（无明文） |
| `/etc/p3blog/proxy-secret` | `640 root:blog` | nginx 与后台之间的共享密钥 |
| `/srv/blog/repo/.admin/backups/` | — | posts.js 滚动备份（20 份） |
| `/srv/blog/repo/.admin/trash/` | — | 删除的文章 |

本机上对应的口令明文在 `D:\DS\.admin\.server-pass.txt`（`.admin/` 已 gitignore）。
**仓库里没有任何秘密**（已审计确认：全部提交历史里没有口令、密钥、私钥）。

---

## 4. 运维命令

```bash
# 状态
systemctl status p3-admin
journalctl -u p3-admin -n 30 --no-pager
ss -lntp | grep 8848            # 必须只有 127.0.0.1

# 改口令（不要用 --pass，会进 ps 与 journald）
printf %s '新口令' | sudo -u blog env PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/local/bin/node /srv/blog/repo/blog-enter/server/dev-server.mjs --set-pass --pass-stdin

# 手工发布（会自动提交内容）
sudo -u blog blog-publish

# 回滚代码
cd /srv/blog/repo && git log --oneline -10 && git reset --hard <commit>

# 回滚内容（管理页里也能做）
sudo -u blog git -C /srv/blog/repo log --oneline -5
```

---

## 5. 要开公网后台的话（未执行）

按 `PLAN-ADMIN-LIVE.md` 第 7 节配 nginx：删掉伪静态里的
`location ^~ /_admin/ { return 404; }`，加 `/_admin/` 与 `/api/` 两段反代，
并把 `/etc/p3blog/proxy-secret` 的值注入 `X-Admin-Proxy-Secret`。

**先想清楚**：那等于把管理面挂到明文 HTTP 上。**先把域名与证书弄好**
（`--public-origin https://simonfu.xin` 会让 cookie 自动带上 `Secure`），
或者至少加 mTLS / IP 白名单。

---

## 6. 已知的、还没做的事

| 项 | 状态 |
| --- | --- |
| Waline 评论区 | **已上线**（2026-10-06）：服务端 + nginx + 前端都跑起来了，见第 8 节。<br>**还没做**：① 管理员账号还没注册（第一个注册的自动是管理员）；<br>② SMTP 授权码没填，所以邮箱验证码还没开；③ 开完要删掉伪静态里那段临时的注册封锁 |
| 服务器回推 GitHub | **现在能推了**（2026-10-06 实测：管理页保存产生的内容提交会自动推到 `origin/main`，来源是服务器上的内容提交 `a371843`）。<br>`blog` 用户下有一把 `~/.ssh/github_deploy`；本机与服务器并行提交时要注意先 rebase 再推 |
| `images.mjs` 的 SVG `<style>` 文本未净化 | 未修（ReDoS 只修了 `validate.mjs`） |
| 图片像素上限 / 登录并发上限 / `/api/session` 性能 | 未修，见 `AUDIT-INDEX.md` |
| 前端渲染期转义（审计 F5/F6/F7） | 现在只靠保存期白名单挡 |
| 宝塔面板访问 | 已从公网摘掉（firewalld 移除 `8888/tcp`），改走 `ssh -L 8888:127.0.0.1:8888` |
| SSH 允许 root 口令登录 | **仍未关**（`permitrootlogin yes` + `passwordauthentication yes`），<br>且未装 fail2ban。密钥已可免密登录 root，关掉是安全的，但需你确认 |
| 域名与 TLS | `simonfu.xin` NXDOMAIN、443 未监听 |

---

## 7. 踩过的坑（改法都已在代码里）

0. **以 root 跑过 git → 自动提交失败 → 你以为保存成功但站点没变。**
   `git` 以 root 身份执行会在 `.git/objects` 留下 root 拥有的目录，之后
   `blog` 身份的自动提交写不进去：

   ```
   error: insufficient permission for adding an object to repository database .git/objects
   ```

   症状极具误导性：保存返回 **200**、内容确实进了工作区，但提交失败 →
   工作区变脏 → 发布被"脏就报错"闸门拒绝 → **站点不变，而界面没说保存失败**。
   修法：`bash deploy/bin/fix-repo-ownership.sh`（把整个仓库还给 `blog`）。
   预防：**别用 root 在 `/srv/blog/repo` 里跑 git**；要跑就 `sudo -u blog git …`。
   实证：修前 `.git` 里 110 个 root 文件，`blog` 提交必失败；修后 0 个，提交正常。

1. **`--auto-publish` 跑的是旧脚本**：引导脚本把 `blog-publish.sh` 复制到
   `/usr/local/lib/p3blog/`，改仓库不生效。现在包装器直接执行仓库里那份
   （`install-publish-wrapper.sh`）。
2. **自动提交从未生效**（三连坑）：① 文档写了"先 commit 再同步"但实现里没有；
   ② `CONTENT_PATHS` 是带空格的字符串，`git status -- "$CONTENT_PATHS"`
   把它当成**单个路径**；③ 改数组后 `git add` 遇到不存在的 `img/uploads`
   整体报错。最终改成"按前缀过滤真实改动路径再 add"。
3. **`git fetch` 失败会让整个发布脚本退出**（`set -e`），表现为"什么都没发布"。
   现在 fetch 失败只警告，按当前工作区继续发布。
4. **服务器连不上 GitHub 时不要硬等**：部署期间用的是 tar + `git bundle` 直传，
   因为沙箱里的 GitHub 推送被 EPERM 挡住（已提权完成）。
5. **`Host: 127.0.0.1` 会命中宝塔的 status server 块**（`phpfpm_status.conf`），
   于是所有请求 404 —— 一度让我误判"站点被我搞坏了"。本机自测必须带
   `-H 'Host: 43.108.100.116'`。
6. **`isDraft` 的 slug 就在公开的 `posts.js` 里**，所以 `?preview=<slug>`
   等于没有保护。现在发布脚本遇到草稿直接拒绝发布（exit 4）。
7. **`images.mjs` 的 `style` 是允许标签**，而标签之间的文本不过滤；
   另外 `validate.mjs` 原来的标签正则有 ReDoS（43 字节 → 1288ms），已改线性分词器。

---

## 8. 评论区（Waline）—— 2026-10-06 实测

方案是 `PLAN-COMMENTS-WALINE.md`（方案 E）。**它写的顺序基本对，但有五处是错的/漏的**，
下面按实测补上。装法已经沉淀成脚本：`bash deploy/bin/install-waline.sh`（幂等）。

### 8.1 现在长什么样

```
浏览器 ──► nginx 43.108.100.116:80
             ├─ /comments/…            ──► 127.0.0.1:8360  Waline（p3-waline.service）
             │      含 /comments/api/、/comments/ui/、/comments/verification
             ├─ /comments/ui/          ──► 只 allow 127.0.0.1（管理后台走 SSH 隧道）
             ├─ /comments/api/user     ──► 临时只 allow 127.0.0.1（防管理员被抢注）
             ├─ /comments-assets/*.js|css ─► 静态文件（评论客户端/后台 bundle，自托管）
             └─ 其余                    ──► 静态站点，完全不受影响

本机 ──ssh -L 8360──► 127.0.0.1:8360/ui/  管理后台（页面、API、口令全程不出本机）
```

| 项 | 值 |
| --- | --- |
| 服务端 | `@waline/vercel` **1.43.4**，`/srv/waline/app`，systemd `p3-waline` |
| 客户端 | `@waline/client` **3.16.0**（自托管在 `blog-enter/comments-assets/`） |
| 后台 UI | `@waline/admin` **0.36.0**（同上；地址写在 `WALINE_ADMIN_MODULE_ASSET_URL`，是绝对公网地址） |
| 数据库 | `/srv/waline/data/waline.sqlite`（**仓库外**，`blog:blog` 640） |
| 配置 | `/etc/p3blog/waline.env`（640 root:blog，含 `JWT_TOKEN`） |
| 当前策略 | `LOGIN=disable`（匿名可评）+ `COMMENT_AUDIT=true`（先审后发）+ `IPQPS=60` |

### 8.2 方案 E 里五处与实测不符的地方（照抄会踩）

1. **SQLite 必须先放官方结构文件。** 空库不会自建表 —— 读写一律
   `{"errno":500,"errmsg":"no such table: wl_Comment"}`。官方文档
   「多数据库服务支持 · SQLite」要求先下载
   `assets/waline.sqlite`。安装脚本会从三个源里挑一个能用的下下来，
   并**校验里面确实有 `CREATE TABLE "wl_Comment"`** 才安装。
2. **Waline 默认监听 `0.0.0.0`。** 实测 `ss -lntp` 是 `*:8360`，
   等于绕过 nginx 裸奔（限流、日志、`/ui/` 的 IP 限制全部失效）。
   修法：在 `vanilla.js` 旁边放 `config.js` 导出 `{ host: '127.0.0.1' }`
   （`vanilla.js` 在 `run()` 之后会 `require('./config.js')` 逐项 `think.config`）。
3. **`proxy_pass` 结尾必须带 `/`（剥前缀）。** 方案 E 写的是
   `proxy_pass http://127.0.0.1:8360;`（不带 URI）—— 那样
   `/comments/api/comment` 会原样转发上去，而 Waline 的接口前缀是 `/api/`，结果 404。
   同一段里 `X-Forwarded-For` 用 `$remote_addr` **覆盖**而不是 append：
   thinkjs 开了 `proxy=true`，append 的话攻击者自带 XFF 就能伪造 IP 绕过 IPQPS。
4. **只反代 `/comments/api/` 与 `/comments/ui/` 会漏路由。** 翻开 Waline 的
   controller 才看到它还有 `/verification`（**邮件验证链接就指这里**）、`/token` 等
   根级路由。漏掉 `/verification` 的后果是：用户点邮件里的验证链接直接 404。
   所以改成**整段** `^~ /comments/` 反代，并把客户端静态资源挪到
   `/comments-assets/`（否则会被一起转走然后 404）。
5. **管理端经隧道打开时，`window.serverURL` 指向公网明文地址。** 它是 Waline 用
   `SERVER_URL` 拼的，而 `SERVER_URL` 必须是公开地址（邮件链接要用），
   于是隧道里点"登录"会把**口令 POST 到公网明文地址**上 —— 恰好是隧道要避免的事。
   修法：install 脚本对 `src/middleware/dashboard.js` 做一行 patch，
   让 `window.serverURL` 跟当前地址走。实测隧道下它算成
   `http://127.0.0.1:18360/api/`，`/api/token` 确实打到本机。
   admin bundle 的地址则必须是**绝对公网地址**（它只是静态文件，不含秘密）。

> ⚠️ 第 2 与第 5 条都是对 `node_modules` 里文件的改动：
> **重装 `@waline/vercel` 会冲掉它们**，装完要重跑 `deploy/bin/install-waline.sh`。

另外一条方案没提、真浏览器才发现的：**客户端默认会去 unpkg 拉表情包**
（`https://unpkg.com/@waline/emojis@1.1.0/...`）。本站零外部运行时依赖，
所以 `init` 里写的是 `emoji: false`；要开就得把表情包也自托管。

（评论区后台自己会去 `waline.js.org` 取一个 logo 图片，那是管理端的事，公开页面不受影响。）

### 8.3 验收（都跑过）

```bash
# 路由没被抢 / 站点没受影响
for u in / /index.html /archive.html /article.html /about.html /404.html /js/posts.js; do
  printf '%-16s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' http://43.108.100.116$u)"; done   # 全 200
for u in /comments-assets/waline.js /comments-assets/waline.css /comments-assets/waline-admin.js \
         /comments/verification; do
  printf '%-34s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' http://43.108.100.116$u)"; done  # 全 200
curl -s -o /dev/null -w '%{http_code}\n' http://43.108.100.116/_admin/        # 404（管理面没被带出去）
curl -s -o /dev/null -w '%{http_code}\n' http://43.108.100.116/comments/      # 404（不给 Waline 演示页）
curl -s -o /dev/null -w '%{http_code}\n' http://43.108.100.116/comments/ui/   # 403（只允许本机）
curl -s -H 'Referer: http://43.108.100.116/article.html' \
     'http://43.108.100.116/comments/api/comment?path=/article.html' | head -c 120   # JSON，不是 404
ss -lntp | grep 8360        # 必须 127.0.0.1:8360
```

```powershell
node blog-enter/server/tests/verify-comments-live.mjs   # 真浏览器 15 项全绿
```

端到端发一条：真浏览器在文章页填昵称邮箱 → 提交 → 页面出现"评论正在审核中
（当前仅自己可见）"，接口 200，`wl_Comment` 里 `status=waiting`，
region 正确（说明 XFF 传对了）。这条测试评论已从库里删掉。

评论后台也真浏览器验过（`ssh -L 18360:127.0.0.1:8360` 后打开
`http://127.0.0.1:18360/ui/`）：登录页渲染正常、无控制台报错，
`window.serverURL` 是 `http://127.0.0.1:18360/api/`，`/api/token` 打在本机，
全页只有 admin bundle 一个文件来自公网。

### 8.4 还没做的（下一步）

| 序 | 做什么 | 卡点 |
| --- | --- | --- |
| 1 | **注册管理员**：`ssh -L 8360:127.0.0.1:8360 root@43.108.100.116` → `http://127.0.0.1:8360/ui/` | 第一个注册的自动是管理员，**绝不能拖到开放注册之后** |
| 2 | 填 `SMTP_*`（QQ/163 授权码）→ `systemctl restart p3-waline` → 验证码能发出来 | 发不出信 = 谁也评论不了，所以顺序不能反 |
| 3 | 把 `LOGIN` 改成 `force`，同步改 `article.html` 里的 `login` | 两处必须一致 |
| 4 | 删掉伪静态里那段**临时**的 `location = /comments/api/user`（现在是它挡着公网注册） | 不删 = 评论者永远注册不了 |

---

## 9. 公开登录与 MySQL —— 2026-10-06 骨架（实测结果待 t18 填）

新系统：`p3-public`（只绑回环 `127.0.0.1:8850`）+ MySQL 库 `p3blog`，经 nginx 的
`/api/auth/*` 与 `/api/comments*` 反代段对外；页面评论从 Waline 换成自建组件（MySQL 存储）。
部署件与逐步安装清单见 `deploy/PLAN-PUBLIC-LOGIN.md`（每步都带验证命令），
表结构见 `blog-enter/server/sql/schema.sql`，接口形状见
`blog-enter/server/CONTRACT-public-api.md`。

### 9.1 现状（t18 逐项填实测）

| 项 | 期望 | 实测 |
| --- | --- | --- |
| `systemctl is-active p3-public` / `is-enabled` | active / enabled | TODO |
| `ss -ltnp \| grep 8850` | 只有 `127.0.0.1:8850` | TODO |
| `mysql --defaults-file=/etc/my.cnf -N -e "select count(*) from information_schema.tables where table_schema='p3blog'"` | 6 | TODO |
| 公网 `GET /api/auth/me` | 200 + `{"ok":true,"user":null,"db":"up",…}` | TODO |
| 公网 `/_admin/`、`/server/`、`/*.mjs` | 全 404 | TODO |
| 首页右上角登录入口；article.html 无 Waline | 是 / 是 | TODO |
| 注册→登录→发评论→删除→登出 | 闭环全通 | TODO |
| 越权（A 删 B 的评论） | 403 且评论仍在 | TODO |
| 限流（错误口令连打） | 第 11 次 429 + `Retry-After` | TODO |
| 响应体不含 `password_hash`/`email`/`user_id` | 是 | TODO |
| **直连 8850 不带/伪造密钥头**（冒充 nginx） | 必须 403；而经公网同一请求 200 | TODO |
| **给了 `--proxy-secret-file` 但密钥文件缺失/为空** | 服务**启动失败**（fail-fast，journal 有明确原因），不是静默降级 | TODO |
| 代理密钥文件 | `/etc/p3blog/public-proxy-secret` 640 root:blog、`/etc/p3blog/public-proxy-header.conf` 600 root:root，两者同值 64 位十六进制 | TODO |

### 9.2 可回滚点（t18 填）

| 项 | 值 |
| --- | --- |
| 部署前 commit / 部署后 commit | TODO |
| 伪静态备份 | `/root/p3-rewrite.bak-*.conf`、`/root/p3-rewrite.bak2-*.conf` |
| 全库备份（**重置前**，t13 留的） | `/www/backup/p3-mysql-pre-reset-20261006-162241.sql.gz` |
| 上线后新做的全库备份 | TODO（命令见 9.6） |
| `/etc/my.cnf` 备份 | `/root/p3-my.cnf.bak-20261006-162432`、`/root/p3-my.cnf.bak2-20261006-162613` |
| binlog 索引备份 | `/root/p3-mysql-bin.index.bak-20261006-162105` |
| 代理密钥（新机制，n/a 表示由 t18 首次生成） | `/etc/p3blog/public-proxy-secret`(640 root:blog)、`/etc/p3blog/public-proxy-header.conf`(600 root:root) |

### 9.3 回滚动作 A：停用公开服务（最快，30 秒）

```bash
systemctl disable --now p3-public
systemctl is-active p3-public              # inactive
ss -ltnp | grep 8850 || echo '8850 已关闭'
```

只停服务、不动 nginx 时，`/api/*` 会变成 502/504（反代还在、后端没了），前端走
"接口不可用"的降级显示。想让这些路径干脆 404，接着做 9.4。

### 9.4 回滚动作 B：回退 nginx 反代段

```bash
RW=/www/server/panel/vhost/rewrite/43.108.100.116.conf
cp -a "$RW" "/root/p3-rewrite.before-rollback-$(date +%Y%m%d-%H%M%S)"   # 先留证据
# 方案 1（推荐）：整段恢复备份
cp -a /root/p3-rewrite.bak2-<时间戳> "$RW"
# 方案 2：只删公开 API 段，保留其它规则的最新改动
# sed -i '/^# ==== P3_public API 开始/,/^# ==== P3_public API 结束/d' "$RW"
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
```

**验证**：`curl -s -o /dev/null -w '%{http_code}\n' http://43.108.100.116/api/auth/me` → 404；
`/_admin/` 仍 404、`/comments/` 状态码与回滚前一致。
`nginx -t` 不过就**不要 reload**，先 `cp -a` 恢复。

> ⚠️ 回退 nginx 段会把每条 `/api/*` location 里的
> `include /etc/p3blog/public-proxy-header.conf;` 一起带走 —— 公网请求不再带密钥头。
> 如果后端这时仍带 `--proxy-secret-file`，公网 `/api/*` 会**全部 403**（服务本身是活着的，
> 只是每个请求被判"不是来自我们的 nginx"→ 运行时拒绝，属 fail-closed；这与启动期的
> fail-fast 不同：那个表现是服务根本起不来）。要彻底回退就两步一起做：恢复伪静态 +
> 去掉单元里的 `--proxy-secret-file` 并 `systemctl daemon-reload && systemctl restart p3-public`。

### 9.5 回滚动作 C：重新启用 Waline（资源与反代都还在，从未删除）

Waline 的 nginx 段（`location ^~ /comments/`、`/comments/ui/`、`location = /comments/api/user`）
与静态资源 `comments-assets/waline*.js|css` 都原样保留，服务单元 `p3-waline` 也在：

```bash
systemctl status p3-waline --no-pager | head -5     # active
ss -lntp | grep 8360                                # 127.0.0.1:8360
curl -s -o /dev/null -w '%{http_code}\n' http://43.108.100.116/comments-assets/waline.js   # 200
```

前端换回去（改代码后重新发布）：

1. `article.html`：删掉 `js/comments.js` 引用，恢复 `comments-assets/waline.js` +
   `comments-assets/waline.css` 与原来的 `Waline.init({...})` 调用；
2. 五个页面：去掉 `js/auth-ui.js` 引用（登录按钮与新系统绑定；要留按钮就得留着 `p3-public`）；
3. `sudo -u blog blog-publish`，然后
   `curl -s http://43.108.100.116/article.html | grep -ci waline` 应 ≥1。

> Waline 的数据在 `/srv/waline/data/waline.sqlite`，与 MySQL **互不相通**：
> 回退等于"新系统期间的评论在页面上消失"（数据仍在 MySQL，按 9.6 备份留档）。

### 9.6 回滚动作 D：MySQL 库的备份与删除

```bash
# 全库备份（走 /etc/my.cnf [client] 的 root 凭据，命令行不出现口令）
TS=$(date +%Y%m%d-%H%M%S)
mysqldump --defaults-file=/etc/my.cnf --single-transaction --routines --events \
  --all-databases | gzip -c > /www/backup/p3-mysql-all-$TS.sql.gz
gzip -t /www/backup/p3-mysql-all-$TS.sql.gz && ls -la /www/backup/p3-mysql-all-$TS.sql.gz

# 只备份业务库
mysqldump --defaults-file=/etc/my.cnf --single-transaction --databases p3blog \
  | gzip -c > /www/backup/p3blog-$TS.sql.gz

# 恢复（覆盖现有 p3blog）
zcat /www/backup/p3blog-$TS.sql.gz | mysql --defaults-file=/etc/my.cnf

# 删除（不可逆：先备份）
mysql --defaults-file=/etc/my.cnf -e "DROP DATABASE IF EXISTS p3blog;"
mysql --defaults-file=/etc/my.cnf -e "DROP USER IF EXISTS 'p3app'@'127.0.0.1';"
mysql --defaults-file=/etc/my.cnf -e "SELECT user,host FROM mysql.user WHERE user='p3app';"   # 应为空
```

删库**不会**自动停服务：`p3-public` 会退到"库不可用"（`/api/auth/me` 仍 200 + `db:"down"`，
其余端点 503）。要彻底下线先做 9.3。

### 9.7 运维注意事项（t13 踩出来的，别忘）

* `mysqld` 由**宝塔生成的 SysV 脚本**托管（`/etc/rc.d/init.d/mysqld` → systemd 的
  `mysqld.service`），不是原生 systemd 单元。升级/重装宝塔可能覆盖启动链，症状是
  「3306 又连不上」；异常先看 `/etc/init.d/mysqld`、`journalctl -u mysqld`、以及
  `/www/server/data/mysql-bin.index` 里是否又留下不存在的 binlog 条目（会 `Aborting`）。
* `/etc/my.cnf` 已启用 `skip-name-resolve`：TCP 按**字面 IP** 认账号。`'root'@'127.0.0.1'`
  不存在，所以 `mysql -h127.0.0.1 -uroot` 会 1045（socket 路径正常）。**不要**关掉它 ——
  关掉后 `'p3app'@'127.0.0.1'` 立刻连不上（127.0.0.1 会被反解成 localhost），新系统全站 503。
* MySQL 5.7 客户端里 **option file 的 password 优先级高于 `MYSQL_PWD`**：验证脚本要显式带
  `--defaults-file` 或 `--password=`，别以为设了环境变量就赢。
* 口令分布：`p3app` → `/etc/p3blog/public.env`(600 root:blog)；root →
  `/root/p3-mysql-root.txt`(600) 与 `/etc/my.cnf [client]`(600 mysql:mysql)。仓库里没有任何口令。
* **代理共享密钥是一对机制**：`--trust-proxy`（后端相信 XFF 的最后一段）必须与
  nginx 注入的 `X-Admin-Proxy-Secret`（值来自 `/etc/p3blog/public-proxy-header.conf`，
  由 `--proxy-secret-file` 比对）**同时存在**。
  · 只开后端那一半 → 本机任何进程都能直连 8850 自塞 XFF 伪造客户端 IP（限流形同虚设、审计记假地址）；
  · 只开 nginx 那一半 → 后端不看 XFF，所有请求对端都是 127.0.0.1（限流退化成全站共享桶）。
  **语义（t14 定稿）**：给了 `--proxy-secret-file` → 密钥文件必须存在且非空，否则**启动失败**
  （fail-fast；反过来说，服务能起来就证明两份密钥文件都在）；完全不给该参数 → 允许启动但强制
  关闭代理信任并告警。nginx 侧密钥头文件缺失时 `nginx -t` 失败、reload 不执行（fail-closed）。
  **顺序**：第 4 步一次建好两份密钥文件 → nginx -t + reload → 再 start/restart 后端；
  这样"后端要密钥但 nginx 没送"与"nginx 送头但后端不校验"两个中间态都不存在，**没有过渡期 403**。
  **信任层**：`public-proxy-header.conf` 与伪静态文件同属 root-only 配置层（600 root:root），由
  root 的 nginx master 在配置解析期读取 —— **不要为了"方便读"把它放宽成 www 可读**
  （worker 是 www；一旦放宽，同机低权限用户就能拿到密钥、重新伪造成 nginx）。
  细节见 `PLAN-PUBLIC-LOGIN.md` 第 4/5/6 步，以及第 5 步的「顺序要求：三步、零中间态」。
* **依赖清单 / node_modules 有两道闸，别只留一道**：第一道是发布脚本的
  `--filter='-s /server/'`（结构上排除整个 `server/` 子树）+ 发布后自检（顶层出现
  `package.json` / `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` / `npm-debug.log`
  就 `exit 5`）；第二道是宝塔伪静态里的
  `location ^~ /node_modules/` 与 `location ~* ^/(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|npm-debug\.log)$`
  兜底 404（覆盖手工 rsync / 快照还原 / 换发布方式这些绕过发布脚本的路径）。
  **第二道不是放宽第一道的理由**：发布排除必须保持。该正则锚定站点根（`^/…$`，
  即发布脚本会散落文件的位置），嵌套目录里的同名文件不在其内；`/node_modules/` 用 `^~`
  前缀覆盖任意深度，且 `^~` 优先于正则，不会被 `~* \.(js|css)$` 的缓存规则抢走
  （真机 18080 探针验过 `/js/posts.js` 仍 200）。回退时这两条随
  「P3_blog 规则」整段一起被带走（见 9.4）。

### 9.8 t16 独立验证（verifier）—— 本地端到端已完成；公网闭环待 t18 后补跑

验证脚本：`blog-enter/server/tests/verify-public-live.mjs`（独立于实现者：期望值全部从
`CONTRACT-public-api.md` 抄下来硬编码，不 import 被测业务逻辑；本地模式只动态 import
`createPublicApp()` 起真 HTTP 服务，线上模式零产品依赖）。
脚本可重复执行：每轮账号名/评论内容/slug 都带随机 runId（`t16v<6 hex>`），退出时先软删自己的
评论、再经 SQL 通道删除本轮用户行（外键级联带走会话与评论）并清零登录限流；`--keep-data`
可保留数据供人工查看，`--skip-rate-limit` 可跳过 429 段（跳过会记成失败，不隐瞒）。

#### 9.8.1 本轮状态（2026-10-06）

| 判据 | 实测命令 | 实际结果 | 结论 |
| --- | --- | --- | --- |
| **A. 本地 7 端点（+`mine`）的成功与失败路径全部实测** | `node blog-enter/server/tests/verify-public-live.mjs --local --out .preview/t16/local-report.md` | `合计 107 项：PASS 107 / FAIL 0`（失败形状断言累计 48 条），exit 0 | **通过** |
| **B. 公网真实入口闭环** | 同上脚本 `--base http://43.108.100.116 --ssh root@43.108.100.116` | **未执行**：本轮线上尚未部署（`systemctl is-active p3-public` = inactive；nginx 无 `/api/*` 段；`http://43.108.100.116/api/auth/me` → 404）。脚本已就绪并在本进程 shim 上自检 `31 PASS / 0 FAIL / 2 NA`，exit 0 | **待 t18 部署后补跑** |
| 线上跨账号删除 403 / 未登录删除 401 | 同上 | 同上（本地与 shim 两条路径已全绿：A 删 B 的评论 → 403 且目标仍在；未登录 / 伪造 cookie / 退出后 → 401） | **待 t18 后补跑** |
| 线上错误口令连打 → 429 + 无口令哈希/邮箱泄漏 | 同上 | 同上（本地 HTTP 层内存窗口第 11 次 429 `Retry-After: 3600`；库内 `auth_throttle` 熔断单独验过；线上入口待跑） | **待 t18 后补跑** |
| 脚本可重复执行且自清理；报告逐条给出命令与实测 | 见 9.8.2 | 本地 107 行报告表由 `--out` 落盘；SQL 通道（`--ssh`/`--sql-local`）在本机实测可用（`mysql -N -B p3blog` 经 ssh 返回 `0 0 0`，说明库存在且为空） | **通过（线上清理待跑）** |

> 除 429 那一段外，脚本对线上的**任何请求都不会写坏数据**；429 那一段会按契约把
> **本机公网 IP 的登录限流锁 1 小时**（库内 `auth_throttle` + 进程内窗口）。解锁：
> 部署后清理步骤会自动执行 `DELETE FROM auth_throttle WHERE action='login';`，
> 手工解锁用 `ssh root@43.108.100.116 "mysql -N -B p3blog -e \"DELETE FROM auth_throttle WHERE action='login'\""`
> （进程内窗口随 `systemctl restart p3-public` 清零）。

#### 9.8.2 A 部分（本地，跑过）分组明细

命令：`node blog-enter/server/tests/verify-public-live.mjs --local --out .preview/t16/local-report.md`
（逐条「判据 → 命令 → 实测 → 结果」在 `.preview/t16/local-report.md`，107 行）

| 分组 | 项数 | 结果 |
| --- | --- | --- |
| 静态：五页登录入口标记 / `article.html` 无 Waline / `auth-ui.js`、`comments.js` 无 innerHTML 拼接 / 公开服务无管理面引用 | 12 | 全通过 |
| 本地 0：7 模块 `node --check`；`--print-config` 常量（8 条路由、cookie 名、5 组限流阈值）；缺库 exit 6 / 绑 0.0.0.0 exit 4 / 密钥文件缺失 exit 7 | 11 | 全通过 |
| 本地 1：`GET /api/auth/me`（匿名 200+null+`db:up`、带会话本人字段、响应头 no-store） | 3 | 全通过 |
| 本地 2：`register` 成功 201 + cookie 属性 + 库内是 pbkdf2 哈希；11 条失败路径（用户名/邮箱/口令格式、大小写不敏感的 409）+ 第 6 次 429 | 15 | 全通过 |
| 本地 3：`login`（用户名/邮箱/别名、错口令与不存在用户逐字节一致、耗时对齐、禁用账号同形、415、内存第 11 次 429、库内熔断短路不再查库） | 12 | 全通过 |
| 本地 4：`logout`（带/不带/伪造 cookie、清 cookie 属性一致、第 31 次 429） | 5 | 全通过 |
| 本地 5：评论列表（空数组、升序+id tie-breaker、键集合白名单、无 email/口令列、3 条非法 slug、跨文章回复 422） | 7 | 全通过 |
| 本地 6：发评论（未登录 401、201 形状、首尾空白、2000/2001 边界、`parent_id` 三种边界、415、非法 JSON、数组体、>1MiB 413、第 21 条 429） | 15 | 全通过 |
| 本地 7：删评论（未登录 401、跨账号 403 且目标仍在、软删 200 后 404、非正整数 id 404、admin 可删、第 21 次 429） | 11 | 全通过 |
| 本地 8：`/api/comments/mine`（未登录 401、只给自己的+slug+降序、静态路由优先于 `:id`） | 3 | 全通过 |
| 本地 9：OPTIONS 204（无 CORS 头）、404、405+Allow、Host 白名单（DNS rebinding）、Origin/Sec-Fetch-Site | 5 | 全通过 |
| 本地 10：库不可用（`me` 200+`db:down`、写端点 503、登出仍 200）与数据层未知异常 → 500 且不泄细节 | 8 | 全通过 |

自检（脚本自身的线上代码路径，部署前预演）：`node … --shim` → `合计 33 项：PASS 31 / FAIL 0 /
NA 2`，exit 0。NA 的两项是需要 SQL 通道的库内行数核对与 SQL 侧清理 —— 这是如实标注"不适用"，
不是通过。

#### 9.8.3 B 部分（公网，t18 部署后执行；命令照抄即可）

```bash
# 1) 公网入口（从能连公网的机器）
node blog-enter/server/tests/verify-public-live.mjs \
  --base http://43.108.100.116 --ssh root@43.108.100.116

# 2) 回环 8850（在服务器上跑；--sql-local 用 /etc/my.cnf [client] 的 root 凭据查库）
scp blog-enter/server/tests/verify-public-live.mjs root@43.108.100.116:/tmp/t16-verify.mjs
ssh root@43.108.100.116 "node /tmp/t16-verify.mjs --base http://127.0.0.1:8850 --sql-local"
```

覆盖：注册→登录（拿 cookie）→发评论→列表可见→删除自己的→列表不可见→登出→旧 cookie 401；
两个账号验跨账号删除 403 且目标评论仍在；未登录删除 401；错误口令连打触发 429 且响应体无
口令哈希/邮箱；`users`/`comments`/`sessions` 行数与接口行为一致（含软删行仍在）；
`/package.json`、`/server/*.mjs` 必须 404。

#### 9.8.4 观察（非阻塞，不影响本轮判定）

* `POST /api/auth/login` 成功体除契约写的 `ok` + `user` 外还多两个顶层字段 `userId` 与
  `detail`（`public-server.mjs` 的 handler 把审计收尾用的 `{userId, detail}` 一起返回了，
  而 `register` 是自己写响应所以没有）。契约 §0.1 对成功体允许额外字段（只有失败体被冻结成
  恰好 `ok`/`error`），且 `detail` 只是 `"ok"`、`userId` 与 `user.id` 重复，不含敏感信息，
  前端按 `code` 分支也不受影响 —— 故**记为观察项而非缺陷**。要收紧形状的话，把 login 分支
  改成与 register 一样自己 `sendJson` 即可（属实现方决定，verifier 未改产品代码）。

---

### 9.10 CSP hash 的证据包（S8）—— 声明值、算法、以及"算出不同值"的成因

> 背景：S8 给公开页加了 `Content-Security-Policy-Report-Only`，其中 `script-src` 用
> `sha256-…` 放行 `blog-enter/404.html` 里**唯一一个内联脚本**。复核时得到了与声明
> **不同**的 hash。本节把可复现命令、各版本实际输出、以及分歧最可能的成因一次写清。

**一键重算闸（已入库，可重复执行）**

```bash
node deploy/bin/check-csp-hash.mjs
```

当前实测输出（2026-10-06）：

```
文件：blog-enter\404.html
内联脚本块数：1
  第 1 块（444 字节）：sha256-hYOyioQ9GfQfnJv4xh6Ewrh3HPmlKcVC0sXdC6HeEDc=
配置里声明的 hash（deploy\bt\nginx-locations.conf）：
  sha256-hYOyioQ9GfQfnJv4xh6Ewrh3HPmlKcVC0sXdC6HeEDc=

结论：**PASS** —— 配置里声明的每一个 hash 都对应当前文件的一个内联脚本块
```

**算法（按 CSP 规范，写死在这里避免再记错）**

1. 取 `<script>` 与 `</script>` **标签之间**的原始字节 —— **不含标签本身**；
2. 按 **UTF-8** 编码后 SHA-256，再 base64；
3. **只对没有 `src` 的（内联）脚本**算；外链脚本归 `script-src 'self'`，不需要 hash。

**三种取法 / 三个版本的实测对照（这就是分歧的来源）**

| 取的是什么 | 结果 |
| --- | --- |
| **当前工作区** 404.html · 标签之间的字节（**正确取法**） | `sha256-hYOyioQ9GfQfnJv4xh6Ewrh3HPmlKcVC0sXdC6HeEDc=` ← 与配置一致 |
| 当前工作区 · 含 `<script>` 开标签 | `sha256-lyIOjYoH6ovWYGn4wzg2ea17zpiWt7KewKNSLzLuBbc=` |
| 当前工作区 · 含首尾两个标签 | `sha256-KvuXxcThw8J2/SvpWHLgabTocyxW5GiNHkPqoMRCC5E=` |
| **git HEAD 版**（`git show HEAD:blog-enter/404.html`） | **该版本里没有内联脚本**（0 块）—— 内联脚本是 HEAD 那条 commit **之后**（当前未提交的改动）才加的 |

**结论（双方独立复算后定稿）**

> **S8 经双方独立复算判定为假阳性；差异来源＝线上产物尚未更新。**
> captain 与实现者分别对**当前工作区** `blog-enter/404.html` 逐字节计算，均得
> `sha256-hYOyioQ9GfQfnJv4xh6Ewrh3HPmlKcVC0sXdC6HeEDc=`（内联脚本正文 444 字节），
> 与 `nginx-locations.conf` 的声明**逐字符一致**。评审者报出的 `sha256-6ndOo9B+…`
> 既不属于"标签之间"、也不属于"含标签"，且 `git HEAD` 版 404.html **没有内联脚本**
> （0 块）⇒ 它最可能取自**线上当前产物** `/www/wwwroot/43.108.100.116/404.html`，
> 即"产物尚未随本次发布更新"的**部署顺序问题**，**不是配置错**。

* 配置里声明的值**等于**当前工作区文件按规范算法算出的值 ⇒ 就"将要发布的这一版"而言，
  声明是**对的**，不存在"保留一个对不上的 hash"。**保持内联 + hash，不改成外链。**
* **t20 在部署后顺带确认**：发布新产物后，用下面这条取**线上**字节比对，期望等于上表第一行；
  若仍不等，说明发布没有真正覆盖 404.html（那就不是 hash 的问题，而是发布没生效）：

  ```bash
  curl -s http://127.0.0.1/404.html | node -e "
    let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{
      const c=require('crypto'),re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;let m;
      while((m=re.exec(s)))console.log('sha256-'+c.createHash('sha256').update(Buffer.from(m[1],'utf8')).digest('base64'));
    });"
  ```
* **用真 Chrome 抓实际值（权威）**——本机**做不到**：headless Chrome 在本沙箱被 crashpad
  拒绝（`crashpad_client_win.cc:421 OpenProcess: 拒绝访问 (0x5)` →
  `crash server failed to launch, self-terminating`），与 t12 记录的同一限制一致。
  请在有可用浏览器的机器上这样做：把 `blog-enter` 当站点根起本地服务、**按下发配置里的 CSP 头**
  （先 `Report-Only`、再换成强制的 `Content-Security-Policy`），headless Chrome 打开
  `/404.html` 后读 console：
  * 出现 `Refused to execute inline script … 'sha256-…'` ⇒ 引号里那个值就是浏览器实算值，直接比对；
  * 强制模式下无违规、且 404 页的路径提示（`#errPath`）被填上 ⇒ hash 匹配、脚本正常执行。
  ⚠️ **对象必须区分清楚**：凡在"本地前端 + stub"上得到的 hash 结论，都**不能**直接用于
  判定"本地 nginx 产物"或"线上产物"——这三份文件的脚本字节可能各不相同，这正是本次分歧的成因。
  跑浏览器闸时请在结论里写清"对哪个对象"（前端 + stub / 本地 nginx 产物 / 线上产物）。
* **保留 `deploy/bin/check-csp-hash.mjs` 作为防漂移闸**：它把"声明值 == 当前文件实算值"钉死，
  `404.html` 一改就会 FAIL，不会再出现"声明悄悄过期"。若将来改为外链脚本，
  记得同时删掉配置里的 `sha256-…` 与这条闸（否则它会因"无内联脚本却声明 hash"而 FAIL）。

---

### 9.9 明文 HTTP 的风险接受（业主已知情并接受）—— **S1，未修复**

> 本节按 t21 要求**显式留痕**。措辞刻意避开"已修复/已缓解"：**这条风险仍然存在**，
> 业主在知情的前提下决定按演示系统上线。

**触发条件**：公开站点目前只有 HTTP（nginx 只监听 `0.0.0.0:80`，无 443），
`p3-public.service` 传的是 `--public-origin http://43.108.100.116`，因此
`wantsSecureCookie()` 为假、会话 cookie **不带 `Secure`**。

**影响面**：

* 注册/登录请求体里的**明文口令**过网（`{"user":…,"password":"明文"}`）。
* `p3_uid` 会话 cookie 明文过网；它是 **bearer 型**、有效期 30 天，**抓到一次即等于账号被接管**
  （可以发评论、删自己的评论、读自己的邮箱）。`HttpOnly` 只挡 JS，**不挡网络嗅探**。
* 任何一跳都可能读到：同 Wi-Fi 的其他人、运营商、VPS 上游链路、ARP/DNS 投毒者。
* 没有 TLS 也就没有 HSTS，无法阻止降级。

**业主决定**：**接受该残留风险**，按演示系统上线（本轮不修）。已同步记录在
`blog-enter/server/AUDIT-public-login.md` 的 §0.1 / R1（那里同时保留了评审当时的证据与行号）。

**未来修法（零产品代码改动，只需运维）**：

```bash
# 1) 给 simonfu.xin 签证书（vhost 的 server_name 已含 simonfu.xin www.simonfu.xin，
#    用宝塔面板的 Let's Encrypt 即可）
# 2) 开 443 并把 80 的流量 301 跳过去（在 vhost 的 80 server 块里）：
#      return 301 https://$host$request_uri;
# 3) 单元里把 origin/host 换掉（deploy/systemd/p3-public.service 的 ExecStart）：
#      --public-origin https://simonfu.xin --public-host simonfu.xin
#    （Host 白名单必须补 simonfu.xin，否则 nginx 传来的 Host 过不了白名单 → 全站 403）
# 4) nginx 加 HSTS（放在 server 级安全头那一组，注意 add_header 不继承）：
#      add_header Strict-Transport-Security "max-age=31536000" always;
# 5) systemctl restart p3-public && nginx -t && nginx -s reload
```

改完之后 `wantsSecureCookie` 会**自动**给 cookie 加上 `Secure`（`http.mjs` 里
"白名单含 https:// 才加"的那条判据），**不需要改任何产品代码**。

⚠️ **不要**为了"看起来安全"单独给 cookie 硬加 `Secure`：纯 HTTP 下浏览器会直接拒绝保存
该 cookie，症状是"登录成功、一刷新就掉线"（`http.mjs` 的注释里已写明这一点）。

**过渡期的使用纪律**：只经 SSH 隧道访问（`ssh -L 8080:127.0.0.1:80 root@43.108.100.116`
后开 `http://127.0.0.1:8080`），**禁止在这条 HTTP 链路上输入任何真实口令**
（尤其不要复用你在别处用过的口令）。

