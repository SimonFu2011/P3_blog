# 公开登录 / 评论系统安全评审 — `blog-enter/server`（t17）

评审对象：t10（HTTP 路由层 + 契约）、t12（前端登录入口与评论组件）、t14（连接池 / 认证会话 / 评论数据层）、
t15（systemd 单元与 nginx 反代模板）的产出，以及 t13 在 43.108.100.116 上落地的实际配置。
只读评审：本报告**不含任何产品代码改动**，需要修的地方全部在「发现清单」里交给实现者与后续修复任务。

评审方式：逐文件读源码并核对行号；在本机以 `--allow-degraded` 起真服务打真 HTTP 验证闸门；
用 SSH（只读命令、不重启任何服务、不改任何文件）核对线上实际配置；用 `curl` 从公网核对暴露面。
所有命令与原始输出见第 3、4 节。

> 行号说明：下列行号是**本次会话逐行读过的那一版**（工作区未提交版本，与 t14/t15 交付同版）。
> 线上机器上 `/srv/blog/repo` 仍是旧检出（`blog-enter/server/` 尚不存在），所以"线上行为"限于
> MySQL、nginx、防火墙、监听面这些已经落地的部分 —— 公开服务本身**尚未部署**（见 §3）。

---

## 0. 结论

| # | 判据 | 结论 |
| --- | --- | --- |
| 1 | SQL 注入 | **通过**：产品代码里 22 条 SQL 全部 `?` 参数化，无拼接、无 LIKE、无动态 ORDER BY |
| 2 | 口令存储 | **通过（含一处参数偏弱）**：PBKDF2-SHA256 + 16B 随机盐 + `timingSafeEqual`；明文/哈希不出现在日志或响应体。210000 轮低于当前建议值 → S5 |
| 3 | 会话 | **通过**：256 位 CSPRNG 令牌、库里只存 SHA-256、HttpOnly/Lax/Path/Max-Age 正确、登出真删库、无滑动续期、登录换发新 id。纯 HTTP 下缺 `Secure` → S1 |
| 4 | XSS | **通过**：评论渲染全 `textContent`、后端有长度与形状限制、响应 `nosniff`。公开页无 CSP → S8 |
| 5 | 越权 | **通过**：删除授权在服务端（`user_id`/`role`），`parent_id` 在 SQL 里校验同 slug + approved，注册无法覆盖已有用户、无法自封 admin |
| 6 | 用户枚举与限流 | **登录接口通过**（文案/状态码/耗时三重对齐）；注册接口**不是**匿名预言机以外的东西 → S4；限流落库、XFF 信任边界正确（密钥未过 → 403） |
| 7 | 边界隔离 | **代码层通过、OS 层未收口**：公开服务零文件读路径、无管理面 import；但与 `blog` 同 uid 且可读 `.admin/`，仓库目录 0777 → S3。nginx 已挡住 `/_admin/`、`/server/`、`*.mjs`；3306 只绑回环（实测） |
| 8 | 明文 HTTP | **高危**：口令与会话在公网明文传输，无 443 监听、cookie 无 `Secure` → **S1（high）** |

**三条硬红线（未参数化 SQL / 口令明文或哈希泄漏 / 仅前端授权）逐条核对后均未发现**，详见 §1.1、§1.2、§1.5。
据此：`verdict = 通过`（评审本身完成、结论与证据齐备），但 **S1 必须在把系统对真实用户开放之前处置**，
S2/S3 建议在同一批修复里做掉（都是小改动，见 §2）。

发现计数：**1 high + 4 medium + 4 low**（S1–S9），另有 3 条 informational（N1–N3）。

---

## 0.1 处置状态与已知风险（t21 追加）

> **append-only 声明**：本节只记录"业主/队长决定怎么处置"与**当前**处置结果，
> **不改动**上面 §0 的评审结论与下面 §1/§2 的证据与行号（那些是评审当时的实际观察）。
> 行号引用仍是评审当时那一版；t21 的改动见各条"本轮"状态。

| 发现 | 处置 | 结果 |
| --- | --- | --- |
| **S1** 明文 HTTP（high） | **业主已明确接受风险**，按演示系统上线；不改代码 | **未修复（业主已知情并接受）**。正式留痕**已完成**：`deploy/DEPLOY-RECORD.md` §9.9（触发条件 / 影响面 / 未来修法 / 过渡期纪律，措辞未表述为"已修复/已缓解"）。未来修法见下方 R1。t22 复核：留痕齐备且措辞诚实 → 该项不再阻塞通过 |
| **S2** 会话 cookie 交给同源第三方（medium） | **本轮修复** | `http.mjs` 新增 `SESSION_COOKIE_PATH='/api'`（原 `Path=/`），`buildSessionCookie`/`clearSessionCookie` 默认使用；同一发现下停用 `/comments/` 反代段（Waline 已由自建评论替换，`waline.sqlite` 保留）。契约 §0.5 已同步 |
| **S3** 同 uid / `.admin` 可读 / 0777（medium） | **t24 复核：工作区侧 ① ② ③ ⑤ 通过、④ 未通过；服务器侧为未完成清单**（详见 §0.3） | t23 已补：`User=p3public`+`InaccessiblePaths=`、`p3-fix-repo-perms.sh`、PLAN 的 `useradd p3public` 与 p3public 验证用户。**仍未闭环两处**：① 脚本 `ADMIN_MODE=0700` 清不掉 setgid → `.admin` 实际停在 `2700` → 脚本自己 `[FAIL]` 并 `exit 1`（实测）；② `PLAN:136` 的 `install -d -m 750 … /etc/p3blog` 会让 `p3-admin`（User=blog）读不到 `/etc/p3blog/proxy-secret` → 下次重启 `exit 5`。服务器侧 11 条命令/期望值见 §0.3.6，**保持"未完成"** |
| **S4** 注册可枚举 / 可批量造号（medium） | **业主决定保持开放注册 → 本轮不修，只记录** | 见下方 R2；限流阈值恒为 5 次/小时、**只计失败**（见 R3） |
| **S5** PBKDF2 210000 轮（medium） | **本轮修复** | `ITERATIONS` → **600000**；`needsRehash()`/`rehashPassword()` + 登录成功后按需回写。老记录（210000）仍按**记录里的**轮数校验。契约 §4.0 已同步 |
| **S6** 413 拿不到 JSON（low） | **本轮修复** | `readBody` 改为 `req.pause()` + 抛带 `shutdown` 标记的错误，发完响应后在 `finish` 里 `socket.end()`（干净 FIN，避免 RST）。测试里的"连接被 reset 也算通过"宽容分支**已删除**，现在必须真的读到 `413 BODY_TOO_LARGE` |
| **S7** 防火墙无 3306/8850 兜底（low） | 规则与核对命令已给出，**落地交 t18** | 服务器绝对路径不在工作区 |
| **S8** 公开页无 CSP（low） | **本轮修复 + t24 复算通过** | CSP 已加（`Content-Security-Policy-Report-Only`，`script-src 'self' + 1 个 hash`，无 script 侧 `unsafe-inline`）。t24 用 node 取"`<script>` 与 `</script>` 之间的 UTF-8 原始字节"独立复算：工作区 `404.html`（4507 B）inner=334 字符 / **444 字节** → `sha256-hYOyioQ9GfQfnJv4xh6Ewrh3HPmlKcVC0sXdC6HeEDc=`，与 nginx 声明**逐字符一致**。t22 原先在这一行报的 `sha256-6ndOo9B+…` 是**假阳性**（我当时取字节的方法错了），已撤回，原因见 §0.2.4 |
| **S9** 无评论审核（low） | **本轮不修，只记录** | 见下方 R4 |
| **N1** 登录不撤销既有会话 | 不修（`destroyUserSessions` 入口已备） | 非会话固定：每次登录换发新令牌 |
| **N2** 验证脚本里拼接 SQL | 建议后续参数化 | 标记由脚本自生成，非用户输入 |
| **N3** 无密钥时 `auth_throttle.ip` 退化成常量 | **部署验收必须确认** | `--print-config` 的 `trustProxy: true` + 公网登录 11 次实测 429；漏配的症状是"任何人连错 10 次锁死全站 1 小时" |

### 已知风险（业主已接受，仅记录）

* **R1 = S1：公网明文 HTTP 传口令与会话** —— 业主决定按演示系统上线并接受。
  *影响面*：任何一跳（同 Wi-Fi、运营商、VPS 上游链路、ARP/DNS 投毒者）都能直接拿到
  明文口令与 30 天有效的会话 cookie；会话是 bearer 型，被嗅到一次即等于账号被接管。
  *未来修法*（**零产品代码改动**，只需运维）：给 `simonfu.xin` 签证书 → 开 443 +
  `return 301 https://$host$request_uri` → 单元里 `--public-origin https://simonfu.xin`
  并补 `--public-host simonfu.xin` → 加 `Strict-Transport-Security`；
  `wantsSecureCookie` 会自动给 cookie 加 `Secure`。
  **不要**单独给 cookie 硬加 `Secure` —— 纯 HTTP 下浏览器会直接拒绝保存 cookie。
  过渡期只经 SSH 隧道访问、禁止输入真实口令。
* **R2 = S4：开放注册、可枚举、无邮箱验证、可批量造号** —— 业主决定保持开放注册。
  *影响面*：(a) 409 `USERNAME_TAKEN`/`EMAIL_TAKEN` 是"某用户名/邮箱是否本站用户"的预言机；
  (b) 无人机校验，分布式可批量造号；(c) 若日后接"忘记口令"而直接信任 `users.email`
  （`email_verified` 恒 0），会把抢注的邮箱变成口令重置通道 —— 落地邮件验证码时
  **必须**把 `email_verified=0` 当作"邮箱未经证明"，重置流程只在验证后可用且一律回同一条文案。
  *运维动作（发现滥用时）*：临时关闭注册（nginx 层摘掉 `/api/auth/register`）；
  **不要**用"收紧注册限流"来兜 —— 那会连带挡住正常用户（见 R3）。
* **R3：注册限流语义（冻结，勿再收紧）** —— 阈值 = 每 IP 5 次失败/小时（内存那道，按**请求**计数）
  + 5 次失败/6 小时（落库那道），封禁 1 小时；**请求体校验失败（422）不计入落库计数**，
  注册成功清零落库计数。这条曾被改成"每次调用都计数 + 3 次/小时"，
  后果是正常用户填错两次表单就被挡在门外 —— 等于拿可用性去换 R2 这条业主已接受的风险。
  契约 §0.6 已把该语义钉住，`public-api.test.mjs` 有对应回归闸。
* **R4 = S9：评论无审核队列** —— 新评论一律 `status='approved'` 立即公开。
  *影响面*：垃圾评论/辱骂只能靠作者自删或运维手工改库。
  *运维动作*：`UPDATE comments SET status='deleted' WHERE id=<id>;`（软删，两个列表查询立刻不再返回）；
  批量治理按 `slug` + `created_at` 圈范围。
  **先审后发**需要新增管理端入口，且必须同时改写入路径与 `listComments`/`listCommentsByUser`
  两处过滤 —— 不要用"加个开关但默认关"的方式悄悄带进来（那会让新评论对公开列表静默消失）。

---

## 0.2 t22 第二轮复核（round 2，对 t21 的修复逐条按**行为**验）

> 复核对像：t21 修完后的工作区版本 + 线上实际状态。方法：本机真 HTTP（真 `http.mjs`/`userstore`/`passwords`，
> store 为内存桩）跑一遍拿第一手输出；SSH 只读核对线上；不改任何产品代码（本轮只改本报告的处置状态）。
> 结论：**verdict = needs_revision**。S2/S5/S6/S1/S4 已按行为闭环；**S3 未闭环**（见 §0.2.2）。
> 本节还报了 **S8 未闭环**——该条已由 t24 复算判为**假阳性并撤回**（错在我的取字节方法，不在产品），
> 更正与原因见 §0.2.4；§0.2.2 里那一段保留原文但已标注撤回。

### 0.2.1 已闭环（附第一手证据）

| 项 | 判据 | 实测证据（本轮亲自跑出） |
| --- | --- | --- |
| **S2** | cookie 不再对同源第三方可见 | 真 HTTP 注册与登录的 `Set-Cookie`（fetch 与 curl 各一次）均为 `p3_uid=…; Path=/api; HttpOnly; SameSite=Lax; Max-Age=2592000`；`http.mjs` `SESSION_COOKIE_PATH='/api'`（`:354`）；`nginx-locations.conf` 的 Waline 段已改为 `location = /comments/` 与 `^~ /comments/ { return 404; }`（`:122-123`），回滚办法与"数据不删"写在 `:94-119` |
| **S5** | 轮数 ≥600000 且老哈希兼容 + 登录后回写 | `ITERATIONS=600000`、`PBKDF2_ITER=600000`（实读）；210000 的老记录**登录成功（200）**，且登录路径真的发出了 `UPDATE users SET password_hash = ?, password_algo = ? WHERE id = ?`，参数是 **`pbkdf2-sha256$600000$…`**（回写发生在验过口令之后：`public-server.mjs:461-466`，实现 `userstore.mjs:193-202`） |
| **S6** | 超限请求体必须拿到结构化 413 | curl 1.1MB：`HTTP/1.1 413 Payload Too Large` + `connection: close` + `{"ok":false,"error":{"code":"BODY_TOO_LARGE","message":"请求体超过上限（1.00 MB）"}}`（旧版这里是 `Empty reply from server`）；fetch 客户端同样拿到 413 |
| **S1** | 留痕齐备、措辞诚实 | `deploy/DEPLOY-RECORD.md` §9.9 标题即写 **"S1，未修复"**、"业主已知情并接受"，含触发条件/影响面/未来修法/过渡期纪律，未出现"已修复/已缓解" |
| **S4** | 如实记录为已知风险 | 本报告 §0.1 的 **R2**（开放注册可枚举/可批量造号）已记录，并写明"落地邮件验证码时必须把 `email_verified=0` 当邮箱未经证明" |

**S2 的线上生效时点**（t18/t20 注意）：生产伪静态尚未替换，实测 `GET /comments/api/comment` 仍返回
`x-waline-version: 1.43.4` + `{"errno":403}` → **线上 `/comments/*` 仍在反代 Waline**；新模板的 404 只有
reload 之后才生效。也就是说 S2 的"线上不可达"这一半必须由 t20 在 t18 之后复验。

### 0.2.2 未闭环（本轮判 needs_revision 的全部理由）

* **S3（medium，未闭环）** —— 三条都只有工作区文本、没有行为：
  1. **服务器上的 0777 原样未动**（SSH 只读实测）：
     `drwxrwxrwx blog blog /srv/blog/repo/blog-enter`、同样 0777 的 `deploy`、`p3-menu`
     —— 即"本地任意可登录账号（同机还有 admin、springboot）能改写服务要加载的代码"这条链**仍然成立**；
     任何位置都没有 `ls -ld` 前后对比的证据。
  2. **`p3public` 账号不存在**：`getent passwd p3public` → 无（rc=2）。单元 `User=p3public`（`:22`）注释里
     让读者"见 PLAN-PUBLIC-LOGIN.md"，但 PLAN 与 DEPLOY-RECORD 里**都没有** `useradd p3public` 这一步
     （grep `useradd|adduser|nologin` 两文件零命中）→ 现在照单元部署，服务**根本起不来**。
  3. **uid 切换会撞上代理密钥的读权限**：`ExecStart` 用 `--proxy-secret-file /etc/p3blog/public-proxy-secret`，
     而 PLAN 第 4 步把该文件设成 `chown root:blog && chmod 640`（PLAN:127-128），验证命令也是
     `sudo -u blog test -r …`（PLAN:148）——换成 `User=p3public` 后它**读不到**（不在 blog 组）→ 按 fail-fast
     语义 exit 7。单元注释 `:146-150` 恰恰把"640 root:blog"写成了"公开进程必须读的最小集合"，这是错的。
     正确做法是二选一：把密钥文件 `chown root:p3public`（或 `chgrp p3public` 并 640），或让 p3public 属于 blog 组
     并接受"同组可读"的取舍；同时把 PLAN 的验证用户从 `blog` 改成 `p3public`。
  4. "确认公开服务进程无法读取 `.admin/`"目前是**推断**（`.admin` 实测是 `0700 blog:blog`，换个 uid 确实读不到），
     但没有可复现的实测输出；应补一条 `sudo -u p3public test -r /srv/blog/repo/.admin/passphrase.json; echo rc=$?`（期望非 0）。
* **S8（low，未闭环）——【t24 复算后撤回：以下整段结论不成立，详见 §0.2.4】** CSP 加了，但**声明的 hash 与实际不符、也没做过真机验证**：
  声明 `sha256-hYOyioQ9GfQfnJv4xh6Ewrh3HPmlKcVC0sXdC6HeEDc=`（`nginx-locations.conf:80`，注释 `:81` 说它"对应
  blog-enter/404.html 里那唯一一个内联脚本"）；实测 404.html 内联脚本（357 字节）的 SHA-256 是
  `sha256-6ndOo9B+rsiLC+j90doE8ePiI34jb2K8VHpHgPAVBpY=`，raw/`trim`/补尾换行三种取法**都不等于**声明值，
  全站 `.html` 里也没有任何一个内联脚本能对上它。当前是 Report-Only 所以只是"上报一条违规、脚本照跑"，
  但按注释"观察一周后去掉 -Report-Only"改成强制时，**404 页的内联脚本会被拦掉**（正是注释自己警告的
  "页面某块静默失效"）。修法二选一：把 hash 重算对，或按注释 `:84` 把那段脚本挪成外链 `.js`。
  另外 `style-src 'self' 'unsafe-inline'` 经核对**可以接受**：页面确实有 `style="…"`，而 `script-src` 没有
  `unsafe-inline`（`'self'` + 单个 hash）——XSS 相关的执行面是真拦住的，不属"假防护"。

### 0.2.3 未要求本轮闭环但仍在册

* **S7**：`deploy/bin/p3-restrict-loopback-ports.sh` 已备好，但线上 `iptables -S INPUT` 与 t17 看到的一模一样
  （策略 ACCEPT，无 3306/8850 规则）→ 落地仍待 t18；今天的隔离仍只靠 `bind-address` 与应用启动硬校验。
* **N1/N2/N3**：N1 不修（每次登录换发新令牌，非会话固定）；N2 已把拼接改成 `sqlStr()` 转义（`verify-public-live.mjs:1843`）；
  N3 的现场判据（`--print-config` 的 `trustProxy=true` + 公网登录 11 次得 429）已写进 t18 验收项。

### 0.2.4 S8 更正：t22 的"hash 不符"是**假阳性**（错在评审的取字节方法，不在产品）

t24 复算（node，`fs.readFileSync(p)` → `indexOf('<script>')`/`'</script>'` → 对两标签之间的
**UTF-8 原始字节**做 SHA-256 → base64），**两个不同对象都得到声明值**：

| 对象 | 文件字节 | 内联脚本字符数 | 内联脚本 UTF-8 字节 | 计算出的 hash |
| --- | --- | --- | --- | --- |
| 工作区 `blog-enter/404.html`（mtime 16:21:36） | 4507 | 334 | **444** | `sha256-hYOyioQ9GfQfnJv4xh6Ewrh3HPmlKcVC0sXdC6HeEDc=` |
| 线上产物 `/www/wwwroot/43.108.100.116/404.html`（curl 取回） | 3621 | — | **444** | `sha256-hYOyioQ9GfQfnJv4xh6Ewrh3HPmlKcVC0sXdC6HeEDc=` |

两者都与 `nginx-locations.conf:80` 的声明**逐字符一致** → **S8 的 CSP hash 是正确的，该条不成立，予以撤回。**

**差异来源（可复现的根因，不是"对象不同"）**：t22 当时用 PowerShell
`Get-Content -Raw 404.html` + .NET 正则取内联脚本，`Get-Content -Raw` 把这份 **UTF-8** 文件按
**本机传统 ANSI 代码页**解码（同一文件：真实 4507 字节 → 读出 3918 个字符），随后我用
`[Text.Encoding]::UTF8.GetBytes()` 把已经乱码的字符串重新编码再算 SHA-256 → 得到 357 字符 /
`sha256-6ndOo9B+…` 这个**与任何真实对象都对不上的值**。也就是说：不是"算了线上旧产物"，也不是
"取 HEAD 版本"，而是**取字节的工具错了**。同类教训写在这里：
**凡是对文本文件取字节做 hash，必须用 node/`fs.readFileSync` 或显式指定 UTF-8 读取，
不要用 PowerShell `Get-Content -Raw` 之类的默认编码路径**；报告里引用任何 hash 时，必须写明
"对哪个对象、哪个字节区间"算的。Captain 与 backend-engineer 各自独立算出的 444 字节 /
`hYOyioQ9…`（以及"含开标签 `lyIOjYoH…`、含两标签 `KvuXxcTh…`"这两个不同的取值口径）与本节的结论一致。

**S8 的其他部分复算后仍然成立且不必改**：`style-src 'self' 'unsafe-inline'` 有页面内联 `style=` 的依据、
`script-src` 不含 `unsafe-inline`（只有 `'self'` + 该 hash）→ 不是"假防护"；这条 CSP 目前是
Report-Only，切强制前仍建议用真浏览器看一次控制台（本沙箱 Chrome 因 crashpad `OpenProcess 0x5`
起不来，所以"浏览器实算"这一环在本机无法完成，不把它当作结论）。

---

## 0.3 t24 第三轮复核（round 3，只判 t23 的**工作区侧**；服务器侧按契约保持"未完成"）

> 复核对像：`deploy/bin/p3-fix-repo-perms.sh`、`deploy/bin/check-csp-hash.mjs`、`PLAN-PUBLIC-LOGIN.md`、
> `p3-public.service`、`blog-enter/404.html` 与 nginx 模板；方法：读源码 + 在 43.108.100.116 上用
> **沙箱**（把脚本常量 sed 到 /tmp 下的假仓库）真跑一遍拿退出码 + 只读 `--check` + 独立复算 hash。
> **verdict = needs_revision**：① ② ③ ⑤ 通过，**④ 未通过**（脚本永远到不了它自己判定的目标态），
> 并且发现一条会打断管理面的 PLAN 步骤（§0.3.3）。

### 0.3.1 S3 工作区侧：① ② ③ ⑤ 通过，**④ 未通过**

| 项 | 结论 | 证据 |
| --- | --- | --- |
| ① 改前产出回滚清单到 /root 下 600 文件 | **通过** | `p3-fix-repo-perms.sh:62-72` 用 `find -printf 'chmod %m %p\nchown %u:%g %p\n'` 抓 `$REPO` 与 `/etc` 两份，写入 `/root/p3-perms-rollback-<时间戳>.txt` 后 `chmod 600`；`main()` 里 `check`(:158) → `snapshot`(:159) → 才开始改(:163+)。实测（我在 /tmp 假仓库上跑真脚本，快照路径未被 sed 到、真实落在 /root）：`-rw------- 1 root root` 两份，内容含**改动前**的 `chmod 777 …/blog-enter`（即"改前"语义成立）。这两份是我测试产生的，已删除 |
| ② 目录 2775 / 文件 664 / 属主保持 blog:blog | **通过** | `:51-52` `DIRMODE=2775`/`FILEMODE=664`、`:47` `OWNER=blog`、`:173` `chown -R "$OWNER:$OWNER"`、`:174-175` 两个 `find … chmod`。实测沙箱 main 后：目录 `2775 blog:blog`、文件 `664 blog:blog` |
| ③ `.admin` 复位步骤在 `find -type d` 之后 | **通过** | `:174` `find -type d -exec chmod 2775` → `:181-185` 才 `chown`+`chmod "$ADMIN_MODE" "$ADMIN_DIR"`；注释 `:178-180` 写明原因。实测沙箱：先把 `.admin` 放开到 `2775` 再跑 main，复位步骤确实在其后执行（但复位结果见 ④） |
| ④ 三条行为验证计入退出码、任一 FAIL → exit 1 | **未通过** | 计数与退出码机制本身是对的（`verdict()` `:56-58` 累加、`main` `:204-216` `exit 1`；实测强制 FAIL 场景 `D_EXIT=1`）。**但脚本永远达不到 `.admin=700` 这个它自己判定的目标态**：`:53` `ADMIN_MODE=0700` + `:183` `chmod 0700` 在**已带 setgid** 的目录上清不掉 setgid（`:174` 的 2775 会给 `.admin` 也加上）。服务端实测（GNU coreutils 8.30，`/root`、`/var/tmp`、`/tmp` 三处一致）：起点 `2775` → `chmod 700`=`2700`、`chmod 0700`=`2700`、`chmod u=rwx,go=`=`2700`，只有 `chmod 00700`=`700`、或 `chmod 700` 后再 `chmod a-s`=`700`。沙箱真跑 main 的后果：`[FAIL] .admin 是 700 blog:blog（实际：2700 blog blog）` → `== 结论：FAIL（1 条行为验证未通过）==` → **exit 1**（B_EXIT=1） |
| ⑤ p3public 未创建 → SKIP 而非假红 | **通过** | `:99-102` 先 `id -u` 判存在，不存在就 `[SKIP] … 先 useradd 再复跑` 并 `return 0`（不计 failures）。两处实测：真实路径 `--check` 打印 `[SKIP] p3public 尚未创建`（当前服务器确实没有该账号）；沙箱用不存在的用户名同得 SKIP、退出码 0（A_EXIT=0） |

**④ 的影响与修法**：`2700` 与 `700` 在**访问控制上是等价的**（group/other 位都是 `---`，setgid 只是新文件继承组），
所以这不是权限漏洞；但它是"交付物自己的判据不成立"——脚本在真机上**永远红一条并 exit 1**，
`--check`/`main` 的输出都会与实际安全状态相反（看起来没修好，其实修好了）。
修法（一行）：`deploy/bin/p3-fix-repo-perms.sh:53` 的 `ADMIN_MODE=0700` 改成 `ADMIN_MODE=00700`，
或在 `:183` 的 `chmod` 之后补一句 `chmod a-s "$ADMIN_DIR"`；`:108-112` 的 verdict 期望值保持 `700` 不动。
改完要求：`bash deploy/bin/p3-fix-repo-perms.sh --check` 里 `.admin` 那行 `[PASS]`，且 `main` 末尾 `exit 0`。

### 0.3.2 顺带发现（同属 t23 交付物，均低）

* **R3-3（low）`--check` 恒 `exit 0`**：`:222` `--check) need_root; check; exit 0 ;;` —— 即使行为验证全 FAIL 也返回 0，
  自动化无法用它做闸（只能人读 `[PASS]/[FAIL]`）。实测真实路径 `--check` 退出码 0。
  修法：`--check) need_root; check; [ "${failures:-0}" -eq 0 ] || exit 1 ;;`（只读语义不变）。
* **R3-4（low）脚本头部自相矛盾**：`:11` 写"属主 root:blog"，而 `:32-39`/`:47`/`:173` 实现的是 `blog:blog`
  （也正是 captain 定的口径）。修法：把 `:11` 改成"属主保持 blog:blog"。这属于"文档与行为一致"的判据范围，
  虽在脚本自身的注释里，但会误导读的人按 root:blog 去核对。

### 0.3.3 新发现：PLAN 第 4 步会把 `/etc/p3blog` 收紧到 750 → 打断 p3-admin（**必改**）

* **发现**：`deploy/PLAN-PUBLIC-LOGIN.md:136` 是 `install -d -m 750 -o root -g p3public /etc/p3blog`。
  该目录现在是 `755 root:blog`（服务端实测），`install -d` 会把**已存在**目录的属组与模式一起改掉。
* **为什么这是问题**：`p3-admin.service` 以 `User=blog` 运行，命令行带
  `--proxy-secret-file /etc/p3blog/proxy-secret`（该文件 `640 root:blog`）；而 `dev-server.mjs:932-939`
  读不到该文件时**直接 `process.exit(5)`**。目录一旦变成 `750 root:p3public`，`blog` 不在 `p3public` 组
  → 连目录都进不去 → 那份 640 的文件也读不到 → **管理面在下次重启时起不来**（团队目标要求"管理员本机后台保持不变"）。
  服务端机制实测：造一个 `750 root:springboot` 的目录，里面放 `640 root:blog` 的文件 →
  `sudo -u blog cat` = **DENIED**；目录改回 `755` → OK。
* **为什么没人会发现**：PLAN 第 4 步的验证（`:160-163`）只验 `p3public` 能读密钥、读不到 `.admin`，
  **没有一条**验 `blog` 还能读 `/etc/p3blog/proxy-secret`。
* **修法**：`:136` 改成 `install -d -m 755 -o root -g p3public /etc/p3blog`（目录可穿越、文件级权限照旧保护），
  并在第 4/6 步补两条验证：`sudo -u blog test -r /etc/p3blog/proxy-secret && echo p3admin-can-read-ok`、
  `systemctl restart p3-admin && systemctl is-active p3-admin`（期望 `active`）。

### 0.3.4 S8 复核：**通过**（t22 的"hash 不符"确认为假阳性）

* **独立复算**（node：取 `<script>` 与 `</script>` **标签之间**的 UTF-8 原始字节 → SHA-256 → base64）：
  工作区 `blog-enter/404.html` 内联块 **334 字符 / 444 字节** → `sha256-hYOyioQ9GfQfnJv4xh6Ewrh3HPmlKcVC0sXdC6HeEDc=`，
  与 `deploy/bt/nginx-locations.conf:80` 的声明**逐字符一致**。
* **差异来源假设的排查**：线上产物 `/www/wwwroot/43.108.100.116/404.html`（curl 取回，3621 B）的内联块**也是 444 字节**
  → 同一个 hash ⇒ **"线上产物未更新"这个假设在此不成立**；也不是"取了 HEAD 版本"（HEAD 版该页没有内联脚本）、
  更不是"含标签字节"。真正原因是我 t22 用了 PowerShell `Get-Content -Raw` 读取：它把这份 **UTF-8** 文件按本机传统
  ANSI 代码页解码（4507 真实字节 → 读出 3918 个字符），我又把**已乱码的字符串**用 UTF-8 重新编码后算 SHA-256，
  于是得到 357 字符 / `sha256-6ndOo9B+…` 这个与任何真实对象都对不上的值。**错在我的取字节工具，不在产品。**
* **`check-csp-hash.mjs` 是有效的闸**（不是橡皮图章）：仓库内直接跑 → `PASS`、`exit 0`（并自行打印"444 字节"）；
  把它的目录结构复制到沙箱、只把配置里的 `sha256-hYOyioQ9…` 改成 `sha256-AAAioQ9…` → `FAIL`、**`exit 1`**。
* **不采信未实测的浏览器值**：本沙箱 Chrome 因 crashpad `OpenProcess 0x5` 起不来，浏览器实算这一环没有做，
  也不作为结论（CSP 目前是 Report-Only，切强制前建议在能起浏览器的地方看一次控制台）。

### 0.3.5 文档一致性（PLAN / p3-public.service vs 脚本行为）：**除 §0.3.3 与 R3-4 外一致**

* PLAN 有 `useradd --system --no-create-home --shell /usr/sbin/nologin p3public`（`:129-131`，第 4 步 ⓪）✓
* 验证用户已不是 `blog`：`:160` `sudo -u p3public test -r …/public-proxy-secret`、`:162-163` 验 `p3public` 读不到
  `.admin/passphrase.json` 与 `/etc/p3blog/proxy-secret` ✓
* "`public-proxy-secret` 是 ExecStart 的 `--proxy-secret-file`，必须对 p3public 可读，因此不得列入 InaccessiblePaths"：
  PLAN `:133-135,138` 与单元 `:146-154` 都写了，单元 `:165` 的 `InaccessiblePaths` 里**确实没有**它 ✓
  （脚本 `:187-190` 的行为也一致：`chown root:p3public` + `640`）
* 单元 `User=p3public`/`Group=p3public`（`:22-23`）、`ExecStart` 里 `--proxy-secret-file /etc/p3blog/public-proxy-secret`（`:98`）✓

### 0.3.6 服务器侧 S3：**未完成清单（交给 t18，本轮不判通过）**

以下每一条都**还没做**（本轮实测：`p3public` 不存在、仓库三目录仍 `drwxrwxrwx`、密钥文件尚未创建）。t18 执行后请把命令与输出原样记入 `DEPLOY-RECORD` 第 9 节：

| # | 命令 | 期望值 |
| --- | --- | --- |
| 1 | `ls -ld /srv/blog/repo /srv/blog/repo/blog-enter /srv/blog/repo/deploy /srv/blog/repo/p3-menu`（改前 / 改后各一次） | 改后：三目录 `drwxrwsr-x blog blog`（2775），不再有 `others` 写位；顶层 `/srv/blog/repo` 保持 `755` |
| 2 | `bash /srv/blog/repo/deploy/bin/p3-fix-repo-perms.sh --check` 然后 `bash …/p3-fix-repo-perms.sh` | 改后 `.admin` 那行 `[PASS]`、全部 `[PASS]`、`exit 0`（**须先修 §0.3.1 ④ 的 `ADMIN_MODE`**，否则必然 `[FAIL]` + `exit 1`） |
| 3 | `id -u p3public` 与 `getent passwd p3public` | 打印 uid（系统号段），不再是 rc=2 |
| 4 | `stat -c '%a %U:%G' /etc/p3blog/public-proxy-secret` | `640 root p3public` |
| 5 | `sudo -u p3public test -r /etc/p3blog/public-proxy-secret; echo $?` | `0`（服务能读密钥，否则 exit 7） |
| 6 | `sudo -u p3public test -r /srv/blog/repo/.admin/passphrase.json; echo $?` 与 `… test -r /etc/p3blog/proxy-secret; echo $?` | 两者都**非 0**（公开进程读不到管理面凭据） |
| 7 | `stat -c '%a %U:%G' /srv/blog/repo/.admin` | `700 blog blog` |
| 8 | `sudo -u blog test -w /srv/blog/repo/blog-enter/js/posts.js; echo $?`、`… img/uploads`、`… .git` | 三者都 `0`（收窄没弄坏发布链路） |
| 9 | `systemctl restart p3-public && systemctl is-active p3-public` | `active`；journal 无"读不到反代密钥文件" |
| 10 | `systemctl is-active p3-admin p3-waline`（**见 §0.3.3：PLAN:136 的 750 会打断 p3-admin**） | 两者仍 `active` |
| 11 | 给密钥文件改名/清空后 `systemctl restart p3-public` | **必须失败**（fail-fast，`is-active=failed`）；验完还原再确认 `active` |

**S2 的线上那一半（不计入本轮）**：模板侧已就绪（`location = /comments/` 与 `^~ /comments/ { return 404; }`），
但生产伪静态尚未替换——实测 `curl http://43.108.100.116/comments/api/comment` 仍回
`x-waline-version: 1.43.4` + `{"errno":403}`。**挂 t18（reload 后）与 t20（公网复验）**，本轮不判。

---

## 1. 八类判据逐条结论

### 1.1 SQL 注入 —— 通过

**结论：产品代码里没有一条拼接 SQL、没有一处用户输入进 LIKE / ORDER BY。**
清单（`?` 占位符数量 = 参数个数，全部对上）：

| 文件:行 | 语句 | 参数 |
| --- | --- | --- |
| `lib/public/userstore.mjs:55-57` | `SELECT … FROM users WHERE email=? / username=? LIMIT 1` | `[String(value)]` |
| `lib/public/userstore.mjs:63` | `SELECT … FROM users WHERE id=?` | `[Number(id)]` |
| `lib/public/userstore.mjs:93-94` | `INSERT INTO users (…) VALUES (?,?,?,?)` | 4 个 |
| `lib/public/userstore.mjs:109-110` | `INSERT INTO sessions (…) VALUES (?,?,?,?,?)` | 5 个 |
| `lib/public/userstore.mjs:126-130` | 会话 JOIN 校验（含 `expires_at > ?`） | `[tid, dbNow()]` |
| `lib/public/userstore.mjs:140` | `UPDATE sessions SET last_seen=CURRENT_TIMESTAMP WHERE id=?` | `[tid]` |
| `lib/public/userstore.mjs:161 / 167 / 173` | 三条 `DELETE`（单条 / 按用户 / 批量过期） | 全部 `?` |
| `lib/public/userstore.mjs:207-208` | 限流状态查询 | `[ip, action]` |
| `lib/public/userstore.mjs:254-258` | `INSERT … ON DUPLICATE KEY UPDATE`（单条 upsert） | 4 个 |
| `lib/public/userstore.mjs:263` | 清限流 | `[ip, action]` |
| `lib/public/userstore.mjs:276-278` | `INSERT INTO auth_log …` | 5 个 |
| `lib/public/commentstore.mjs:41-44` | 列表（`WHERE slug=? AND status='approved' ORDER BY created_at ASC, id ASC LIMIT ?`） | `[slug, limit]` |
| `lib/public/commentstore.mjs:53-56` | 我的评论 | `[userId, limit]` |
| `lib/public/commentstore.mjs:74-77` | 父评论合法性校验（`id=? AND slug=? AND status='approved'`） | `[pid, s]` |
| `lib/public/commentstore.mjs:81-82`、`84` | 插入 + 回读 | 全部 `?` |
| `lib/public/commentstore.mjs:97-98` | 删除前取行 | `[Number(id)]` |
| `lib/public/commentstore.mjs:114-118` | 软删（授权写在 WHERE 里） | 全部 `?` |
| `lib/public/commentstore.mjs:124` | 计数 | `[String(slug)]` |

* **零拼接**：唯一出现的模板串是 `SELECT ${USER_COLUMNS} FROM …`（`userstore.mjs:42-43,55-56,63`），
  `USER_COLUMNS` 是同文件里的**常量列名清单**，不含任何请求数据。
* **零 LIKE**：整个公开面没有 `LIKE`；`ORDER BY` 只有 `created_at ASC/DESC, id ASC/DESC` 两种固定写法。
* **LIMIT 也参数化**：`LIMIT ?` 传 `Number(limit)`（常量 500/200），不是字符串。
* **多语句关闭**：`lib/public/db.mjs:157` `multipleStatements: false` —— 把任何单点注入放大成任意 SQL 的路被堵死。
* **入参先过白名单**：`http.mjs:416-423`（`parent_id` 只接受 `^[1-9][0-9]{0,18}$`）、
  `:426-432`（`:id` 同形）、`:402-408`（slug 去空白 + 拒绝控制字符）。

> informational N2：仓库里唯一出现字符串拼接 SQL 的地方是 `tests/verify-public-live.mjs:1762,1816-1821`
> （t16 的线上验证脚本，用 `LIKE '${MARKER}%'` 清理数据）。那里的 `MARKER` 由脚本自己用 `t16v+run-id`
> 生成（`:90-91`），不是用户输入，因此不构成本次评审对象里的注入；但建议后续把它改成参数化，
> 免得被抄进产品代码。

### 1.2 口令存储 —— 通过（轮数偏弱 → S5）

* 算法/参数（`lib/public/passwords.mjs:32-38`）：`pbkdf2-sha256`、`ITERATIONS = 210000`、`KEYLEN = 32`、
  `SALT_BYTES = 16`；盐由 `crypto.randomBytes(16)` 生成（`:55`）。
* 存储形态 `pbkdf2-sha256$210000$<salt_b64>$<key_b64>`（`:58`），自描述 → 换算法/加轮数不需要数据迁移，
  与 `users.password_algo`（`sql/schema.sql:71`）互为备份说明。
* **比较用 `timingSafeEqual`**（`:96-99`），长度先比再比内容，不等长不会抛错。
* **账号不存在也跑等价耗时**：`dummyVerify()`（`:112-115`）+ 统一入口 `checkAgainstUser()`（`:121-131`），
  未激活 / 未知算法 / 哈希列损坏三条路径都归到同一条假校验上。
* **明文与哈希都不外流**：
  * 明文只在 `store.mjs:97-100` 出现一次，算完哈希立即不再引用；
  * 写库返回后显式摘掉 `password_hash` / `password_algo`（`store.mjs:105-108`）；
  * 响应体只走白名单构造函数 `publicUser/selfUser/publicComment`（`http.mjs:746-774`）；
  * `--print-config` 走 `safeDbSummary`，口令位写死 `'(已设置，不显示)'`（`db.mjs:105-113`）；
  * 启动横幅不打印任何口令/令牌/cookie（`public-server.mjs:680-702`）；
  * `auth_log.detail` 只放失败分类或 `'ok'`（`public-server.mjs:311,321`，`userstore.mjs:275-289`），
    `sql/schema.sql:219` 明确"任何口令、令牌、摘要都不允许写入"。
* 本机实测：`hashPassword('a-good-password')` → `pbkdf2-sha256$210000$…`；`verifyPassword` 正确口令 `true`、错误口令 `false`。
* 参数偏弱见 **S5**（210000 < 当前 OWASP 对 PBKDF2-HMAC-SHA256 的 600000 建议）。

### 1.3 会话 —— 通过（`Secure` 见 S1）

* **熵源与长度**：`userstore.mjs:25-28` `TOKEN_BYTES = 32`，`crypto.randomBytes(32).toString('hex')` = 256 位 CSPRNG。
  实测：`newSessionToken()` 长 64，匹配 `^[0-9a-f]{64}$`。
* **库里不存令牌**：`tokenHash()`（`:31`）存 SHA-256 十六进制，与 `sessions.id CHAR(64)` 对齐（`schema.sql:95-96,109`）；
  实测令牌与其摘要不相同。库被拖走也无法直接冒用会话。
* **cookie 属性**（`buildSessionCookie`，`http.mjs:315-325`；本机实测原样输出）：
  ```
  p3_uid=<64hex>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000
  （https origin 时追加 ; Secure —— 实测 buildSessionCookie(…,{secure:true}) 会带上）
  ```
  HttpOnly 挡住 XSS 读会话；`SameSite=Lax` 让跨站 POST 不带 cookie；
  `Path=/` 与 `Max-Age=2592000` 与 `sessions.expires_at` 同源（`http.mjs:41` 与 `db.mjs:234-235`）。
  用 Lax 而非 Strict 的理由写在 `http.mjs:307-309`（外站首跳不带 cookie 会显示"掉线"）。
* **登出真删库**：`public-server.mjs:462-495` → `destroySession` → `DELETE FROM sessions WHERE id=?`（`userstore.mjs:160-163`），
  响应体如实回 `destroyed` 布尔；cookie 以 `Max-Age=0` 清除（`http.mjs:329-330`）。测试覆盖：`tests/public-api.test.mjs:953`。
* **过期语义是绝对的、不可滚动利用**：查询条件 `expires_at > ?` 在 SQL 里（`userstore.mjs:129`），
  `last_seen` 只是显式 UPDATE（`:140`，schema 特意不设 `ON UPDATE`），**从不延长 `expires_at`**，
  也不重复下发 Set-Cookie → 不存在"无限续命"或"会话过期后又被刷新回来"的路径。
  另外 `u.status = 'active'` 写进 SQL（`:129`）→ 账号一被封，全部会话立即失效。
* **登录换发新 id、旧会话不撤销**：`public-server.mjs:446` 每次登录都 `createSession` 造新随机令牌并重新下发 cookie
  → **不存在会话固定（session fixation）**：即使攻击者能往受害者浏览器塞一个已知 `p3_uid`，登录后也被新令牌覆盖，
  旧令牌只是攻击者自己那条会话。informational N1：登录不会清掉该用户名下其它既有会话（本轮无"退出所有设备"需求）；
  改口令/封禁时的批量撤销入口 `destroyUserSessions` 已备好（`userstore.mjs:166-169`）。
* **cookie 读入是纯字符串解析**（`http.mjs:286-298`），不做任何反序列化。

### 1.4 XSS —— 通过（缺 CSP → S8）

* **渲染路径全 `textContent`**：
  * `js/comments.js:36-41` 唯一的建节点工具 `el()` 只写 `textContent`；
  * 正文 `comments.js:325` `el('div','cm-text', c.content)`，作者名 `:309`、时间 `:311`、错误提示 `:378,386` 同理；
  * 换行靠 CSS：`css/comments.css:509-515` `.cm-text { white-space: pre-wrap; overflow-wrap: anywhere; }` → 不需要拼 `<br>`；
  * 头像 `comments.js:211-220` 只接受 `data:image/*` 或**同源** http(s)，第三方外链一律退回首字母方块；
  * `js/auth-ui.js:35-40` 同一套 `el()`；「我的评论」列表 `:585-599` 全是 `textContent`，文章链接用 `encodeURIComponent`（`:591`）；
  * 模态框里的用户名（`:259`）、`aria-label`（`:258`）也是 `textContent` / `setAttribute` 而非字符串拼 HTML。
* 全仓 `grep -n innerHTML|outerHTML|insertAdjacentHTML|document.write`：两个新脚本里**零命中**
  （仅注释里出现字样）；`tests/verify-comments-live.mjs:76-77` 把这条做成了静态闸。
* **后端长度与结构限制**：`validateContent` 去首尾空白后 1–2000 字符（`http.mjs:392-397`、`COMMENT_MAX` `:44`）；
  slug ≤200 且拒绝控制字符/空白（`:402-408`）；请求体必须 `application/json` 且 ≤1MB（`:142-156`、`:34`）；
  评论以纯文本存 TEXT（`schema.sql:128-129`），后端**不做** HTML 转义 —— 契约要求转义归渲染层
  （`CONTRACT-public-api.md:314`），两层都做会造成 `&lt;` 二次转义。这个取舍成立的前提就是上面那条"零 innerHTML"，
  因此 S8（CSP）是它的必要纵深。
* **其它把用户数据写进 HTML 的地方**：`js/article.js:220` `body.innerHTML = post.body` 写的是**作者自己**的文章正文
  （来自 admin 面，不走公开评论表）；`js/archive.js:311`、`js/boot.js:102`、`js/menu.js:42`、`js/pages.js:131,198`、
  `admin/admin.js:139,168-170` 打的都是页面自身/作者自己的数据。公开评论数据没有任何一条路径进入这些 `innerHTML`。
* 响应侧：所有 JSON 一律 `nosniff` + `no-referrer` + `no-store` + `x-frame-options: DENY`（`http.mjs:163-176`，`security.mjs:225-228`）。

### 1.5 越权 —— 通过

* **删评论在服务端判定，且判定不可绕过**：
  * 路由要登录（`public-server.mjs:552` `auth:'required'`；未登录 401 由 `http.mjs:663-665` 统一发）；
  * `public-server.mjs:563-567` 用**会话里的** `ctx.user.id` 与 `ctx.user.role` 判 owner/admin，两者都不来自请求体；
  * 数据层把同一判定再写进 `UPDATE … WHERE`：非 admin 走 `id=? AND user_id=? AND status<>'deleted'`（`commentstore.mjs:116`），
    admin 走 `id=? AND status<>'deleted'`（`:115`）→ `affectedRows=0` 就是"不是你的"，没有 TOCTOU 窗口；
  * 前端 `comments.js:194-201` 的 `canDelete()` 只决定要不要画按钮，`armDelete/doDelete`（`:433-472`）拿到 403 照样如实提示。
    本机实测：带正确代理密钥但无 cookie 的 `DELETE /api/comments/5` → **401**。
* **改 `parent_id` / `slug` 动不了别人的数据**：`createComment` 在插入前用 SQL 校验父评论
  `id=? AND slug=? AND status='approved'`（`commentstore.mjs:74-79`），三者缺一即 422 `INVALID_PARENT`；
  `slug` 是自选字符串，但只能决定"这条新评论挂在哪篇文章下"，无法改已存在的行、也无法把评论插到别人的楼层里。
* **注册不能覆盖已有用户**：`insertUser` 是纯 INSERT（`userstore.mjs:93`），靠 `uk_users_username` / `uk_users_email`
  唯一键兜底（`schema.sql:86-87`），冲突翻译成 409（`userstore.mjs:78-89`，HTTP 层再兜一次 `public-server.mjs:254-262`），
  不存在 upsert/覆盖路径。
* **不能自封 admin**：`register` 只校验三个字段（`public-server.mjs:368-370`），`createUser` 只 destructure
  `{username,email,password}`（`store.mjs:97`），INSERT 只写四列（`userstore.mjs:93`）→ `role` 永远取 schema 默认
  `'user'`（`schema.sql:75`）；`status` 同理默认 `'active'`（`:79`）。多传的字段（包括 `role`）被完全忽略，无 mass assignment。
* 「我的评论」只按会话 user_id 过滤（`public-server.mjs:542-547` → `commentstore.mjs:52-57`），拿不到别人的。

### 1.6 用户枚举与限流 —— 登录侧通过，注册侧见 S4

* **登录文案/状态码/耗时三重对齐**：
  * 用户不存在与口令错误走同一分支、同一状态码、同一 code、同一句话
    `INVALID_CREDENTIALS`「用户名或密码不正确」（`public-server.mjs:432-443`）；
  * 耗时靠 `checkAgainstUser` 在无用户行时照跑 210000 轮 PBKDF2（`passwords.mjs:112-115,121-131`）；
  * 连"库连不上"都不会在这条路径上变成 500（`http.mjs:216-240` 只把 HttpError 的 message 外发，其它一律固定 500 文案）；
  * 非 active 账号也走假校验（`public-server.mjs:440`）。
  * 已知残余：`classifyLoginId` 按"含 @ 就当邮箱"分流（`http.mjs:385-390`），两条查询走不同唯一索引，
    理论上仍是 1 次索引查找的差异 —— 与 PBKDF2 的几十毫秒相比不构成可用信号，记为 informational。
* **限流落库**：`auth_throttle` 表（`schema.sql:158-174`，唯一键 `(ip,action)`），
  单条 `INSERT … ON DUPLICATE KEY UPDATE` 原子累加 + `IF(fails>=?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND), NULL)`
  （`userstore.mjs:252-259`）；阈值 `THROTTLE_POLICY`（`public-server.mjs:240-243`）：登录 10 次/15 分钟 → 封 1 小时，
  注册 5 次/6 小时 → 封 1 小时；熔断时**在查口令之前**就 429（`public-server.mjs:416-417`），不给计时探测留窗口。
  另外进程内还有一道固定窗口限流（`http.mjs:447-460`）挡在"读数据库之前"。
  本机实测：同一 XFF 连打 11 次登录 → 前 10 次 503（本机无库），**第 11 次 `429` + `retry-after: 3600`**，
  响应体 `{"ok":false,"error":{"code":"RATE_LIMITED","message":"操作过于频繁，请 3600 秒后再试"}}`；
  换一个 XFF（`198.51.100.7`）→ 独立的桶（不再是 429），证明是按 IP 分桶而不是全局一个桶。
* **XFF 信任边界正确（这是最容易做错的一处）**：
  * nginx 用 `$proxy_add_x_forwarded_for` **追加**（`deploy/bt/nginx-locations.conf:222,236,250,264,280,296,315`），
    后端取**最后一段**（`security.mjs:67-76`）→ 客户端自己塞的伪造值排在被忽略的前段；
  * 后端要**每个请求**都带 `X-Admin-Proxy-Secret` 且与 `--proxy-secret-file` 一致（`security.mjs:84-97`，`http.mjs:256-265`），
    nginx 每条 `/api/*` location 都 `include` 了同一头（`nginx-locations.conf:217,231,245,259,275,291,310`）→
    本机其它进程尽管能连回环 8850，也**伪造不了客户端 IP**；
  * 三态 fail-fast：给了参数但文件读不到/为空/短于 32 字符 → **拒绝启动 exit 7**（`public-server.mjs:739-756`）；
    不给参数 → 强制关闭代理信任并告警（`:757-765`），`resolveConfig:94-96` 保证"没密钥就不可能信任 XFF"。
  * 本机实测：不给密钥头 → **403**；给错密钥 → **403**；给对密钥 → 200。
  * 记账 IP 的取值与信任绑定：`auditIpOf`（`public-server.mjs:278-282`）只在密钥生效时用 XFF，否则回落到直连对端，
    避免"拿可伪造的头写审计/限流"。
* **注册侧的两条残余**（S4）：409 `USERNAME_TAKEN` / `EMAIL_TAKEN` 本身就是"这个用户名/邮箱在不在"的预言机，
  且本轮 SMTP 未配置、`email_verified` 恒 0，没有验证码/人机校验 → 可被批量造号。

### 1.7 边界隔离 —— 代码层通过，OS 层未收口（S3）

* **代码层隔离是真的**：`public-server.mjs:47-60` 只 import `node:*` 与 `lib/public/http.mjs`；
  `lib/public/*` 只 import `../util.mjs` / `../security.mjs` / 同目录模块，**零管理面依赖**。
  测试把它做成了可执行判据：`tests/public-api.test.mjs:1204-1220`（不得 import `dev-server.mjs` / `lib/auth.mjs` /
  `posts-store`，不得引用 `.admin`）。`lib/public/**` 全域 grep `readFile|node:fs|fs\.` → **零命中**：
  公开服务唯一的文件读取是启动时读 `--proxy-secret-file`（`public-server.mjs:741`），
  因此不存在"路径穿越读文章源码 / 读管理端令牌"的入口（公开面也**不提供任何静态文件服务**）。
* **nginx 面**：`location ^~ /admin/`、`^~ /server/`、`^~ /_admin/`、`~* \.(mjs|cjs)$`、`^~ /node_modules/`、
  `~* ^/(package(-lock)?\.json|…)$` 全部 `return 404`（`nginx-locations.conf:18-24,39-40`）；
  新公开面只放行**逐条列举**的 7+1 条路径，末尾 `location /api/ { return 404; }` 做默认拒绝（`:215-330`）。
  公网实测（本机 `curl`）：
  ```
  /server/public-server.mjs  404    /_admin/                 404    /api/auth/me             404
  /server/sql/schema.sql     404    /admin/                  404    /api/comments?slug=test  404
  /package.json              404    /.admin/passphrase.json  404    /api/comments/mine       404
  /node_modules/             404    /.git/config             404    /js/posts.js             200
  ```
  （`/js/auth-ui.js`、`/js/comments.js`、`/css/comments.css` 此刻也是 404 —— 新前端**尚未发布**，见 §3。）
  线上生效的伪静态文件里已含 `^~ /server/`、`^~ /_admin/`、`*.mjs`
  （`/www/server/panel/vhost/rewrite/43.108.100.116.conf:21-22,26`），
  但**还没有**新增的 `/api/` 段（mtime 2026-10-06 13:22，早于 t15）→ 目前 `/api/*` 落到面板默认规则而 404，属预期。
* **3306 只绑回环（实测）**：
  ```
  ss -lntp → LISTEN 127.0.0.1:3306 (mysqld)   127.0.0.1:8360/8848/8849 (node)   0.0.0.0:80 (nginx)
  mysql -N -B -e 'SELECT @@bind_address; SELECT @@skip_name_resolve;' → 127.0.0.1 / 1
  外部 TCP 探测 3306/8850/8849/8848/8360 → 全部 unreachable
  公网无 443 监听（唯一的 nginx 监听是 0.0.0.0:80）
  ```
* **数据库侧最小权限（实测）**：`SHOW GRANTS FOR 'p3app'@'127.0.0.1'` →
  `GRANT USAGE ON *.*` + `GRANT SELECT, INSERT, UPDATE, DELETE ON \`p3blog\`.*`（无 DDL/GRANT/FILE）；
  `mysql.user` 只有 `p3app@127.0.0.1`、`mysql.session@localhost`、`mysql.sys@localhost`、`root@localhost`
  —— 无匿名账号、无 `%` 主机账号；`p3blog` 六表齐备，当前 `users/comments/sessions/auth_log` 均为 0 行（干净）。
* **未收口的地方（S3）**：公开服务 `User=blog`（`deploy/systemd/p3-public.service:12-13`）与管理面**同 uid**，
  而实测 `sudo -u blog test -r /srv/blog/repo/.admin/passphrase.json` 与 `…/session.json` 均为**可读**
  （管理面口令哈希 + 管理端会话令牌）；`/srv/blog/repo/{blog-enter,deploy,p3-menu}` 目录权限是 **0777**，
  同机还有 `admin`、`springboot` 两个可登录账号 → 存在一条"本地低权用户写公开服务代码 → 以 blog 身份执行 →
  读 `.admin` 与管理面代理密钥 → 打通管理面"的提权链。详见 S3。
* **防火墙不是兜底**：`iptables -S INPUT` 策略是 `ACCEPT`，除 22/8888 外没有任何针对 3306/8850 的 DROP。
  今天的隔离**完全依赖** mysqld 的 `bind-address=127.0.0.1` 与公开服务的启动硬校验
  （`public-server.mjs:779-783`：非回环 `--listen` 直接 exit 4）。见 S7。

### 1.8 明文 HTTP 的现实风险 —— **高危（S1）**

**结论：当前部署形态下，注册/登录口令与整个会话 cookie 都在公网上明文传输，任何一跳（同 Wi-Fi、
运营商、VPS 上游链路、ARP/DNS 投毒者）都能直接拿到。这是本轮最严重的问题，且不能因为"用户已知情"而跳过。**

事实与证据：

1. 站点只有 HTTP：nginx 只监听 `0.0.0.0:80`，无 443（§1.7 实测）；`http://43.108.100.116/` 正常返回 200。
2. 会话 cookie **没有 `Secure`**：`resolveConfig` 只在白名单里出现 `https://` 时才加
   （`http.mjs:333-334`，`public-server.mjs:602`），而单元文件给的是 `--public-origin http://43.108.100.116`
   （`p3-public.service:86`）→ 本机实测的输出是 `p3_uid=…; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`（无 Secure）。
   注释本身也如实承认这一点（`p3-public.service:49-53`）。
3. 登录/注册请求体是 `{"user":…,"password":"明文"}`（`js/auth-ui.js:469,535-542`）→ 明文口令过网。
4. `HttpOnly` 只挡 JS，**不挡网络嗅探**：抓一个 `p3_uid` 就等于拿到 30 天的完整账号（发评论、删评论、看自己的邮箱）。
5. 会话令牌是 bearer 型（服务端不绑定设备/TLS 指纹），拿到即用；没有 HTTPS 也就没有 HSTS 可挡降级。

**缓解路径（按代价从低到高）**：

* **过渡（今天就能做）**：不要把系统对真实用户开放；仅在 SSH 隧道内验收
  （`ssh -L 8080:127.0.0.1:80 root@43.108.100.116` 后访问 `http://127.0.0.1:8080`），
  或临时用 `--public-origin https://<临时域名>` + 反代终止 TLS。真实口令一律不要在这条 HTTP 上输入。
* **正解（推荐，一步到位）**：`43.108.100.116` 的 vhost 里已经写了 `server_name 43.108.100.116 simonfu.xin www.simonfu.xin`
  （线上 `/www/server/panel/vhost/nginx/43.108.100.116.conf:4`）→ 给 `simonfu.xin` 签证书（面板 Let's Encrypt 即可），
  开 443 + `return 301 https://$host$request_uri;`，把单元里的
  `--public-origin http://43.108.100.116` 改成 `https://simonfu.xin` 并补 `--public-host simonfu.xin`
  （`p3-public.service:82-88`），再给 `nginx-locations.conf` 的 location 加上
  `add_header Strict-Transport-Security "max-age=31536000" always;`（注意 `:53-55` 那条 add_header 继承陷阱）。
  改完之后 `wantsSecureCookie` 自动给 cookie 加 `Secure`，**不需要改任何产品代码**。
* 若短期拿不到域名/证书，就把它当"内网/演示系统"，在页面上明确写"请勿使用常用口令"，并禁用公开注册。

---

## 2. 发现清单（按 severity）

### S1 — 口令与会话在公网明文传输（无 TLS）—— **high**

* **id**：S1
* **severity**：**high**（本轮的"必须处置项"；不修则后续一切认证强度都无意义）
* **files/lines**：
  * `deploy/systemd/p3-public.service:86` — `--public-origin http://43.108.100.116`（决定不加 Secure，`:49-53` 自述）
  * `blog-enter/server/lib/public/http.mjs:315-325`、`:333-334` — `Secure` 只在 https origin 时出现
  * `blog-enter/js/auth-ui.js:469,535-542` — 明文口令进请求体
  * 线上实测：`ss -lntp` 无 443；`curl http://43.108.100.116/` → 200
* **problem**：见 §1.8。会话是 bearer 型、有效期 30 天，被嗅到一次即等于账号被接管；口令明文可被直接复用（用户很可能在别处复用）。
* **requiredFix**：按 §1.8 的"正解"接 TLS（证书 + 443 + 301 + 改 `--public-origin/--public-host` + HSTS）；
  在此之前把系统限制在隧道内使用，并禁止真实口令。**不要**通过"给 cookie 硬加 Secure"来绕过 —— 纯 HTTP 下加了
  只会导致浏览器不存 cookie（`http.mjs:312-314` 已写明）。
* **confidence**：**high**（配置与实测双重证据）
* **移交**：t18（部署）或新开修复任务；验收点 = `curl -I https://…` 有 HSTS、`Set-Cookie` 含 `Secure`。

### S2 — 同源第三方应用（Waline）会收到 `p3_uid` 会话 cookie —— **medium**

* **id**：S2
* **severity**：**medium**（当前不是"已被利用"，而是"把会话交到不必要的第三方手里"）
* **files/lines**：
  * `deploy/bt/nginx-locations.conf:82-91` — `location ^~ /comments/ { proxy_pass http://127.0.0.1:8360/; … }`
    只覆写了 `Host / X-Real-IP / X-Forwarded-For / X-Forwarded-Proto`，**Cookie 头按 nginx 默认原样透传**
  * `blog-enter/server/lib/public/http.mjs:317` — cookie `Path=/`，覆盖站点全部路径
  * `deploy/bt/nginx-locations.conf:95-120` — Waline 后台/注册虽限本机，但 `/comments/` 主体仍公网可达
  * 线上实测：`/comments-assets/waline.js` → 200；Waline 服务 127.0.0.1:8360 在跑
* **problem**：会话 cookie 的作用域是整个 host，因此每一次 `http://43.108.100.116/comments/*` 请求都会把
  `Cookie: p3_uid=<会话令牌>` 交给 Waline 进程。Waline 是自托管的第三方应用（自带用户体系、历史上多处 XSS/CVE），
  服务端能原样读到该头 → 一旦它被攻破或存在日志/调试泄露，攻击者不需要任何 XSS 就能拿到我们的会话令牌。
  HttpOnly 在这条路径上完全无效（泄露发生在服务端读头，不是 JS 读）。
* **requiredFix**（二选一，推荐两条都做）：
  1. 切换完成后**停用并删除 Waline 那段反代**（`nginx-locations.conf:67-121`）与 `comments-assets/` 的残留资源
     （`comments-assets/README.md` 已写了回滚办法）；至少不要让它继续对外可达。
  2. 把会话 cookie 的 `Path` 收窄到 `/api`（`http.mjs:317`）。前端所有请求都只打 `/api/*`（`auth-ui.js:30,120`、
     `comments.js:32,90`），静态页与 `/comments/` 都不需要这个 cookie，因此这是零功能代价的收窄；
    若采纳需同步改 `CONTRACT-public-api.md` 的 COOKIE 段与相关测试。
* **confidence**：**high**（Path=/ 与 nginx 默认透传都是确定行为；是否已被利用取决于 Waline 自身，未做实测）
* **移交**：t18（关停 Waline）+ 契约/实现修复任务（Path 收窄）。

### S3 — 公开服务与管理面同 uid、可读 `.admin/`，且仓库目录 0777 —— **medium**

* **id**：S3
* **severity**：**medium**（需要"公开进程被拿下"或"本地有对手用户"作为前提；但它是把两者连成一条链的黏合剂）
* **files/lines**：
  * `deploy/systemd/p3-public.service:12-13`（`User=blog` / `Group=blog`）、`:123`（`ReadOnlyPaths=/srv/blog/repo /etc/p3blog`）
  * `blog-enter/server/public-server.mjs:76-96` 起的数据层测试：`tests/public-api.test.mjs:1204-1220` —— 隔离只到"代码不引用"这一层
  * 线上实测：
    ```
    sudo -u blog test -r /srv/blog/repo/.admin/passphrase.json && echo PASSFILE_READABLE_BY_BLOG
      → PASSFILE_READABLE_BY_BLOG
    sudo -u blog test -r /srv/blog/repo/.admin/session.json    && echo SESSIONFILE_READABLE_BY_BLOG
      → SESSIONFILE_READABLE_BY_BLOG
    ls -la /srv/blog/repo  → drwxrwxrwx blog blog blog-enter / deploy / p3-menu
    getent passwd | grep '/bin/\(bash\|sh\)$' → root, admin, springboot, blog
    ```
* **problem**：`public-server.mjs:3-16` 把"物理隔离"写成设计目标，但落地形态只做到"代码里找不到那些路径"：
  同一个 uid 让公开进程在 OS 层就能打开 `passphrase.json`（管理口令的 PBKDF2 哈希）与 `session.json`
  （管理端会话令牌）；`0777` 的仓库目录还让**其它本地账号**能改写公开服务要加载的 `.mjs`
  → 以 `blog` 身份执行 → 再读 `.admin` 与 `/etc/p3blog/proxy-secret`（640 root:blog）。
  也就是说"公开面被拿下 = 管理面被拿下"的通道目前是开的，靠的只是"公开代码里恰好没有文件读"。
* **requiredFix**：
  1. 给公开服务独立 uid（如 `p3public`），不要与 p3-admin 共用 `blog`；
  2. 单元里显式挡掉管理面运行时数据（systemd ≥ 231）：
     `InaccessiblePaths=/srv/blog/repo/.admin /etc/p3blog/proxy-secret`（前者是本次评审重点；后者公开服务也不需要）；
  3. 修正权限：`chown -R root:blog /srv/blog/repo && chmod 0755` 目录 / `0644` 文件（去掉 0777），
     `.admin` 保持 `0700 blog:blog`；
  4. 记一条运维纪律：今后任何"公开面进程能读的路径"都不许放凭据（口令哈希、令牌、代理密钥）。
* **confidence**：**high**（可读性与 0777 都是实测）
* **移交**：新开修复任务（改 `deploy/**` 与服务器权限；本报告不动代码）。

### S4 — 注册接口是账号/邮箱枚举预言机；无邮箱验证、无 CAPTCHA，可批量造号 —— **medium**

* **id**：S4
* **severity**：**medium**
* **files/lines**：
  * `blog-enter/server/public-server.mjs:382-383` — 409 `USERNAME_TAKEN` / `EMAIL_TAKEN`（已注册/已占用可区分）
  * `blog-enter/server/lib/public/userstore.mjs:78-89`、`:110-117` — 冲突翻译
  * `blog-enter/server/sql/schema.sql:77-78` — `email_verified` 恒 0（本轮 SMTP 未配置）、`:186-193` — `email_verify` 只建表备用
  * `blog-enter/server/public-server.mjs:454-457` — 失败才计入 `auth_throttle` 退避
  * `blog-enter/server/lib/public/http.mjs:452` — 注册 5 次/小时·每 IP（换 IP 即绕开）
* **problem**：(a) 攻击者可用注册接口逐一确认"某用户名/某邮箱是否本站用户"，这既是隐私泄露也是精准撞库的前置；
  (b) 没有邮箱验证也没有人机校验，botnet 可批量造号（每 IP 5 次/小时的阈值对分布式攻击只是成本提高），
  并可**抢先注册别人的邮箱**；(c) 若将来接上"忘记口令"流程而直接信任 `users.email`（`email_verified=0`），
  就会把别人抢注的邮箱变成口令重置通道。
* **requiredFix**：
  1. 接受 409 作为注册体验的一部分（它确实比"500"好得多），但把"枚举"这一面用限流压住：注册的**每次调用**
     （不只失败）都计入 `auth_throttle`，并把 `THROTTLE_POLICY.register` 的窗口/阈值按线上实际观察收紧；
  2. 落地邮件验证码骨架时，`email_verified=0` 必须被当成"邮箱未经证明"：重置口令流程只在验证通过后可用，
     且一律回同一条文案（避免把 reset 接口又做成一个枚举预言机）；
  3. 在 SMTP/验证码就绪之前，考虑把注册接口限制在低峰或加一个轻量人机校验（如 honeypot + 时间窗），
     并明确记录"当前允许匿名造号"这一残余风险。
* **confidence**：**high**

### S5 — PBKDF2 迭代 210000 轮低于当前建议值 —— **medium**

* **id**：S5
* **severity**：**medium**
* **files/lines**：`blog-enter/server/lib/public/passwords.mjs:34`（`ITERATIONS = 210_000`）、`:58`（自描述串）、
  `blog-enter/server/sql/schema.sql:71-72`（`password_algo` 列就是为升级准备的）
* **problem**：OWASP 对 PBKDF2-HMAC-SHA256 的现行建议是 600000 轮；210000 轮在库被拖走时把离线破解成本压低了约 3 倍。
  该值沿用的是管理面参数（`passwords.mjs:4-9` 有说明），一致性本身是对的，但一致性不该把两边都钉在偏低的数值上。
* **requiredFix**：把 `ITERATIONS` 提到 ≥600000 并在服务器上实测登录耗时（目标：单次校验 <300ms，
  与现有每 IP 限流配合后 CPU 可承受）；利用自描述串 + `password_algo`：老记录用**记录里的**轮数校验，
  校验成功且轮数偏低时顺手重算回写（schema 注释已写明这条路径，实现按需加）。
  若允许加依赖，可另行评估 argon2id；本轮不必。
* **confidence**：**high**（参数值可直接读出；"偏低"是按公开建议判断）

### S6 — 超限请求体直接销毁连接，契约里的结构化 413 实际拿不到 —— **low**

* **id**：S6
* **severity**：**low**（fail-closed，没有安全后果；但会让 t18 的 413 验收项失败）
* **files/lines**：
  * `blog-enter/server/lib/public/http.mjs:111-130` — `size > limit` → `bail(...)` 后立刻 `req.destroy()`（`:122`）
  * `blog-enter/server/tests/public-api.test.mjs:1131-1141` — 测试把"连接被 reset"当成通过（注释自述这一点）
* **problem**：本机实测（`public-server.mjs` + 1.1MB body）：
  ```
  带/不带 Expect: 100-continue 都拿不到 JSON：
    code=000 err=Empty reply from server        （无 Expect）
    HTTP/1.1 100 Continue … code=000 err=Empty reply from server
  ```
  即"边读边判超限"确实阻止了内存耗尽，但**契约承诺的 `413 BODY_TOO_LARGE` JSON 永远不会送到客户端**。
  curl/浏览器看到的是连接被重置，前端只能显示网络错误。
* **requiredFix**：把超限处理改成"先回 413 再断"：不要在同一 tick 里 `req.destroy()`；
  可以先 `res.writeHead(413,…); res.end(body)`，在 `res` 的 `finish` 回调里再 `req.destroy()`，
  或改用 `req.pause()` + 写响应 + `socket.end()`。同时把 `public-api.test.mjs:1138-1141` 那条
  "reset 也算过"的宽容分支删掉，让它真正验证 413。
* **confidence**：**high**（本机可复现的原始输出）

### S7 — 主机防火墙没有 3306/8850 的兜底 DROP —— **low**

* **id**：S7
* **severity**：**low**（当前隔离有效，属纵深防御缺口）
* **files/lines**：线上 `/etc/p3blog/iptables.rules` 与 `iptables -S INPUT`：
  策略 `ACCEPT`，规则只有 22(f2b)、8888、以及两条 DROP；**没有** 3306/8848/8849/8850 的规则。
* **problem**：DB 只绑回环、应用只绑回环、外网实测全不可达 —— 今天没问题。但把"不可达"完全押在
  mysqld 的 `bind-address`（`/etc/my.cnf:7`）与应用的启动硬校验（`public-server.mjs:779-783`）上：
  任何一次配置漂移（改 my.cnf、加 `--skip-networking` 反操作、手工起一个绕过 systemd 的实例、面板"开放 3306"）
  都会立刻把库暴露到公网，因为防火墙不会拦。
* **requiredFix**：在 `/etc/p3blog/iptables.rules` 增加明确拒绝（并在 `p3-firewall.service` 重载后核对）：
  `-A INPUT -p tcp -m multiport --dports 3306,8360,8848,8849,8850 -j DROP`（放在 `-i lo` 允许之后），
  或至少 `-A INPUT -p tcp --dport 3306 -j DROP`。保持"两条独立机制同时成立"。
* **confidence**：**high**

### S8 — 公开页没有 CSP，XSS 防线只靠 `textContent` 一处 —— **low**

* **id**：S8
* **severity**：**low**
* **files/lines**：
  * `blog-enter/server/lib/security.mjs:223-224` — 公开页**故意**不设 CSP 的说明；`baseHeaders:225-228` 只有 nosniff + no-referrer
  * `deploy/bt/nginx-locations.conf:53-58` — 站点级 add_header（含"某个 location 里出现 add_header 会让同 server 块的这些全作废"的警告）
  * 实测：`article.html` / `index.html` / `archive.html` / `about.html` 的 `<script>` 全是外链（0 个内联），`404.html:93` 有 1 个内联
* **problem**：评论正文与用户名目前**唯一**的 XSS 控制就是渲染层用了 `textContent`（§1.4）。只要将来有人加一个
  "评论摘要渲染到 HTML"的功能、或引回一个第三方评论脚本（Waline 就是这么进来的：`admin/admin.js:170`、
  `js/pages.js:198` 这些 `innerHTML` 用法的存在说明团队并不缺这类写法），就会直接变成存储型 XSS，
  且因为 cookie 是 HttpOnly，攻击面主要是"以受害者身份发/删评论"而不是偷会话 —— 仍然不可接受。
* **requiredFix**：给公开页加 CSP（纯外链脚本的页面可以很严）：
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`；
  `404.html` 的那 1 个内联脚本用 hash 或去掉。**先上 `Content-Security-Policy-Report-Only`** 观察一周再强制，
  并注意 `nginx-locations.conf:53-55` 记录的 add_header 继承陷阱（要加在 server 块或每个 location 都补）。
* **confidence**：**medium**（CSP 本身确定可加；具体会不会破坏页面需要一次实测）

### S9 — 评论默认 `approved`、无审核队列，滥用只能人工改库 —— **low**

* **id**：S9
* **severity**：**low**
* **files/lines**：`blog-enter/server/sql/schema.sql:130-131`（`status ENUM('approved','pending','deleted') DEFAULT 'approved'`）、
  `blog-enter/server/lib/public/commentstore.mjs:40-46`（只读 approved）
* **problem**：`pending` 这一档已经留在 schema 里，但没有任何入口把新评论写成 `pending`，也没有管理端审核界面 →
  对公网开放注册后，垃圾评论/辱骂内容只能靠 DBA 手改 `status`（或让作者自己删）。这不是漏洞，是本轮明确的滥用面残余。
* **requiredFix**：把"新评论先 pending、管理端审核后 approved"做成一个开关（哪怕先只改 `createComment` 的写入值 +
  一条管理侧 SQL），或在部署说明里显式记录"当前无审核、发现滥用就临时关闭注册"的运维动作。
* **confidence**：**high**

### informational

* **N1**：登录不会撤销该用户名下既有会话（`public-server.mjs:446` 只新增，不删旧）。不是会话固定（每次都换发新令牌），
  仅记录为"没有 logout-all 能力"；`destroyUserSessions`（`userstore.mjs:166-169`）已备好入口。
* **N2**：`tests/verify-public-live.mjs:1762,1816-1821` 用字符串拼接 SQL（标记由脚本自己生成，非用户输入）。
  建议改成参数化，避免这个写法被复制进产品代码。
* **N3**：`auth_throttle.ip` 在 `--trust-proxy` 未生效时会退化成常量（全站一个桶）；当前单元**确实**带了密钥，
  所以线上是按真实 IP 分桶。这一点必须在 t18 部署验收里显式确认（`--print-config` 的 `trustProxy: true` +
  公网登录 11 次实测 429），一旦漏配密钥，症状是"任何人连错 10 次就把全站登录锁死一小时"（可用性事故）。

---

## 3. 线上取证记录（2026-10-06，只读命令）

```text
$ ssh root@43.108.100.116 'ss -lntp'
LISTEN 127.0.0.1:8360 (node)   127.0.0.1:3306 (mysqld)   127.0.0.1:8848 (node)
LISTEN 0.0.0.0:80   (nginx)    127.0.0.1:8849 (node)      ← 无 443

$ systemctl is-active p3-public ; systemctl is-enabled p3-public
inactive
Failed to get unit file state for p3-public.service: No such file or directory
$ ls -la /etc/systemd/system/ | grep p3
p3-admin-proxy.service  p3-admin.service  p3-firewall.service  p3-waline.service
  ← 公开服务尚未部署（t15 的原话："服务器未做任何生产变更"），8850 无监听

$ grep -nE 'bind-address|skip-name-resolve' /etc/my.cnf
7:bind-address = 127.0.0.1
29:skip-name-resolve

$ mysql --defaults-file=/etc/my.cnf -N -B -e 'SELECT VERSION(); SELECT @@bind_address; SELECT @@skip_name_resolve;'
5.7.40-log / 127.0.0.1 / 1

$ mysql … -e "SHOW GRANTS FOR 'p3app'@'127.0.0.1'"
GRANT USAGE ON *.* TO 'p3app'@'127.0.0.1'
GRANT SELECT, INSERT, UPDATE, DELETE ON `p3blog`.* TO 'p3app'@'127.0.0.1'

$ mysql … -e 'SELECT user,host FROM mysql.user'
p3app 127.0.0.1 / mysql.session localhost / mysql.sys localhost / root localhost   ← 无匿名、无 '%'

$ mysql … -e 'SELECT (SELECT COUNT(*) FROM p3blog.users) users,(…comments) comments,(…sessions) sessions,(…auth_log) auth_log'
0  0  0  0      ← 库表已建，尚无真实用户/评论/会话

$ ls -la /www/server/panel/vhost/rewrite/43.108.100.116.conf
-rw------- 1 root root 5312 Oct  6 13:22        ← 早于 t15；grep 结果里只有 /server/、/_admin/、*.mjs 与 Waline 段，
                                                  没有任何 /api/* 或 8850 的字样（新反代尚未生效）

$ ls -la /etc/p3blog/
proxy-secret(640 root:blog) public.env(600 root:blog) waline.env iptables.rules …
  ← public-proxy-secret / public-proxy-header.conf **尚未创建**（部署时按 PLAN 第 4 步一次建两份）

$ iptables -S INPUT
-P INPUT ACCEPT … -A INPUT -p tcp -m multiport --dports 22 -j f2b-sshd … （无 3306/8850 规则）

$ getent passwd | grep -E '/bin/(bash|sh)$'
root / admin / springboot / blog

$ sudo -u blog test -r /srv/blog/repo/.admin/passphrase.json && echo PASSFILE_READABLE_BY_BLOG
PASSFILE_READABLE_BY_BLOG
$ sudo -u blog test -r /srv/blog/repo/.admin/session.json && echo SESSIONFILE_READABLE_BY_BLOG
SESSIONFILE_READABLE_BY_BLOG
$ ls -la /srv/blog/repo  → drwxrwxrwx blog blog blog-enter / deploy / p3-menu
$ ls -la /srv/blog/repo/blog-enter/server → No such file or directory   ← 新代码尚未上线
```

公网侧（本机 `curl`，2026-10-06）：

```text
/                        200      /server/public-server.mjs   404     /_admin/   404
/js/posts.js             200      /server/sql/schema.sql      404     /admin/    404
/comments-assets/waline.js 200    /package.json               404     /node_modules/ 404
/js/auth-ui.js           404      /.admin/passphrase.json     404     /.git/config   404
/api/auth/me             404      /api/comments?slug=test     404     /api/comments/mine 404
  ← 404 而非 403/200：既有拒绝规则生效；新前端与 /api/ 反代都还没发布
外部 TCP 3306 / 8850 / 8849 / 8848 / 8360 → 全部 unreachable
HTTP/1.1 200 OK（Server: nginx，X-Content-Type-Options: nosniff，无 Set-Cookie、无 HSTS）
grep -c isDraft /www/wwwroot/43.108.100.116/js/posts.js → 0   ← 线上产物里没有草稿
```

## 4. 本机可复现命令

```bash
# 1) 起真服务（骨架模式，不需要 MySQL），然后核对闸门
node blog-enter/server/public-server.mjs --allow-degraded --listen 127.0.0.1 --port 8851 \
  --public-host 43.108.100.116 --public-origin http://43.108.100.116

Host: 127.0.0.1:8851   GET /api/auth/me                  → 200 {"ok":true,"user":null,"db":"down",…}
Host: evil.example.com GET /api/auth/me                  → 403（DNS rebinding 白名单）
无 JSON Content-Type    POST /api/auth/login             → 415
Origin: http://evil.example.com   POST /api/auth/login   → 403
Sec-Fetch-Site: cross-site        POST /api/auth/login   → 403
无 cookie              DELETE /api/comments/5            → 401
无 slug                GET  /api/comments                → 422
无登录                 GET  /api/comments/mine           → 401
PUT                    /api/comments                     → 405（带 Allow）
                       /api/nope                          → 404

# 2) 代理密钥三态（密钥 46 字符，写在 %TEMP% 的临时文件里）
… --trust-proxy --proxy-secret-file <file>
无 X-Admin-Proxy-Secret → 403     错的密钥 → 403     对的密钥 → 200
同一 XFF 连打 11 次登录 → 前 10 次 503（本机无库）；第 11 次 429 + retry-after: 3600
换一个 XFF              → 独立的桶（不再是 429）

# 3) cookie / 令牌属性
node -e "import('./blog-enter/server/lib/public/http.mjs').then(m=>console.log(m.buildSessionCookie('deadbeef'.repeat(8))))"
  → p3_uid=…; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000              ← 无 Secure（http origin）
node -e "import('./blog-enter/server/lib/public/userstore.mjs').then(m=>{const t=m.newSessionToken();console.log(t.length,/^[0-9a-f]{64}$/.test(t),m.tokenHash(t)===t)})"
  → 64 true false
```

## 5. 移交与后续动作（本报告不改任何产品代码）

| 发现 | severity | 建议承接 |
| --- | --- | --- |
| S1 明文 HTTP（TLS + Secure + HSTS） | high | t18 部署阶段一并做；证书/域名属运维动作，代码零改动 |
| S2 Waline 同源拿到会话 cookie | medium | t18 关停 Waline；`Path=/api` 收窄单开修复任务（含契约与测试同步改） |
| S3 同 uid / `.admin` 可读 / 0777 | medium | 新开修复任务（改 `deploy/systemd/p3-public.service` + 服务器 `chmod/chown`） |
| S4 注册枚举 + 无邮箱验证 | medium | 与"邮件验证码骨架"任务合并；本轮至少收紧注册限流 |
| S5 PBKDF2 210k → ≥600k | medium | 小修复任务（`passwords.mjs:34` + 服务器实测耗时；自描述串已支持灰度） |
| S6 413 拿不到 JSON | low | t18 验收时会踩到；同时修 `readBody` 与测试的宽容分支 |
| S7 防火墙无 3306/8850 兜底 | low | 运维动作（`/etc/p3blog/iptables.rules`） |
| S8 公开页无 CSP | low | 新开小任务，先 Report-Only |
| S9 无评论审核 | low | 与滥用治理/后台任务合并 |

**本报告未做的事（明确边界）**：没有改任何产品代码、HTML、deploy 文件；没有重启线上任何服务；
没有写线上任何文件（只用了 `ss/ls/grep/systemctl show/mysql SELECT/iptables -S/test -r` 这类只读命令）。
