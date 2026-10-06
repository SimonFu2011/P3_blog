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

