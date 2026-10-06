# 本地文章管理（上传 / 更改 / 删除 / 图片）

离线写文章、改文章、传图片，然后 `git push` 发布。**只有你的这台机器能改** ——
不是"藏起来的管理页"，而是公开发布的那份产物里根本不存在管理页与写接口。

---

## 1. 启动

```powershell
node blog-enter/server/dev-server.mjs
```

打开 <http://127.0.0.1:8848/_admin/>。

| 命令 | 作用 |
| --- | --- |
| `node blog-enter/server/dev-server.mjs` | 起服务（站点 + 管理页），端口 8848 |
| `... --port 9000` | 换端口 |
| `... --set-pass --pass "你的口令"` | 设访问口令（可选，见第 5 节） |
| `... --clear-pass` | 清除口令 |
| `... --runtime <目录>` | 换运行时目录（默认 `.admin/`） |

管理页里的操作：

* **新建 / 编辑**：左边选文章，右边改字段与正文，预览区实时渲染。
* **正文是 HTML 片段**（跟原来一样），工具条负责插入常用结构：
  段落 / 小标题 / 列表 / 引用 / 代码块 / 配图 / 链接。
  刻意**不做 Markdown 隐式转换** —— 那种转换会在"你写的"和"页面渲染的"
  之间插一层，出问题时最难查。
* **图片**：点「上传图片」，或者直接把图**拖进正文框**，或者 `Ctrl+V` 粘贴。
  服务端按文件内容判断类型（png/jpeg/gif/webp/svg），重新起一个安全文件名，
  存进 `blog-enter/img/uploads/`，并自动插入 `<figure>`。SVG 会过一遍净化。
* **草稿**：勾上「草稿」后，归档页不会列出它、也不计数；
  详情页需要 `article.html?slug=xxx&preview=xxx` 才能看。
* **改 slug**：旧地址会自动记进 `aliases`，老外链仍然能打开，并自动跳转到新地址。
* **删除**：内容先搬进 `.admin/trash/`，需要时可以手动恢复。
* **提交**：左栏底部「提交到 git」。提交前会先复核所有文章
  （能求值、正文能过安全检查），不通过就拒绝提交。**push 仍然由你在终端做。**

快捷键：`Ctrl/⌘+S` 保存（其实写完就落盘了），`Esc` 关抽屉。

---

## 2. 数据写到哪里

唯一真源还是 **`blog-enter/js/posts.js`**。保存时：

1. 解析出每篇文章在源码里的字符区间；
2. **只替换被改动的那几篇**，其余文章逐字节保留（注释、缩进、空行都不动）；
3. 重新求值复核，逐字段比对上一步的预期；
4. 备份旧文件 → 原子写（临时文件 + rename）。

任何一步不过就**拒绝保存**，宁可让你重来一次，也不把文件写坏。
旧文件都在 `.admin/backups/`（滚动保留 20 份），管理页的「备份 / 图片 / 日志」
面板里可以一键恢复。

---

## 3. 权限：为什么只有你能改

| 层次 | 做法 |
| --- | --- |
| 不出现在产物里 | 管理页与 `/api/*` 只在这个本地进程的路由里存在；静态发布时没有它们 |
| 只监听本机 | 服务只绑 `127.0.0.1`，没有"顺手绑 0.0.0.0"的开关 |
| 拒绝被转发进来 | 每个请求都检查对端地址必须是回环 |
| 防 DNS rebinding | `Host` 头必须是本机名 + 本次端口 |
| 防跨站请求 | `Origin` / `Referer` / `Sec-Fetch-Site` 必须同源 |
| 防误触 | 所有写操作要一次性会话令牌，令牌每次启动重新生成，只发给本站页面 |
| 可选第二把锁 | 口令用 PBKDF2-SHA256（21 万轮 + 随机盐）存哈希；失败退避 1s→30s 冷却 |
| 输入校验 | 每个字段 + 正文 HTML 都过一遍检查（脚本标签、事件属性、`javascript:` 一律拒） |
| 图片 | 按魔数判类型、服务端重新命名、SVG 走标签白名单净化 |
| 发布 | `git add/commit` 只跑白名单子命令、参数以数组传递（不过 shell） |

**没做的**：没有把管理页做成"带登录的后台"。纯静态站点前端做鉴权是假安全，
所以这里的边界是**本机文件系统 + git 权限**，口令只是本机上的第二道锁。

---

## 4. 验证

```powershell
# 单元 + 接口 + 页面逻辑，共 48 项，不需要浏览器
node blog-enter/server/tests/run-all.mjs

# 真实浏览器走完整个流程（需要 Chrome，且要先把服务器起起来）
node blog-enter/server/dev-server.mjs
node blog-enter/server/tests/verify-admin-ui.mjs
```

`verify-admin-ui.mjs` 会用无头 Chrome 真的点按钮、真的上传一张图、
真的删掉一篇文章，然后验证公开页面（归档 / 详情 / 草稿可见性），
跑完自动还原 `posts.js` 并清理测试图片。

覆盖到的判据（`api.test.mjs` 里逐条有对应用例）：

* Host 白名单：`evil.example`、端口不符、缺 Host → 403
* 跨站：`Origin` / `Sec-Fetch-Site: cross-site|same-site` → 403
* 令牌：缺失 401、错误 403；口令模式未解锁 → 401，冷却期内正确口令也 429
* 路径：`%2e%2e` 越界、`.admin`/`.preview` 等隐藏目录 → 403/404
* 校验：坏 slug、非法日期、`<script>`、事件属性、`javascript:`、重复 slug → 422 且文件不动
* 并发：过期版本号 → 409（不静默覆盖）
* 图片：伪装成 `.png` 的 HTML → 422；`../../` 文件名 → 被净化
* 写坏防线：手工把危险正文塞进 `posts.js` → 提交被拒

---

## 5. 口令（可选）

不设口令时，安全性完全依赖"只监听本机 + 同源判定 + 会话令牌"，对单人机器足够。
如果这台机器别人也用（或你常开着管理页），建议加口令：

```powershell
node blog-enter/server/dev-server.mjs --set-pass --pass "一串只有你知道的口令"
```

之后打开管理页需要输入口令。忘了就 `--clear-pass` 清掉（这相当于"本机物理访问
即可重置"，符合本机工具的定位）。

---

## 6. 回滚

| 场景 | 做法 |
| --- | --- |
| 刚保存完发现写错了 | 管理页「备份 / 图片 / 日志」→ 选上一份备份 → 恢复 |
| 已提交 | `git revert <sha>` 或 `git checkout <sha> -- blog-enter/js/posts.js` |
| 误删了文章 | 内容在 `.admin/trash/`，把 JSON 里的字段粘贴回管理页即可 |
| 图片传错了 | `blog-enter/img/uploads/` 下直接删文件；正文里的引用自己清一下 |

---

## 7. 文件一览

| 路径 | 说明 |
| --- | --- |
| `blog-enter/server/dev-server.mjs` | 服务入口（也是模块：`createApp()` 可供测试同进程启动） |
| `blog-enter/server/lib/posts-store.mjs` | 文章源码的读 / 改 / 写（区间替换 + 沙箱求值 + 复核） |
| `blog-enter/server/lib/validate.mjs` | 字段校验与正文 HTML 检查 |
| `blog-enter/server/lib/images.mjs` | 魔数判类型、文件名净化、SVG 净化 |
| `blog-enter/server/lib/security.mjs` | 对端 / Host / Origin / Sec-Fetch-Site 判定与安全头 |
| `blog-enter/server/lib/auth.mjs` | 会话令牌、口令哈希、失败退避 |
| `blog-enter/server/lib/backup.mjs` | 备份与回收站 |
| `blog-enter/server/lib/git.mjs` | 白名单 git 操作（不可用时自动降级） |
| `blog-enter/admin/` | 管理页 UI（随仓库走；不被任何公开页面引用） |
| `blog-enter/server/tests/` | 48 项验签 + 浏览器段脚本 |
| `.admin/` | 运行时数据：会话、口令哈希、备份、回收站（**已 gitignore**） |

---

## 8. 评论区（Waline，**在另一个后台管**）

文章页底部的评论区是 **Waline**（自建，不是第三方托管）。它和后台上面的这套
文章管理**完全是两个系统**，各有各的登录、各有各的数据库。

| | 文章管理（本文档 1–7 节） | 评论 |
| --- | --- | --- |
| 入口 | 本地 `node dev-server.mjs` → `/_admin/`；线上走 SSH 隧道 | `http://43.108.100.116/comments/`（文章页里可见） |
| 后台 | `/_admin/`（口令 + 会话 cookie） | `/comments/ui/`（邮箱 + 密码），**只允许服务器本机访问** |
| 数据 | `blog-enter/js/posts.js`（在仓库里） | `/srv/waline/data/waline.sqlite`（**不在仓库里**） |
| 程序 | `blog-enter/server/` | `/srv/waline/app`（`@waline/vercel`，systemd `p3-waline`） |

### 8.1 进评论后台

管理面**没有**对公网开放（nginx 里 `/comments/ui/` 只 allow 127.0.0.1）。走隧道：

```powershell
ssh -L 8360:127.0.0.1:8360 root@43.108.100.116
# 保持这个窗口开着，然后浏览器打开：
#   http://127.0.0.1:8360/ui/
```

**为什么非要走隧道**：站点是纯 HTTP。管理端对公网开放的话，登录口令就是明文过网。
隧道下页面、API、口令全程留在本机 —— 实测管理端那句
`window.serverURL` 算出来是 `http://127.0.0.1:8360/api/`，`/api/token` 也确实打到本机。
唯一从公网取的是那个 admin JS bundle（公开的开源文件，不含任何秘密），
它的地址必须是**绝对地址**，写在服务器 `WALINE_ADMIN_MODULE_ASSET_URL` 里。

> 这是 Waline 源码里的一处行为：它默认用 `SERVER_URL` 拼绝对地址，而 `SERVER_URL`
> 必须是公开地址（邮件里的验证链接要用它）。所以 `deploy/bin/install-waline.sh`
> 会对 `src/middleware/dashboard.js` 做一行 patch，让它跟着当前地址走。
> **重装 `@waline/vercel` 会冲掉这个 patch**，症状是"隧道里点登录没反应/报错"，
> 重跑一遍安装脚本即可。

### 8.2 第一个注册的账号就是管理员

Waline 的约定：**第一个注册的用户自动成为管理员**。所以顺序是死的：

1. 先用隧道打开 `http://127.0.0.1:8360/ui/` → 页面底部「用户注册」→ 注册
   （这一步**不能拖到对公网开放之后**，否则可能被别人抢注）；
2. 确认自己进得去后台、能看到评论列表；
3. 才谈得上开放注册。

在那之前，nginx 里有一段**临时**规则把 `/comments/api/user` 也锁在回环
（伪静态里的 `location = /comments/api/user`）。**管理员注册完、要开放注册时，
必须删掉那一段**，否则评论者永远注册不了。仓库里对应的模板是同名那段，
见 `deploy/bt/nginx-locations.conf`。

> 顺带：邮件里的验证链接指向 `/comments/verification`（现在整段 `/comments/` 都
> 反代给 Waline，所以这个链接能通），验证完 Waline 会跳到 `/comments/ui/login` ——
> 那个地址**只允许本机**，所以在公网浏览器里点完会看到 403。验证本身已经生效，
> 不影响使用；要看登录页就从隧道进。

### 8.3 评论策略在两处，必须一致

| 在哪 | 变量 | 现在 | 说明 |
| --- | --- | --- | --- |
| 服务器 `/etc/p3blog/waline.env` | `LOGIN` | `disable` | `force` = 必须登录/验证后才能评论 |
| `article.html` 底部的模块脚本 | `login` | `disable` | 客户端选项，**必须与服务端一致** |

`COMMENT_AUDIT=true`：新评论先审后发。作者自己看得到并带"审核中"提示，
别人看不到。审核在 `/comments/ui/`。

邮箱验证码**不是开关**：`waline.env` 里一旦填好 `SMTP_*`，注册与评论就自动要求
验证码。顺序不能反 —— **先验通发信，再把 `LOGIN` 改成 `force`**，否则发不出信
等于谁也评论不了。

先把发信验通（脚本版，比手工敲 nodemailer 那段清楚）：

```bash
bash deploy/bin/check-waline-smtp.sh              # 只验连接 + 登录
bash deploy/bin/check-waline-smtp.sh you@qq.com   # 再真发一封
```

它会打印 nodemailer 实际用的主机与端口、把口令只显示长度，并把常见失败翻译成
人话（535 = 授权码/应用密码不对；`550 5.7.30` = Exchange Online 停用了基本认证；
ETIMEDOUT = 端口不通；TLS 模式配反了……）。

### 8.3.1 邮件服务商：Outlook 有两种命运，别选错那个

| 你的邮箱 | 能不能给 Waline 用 | 怎么配 |
| --- | --- | --- |
| 个人 `@outlook.com` / `@hotmail.com` / `@live.com` | **能** | 开两步验证 → 账户「安全 → 高级安全选项 → 应用密码」生成一个，拿它当 `SMTP_PASS` |
| 工作 / 学校的 Microsoft 365（含挂在 M365 上的自有域名） | **基本不能** | Exchange Online 已停用 SMTP 的**基本认证**（2026-03-01 起逐步拒绝、2026-04-30 起全部拒绝，报 `550 5.7.30 Basic authentication is not supported for Client Submission`），只剩 OAuth；而 Waline 只支持"用户名+密码"（源码里就是 `auth: { user, pass }`），**不支持 OAuth** |
| QQ / 163 | 能 | 用**授权码**（不是登录密码），465 + SSL。`SMTP_SERVICE=QQ` / `163` |
| 阿里云邮件推送 / SendGrid 之类 | 能，而且最稳 | 换成 `SMTP_HOST` + `SMTP_PORT`；代价是要先有一个能验证的发件域名 |

个人 Outlook 就这两种写法，**二选一**：

```ini
# 写法一：用 nodemailer 的预设（推荐，省得记端口）
SMTP_SERVICE=Hotmail            # 别名 Outlook / Outlook.com / Hotmail.com 都认
SMTP_USER=you@outlook.com
SMTP_PASS=<应用密码>

# 写法二：显式写主机与端口
SMTP_HOST=smtp-mail.outlook.com
SMTP_PORT=587
SMTP_SECURE=false
```

⚠️ **设了 `SMTP_SERVICE` 时，`SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` 全部被忽略** ——
端口由 nodemailer 的预设决定（`Hotmail` → `smtp-mail.outlook.com:587`，STARTTLS）。
两边都写、还写得不一样，症状就是"我明明改了端口，怎么没生效"。

另外三条实测：

* `SENDER_EMAIL` 必须与 `SMTP_USER` **相同** —— Microsoft 不允许用别的地址发信。
* 这台服务器是阿里云 IP，Microsoft 可能把首次登录判成"异常活动"而拒绝（也可能
  要你去账户里确认一次）。**先在服务器上把 verify 跑通**再切 `force`。
  阿里云默认封 25 端口（实测确认），465/587 都通，Outlook 的 587 从这台机器可达。
* 送达率：Outlook 发往 QQ/163 **很容易进垃圾箱**。如果读者主要是 QQ/163，
  用 QQ/163 发反而更稳（同域投递几乎不会被判垃圾）。

### 8.4 评论是按 URL 绑的

Waline 用 `path` 把评论绑到文章地址上，本站写死成 `/article.html?slug=<slug>`
（在 `article.html` 里）。所以**改 slug 之后，评论不会跟着走** —— 旧评论留在旧
path 上，要么在 `/comments/ui/` 里手工改它，要么接受"改名 = 评论清零"。

### 8.5 客户端资源是自托管的，但**不在** `/comments/` 下

`waline.js` / `waline.css` / `waline-admin.js` 三个文件放在
**`blog-enter/comments-assets/`**，随站点一起发布（版本、来源、升级方法见该目录的
`README.md`）。**不走 unpkg**：它挂了的话评论区是运行时一片空白，本地根本测不出来。

目录名是 `comments-assets` 而不是 `comments`，因为 nginx 把**整段** `/comments/`
反代给了 Waline —— 接口 `/comments/api/`、后台 `/comments/ui/`、邮件验证链接
`/comments/verification` 都是它自己注册的路由。静态资源混在里面会被一起转走然后 404。

### 8.6 验证

```powershell
# 不依赖浏览器的 74 项（含页面逻辑、接口、沙箱）
node blog-enter/server/tests/run-all.mjs

# 真浏览器：面板有没有渲染出来、不存在的 slug 会不会偷偷拉评论、有没有外部请求
node blog-enter/server/tests/verify-comments-live.mjs
```

人工那一条（发一条真评论）在 `deploy/DEPLOY-RECORD.md` 的评论区一节。

### 8.7 回滚

```bash
sudo systemctl disable --now p3-waline          # 关评论服务
# 伪静态恢复成加评论区之前那份（备份在 /root/p3-conf-backups/）
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
```

前端退回占位状态就用 `git revert` 撤掉接评论那次提交。**评论数据在
`/srv/waline/data/waline.sqlite`，别删** —— 将来还能再拉起来。
