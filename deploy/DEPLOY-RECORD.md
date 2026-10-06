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

## 9. 公开登录与 MySQL —— 2026-10-06 已上线（t26 线上部署与真实站点验收）

> 本节由 **t26（集成）** 于 2026-10-06 18:16–18:21 CST 在 `root@43.108.100.116` 落地后逐条实测填写。
> 凡写"实测"的行，都是**当场跑出来并把命令与原始输出贴在行内**的；没有实测的一律显式写"未实测"，
> 不写成"通过"。本轮**唯一未通过**的判据是 §9.8 的 B-32（公网打未知 `/api/*` 路径回 nginx 的 404
> 而不是契约的 JSON 404）：它是**非阻塞**（8 条对外端点无一受影响）但**不隐瞒**的失败项，见 §9.8.5。
> 另外 §9.11 记录了本轮踩到的 4 个**环境/工具缺陷**（都不是产品代码问题），供后续复跑时避坑。

新系统：`p3-public`（只绑回环 `127.0.0.1:8850`）+ MySQL 库 `p3blog`，经 nginx 的
`/api/auth/*` 与 `/api/comments*` 反代段对外；页面评论从 Waline 换成自建组件（MySQL 存储）。
部署件与逐步安装清单见 `deploy/PLAN-PUBLIC-LOGIN.md`（每步都带验证命令），
表结构见 `blog-enter/server/sql/schema.sql`，接口形状见
`blog-enter/server/CONTRACT-public-api.md`。

### 9.1 现状（t26 逐项实测，2026-10-06 18:20 CST）

| 项 | 期望 | 实测 |
| --- | --- | --- |
| `systemctl is-active p3-public` / `is-enabled` | active / enabled | **active / enabled**（`is-active=active`、`is-enabled=enabled`） |
| `ss -ltnp \| grep 8850` | 只有 `127.0.0.1:8850` | **`LISTEN 0 511 127.0.0.1:8850 … node pid=40156`**，无 `0.0.0.0:8850`、无 `[::]:8850` |
| `mysql --defaults-file=/etc/my.cnf -N -e "select count(*) from information_schema.tables where table_schema='p3blog'"` | 6 | **6**（`tables=6`；`users/comments/sessions` 验收清理后均为 0） |
| 公网 `GET /api/auth/me` | 200 + `{"ok":true,"user":null,"db":"up",…}` | **200** + `{"ok":true,"user":null,"db":"up","session_max_age_days":30}` |
| 公网 `/_admin/`、`/server/`、`/*.mjs` | 全 404 | 全 **404**（另测 `/package.json` 404、`/server/public-server.mjs` 404、`/evil.mjs` 404、`/api/auth/xyz` 404、`/api/comments/abc` 404） |
| 首页右上角登录入口；article.html 无 Waline | 是 / 是 | **是 / 是**：五页 `data-auth-entry=1`、`auth-ui.js≥1`；`article.html` 的 `waline` 计数 **0**、`comments.js` 计数 4 |
| 注册→登录→发评论→删除→登出 | 闭环全通 | **全通**，逐码见 §9.8.6（201·200·200·201·200·200·200·200·401） |
| 越权（A 删 B 的评论） | 403 且评论仍在 | **403 FORBIDDEN**，且列表里 B 的评论**仍在**（t16 脚本 B-19/B-20） |
| 限流（错误口令连打） | 第 11 次 429 + `Retry-After` | **第 1–10 次 401、第 11 次 429**，`retry-after: 3600`；第 12 次仍 429 |
| 响应体不含 `password_hash`/`email`/`user_id` | 是 | 评论相关响应（创建/列表/我的）**不含**三者；`password_hash` 与 `user_id` 在**所有**响应里都不出现（库内是 `pbkdf2-sha256$600000$…`）。**例外**：`/api/auth/login` 成功体的 `user.email` 是**本人**邮箱（契约允许的成功体额外字段），另有 t19 已记的 `userId`/`detail` 冗余字段 → 见 §9.8.4 观察项 |
| **直连 8850 不带/伪造密钥头**（冒充 nginx） | 必须 403；而经公网同一请求 200 | **不带=403、伪造=403、正确密钥=200**；公网同一请求 **200**（三条都实测） |
| **给了 `--proxy-secret-file` 但密钥文件缺失/为空** | 服务**启动失败**（fail-fast，journal 有明确原因），不是静默降级 | **实测 exit 7**（缺文件/空文件/3 字符短密钥三种都 exit 7，stderr 有中文原因）；systemd 层 `ExecMainStatus=7` + `Failed with result 'exit-code'`，`is-active` 显示 **activating（auto-restart）** 而**不是** `failed` —— 见 §9.11.1 的口径订正 |
| 代理密钥文件 | `/etc/p3blog/public-proxy-secret` 640 root:p3public、`/etc/p3blog/public-proxy-header.conf` 600 root:root，两者同值 64 位十六进制 | **640 root:p3public / 600 root:root / `same-value-ok` / `hex32-ok`**（`wc -l`=1）。注：本行的期望值原写 `root:blog`，实际必须是 `root:p3public`（组=服务账号），PLAN 第 4 步已按此写定 |

### 9.2 可回滚点（t26 实测填写）

| 项 | 值 |
| --- | --- |
| 部署前 commit / 部署后 commit | **`19d7458`**（`19d74583a9d045ea4972fde0cc68ee9edb5d502f`，部署前服务器 `HEAD` 与 `origin/main` 一致）<br>→ **`c30a8b7`**（`c30a8b70a3651988e4cb1770912016c2613eac40`，本轮上线提交，本机/服务器/GitHub 三方一致） |
| 伪静态备份（**本轮实际生成**） | `/root/p3-rewrite.bak-20261006-181608`（部署前原状，sha256 `28924ae640e77b1bdc164fbe0d21f5f1ca624ca81ea91c04680ba29d47889a12`）<br>`/root/p3-rewrite.bak2-20261006-181706`（换段前，同上 sha256 —— 与 bak 同值）<br>`/root/p3-rewrite.bak3-20261006-181726`（真正被替换前那一刻，sha256 同上）。**回滚首选 bak3**（与线上被替换掉的内容逐字节相同） |
| 全库备份（**重置前**，t13 留的） | `/www/backup/p3-mysql-pre-reset-20261006-162241.sql.gz`（193801 B） |
| 上线后新做的全库备份 | **`/www/backup/p3blog-postdeploy-20261006-182052.sql.gz`**（5688 B，`gzip -t` OK，sha256 `08a66b43f4672984cc4e154b072241a8e3a342472d7cfdaa288b88b28b466773`；只含 `p3blog` 库，命令见 9.6） |
| `/etc/my.cnf` 备份 | `/root/p3-my.cnf.bak-20261006-162432`、`/root/p3-my.cnf.bak2-20261006-162613` |
| binlog 索引备份 | `/root/p3-mysql-bin.index.bak-20261006-162105` |
| 仓库权限回滚清单（新机制） | `/root/p3-perms-rollback-20261006-181841.txt`（600 root:root，181470 B；逐行 `chmod/chown` 清单，`p3-fix-repo-perms.sh` 执行前抓的） |
| iptables 快照（新机制） | `/etc/p3blog/iptables.rules`（600 root:root，1198 B，sha256 `0aba0a480d226d245e42bf62d63acd8f86614b45551f233bc2c1e44d4eadddc2`；`p3-firewall.service` 开机恢复的就是它） |
| 代理密钥（新机制，本轮首次生成） | `/etc/p3blog/public-proxy-secret`(**640 root:p3public**)、`/etc/p3blog/public-proxy-header.conf`(**600 root:root**)；另留一份值守副本 `/root/p3-proxy-secret.keep`（fail-fast 实测时用来校验"复原后逐字节相同"）。**值不进仓库**（`grep -rn "$h" /srv/blog/repo` → `repo-clean-ok`） |
| 数据库表结构来源 | `blog-enter/server/sql/schema.sql`（t13 已在线上执行，本轮未改库结构） |

**本轮的回滚命令（按顺序，每条都可在原机直接抄）**

```bash
# ① 停公开服务（最快，公网 /api/* 变 502/504；页面降级为"接口不可用"）
systemctl disable --now p3-public
# ② 回退伪静态（用真正被替换前那一刻的备份）并 reload
RW=/www/server/panel/vhost/rewrite/43.108.100.116.conf
cp -a "$RW" "/root/p3-rewrite.before-rollback-$(date +%Y%m%d-%H%M%S)"
cp -a /root/p3-rewrite.bak3-20261006-181726 "$RW"
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
# ③ 回退代码（前端与后端一起退回部署前）
sudo -u blog git -C /srv/blog/repo reset --hard 19d7458
sudo -u blog env PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/blog-publish   # 重新发布旧前端
# ④ 若要先保数据：先备份再删库（9.6 的命令）
# ⑤ 删掉本轮加的防火墙兜底规则（可选，回滚到"只靠绑定"的旧状态）
bash /srv/blog/repo/deploy/bin/p3-restrict-loopback-ports.sh --remove
```

> 只需 ①+② 就能让公网回到"没有公开登录/评论"的旧观感（页面仍引用 `js/comments.js`，
> 会显示"接口不可用"的降级态）；要连前端也回去就补 ③。**恢复 Waline 见 9.5**，
> 它与两份密钥文件是联动的：只回退 nginx 段、不回退 `--proxy-secret-file`，公网 `/api/*`
> 会**全部 403**（后端仍要求密钥而 nginx 不再注入，属 fail-closed 预期行为）。

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

#### 9.8.1 本轮状态（2026-10-06 —— **t26 部署后已补跑 B 部分**）

> ⚠️ **数字更正**：本表原写 A 部分 `107/107`，那是 t16 首次跑时的旧快照。t26 部署当天在
> **同一份脚本、同一修订**上重跑，A 部分是 **113 项 PASS 113 / FAIL 0**；B 部分（公网真实入口）
> 是 **35 项 PASS 34 / FAIL 1（NA 0）**。下面全部按**本轮真实数字**写，未通过的 1 项照样列出来。

| 判据 | 实测命令 | 实际结果 | 结论 |
| --- | --- | --- | --- |
| **A. 本地 7 端点（+`mine`）的成功与失败路径全部实测** | `node blog-enter/server/tests/verify-public-live.mjs --local --out .preview/t26/local-report.md` | **`合计 113 项：PASS 113 / FAIL 0 / NA 0`**（失败形状断言累计 49 条），**exit 0** | **通过** |
| **B. 公网真实入口闭环** | `node blog-enter/server/tests/verify-public-live.mjs --base http://43.108.100.116 --ssh root@43.108.100.116 --out .preview/t26/public-live-report.md` | **`合计 35 项：PASS 34 / FAIL 1 / NA 0`**，**exit 1**（唯一失败项 B-32，见 §9.8.5） | **34 通过 / 1 失败**（非阻塞，如实保留） |
| 线上跨账号删除 403 / 未登录删除 401 | 同上 B 部分 | **通过**：B-19 A 删 B 的评论 → `403 FORBIDDEN`；B-20 被拒后 B 的评论**仍在**；B-21 未登录删 → `401 UNAUTHENTICATED` 且评论仍在；B-22 伪造 cookie → `401`；B-27 退出后再删 → `401` | **通过** |
| 线上错误口令连打 → 429 + 无口令哈希/邮箱泄漏 | B-40/B-41 + §9.8.6 的"干净桶"复测 | **通过**：干净桶下第 1–10 次 `401`、**第 11 次 `429` + `retry-after: 3600`**，第 12 次仍 429；响应体无口令哈希/邮箱 | **通过** |
| 脚本可重复执行且自清理；报告逐条给出命令与实测 | 见 9.8.2 / 9.8.6 | **通过**：本轮 B 部分报告 35 行落盘 `.preview/t26/public-live-report.md`；SQL 通道经 ssh 可用，脚本自清理后 `users=0 comments=0 sessions=0`（复核见 §9.8.6） | **通过** |
| 静态面（五页入口 / 无 Waline / 404 内联脚本 / 依赖清单不泄漏） | `curl` 逐条 + `deploy/bin/check-csp-hash.mjs` | **通过**：五页 `data-auth-entry=1`、`auth-ui.js≥1`；`article.html` waline=0；`/package.json`、`/server/*.mjs`、`/evil.mjs` 全 404；线上 404 内联脚本 **444 字节 / `sha256-hYOyioQ9GfQfnJv4xh6Ewrh3HPmlKcVC0sXdC6HeEDc=`**，与配置声明**逐字符一致** | **通过** |

> 除 429 那一段外，脚本对线上的**任何请求都不会写坏数据**；429 那一段会按契约把
> **本机公网 IP 的登录限流锁 1 小时**（库内 `auth_throttle` + 进程内窗口）。解锁：
> 部署后清理步骤会自动执行 `DELETE FROM auth_throttle WHERE action='login';`，
> 手工解锁用 `ssh root@43.108.100.116 "mysql -N -B p3blog -e \"DELETE FROM auth_throttle WHERE action='login'\""`
> （进程内窗口随 `systemctl restart p3-public` 清零）。
> **t26 收尾时已执行**上面两步（清 `auth_throttle` + `restart p3-public`），
> 实测 `login_throttle_rows=0`、`is-active=active`，演示环境**没有被锁**。

#### 9.8.2 A 部分（本地）分组明细

命令：`node blog-enter/server/tests/verify-public-live.mjs --local --out .preview/t26/local-report.md`
（逐条「判据 → 命令 → 实测 → 结果」在 `.preview/t26/local-report.md`；**本轮合计 113 项，PASS 113 / FAIL 0**）

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

#### 9.8.3 B 部分（公网）—— 命令与**本轮实测结果**

```bash
# 1) 公网入口（从能连公网的机器）—— t26 已跑，见下
node blog-enter/server/tests/verify-public-live.mjs \
  --base http://43.108.100.116 --ssh root@43.108.100.116

# 2) 回环 8850（在服务器上跑；--sql-local 用 /etc/my.cnf [client] 的 root 凭据查库）
#    本轮未跑这条：公网入口那条已覆盖同一套代码路径，且回环 8850 的密钥头语义
#    由 §9.1 的 403/200 反证覆盖（直连不带密钥头本来就该 403，脚本没带密钥头会全红）。
scp blog-enter/server/tests/verify-public-live.mjs root@43.108.100.116:/tmp/t16-verify.mjs
ssh root@43.108.100.116 "node /tmp/t16-verify.mjs --base http://127.0.0.1:8850 --sql-local"
```

**本轮 B 部分实测（命令与原始输出）**

```
$ node blog-enter/server/tests/verify-public-live.mjs --base http://43.108.100.116 --ssh root@43.108.100.116
模式=live 本轮标记=t16vcd9923
...
============================================================
合计 35 项：PASS 34 / FAIL 1 / NA 0（失败形状断言累计 1 条）
耗时 19.0s
失败项（含最小复现命令）：
  · B-43_108_100_116-32 未知路径 → 404 NOT_FOUND
    复现: curl -s http://43.108.100.116/api/definitely-not-here
    实测: HTTP 404 null
============================================================
EXIT=1
```

覆盖（逐条都在本轮 B 报告里）：注册 201 → 登录 200 → `me` 200 → 发评论 201 →
匿名列表可见 → `/api/comments/mine` 200 → 第二个账号 201 → **跨账号删除 403 且目标仍在** →
未登录 401 → 伪造 cookie 401 → 删自己的 200 → 删后列表不可见 → 再删 404 → 登出 200（清 cookie）→
退出后 401；415 / 405+Allow / OPTIONS 204 / 无 CORS 头；错误口令不可区分（不存在用户与错口令
逐字节同形）；限流 429 + `Retry-After`；库内行数与接口行为一致（`approved=1 deleted=1`、软删行保留、
`sessions` 无残留）；`/package.json`、`/server/*.mjs` 必须 404。

#### 9.8.5 **唯一未通过的判据（B-32）—— 归因、影响面与处置建议**

**现象**：`curl -s http://43.108.100.116/api/definitely-not-here` → **HTTP 404，响应体不是契约的
JSON 失败体**（脚本记为 `HTTP 404 null`），而契约 §1.8/§3 要求"未知路径 → 404 + `{ok:false,error:{code:"NOT_FOUND"…}}`"。

**归因（已定位到具体一处配置，不是产品代码 bug）**：这条路径**根本没到过后端**。
`deploy/bt/nginx-locations.conf` 末尾那条兜底是

```nginx
location /api/ { return 404; }      # 白名单之外一律 404（默认拒绝）
```

它是**有意**的（模板注释第 326-333 行：把"哪些路径对外存在"钉死在白名单里，避免服务里哪天
多一条内部/实验路径就自动上公网）。代价是：白名单外的 `/api/*` 由 **nginx 自己**回 404，
响应体是站点那张 HTML 404 页（`error_page 404 /404.html`），**不会**是契约的 JSON 形状。

**影响面（为什么判为非阻塞）**：8 条对外路由（`/api/auth/{me,register,login,logout}`、
`/api/comments`、`/api/comments/mine`、`/api/comments/<id>`、外加 `/api/` 兜底）**全部在白名单里**，
逐条实测通过；前端只打这几条，`OPTIONS` 也走白名单（204 + `Allow`）。契约那条 JSON 404 形状
在**后端可达**的路径上仍然成立（例如 B-25 的 `DELETE /api/comments/<已软删 id>` → `404 NOT_FOUND`）。
所以：**功能无影响，只是"未知路径的 404 形状"这一条在公网入口与契约不一致**。

**两条处置路径（都需要改仓库文件，t26 的 inScope 只有 `deploy/DEPLOY-RECORD.md`，故只报告不动手）**：

| 方案 | 改动 | 说明 |
| --- | --- | --- |
| A（推荐，零 nginx 改动） | 把契约 §1.8/§3 的措辞收窄为"**服务可达的路径**上未知资源回 JSON 404；白名单外路径由 nginx 默认拒绝（HTML 404）" | 现状本来就是**更严**的默认拒绝；改文档即可对齐，且不动任何安全边界 |
| B（要对齐形状） | nginx 兜底改成把未列举的 `/api/*` 也转给后端（`location /api/ { proxy_pass … }` + 后端自己回 JSON 404） | **会削弱白名单**：路径存在性重新由后端决定，等于放弃"默认拒绝"这一层 —— 与模板注释里的取舍相反，不建议在演示期做 |

**复现命令**（一行，任何人可复算）：

```bash
curl -s -i http://43.108.100.116/api/definitely-not-here | head -3   # 期望-现状：404 且 Content-Type: text/html
curl -s -i http://43.108.100.116/api/auth/xyz | head -1              # 同理 404（白名单兜底）
curl -s -i -X DELETE http://43.108.100.116/api/comments/999          # 对照：这条在后端 → JSON 404
```

#### 9.8.6 t26 自己做的公网闭环（独立于 t16 脚本，逐码留痕）

脚本 `.preview/t26/e2e.mjs`（临时物，`.gitignore` 的 `.preview/*` 覆盖，不入库）。
命令：`node .preview/t26/e2e.mjs`。**每步状态码**（原样抄自终端）：

```
201  1 register   bodyKeys=ok,user  cookie=p3_uid=<token>; Path=/api; HttpOnly; SameSite=Lax; Max-Age=2592000
200  2 login      user=t26e2e5fc767a cookieAttrs=HttpOnly/SameSite=Lax/Path=/api
200  3 me         user=t26e2e5fc767a db=up
201  4 post comment  id=5
200  5 list visible  count=1 hasMine=true
200  6 delete own    deleted=5
200  7 list after delete  count=0 stillThere=false
200  8 logout     destroyed=true clearCookie=yes
401  9 delete after logout  code=UNAUTHENTICATED
```

**限流"干净桶"复测**（先清库内计数 + `restart p3-public` 清进程内窗口，再从公网入口连打）：

```
attempt 1..10 -> 401
attempt 11    -> 429
第 12 次响应头：HTTP/1.1 429 Too Many Requests / retry-after: 3600
```

**收尾清理**（脚本自清理 + 手工复核）：

```
before users=2 comments=1 sessions=3
after  users=0 comments=0 sessions=0 throttle_login=0
```

#### 9.8.4 观察（非阻塞，不影响本轮判定）

* `POST /api/auth/login` 成功体除契约写的 `ok` + `user` 外还多两个顶层字段 `userId` 与
  `detail`（`public-server.mjs` 的 handler 把审计收尾用的 `{userId, detail}` 一起返回了，
  而 `register` 是自己写响应所以没有）。契约 §0.1 对成功体允许额外字段（只有失败体被冻结成
  恰好 `ok`/`error`），且 `detail` 只是 `"ok"`、`userId` 与 `user.id` 重复，不含敏感信息，
  前端按 `code` 分支也不受影响 —— 故**记为观察项而非缺陷**。要收紧形状的话，把 login 分支
  改成与 register 一样自己 `sendJson` 即可（属实现方决定，verifier 未改产品代码）。
  **t26 在公网上复现了这条**（注册一个临时账号后登录，原样输出）：
  ```
  login 200 top-level keys: ok,user,userId,detail
  raw: {"ok":true,"user":{"id":6,"username":"t26sh697098","avatar":null,"role":"user",
        "created_at":"2026-10-06T10:21:19.000Z","email":"t26sh697098@t26.example"},
        "userId":6,"detail":"ok"}
  ```
  同一份响应里 `user.email` 是**本人**邮箱（契约允许"email 只在本人响应里出现"）。
  因此"响应体不含 email"这条只在**评论相关响应**上是全称成立的（创建/列表/我的三条实测均无）；
  口令哈希与 `user_id` 则**任何**响应里都不出现。该临时账号已在收尾清理中删除。
* **`systemctl is-active` 不能直接当 fail-fast 的判据**（t26 实测订正，见 §9.11.1）。

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
* **t26 部署后已确认（2026-10-06 18:19，本轮实测 —— 这条把上面的推断变成了实测）**：
  发布 `c30a8b7` 后，**线上产物**与**服务器工作区副本**两份 `404.html` 各只有 1 个内联脚本块，
  **均为 444 字节、均为 `sha256-hYOyioQ9GfQfnJv4xh6Ewrh3HPmlKcVC0sXdC6HeEDc=`**，
  与 `deploy/bt/nginx-locations.conf` 里的声明逐字符一致：

  ```
  === 404.html inline script hash (LIVE) ===
  block1 bytes=444 sha256-hYOyioQ9GfQfnJv4xh6Ewrh3HPmlKcVC0sXdC6HeEDc=     ← curl http://43.108.100.116/404.html
  inline-blocks=1
  === 404.html inline script hash (服务器工作区副本) ===
  block1 bytes=444 sha256-hYOyioQ9GfQfnJv4xh6Ewrh3HPmlKcVC0sXdC6HeEDc=     ← /srv/blog/repo/blog-enter/404.html
  inline-blocks=1
  === 声明值 ===
  sha256-hYOyioQ9GfQfnJv4xh6Ewrh3HPmlKcVC0sXdC6HeEDc=
  ```

  ⇒ **S8 假阳性结论成立且已被线上产物实测坐实**：评审者拿到不同 hash 的原因正是"线上产物
  尚未随发布更新"，而**不是**配置错。发布生效后，线上字节**等于**声明值。
  （仍未做的是"真 Chrome 实算"这一步 —— 本沙箱起不了 Chrome，见下一条；但那属于**第四种取法**，
  与"配置声明 == 线上字节"这个判据无关。）
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

---

## 10. 站点外壳（可收起侧边栏 / 访问统计 / 标签云）+ 访问统计端点 —— 2026-10-06 已上线

> 本节由**本轮改动的落地者**于 2026-10-06 22:00–22:15 CST 在 `root@43.108.100.116`
> 逐条实测填写。凡写"实测"的行都当场跑过并把原始输出贴在最下面；没有实测的一律写"未实测"。
>
> 上线提交：`c85dac7`（功能）→ `c123c3f`（`path` 语义修正）。回滚见 §10.4。

### 10.1 对外可见的改动

| 位置 | 改动 | 实测 |
| --- | --- | --- |
| 五个页面共用 | 新增 `css/shell.css`（排在所有皮肤之后）+ `js/shell.js`（`<head>` 里**同步**加载，不能 defer） | 线上五页 200，无 4xx 资源（真浏览器网络层逐条核对） |
| 侧边栏 | 桌面 76px 图标栏 ⇄ 完整文字菜单；偏好 `localStorage['p3.shell.nav']`，**首屏绘制前**应用；`[` 键切换；≤980px 仍走 MENU 抽屉 | 线上 64 项断言全过，含"DOMContentLoaded 那一刻侧边栏宽度已是 76px"（无闪动的硬证据） |
| 访问统计 | 内页页脚上方一行 / 首屏左下角（入水后淡入）；拿不到后端时退回本机记录并**如实标注来源** | 见 §10.2、§10.3 |
| 标签云 | 归档页按标签下文章数缩放字号（三档颜色），与标签胶囊共用一份状态；"全部"清空所有筛选 | 点击目标已修到 ≥24×24（WCAG 2.2）；13 种宽度无横向溢出 |

### 10.2 新增接口（契约 §1.8 / §1.9）—— 公网入口实测

```
$ GET  http://43.108.100.116/api/stats
200 {"ok":true,"stats":{"total":0,"today":0,"visitors":0,"day":"2026-10-06"}}
$ POST http://43.108.100.116/api/stats/hit   (Content-Type: application/json, body {})
200 {"ok":true,"stats":{"total":1,"today":1,"visitors":1,"day":"2026-10-06"}}
$ POST .../api/stats/hit（第二次）
200 {"ok":true,"stats":{"total":2,"today":2,"visitors":1,"day":"2026-10-06"}}   ← PV +1，UV 不变（正确）
$ GET  .../api/stats/hit      → 405（路径存在、方法不对）
$ POST .../api/stats          → 405
$ GET  .../api/stats/anything → 404   ← 白名单仍然精确：兜底 404 未被放宽
$ GET  .../api/auth/me        → 200 {"ok":true,"user":null,"db":"up","session_max_age_days":30}
```

回环 8850 直连（不带头）实测仍是 `403 FORBIDDEN` —— 反代密钥那道闸没有因为新增路由而松动：

```
$ curl -s http://127.0.0.1:8850/api/stats      # 不带 x-admin-proxy-secret
403 {"ok":false,"error":{"code":"FORBIDDEN","message":"forbidden"}}
```

### 10.3 库与数据（实测）

`SHOW TABLES` 由 6 张变 8 张，新增两张：

```
| Field   | Type         | Null | Key | Default           | Extra          |
| id      | bigint(20)   | NO   | PRI | NULL              | auto_increment |
| day     | date         | NO   | MUL | NULL              |                |
| visitor | char(32)     | NO   | MUL | NULL              |                |
| path    | varchar(120) | NO   |     |                   |                |
| at      | timestamp    | NO   |     | CURRENT_TIMESTAMP |                |

page_meta：k varchar(40) PRI / v varchar(200) / updated_at timestamp
```

* 盐已生成：`SELECT k, LENGTH(v)` → `visitor_salt  64`（32 字节随机的十六进制）。
* **库里没有明文 IP**：`visitor` 是 32 位十六进制；`LEFT(visitor,8)` 实测 `473b09bc`。
* `path` 记的是**被访问的页面**（取自同源 Referer），实测按页面聚合：

```
| path           | pv |
| /api/stats/hit | 19 |   ← 修正前的旧行（第一版把接口自己的路径记了进去）
| /about.html    | 10 |
| /archive.html  |  5 |
| /404.html      |  1 |
| /index.html    |  1 |
```

* 总量/去重（实测）：`total=36  uv=2` —— 2 个 UV 来自"curl 与浏览器 UA 不同"，
  顺带证明 UA 确实参与了访客标识（同一 IP 不同 UA 算不同访客）。

### 10.4 本轮部署动作与回滚点

按顺序执行（都在 2026-10-06 21:59–22:08）：

```bash
# 1) 推 GitHub（本机）：git push origin main → c123c3f
# 2) 服务器拉取 + 发布静态站（blog 身份；会 fast-forward 并把 blog-enter 同步到站点根）
ssh blog@43.108.100.116 blog-publish
#    实测：git: 已对齐到 origin/main（c123c3f） / published c123c3f / 自检通过

# 3) 建表（幂等；schema.sql 可重复执行）
ssh root@43.108.100.116 "mysql --default-character-set=utf8mb4 < /srv/blog/repo/blog-enter/server/sql/schema.sql"
# 4) 同步 page_views.path 的列注释（仅元数据；见 §10.6 的说明）
scp _fix-path-comment.sql root@43.108.100.116:/tmp/ && ssh root@43.108.100.116 "mysql < /tmp/fix-path-comment.sql"

# 5) nginx 白名单加两条精确 location（脚本插入，幂等 + 自动备份）
scp _patch-nginx-stats.py root@43.108.100.116:/tmp/ && ssh root@43.108.100.116 "python3 /tmp/patch-nginx-stats.py"
#    实测：PATCHED ok；备份=/www/server/panel/vhost/rewrite/43.108.100.116.conf.bak.1791295263
ssh root@43.108.100.116 "nginx -t && systemctl reload nginx"     # syntax ok / test successful / RELOADED

# 6) 重启公开服务（新路由生效）
ssh root@43.108.100.116 "systemctl restart p3-public && systemctl is-active p3-public"   # active
```

**回滚点（本轮新增，逐条可逆）**

| 对象 | 回滚动作 |
| --- | --- |
| nginx 白名单 | `cp -a /www/server/panel/vhost/rewrite/43.108.100.116.conf.bak.1791295263 /www/server/panel/vhost/rewrite/43.108.100.116.conf && nginx -t && systemctl reload nginx`（备份是**加两条 location 之前**的原文，20987 字节） |
| 服务代码 | `ssh blog@… "cd /srv/blog/repo && git reset --hard c30a8b7"`（上一个上线件）+ `systemctl restart p3-public` |
| 站点产物 | 同上 reset 后 `ssh blog@… blog-publish` |
| 新表 | `DROP TABLE p3blog.page_views, p3blog.page_meta;`（**只有当业主确认不要访问数据时**；五页的前端在缺表时自行退回"本机记录"，页面不会坏） |
| 前端统计 | `js/data.js` 的 `stats.endpoint` 置空 → 立即退回本机记录（不用动后端） |

### 10.5 线上验收（`verify-public-live.mjs --base … --ssh …` 实测）

```
合计 38 项：PASS 37 / FAIL 1 / NA 0
[PASS] B-43_108_100_116-03 GET /api/stats → 200 + stats{total,today,visitors,day} + no-store
[PASS] B-43_108_100_116-04 POST /api/stats/hit → 200，total 恰好 +1，today/visitors ≥ 1
[PASS] B-43_108_100_116-05 GET /api/stats/hit → 405 + Allow: POST；缺 content-type → 415
[FAIL] B-43_108_100_116-32 未知路径 → 404 NOT_FOUND
```

* 唯一失败项就是 **§9.8.5 已经记录在案、业主已知情的 B-32**（nginx 兜底 404 是 HTML 形状，
  不是契约 JSON）—— 它不是本轮引入的：那段兜底与那条判据在上一轮就存在，本轮的改动只是
  **在它前面**多插了两条精确 location，且实测 `/api/stats/anything` 仍然落到同一条兜底。
* 其余 37 项（注册 / 登录 / 发评论 / 跨账号 403 / 伪造 cookie 401 / 软删 / 415 / 405+Allow /
  OPTIONS / 限流 429+Retry-After / 库内行数核对 / 清理后残留为 0）**逐条 PASS**，
  说明新增路由与限流项没有动到既有契约。
* 真浏览器另跑 `.preview/verify-shell.mjs`（`SHELL_URL=http://43.108.100.116`）**64/0**，
  含"来源标注写'后端'、第三项是访客数、刷新一次总访问量 +1"。

### 10.6 本轮顺手修的既有缺陷与两处既有测试问题（都不隐瞒）

**产品缺陷（已修，都有回归闸）**

1. `about.html` 邮箱锚点漏写 `>` —— 整行空白、看着像排版错位（三个 `<span>` 被当成 `<a>` 的属性）。
2. 浅底页"当前页"导航文字继承了深色皮肤的 `color: var(--white)` —— 白字在白底上只剩叠印阴影；
   连带新图标栏里那一枚图标（`stroke: currentColor`）**整个消失**。已在 `geo.css` 显式覆盖为墨色。
3. 标签云点击目标只有 43×20 —— 低于 WCAG 2.2 的 24×24，已加到 ≥28 高。
4. `public-api.test.mjs` 漏了 `export { H }` —— `run-all.mjs` 的判定是"没导出就跳过"，
   于是**整个 82KB 的公开面测试一直被静默漏跑**（症状：`run-all` 报 74 项，而单跑该文件有 78 项）。
   补上导出后 `run-all` 由 74 → **153 项**全过。

**既有测试问题（只校正判据，不改产品）**

5. `verify-final.mjs` 的"article/404 保持深水底（不引 geo.css）"—— 文章详情页早在换肤那一轮
   就改成纯白皮肤了（README 的皮肤表写着 pages → geo → prose-light），这条断言**从那时起一直红着**；
   拿 HEAD 的干净站点跑同样 FAIL。已改成真正的判据：404 只有 `pages.css`，文章页是
   `pages + geo + prose-light`（且只看 `<link href>`，不再被注释里的文件名带偏）。
6. `verify-pages.mjs` 仍有 **4 条**历史失败（代码块含 `@property` / 正文配图 / 引用块 /
   旧评论占位文案）—— 属正文内容与旧断言的口径差，与本轮无关：拿 HEAD 的干净站点跑，
   失败集合与数目完全一致（105 通过 / 4 失败）。本轮**未处理**，留在这里备查。
7. 静态预览没有 `/api`，因此 `/api/auth/me` 与 `/api/stats/hit` 的 404 在四套浏览器体检里
   是**预期内**的：已按同一条窄规则（只放行这两条、且必须带 404）豁免，并在每处写明理由。

---

## 11. 词云重做 + 访问统计移到侧边栏（2026-10-06 22:33 CST 追加）

**提交**：`d9b846b`（前端四个文件 + 验证脚本 + `SHELL.md`）。**只改了静态产物**，
所以部署动作只有一条：

```bash
ssh blog@43.108.100.116 blog-publish      # 实测：已对齐 origin/main（d9b846b）/ 自检通过
```

不需要动库、不需要 reload nginx、不需要重启 `p3-public`（服务端一个字节都没改）。

**改了什么**

| 位置 | 改动 |
| --- | --- |
| 归档页筛选区 | 改成两列：左列分类/标签胶囊，右列词云；辅助行横跨两列 |
| 词云 | 从"flex 换行的标签行"换成真正的 word cloud：中心螺旋 + 矩形碰撞逐个摆位（词间 4px 缝），摆不下依次缩字号，仍不行则退到兜底行；最后整朵云等比放大铺满容器。字号 12–44px（约 3.7:1）。"全部"移到抬头行 |
| 筛选 | 点词**不再重排**（篇数没变就不重建 DOM，只同步选中态）；重排只发生在容器尺寸变化与字体就绪时 |
| 访问统计 | 从"页脚上方一行"移到**侧边栏下部**：主指标 24–30px、另两项并排、抬头带来源；收起成图标栏时隐藏；≤980px 跟抽屉收放 |
| 交互 | 悬停（或聚焦 / 触屏点击）三个数字先乱码，约 1 秒内从左到右逐位锁定回真值；只动显示不动数据，乱码期间加 `aria-hidden`，`prefers-reduced-motion` 下不抖 |

**线上验收（真浏览器，`SHELL_URL=http://43.108.100.116 .preview/verify-shell.mjs`）**

```
站点外壳验证：74 通过 / 0 失败
  ok   词云的词数 = 标签数（"全部"不在云里）
  ok   版式：筛选区两列，词云在分类/标签的右侧
  ok   词是绝对定位排布的（不是换行流）——每个词都有算出来的 left/top
  ok   词之间零重叠（碰撞检测生效）
  ok   所有词都在容器内（含整层缩放后）
  ok   整朵云铺满容器（长或宽至少填到 90%）
  ok   点词不会让整朵云重排（位置逐字节不变）
  ok   在侧边栏下部：位于 .nav 内、且排在 .nav-foot 之前
  ok   统计块（含内部元素）不越过侧边栏右边界
  ok   主指标明显更大（总访问量字号 > 其余两项）
  ok   悬停后先进入乱码：值不等于真值、且标了 aria-hidden（读屏不念随机数）
  ok   约 1 秒后落定回真值，且 aria-hidden 摘掉
```

本地四套（`verify-shell` 74/0、`verify-geo` 47/0、`verify-final` 35/0、`verify-dock` 全过、
`check-static`/`check-light-skin`/`check.py` 全过、`run-all` 153/0）同轮跑过；
`verify-pages` 仍是 §10.6 记的 4 条历史失败（与本轮无关）。

**一处按事实订正的判断**：侧边栏那块统计一开始看着"溢出到右边界外"，
量下来（断言里逐个子元素取 `getBoundingClientRect().right`）是**贴着**侧边栏右缘、
并没有越界 —— 与它上面那条发丝线同宽，属于版式本来的对齐方式，故未改。

### 11.1 微调：侧边栏整体左移 + 词云悬停分散（2026-10-06 22:58 CST）

**提交**：`8bce506`（`blog-enter/css/shell.css`、`blog-enter/js/archive.js`、
`.preview/verify-shell.mjs`）。同样只动静态产物，部署一条命令：

```bash
ssh blog@43.108.100.116 blog-publish      # 实测：已对齐 origin/main（8bce506）/ 自检通过
```

| 改动 | 做法 | 为什么不那么做 |
| --- | --- | --- |
| 侧边栏内容整体左移 16px | 收窄 `.nav` 的**左内距**：`max(0, 基准 rail − --ui-nav-shift)`；浅底基准取 `--g-rail`，深水底回退到 `pages.css` 那串 clamp。只在 ≥981px 生效 | 不改宽度（那会动内容区右边界）；不用 transform 位移整块（那会把缩放键一起挪走 —— 它要留在原地） |
| 缩放键不动 | 它绝对定位在 `.nav` 右上角，量的是 padding box 的**右**边，与左内距无关（断言钉住 `railInset === 14`） | —— |
| 词云悬停分散 | 鼠标停在一个词上时，其余词沿"远离它"的方向让开：推力随距离衰减（≤26px、影响半径 ≈96px + 悬停词尺寸），推完做 3 轮松弛分开重叠，每轮都夹一次边界 | 不做"整体缩放"或"随机抖动"：那两种都会让词跳位、失去可读性 |
| 不越界 | 边界按**视觉坐标**算：整层还有一次等比放大 + 居中位移，布局坐标的 `[0,W]` 不等于眼睛看到的 `[0,W]`；按 `matrix()` 的 scale/translate 换算回布局坐标再夹 | 第一版直接用布局边界夹，结果放大后的词被推到容器外、被 `overflow` 裁掉 —— 被断言 `分散后仍不越界` 抓出来（`outside=1`） |
| 可逆 | 只写 `transform`，`left/top` 一个字节都不动；移开鼠标、点词筛选、重新排布都会复位 | 改 `left/top` 会累积漂移，且"点词不重排"的稳定性就没了 |

**线上验收（真浏览器 `SHELL_URL=http://43.108.100.116`）**：`站点外壳验证：83 通过 / 0 失败`，
其中本轮新增/相关的 9 条：

```
ok 侧边栏内容整体左移（内距 = 基准 rail − --ui-nav-shift）
ok 导航项确实跟着内距走（左边缘 = 侧边栏左内距）
ok 缩放键位置不受左移影响（它量的是侧边栏右边缘）        railInset=14
ok 悬停时其余词让开（至少两枚发生了位移）
ok 被悬停的那一枚自身不移位（交给 CSS 的 :hover 抬起）
ok 分散后仍不越界                                     outside=0
ok 分散后词之间仍不重叠
ok 分散只动 transform：left/top 逐字节不变（可逆、不累积漂移）
ok 鼠标移开后所有位移复位（且 left/top 依然没变）
```

**同场作业的说明（重要）**：本轮进行时，另一个会话正在修"图片上传不生效"
（本地已提交 `quotePath` 修复、工作区还有一处未提交的 rsync 排除规则修正）。
我的提交与它**没有任何文件交集**，因此按以下方式并行：

* 先核对本地那份修复与远端 `4003b0f` 的内容**逐字节一致**，再 `git rebase --onto`
  只重放我自己的提交，不重复、不覆盖对方的修复；
* 对方未提交的那处改动**原样留在工作区**，我没有提交、没有改动（它随后由对方
  以 `e5369b3` 提交并推送）；
* 期间远端连续前进了 5 个提交（3 个 `content:` 来自服务器发布流程 + 对方 2 个修复），
  push 被拒一次；改为 `fetch → rebase → push` 重试，最终 `8bce506` 落上，
  与 `origin/main` 齐平（`git status -sb` 无 ahead/behind）。




