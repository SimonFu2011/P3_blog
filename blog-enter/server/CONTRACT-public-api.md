# 公开 API 契约（冻结）

> 文件：`blog-enter/server/CONTRACT-public-api.md`
> 服务：`blog-enter/server/public-server.mjs`（默认 `127.0.0.1:8850`）
> 契约层：`blog-enter/server/lib/public/http.mjs`
> 状态：**冻结**
> 落地者：t10（本契约 + HTTP 层）、t12（前端按本契约调用）、t14（数据层按本契约填 SQL）、t16（按本契约逐条验证）
> 变更规则：**形状**（路径、方法、字段名、状态码、错误码、cookie 属性、限流阈值）一旦冻结，任何改动都必须同步修改本文件、`http.mjs` 里的常量与前端调用方，并在任务输出里写明改了什么。只改代码不改本文件 = 违约。

---

## 0. 通用约定

### 0.1 成功 / 失败形状

```
成功：200 / 201 + { "ok": true, ... }
失败：4xx / 5xx + { "ok": false, "error": { "code": "<错误码>", "message": "<中文短句>" } }
```

* 失败体**只有** `ok` 与 `error` 两个顶层字段；`error` **只有** `code` 与 `message`。
* `message` 是给人看的中文，前端可以直接展示；但前端**必须**用 `code` 做判断（文案会改，code 不会）。
* 所有响应 `Content-Type: application/json; charset=utf-8`。
* 所有响应 `Cache-Control: no-store`（`/api/auth/me` 是"我"的状态，任何缓存都会变成跨账号泄露）。

### 0.2 错误码表（冻结）

| code | HTTP | 触发条件 | message 示例 |
|---|---|---|---|
| `BAD_REQUEST` | 400 | 缺少必需字段、请求体不是对象、越界输入 | `请填写用户名或邮箱` |
| `INVALID_JSON` | 400 | 请求体不是合法 JSON | `请求体不是合法 JSON` |
| `UNAUTHENTICATED` | 401 | 需要登录的端点没有有效会话 | `请先登录` |
| `INVALID_CREDENTIALS` | 401 | 登录失败（**不区分**用户不存在 / 密码错误 / 账号被禁用） | `用户名或密码不正确` |
| `FORBIDDEN` | 403 | 来源判定不过，或删别人的评论 | `只能删除自己的评论` |
| `NOT_FOUND` | 404 | 路径不存在 / 评论不存在（含已软删） | `没有这条评论` |
| `METHOD_NOT_ALLOWED` | 405 | 路径存在但方法不对；响应带 `Allow` 头 | `这个地址不支持 PUT` |
| `USERNAME_TAKEN` | 409 | 用户名已被占用 | `这个用户名已被占用` |
| `EMAIL_TAKEN` | 409 | 邮箱已被注册 | `这个邮箱已被注册` |
| `INVALID_USERNAME` | 422 | 用户名不合规 | `用户名必须是 3-20 位字母、数字或下划线` |
| `INVALID_EMAIL` | 422 | 邮箱不合规 | `邮箱格式不正确` |
| `INVALID_PASSWORD` | 422 | 密码长度不合规 | `密码至少 8 个字符` |
| `INVALID_CONTENT` | 422 | 评论内容为空或超长 | `评论最多 2000 个字符` |
| `INVALID_SLUG` | 422 | 缺 slug 或 slug 含控制字符/空白 | `缺少 slug` |
| `INVALID_PARENT` | 422 | `parent_id` 不是正整数 | `parent_id 必须是正整数` |
| `BODY_TOO_LARGE` | 413 | 请求体 > 1 MiB（连接会被 destroy） | `请求体超过上限（1.0 MB）` |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | 写接口的 `Content-Type` 不是 `application/json` | `请求体必须是 application/json` |
| `RATE_LIMITED` | 429 | 触发限流；响应带 `Retry-After`（秒） | `操作过于频繁，请 47 秒后再试` |
| `INTERNAL` | 500 | 非预期异常（**细节只进日志，绝不外泄**） | `服务器内部错误` |
| `DB_UNAVAILABLE` | 503 | 数据库不可用 / 未配置 | `数据服务暂时不可用（评论）` |

> 500 与 503 必须分开：500 = 我们的代码有问题，503 = 下游依赖不可用。混用会让运维无法从状态码分布里定位故障。

### 0.3 请求头要求

* 写接口（POST / DELETE）必须带 `Content-Type: application/json`，否则 `415`。
  *为什么*：`<form enctype="text/plain">` 这种跨站表单**不需要预检**就能发出去。强制 JSON 让浏览器必须先发 OPTIONS 预检，而预检过不了 Origin 判定 —— 这是一道零成本的 CSRF 补充闸。
* 浏览器端必须带 `credentials: 'same-origin'`（否则 cookie 不发，登录状态"看不见"）。
* **不需要** CSRF token、不需要 `X-Requested-With`。CSRF 防线由这几条组成（都在 `lib/public/http.mjs` 与 `lib/security.mjs` 里）：
  1. cookie `SameSite=Lax`（跨站 POST 不带 cookie）；
  2. `Origin` / `Referer` 精确白名单比对（复用 `security.assertSameOrigin`）；
  3. `Sec-Fetch-Site` 只允许 `same-origin` / `none`；
  4. `Host` 头白名单（防 DNS rebinding）；
  5. `Content-Type: application/json` 强校验。
  *为什么不加 token*：token 必须存在一个前端可读的地方（localStorage / 可读 cookie）。那等于给 XSS 一份长期有效的凭据，只换来"防住了一种已经被 SameSite 防住的攻击"。所以**不加**，而是把上面的判据逐条做实。

### 0.4 来源判定（所有请求，含 GET）

顺序（便宜→贵）：`Host` 白名单 → `Origin`/`Referer`/`Sec-Fetch-Site`。任一不过 → `403 FORBIDDEN`，且**不说明是哪一条不过**。

* `--public-host <name>`（可重复）追加 Host 白名单；回环名（`127.0.0.1` / `::1` / `::ffff:127.0.0.1` / `localhost`）**永远**在白名单里（本服务只绑回环，SSH 隧道/直连要能进来）。
* `--public-origin <origin>`（可重复）给出 Origin 精确白名单；**不给**则只认回环 Origin。不给通配。
* `OPTIONS` 返回 `204` + `Allow` 头，**不发** `Access-Control-Allow-Origin`（不支持跨源调用）。

### 0.5 Cookie（冻结）

| 项 | 值 |
|---|---|
| 名字 | `p3_uid` |
| 值 | 64 位十六进制会话 id（32 随机字节） |
| `HttpOnly` | 是（JS 读不到 → XSS 也偷不走） |
| `SameSite` | `Lax`（跨站 POST 不带；不用 `Strict` 是因为从外站导航进本站时 `Strict` 会"看起来没登录"） |
| `Path` | **`/api`**（只发给 API 请求） |
| `Max-Age` | `2592000`（30 天；与 `sessions.expires_at` 同源） |
| `Secure` | **仅当** `--public-origin` 是 `https://…` 时加 |

* **`Path=/api` 而不是 `/`（审计 S2）**：会话 cookie 的作用域是整个 host，
  `Path=/` 时每一次 `http://<host>/comments/*` 请求都会把 `Cookie: p3_uid=…`
  交给同源上的第三方应用（自托管评论系统那类）。那种泄露发生在**服务端读头**，
  `HttpOnly` 完全无效 —— 对方一旦被攻破或打了日志，攻击者不需要任何 XSS
  就拿到 30 天会话。前端所有请求都只打 `/api/*`（`js/auth-ui.js`、`js/comments.js`），
  静态页不需要这个 cookie，所以收窄是**零功能代价**的。
  实现：`http.mjs` 的 `SESSION_COOKIE_PATH = '/api'`，`buildSessionCookie` /
  `clearSessionCookie` 默认使用它。

*清除 cookie* 用同样的属性 + `Max-Age=0` + 空值（属性必须完全一致，否则可能留下一个删不掉的旧 cookie）。

```
Set-Cookie: p3_uid=<64hex>; Path=/api; HttpOnly; SameSite=Lax; Max-Age=2592000
```

> **变更影响**：`Path` 从 `/` 收窄到 `/api` 后，浏览器里以 `/` 为作用域的旧 cookie
> 不会被新响应覆盖（路径不同 = 不同的 cookie）。旧 cookie 会一直留到 `Max-Age` 到期，
> 但它只在 `/api` 之外的路径才被发送，而那些路径服务端根本不读 `p3_uid`
> （公开面不提供任何文件服务），因此**不构成功能或安全问题**；用户第一次登录/注册
> 都会拿到新作用域的 cookie。若想立即清干净，可由服务端在 `logout` 时同时下发一条
> `Path=/` 的过期 cookie（本轮未做，因为那等于重新引入一个宽作用域 cookie）。

### 0.6 限流阈值（冻结）

两道闸：**HTTP 层内存窗口**（先挡，不碰数据库）+ **库内 `auth_throttle`**（t14 落地，跨进程重启仍生效）。

| action | 键 | 窗口 | 上限 | 触顶后封禁 | 说明 |
|---|---|---|---|---|---|
| `auth.login` | 每 IP | 15 分钟 | 10 次 | 1 小时 | 失败与成功都计数（否则"猜对一次就重置窗口"让计数失去意义） |
| `auth.register` | 每 IP | 60 分钟 | **5 次** | **1 小时** | 防批量造号。**只计失败调用**（成功清零，见下） |
| `comment.create` | 每用户 | 10 分钟 | 20 次 | 5 分钟 | 按用户而非 IP：换 IP 的脚本挡不住 IP 限流 |
| `comment.delete` | 每用户 | 10 分钟 | 20 次 | 5 分钟 | 防止反复写库 |
| `auth.logout` | 每 IP | 60 秒 | 30 次 | 60 秒 | 宽松：登出是"改主意"的正常动作 |
| 读接口（`GET`) | — | — | **不限流** | — | 页面正常流量；设低阈值会让刷新/翻页变成 429 |

* 触顶响应：`429 RATE_LIMITED` + `Retry-After: <秒>`。
* 客户端（前端）必须读 `Retry-After` 并停手，不要"一直重试一直被拒"。
* **注册的计数语义（冻结，勿改）**：注册**只计失败**——**校验失败不计入落库计数**，
  注册成功则清零。也就是说请求体校验不通过（422）既不算"一次尝试"，也不消耗额度；
  只有真正走到"创建用户"那一步并且失败（如 409 冲突）才累加 `auth_throttle`。
  *为什么写死这句*：这里曾经漂过一次（被改成"每次调用都计数 + 阈值收紧到 3 次"），
  后果是正常用户填错两次表单就被挡在门外 —— 拿可用性换一条**业主已明确接受**的风险
  （S4 保持开放注册、只留风险记录）。改这里之前先看 AUDIT-public-login.md 的 S4 处置状态。
* 限流是**两道闸**，阈值同上，但维度不同：
  * **HTTP 层内存窗口**（`lib/public/http.mjs` 的 `createRateLimiter`）—— 在读数据库**之前**挡住洪峰，进程重启即清零；键是客户端 IP（或用户 id）。
  * **库内 `auth_throttle`**（`public-server.mjs` 的 `THROTTLE_POLICY`）—— 登录 10 次失败/15 分钟、注册 **5 次失败/6 小时**（同一 IP 同一 action），触顶后 `gate_until` 封禁 **1 小时**；**跨进程重启仍然生效**。库不可用时这一道的状态查询会直接失败（503），**不**降级为"不检查"。

---

## 0.7 代理信任与 `--proxy-secret-file`（冻结）

`--trust-proxy` 开了之后客户端 IP 取自 `X-Forwarded-For`（取**最后一段**）。问题在于：
nginx 就在本机，所以"对端是回环"这条判据恒真 —— **本机任何进程**都能直连
`127.0.0.1:8850` 伪造整个 XFF。后果有两层：限流可以被逐个假 IP 绕过；审计日志
记下的是攻击者自选的 IP。`lib/security.mjs::assertProxySecret` 就是为这个场景写的
（管理端一直在用），公开服务在**同一个位置**（`http.mjs::assertPublicOrigin`）复用它。

三种状态（**互斥、无中间态**）：

| 情形 | 启动 | 代理信任 | 每个请求 | 客户端 IP 取值 |
|---|---|---|---|---|
| 给了 `--proxy-secret-file`，文件存在、可读、trim 后非空且 ≥ 32 字符 | 正常 | **生效** | 必须带 `x-admin-proxy-secret` 且比对通过，否则 `403 FORBIDDEN` | XFF **最后一段** |
| 给了 `--proxy-secret-file`，但文件不存在 / 读不到 / 空 / 太短 | **拒绝启动**（`exit 7`） | — | — | — |
| 完全没给 `--proxy-secret-file` | 正常（打印醒目告警） | **强制关闭** | 不校验密钥头 | **直连对端**（XFF 一律忽略） |

* 参数名是 `--proxy-secret-file <路径>`，与既有 `--public-host` / `--public-origin` / `--trust-proxy` 同一套解析风格。
* 密钥内容只从**文件**读，不走命令行、不进环境变量、不写日志、不写横幅。
* 密钥比对**复用 `security.assertProxySecret`**（常量时间、长度不等即拒），`http.mjs` 里**没有**第二套比较实现。
* `403` 只回 `{"code":"FORBIDDEN","message":"forbidden"}`，**不说明**是哪一条判据不过（密钥 / Host / Origin / Sec-Fetch-Site 共用这一句）。
* 顺序：反代密钥 → Host 白名单 → Origin/Referer/Sec-Fetch-Site。密钥排在最前（最便宜：一次定长比较），且不合来源的请求连路由表都不该被探测。
* **为什么"给了参数就必须能用"（fail-fast）**：一条打错的路径如果静默退化成"不校验密钥但仍然信任 XFF"，等于在部署时无声地拆掉这道控制 —— 而 `systemctl restart p3-public` 一次就能把密钥链路验证掉（文件必然已由部署脚本生成）。宁可起不来。

**给域名/部署的告警文案（t17 按此核）**（完全没有给参数、且带了 `--trust-proxy` 时打印）：

```
⚠ 警告：指定了 --trust-proxy 但没有 --proxy-secret-file。
  代理信任已**强制关闭**：X-Forwarded-For 一律忽略，客户端 IP 取直连对端。
  带来的后果：所有请求（含 nginx 转发的）都会算到 127.0.0.1 这一个桶上 ——
  本机任何进程连错 10 次口令就能把全站的登录限流锁死。
  生产部署必须同时给 --proxy-secret-file（见 deploy/PLAN-PUBLIC-LOGIN.md）。
```

启动横幅里对应的那一行（三种状态各一句，`bannerLines`）：

* 生效：`代理信任   已启用（XFF 取最后一段；每个请求校验 x-admin-proxy-secret）`
* 请求了但没密钥：`代理信任   ⚠ 已请求但**强制关闭**（没有 --proxy-secret-file）：XFF 一律忽略，客户端 IP 取直连对端`
* 没请求：`代理信任   关闭（XFF 一律忽略，客户端 IP 取直连对端）`

> 审计与限流记账用的 IP 也遵守同一个信任判定（`public-server.mjs::auditIpOf`）：
> 密钥生效 → 用 XFF 最后一段；否则 → 用直连对端。**不能**无条件用直连对端：
> 反代之后那一列恒为 `127.0.0.1`，于是"同一个人连错 10 次"会变成"全世界共享
> 一个计数器"，既锁死正常用户，又让审计失去全部信息量。

---

## 1. 端点（7 个，冻结）

### 1.1 `GET /api/auth/me`

"现在是谁"。每个页面加载时问一次。

* 认证：可选（无会话不是错误）
* 查询参数：无
* 请求体：无

**成功 200**

```json
{ "ok": true, "user": null, "db": "up", "session_max_age_days": 30 }
```

```json
{ "ok": true,
  "user": { "id": 7, "username": "simon", "email": "me@example.com", "avatar": null, "role": "user",
            "created_at": "2026-02-14T09:31:07.000Z" },
  "db": "up", "session_max_age_days": 30 }
```

* **无会话 / 会话过期 → `200` + `user: null`，不是 401。** 理由：未登录是**正常状态**，每个页面都会问这个问题；回 401 会让浏览器控制台刷满红字，也会让前端把正常状态当故障。
* **数据库不可用/未配置时同样 `200` + `user: null`，而 `db` 变成 `"down"`。** 查不到会话 = 未登录，这是一个真答案；而 `db` 字段让前端能区分"没人登录"和"库挂了"（否则库挂了会显示成"你的评论不见了"）。
* `email` 只出现在这个"本人"响应里，**绝不**出现在评论的 `author` 里。
* `role` 取值 `"user"` / `"admin"`；前端用它决定是否显示"删除"（**但授权判定只在服务端**）。

### 1.2 `POST /api/auth/register`

* 认证：无
* 限流：`auth.register`（每 IP 每小时 5 次）
* 请求体：

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `username` | string | 是 | 去首尾空白后匹配 `^[A-Za-z0-9_]{3,20}$` |
| `email` | string | **是** | 去空白 + 转小写后匹配 `^[^\s@]{1,64}@<域名含点>$`，长度 ≤ 190 |
| `password` | string | 是 | 长度 **≥ 8** 且 **≤ 200**（按 UTF-16 码元计） |

* `email` **必填**：本轮 SMTP 未配置、验证码只留骨架，但邮箱必须现在就收 —— 它是唯一能证明"这个人是人"的通道，事后补字段意味着老用户全是 `NULL`。空串/缺字段一律 422。

**成功 `201`**（同时 `Set-Cookie`，即注册成功即登录）

```json
{ "ok": true,
  "user": { "id": 7, "username": "simon", "email": "me@example.com", "avatar": null, "role": "user",
            "created_at": "2026-02-14T09:31:07.000Z" } }
```

| 失败 | 状态码 | code |
|---|---|---|
| 用户名格式 | 422 | `INVALID_USERNAME` |
| 邮箱格式/缺失 | 422 | `INVALID_EMAIL` |
| 密码过短/过长/缺失 | 422 | `INVALID_PASSWORD` |
| 用户名已占用 | 409 | `USERNAME_TAKEN` |
| 邮箱已注册 | 409 | `EMAIL_TAKEN` |
| 触发限流 | 429 | `RATE_LIMITED` |
| 库不可用 | 503 | `DB_UNAVAILABLE` |

* 口令**不落日志、不回响应、不进错误文案**。哈希在数据层完成（PBKDF2-SHA256 600000 轮，见 §4）。
* **请求体校验失败（422）不计入限流**：那几个 422 既不动内存窗口的语义，也不写 `auth_throttle`
  （见 §0.6 的冻结说明）。只有走到"创建用户"且失败的调用才累加。
* **注册成功即登录**：`201` 响应同时下发会话 cookie（`Path=/api`，见 §0.5）。
  注册成功会**清零**该 IP 的注册失败计数。

### 1.3 `POST /api/auth/login`

* 认证：无
* 限流：`auth.login`（每 IP 15 分钟 10 次）
* 请求体：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `user` | string | 是 | **用户名或邮箱**。规范化：`username` / `email` / `login` 作为别名接受（读取时归一） |
| `password` | string | 是 | 长度 8–200（超界直接 422，避免用 1MiB 口令烧 PBKDF2 的 CPU） |

**成功 200**（同时 `Set-Cookie`）

```json
{ "ok": true,
  "user": { "id": 7, "username": "simon", "email": "me@example.com", "avatar": null, "role": "user",
            "created_at": "2026-02-14T09:31:07.000Z" } }
```

**失败 401**（冻结）：`{"ok":false,"error":{"code":"INVALID_CREDENTIALS","message":"用户名或密码不正确"}}`

* **用户不存在、密码错误、账号被禁用，三者响应完全相同**：同状态码、同 code、同 message，且**耗时也要对齐** —— 用户不存在时数据层必须照跑一次 PBKDF2（对固定的假盐）再返回 false。否则一个只看响应时间的攻击者照样能问出"这个用户名存在吗"。
* 登录时**必须换发新的会话 id**（防会话固定攻击），旧的登录会话不因此失效（多设备同时在线是正常需求）。

### 1.4 `POST /api/auth/logout`

* 认证：无（**刻意如此**）
* 限流：`auth.logout`（每 IP 每分钟 30 次）
* 请求体：空 `{}` 或省略

**成功 200**（同时发清 cookie 的 `Set-Cookie`）

```json
{ "ok": true, "destroyed": true }
```

* 带 cookie → 删库里的会话行（`destroyed: true`）；不带 cookie 或会话已过期 → 仍回 `200`，`destroyed: false`。**绝不**因为"没登录"就 401：那样会话过期后用户会卡在"退不出去"的状态里。
* 库不可用时：cookie 一定清（这是用户明确表达的意图），但要记一条 `warn` 日志，让"会话还在库里活着"这件事有痕迹。

### 1.5 `GET /api/comments?slug=<slug>`

* 认证：可选（未登录**可读**）
* 查询参数：`slug`（必填，去空白后 ≤ 200，不得含控制字符或空白）
* 限流：无

**成功 200**

```json
{ "ok": true,
  "comments": [
    { "id": 12, "parent_id": null, "content": "写得清楚", "created_at": "2026-02-14T09:31:07.000Z",
      "author": { "id": 7, "username": "simon", "avatar": null } },
    { "id": 13, "parent_id": 12, "content": "+1", "created_at": "2026-02-14T09:32:00.000Z",
      "author": { "id": 9, "username": "guest", "avatar": null } }
  ] }
```

* 只返回 `status='approved'`（软删的 `deleted`、待审的 `pending` 都不返回）。
* 排序：`created_at` **升序**；`created_at` 相同时按 `id` 升序（同一秒内多条必须有确定顺序，否则前端每次刷新顺序都可能变）。
* 每条必带 `author.id`（前端据此判断"这是不是我发的"）与 `parent_id`（一级回复）。
* **绝不**返回：`password_hash`、`password_algo`、`email`、`user_id`（只给 `author.id`）、`status`、`ip`、`ua`。实现方式是在 `http.mjs` 用 `publicComment()` **白名单**构造，而不是"记得删掉敏感列"。
* 库不可用：`503 DB_UNAVAILABLE`（**不是**空数组 —— 回空数组等于告诉用户"你的评论被删了"）。

### 1.6 `POST /api/comments`

* 认证：**必需**（未登录 → `401 UNAUTHENTICATED`）
* 限流：`comment.create`（每用户 10 分钟 20 次）
* 请求体：

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `slug` | string | 是 | 同 1.5 |
| `content` | string | 是 | **去首尾空白后** 1–2000 字符（按 UTF-16 码元计） |
| `parent_id` | number \| string \| null | 否 | 缺省/空 → `null`；给了必须是正整数 |

**成功 201**

```json
{ "ok": true,
  "comment": { "id": 14, "parent_id": 12, "content": "同意", "created_at": "2026-02-14T09:33:00.000Z",
               "author": { "id": 7, "username": "simon", "avatar": null } } }
```

| 失败 | 状态码 | code |
|---|---|---|
| 未登录 | 401 | `UNAUTHENTICATED` |
| 内容空/超长 | 422 | `INVALID_CONTENT` |
| slug 缺失/非法 | 422 | `INVALID_SLUG` |
| `parent_id` 非法 | 422 | `INVALID_PARENT` |
| 触顶 | 429 | `RATE_LIMITED` |
| 库不可用 | 503 | `DB_UNAVAILABLE` |

* `parent_id` 指向的评论**必须**存在、`status='approved'`、且 `slug` 与本次请求一致（禁止把回复挂到别人文章下的评论上）。不满足 → `422 INVALID_PARENT`。**这条判定必须在数据层用 SQL 做，不能只信前端传值。**
* 内容一律按纯文本存储；前端必须用 `textContent` 渲染，**禁止** `innerHTML` 拼接。后端只做长度限制，不做 HTML 转义（转义是渲染层的事，两层都做会导致 `&lt;` 双重转义）。

### 1.7 `DELETE /api/comments/:id`

* 认证：**必需**
* 限流：`comment.delete`（每用户 10 分钟 20 次）
* 路径参数：`id`（正整数；非正整数 → `404 NOT_FOUND`）

**成功 200**

```json
{ "ok": true, "deleted": 14 }
```

| 情形 | 状态码 | code |
|---|---|---|
| 未登录 | 401 | `UNAUTHENTICATED` |
| 评论不存在 / 已软删 / id 非正整数 | 404 | `NOT_FOUND` |
| 评论存在但既不是本人、`role` 也不是 `admin` | **403** | `FORBIDDEN` |
| 本人或 admin | 200 | — |

* **软删**：`UPDATE comments SET status='deleted'`，不做物理删除（保留审计与回复链）。软删后 `GET /api/comments` **不再返回**该条。
* 授权判定的两个输入（`comments.user_id` 与当前用户的 `role`）**都来自服务端**，绝不接受请求体里的 `user_id` / `role`。前端隐藏按钮只是体验，不是控制。
* 允许 admin 删别人的评论（后台治理需要）；`403` 与 `404` 的区别是刻意的：前者说"这条你不能动"，后者说"这条不存在"。

---

## 2. 端点之外的补充

### 2.1 `GET /api/comments/mine`

* 认证：**必需**（未登录 → 401）
* 用途：右上角登录下拉的「我的评论」。缺了它前端就得把全站评论拉下来自己筛。
* **成功 200**

```json
{ "ok": true,
  "comments": [
    { "id": 14, "slug": "mysql-57-notes", "parent_id": 12, "content": "同意",
      "created_at": "2026-02-14T09:33:00.000Z",
      "author": { "id": 7, "username": "simon", "avatar": null } }
  ] }
```

* 形状 = 1.5 的每条 + `slug`。按 `created_at` **降序**（最近的在最上），上限 200 条。
* 只返回自己的、`status='approved'` 的评论。
* 路由优先级：`/api/comments/mine`（静态段权重高）优先于 `/api/comments/:id`，由 `http.mjs::findRoute` 保证，不依赖注册顺序。

### 2.2 `OPTIONS <任意 /api/ 路径>`

`204` + `Allow: <该方法集合>`。不发 CORS 头。

### 2.3 其它

* 未知路径 → `404 NOT_FOUND`；路径存在但方法不对 → `405 METHOD_NOT_ALLOWED`。
* 请求体 > 1 MiB → `413 BODY_TOO_LARGE` 并销毁连接（边读边判，不先攒进内存）。
* 路径里带 `..` / 编码穿越没有意义（本服务不提供任何文件服务；唯一可能被当作路径的是 `:id`，它必须匹配 `^[1-9][0-9]{0,18}$`）。

---

## 3. 安全边界（为什么公开服务里**找不到**管理面的东西）

| 项 | 公开服务（8849→8850？不是，见右） | 管理服务 |
|---|---|---|
| 端口 | 回环 `8850` | 回环 `8849` |
| 入口 | 由 nginx 反代收口（`/api/auth/*`、`/api/comments*`） | 只本机 / 隧道 |
| 存储 | MySQL `p3blog`（`p3app` 账号，仅 DML） | 文件（`js/posts.js`）+ 运行时目录 |
| 认证 | 站点用户账号（PBKDF2，落 MySQL） | 管理员口令（PBKDF2，落本机文件） |
| 代码 | `server/public-server.mjs` + `server/lib/public/**` | `server/dev-server.mjs` + `lib/auth.mjs` + `lib/posts-store.mjs` |

* 公开服务**绝不** import `dev-server.mjs` / `lib/auth.mjs` / `lib/posts-store.mjs`，**绝不**读取管理面运行时目录下的任何文件。
  *为什么是硬边界而不是"小心一点"*：一旦公开进程的地址空间里存在管理员口令哈希与文章存储路径，公网面上任何一个文件读漏洞都会同时拿走这两样。所以是**物理隔离**——靠"这个进程里根本没有那些路径"来保证，而不是靠"我们不读它"。
* 校验方式（可被 grep / 被 t17 复核）：
  ```
  grep -nE "dev-server|lib/auth\.mjs|posts-store|passphrase|session\.json" blog-enter/server/public-server.mjs blog-enter/server/lib/public/*.mjs
  ```
  期望只命中注释里"我们**不**引用它们"这一类说明。
* 库账号 `p3app` 只有 `SELECT/INSERT/UPDATE/DELETE`（无 DDL / GRANT / FILE），库只监听 `127.0.0.1`。

---

## 4. 数据层接口（t14 按此实现）

HTTP 层不认识 SQL，只认识这组方法。**所有 SQL 必须用参数化占位符 `?`**，任何字符串拼接都是 blocker。

| 方法 | 入参 | 返回 |
|---|---|---|
| `resolveSession(token)` | cookie 里的**原始令牌** | `{ user, sessionId, expiresAt } \| null`（内部先 `sha256(token)` 再按主键查；查到则**显式** `UPDATE last_seen`） |
| `createSession(user, {ip,ua})` | 用户行 | `{ id, expiresAt } \| null`。`id` 是**原始令牌**（`randomBytes(32).toString('hex')`，64 字符），由 HTTP 层放进 cookie |
| `destroySession(token)` | 原始令牌 | `boolean`（`DELETE FROM sessions WHERE id=?`，参数是摘要） |
| `findUserByLogin(kind, value)` | `'username' \| 'email'` | 含 `password_hash`/`password_algo`/`status`/`role` 的用户行 \| null |
| `checkPassword(plain, userRow)` | 明文 + 用户行或 `null` | `boolean`。`userRow` 为 `null`/禁用时**也必须照跑一次 PBKDF2**（假盐）再返回 false —— 这是"不泄露账号是否存在"的耗时对齐 |
| `createUser({username,email,password,ip,ua})` | 明文口令 | `{ user }`；内部做 PBKDF2-SHA256（**600000 轮**、16 字节随机盐）；唯一键冲突抛 `USERNAME_TAKEN` / `EMAIL_TAKEN` |
| `listComments(slug)` | slug | 行[]（`WHERE slug=? AND status='approved' ORDER BY created_at ASC, id ASC LIMIT 500`，带 `user_id/username/avatar/parent_id/created_at`） |
| `listCommentsByUser(userId)` | 用户 id | 行[]（同上 + `slug`，`ORDER BY created_at DESC LIMIT 200`） |
| `createComment({slug,userId,parentId,content})` | — | 插入行；`parent_id` 校验（存在 + approved + 同 slug）失败抛 `INVALID_PARENT` |
| `commentForDelete(id)` | 评论 id | 含 `user_id`/`status`/`slug` 的行 \| null |
| `markCommentDeleted(id,{byUserId,byRole})` | — | `boolean`（`UPDATE comments SET status='deleted' WHERE id=?`，参数化） |

### 4.0 会话令牌的存储语义（**以 `sql/schema.sql` 为准**，冻结）

`sessions.id CHAR(64)` 存的是**令牌的 SHA-256 十六进制摘要**，不是原始令牌：

1. 登录/注册成功 → 生成原始令牌 `token = randomBytes(32).toString('hex')`（64 字符）；
2. `tokenHash = sha256(token)`（64 字符十六进制）→ **摘要写进 `sessions.id`**；
3. `Set-Cookie: p3_uid=<原始令牌>`（客户端拿到的是令牌本身）；
4. 每次请求：对 cookie 值做同样的 `sha256`，再用摘要按主键等值查 `sessions`。

*为什么*：库被拖走也无法直接拿去冒用会话（攻击者拿到的是摘要，而摘要不是有效 cookie）。代价是失去"按令牌反查"的能力，而我们不需要。
**不要**同时存原始令牌与摘要，**不要**为此加列。`email_verify.token` 是同一套思路（只落摘要）。

> HTTP 层对此完全无感：它只把 cookie 值原样交给 `resolveSession` / `destroySession`，把 `createSession` 返回的 `id` 原样放进 cookie。摘要在数据层内部完成 —— 边界就画在这里。

### 4.0.1 与 schema 对齐的其它硬性点

* `expires_at` 是 **DATETIME**（不是 TIMESTAMP）：写入与比较都用应用侧算好的时间，别指望 MySQL 帮你按连接时区换算；过期判断用 `WHERE expires_at > ?` 显式传参。
* `sessions.last_seen` **没有** `ON UPDATE`：要滑动续期就必须显式 `UPDATE sessions SET last_seen=NOW() WHERE id=?`，不要以为它自己会变。
* `users.username` / `email` 在 `utf8mb4_unicode_ci` 下**大小写不敏感**：「Alice」与「alice」是同一个账号，第二个注册会被唯一键拒绝 → 必须翻译成 `409 USERNAME_TAKEN` / `EMAIL_TAKEN`，**不得**报 500。登录查询天然不区分大小写，不要手工 `LOWER()`（那会让唯一索引失效）。
* `auth_throttle` 用**一条** `INSERT ... ON DUPLICATE KEY UPDATE` 原子累加 `(ip, action)`；不要"先 SELECT 再 UPDATE"（并发下会丢计数）。
* 限流用的 IP 一律取**直连 socket 对端**（`socket.remoteAddress`）；`--trust-proxy` 未开时**不**看 `X-Forwarded-For`（该头可伪造，等于把限流的键交给攻击者选）。
* 口令存储格式：`pbkdf2-sha256$<iterations>$<salt_b64>$<key_b64>`，配合列 `password_hash VARCHAR(255)`、`password_algo VARCHAR(32)`。
  **自描述串是刻意的**：轮数与算法随每一行记录走，所以"提高轮数"**不需要数据迁移**。
* **当前轮数 600000（审计 S5 加严，原 210000）**，`passwords.mjs` 的 `ITERATIONS`。
  本机实测（Node v24 单线程）：210000 ≈ 40ms、**600000 ≈ 108–113ms**、900000 ≈ 160ms、
  1200000 ≈ 225ms；取 600000 既满足 OWASP 对 PBKDF2-HMAC-SHA256 的建议下限，
  也为服务器上"单次校验 <300ms"的目标留了余量。
* **灰度升级（同一处改动的一部分）**：
  1. **旧格式（`210000`）的哈希仍可正常校验** —— 校验按**记录里的**轮数派生，不是按当前常量；
  2. 校验**通过**之后调 `needsRehash()`：轮数低于当前值 / 算法变了 → 用**同一份明文**
     重算一次并 `UPDATE users SET password_hash=?, password_algo=? WHERE id=?`（`rehashPassword`）；
  3. 回写失败**不影响**本次登录（用户已经证明是本人，升级是我们的事，下次再试）；
  4. 轮数**高于**当前值的记录不动它（可能是有意加强过的账号，降回去是倒退）。
* 口令校验用 `timingSafeEqual`；任何响应体与日志都**不含**明文口令或哈希。
* 表结构以 `blog-enter/server/sql/schema.sql`（t11）为准。

### 4.0.2 评论排序：为什么契约是**升序**

`GET /api/comments` 定的是 `created_at` **升序**，这**不是**在跟 schema 的复合索引对着干：

* `idx_comments_slug_status_created (slug, status, created_at)` 是 B-tree，`ORDER BY created_at ASC` 同样走索引、同样没有 filesort —— InnoDB 支持反向扫描，"DESC 用到索引"并不排斥 "ASC 用到索引"，两者代价相同。真出现 `Using filesort` 时要查的是 `status` 是否被写成了非等值条件，而不是排序方向。
* 升序是**渲染正确性**的要求：前端按 `parent_id` 分层渲染，父评论必须先于它的回复出现。倒序时最新回复会排到父评论之前，渲染成"回复孤零零挂在顶部"。
* 另外加了 `LIMIT 500`：防止十万条评论的热门文章把整表拉给浏览器。

`GET /api/comments/mine` 相反用**降序**：那是"我最近说了什么"的列表，最新在前才符合预期，而且没有分层渲染问题。

### 4.1 服务接口的注入方式

`public-server.mjs::createPublicApp({ stores })` 接受注入；不注入时尝试载入 `lib/public/store.mjs` 的 `createStores({env})`。

* 有 `P3_DB_HOST/P3_DB_NAME/P3_DB_USER/P3_DB_PASSWORD` 且模块可载入 → 真库模式（`mode: 'mysql'`）。
* 否则 → **骨架模式**（`mode: 'skeleton'`）：`/api/auth/me` 仍回 `200` + `user:null` + `db:"down"`；需要数据的端点（register / login / comments / mine / delete）回 `503 DB_UNAVAILABLE`；`logout` 仍回 `200`（清 cookie 不需要库）；进程**不崩**、不打印任何凭据。
* **绝不**回退到空口令、回退到 `root`、或回退到管理面文件存储。返回假数据（例如"登录永远成功"）是公开面上最危险的一类临时实现。

---

## 5. CLI（冻结的行为）

```
node blog-enter/server/public-server.mjs [选项]

--listen <addr>         默认 127.0.0.1；只接受 127.0.0.1 / ::1 / localhost，其它一律拒绝启动（exit 4）
--port <n>              默认 8850
--public-host <name>    可重复；追加 Host 白名单（回环名永远在）
--public-origin <o>     可重复；Origin 精确白名单；https:// → cookie 带 Secure
--trust-proxy           声明"请求必经我们的 nginx"（XFF 取最后一段）；**必须**配 --proxy-secret-file 才生效
--proxy-secret-file <f> 反代共享密钥文件；缺/空/太短 → 拒绝启动（exit 7）；见 §0.7
--allow-degraded        本机没有 MySQL 时显式降级到骨架模式（只有 /api/auth/me 可用）
--print-config          打印 JSON 配置（含路由表、错误码、限流阈值、代理信任状态）后退出，不起服务
```

> **没有** `--comments-hold-for-review` 这个参数：评论审核（S9）本轮不做，
> 新评论一律由 schema 默认写成 `status='approved'`。任何"先审后发"的实现都是新工作，
> 必须先改 schema 的写入路径、`listComments`/`listCommentsByUser` 的过滤条件与管理端入口，
> 并同步本节与 §1.5/§1.6/§2.1 —— 不要用"加个开关但默认关"的方式悄悄带进来。

* 环境变量：`P3_LISTEN` / `P3_PORT` / `P3_DB_HOST` / `P3_DB_PORT` / `P3_DB_NAME` / `P3_DB_USER` / `P3_DB_PASSWORD` / `P3_SESSION_MAX_AGE_DAYS`。
* 启动横幅不打印任何口令、cookie 值、会话 id、密钥内容。
* `SIGINT` / `SIGTERM` → 先关监听、再关连接池后退出（1.5 秒兜底）。
* 退出码：`4` 监听地址非法 · `5` 端口占用 · `6` 数据库配置缺失/不可用 · `7` 代理密钥文件不可用。

### 5.1 依赖清单位置（**必须**在 `server/` 下）

`blog-enter/server/package.json` + `blog-enter/server/package-lock.json`，`npm install` 也必须在
`blog-enter/server/` 下执行（`node_modules` 落在 `blog-enter/server/node_modules/`）。

*为什么不能放在 `blog-enter/` 顶层*：`deploy/bin/blog-publish.sh` 的 rsync 排除清单里只有
`server/`、`admin/`、`tests/`、`api/`、`*.md` —— 顶层的 `package.json` **不在**排除名单里，
会被同步到站点根目录，于是 `http://43.108.100.116/package.json` 可读，等于把后端依赖清单
与运行时信息挂了出去；而且现有发布自检的禁止清单（`admin _admin server tests api .env .git .admin`
+ 顶层 `*.mjs/*.cjs`）也抓不到它。放进 `server/` 是**结构性**解决：该目录本来就被排除，
将来再加任何后端文件都自动安全，不需要每加一个文件就去改发布脚本。

* `systemd` 单元不用改：`WorkingDirectory` 是仓库根，`ExecStart` 用绝对路径执行
  `…/blog-enter/server/public-server.mjs`，Node 从**脚本所在目录**向上解析模块，命中
  `server/node_modules/`。
* `.gitignore` 的 `node_modules/`（无前缀斜杠）对 `blog-enter/server/node_modules/` 同样生效。
* t18 发布后 `--delete` 会自动清掉线上残留的 `/package.json`（它是"多发出去的文件"，
  不是被 `-s` 排除保护的文件，所以删得掉）。

---

## 6. 验收清单（t16 可逐条打）

| # | 判据 | 怎么验 |
|---|---|---|
| 1 | 7 个端点（+ §2.1 的 `mine`）的路径/方法/字段/状态码/错误码与本文件一致 | 逐条 curl，比对 §1 与 §2.1 |
| 2 | 服务能被 `node` 直接启动并监听 `127.0.0.1:8850` | `node … public-server.mjs --print-config`；启动后 `Get-NetTCPConnection -LocalPort 8850` |
| 3 | 无数据库时 `/api/auth/me` → `200` + `user: null`；需要数据的端点 → 结构化 503 而非崩溃 | 无 `P3_DB_*` 启动后逐个打；`logout` 例外，它回 `200`（清 cookie 不需要库） |
| 4 | 失败形状恒为 `{ok:false,error:{code,message}}` | 对每个失败分支断言顶层键集合 == `['ok','error']` |
| 5 | cookie 属性 | `Set-Cookie` 必须含 `p3_uid=`、`**Path=/api**`、`HttpOnly`、`SameSite=Lax`、`Max-Age=2592000`；`--public-origin https://…` 时含 `Secure` |
| 6 | 限流阈值 | 连续 11 次错误登录 → 第 11 次 `429` + `Retry-After` |
| 7 | 登录失败文案不可区分 | 不存在的用户 vs 存在的用户 + 错密码：状态码/`code`/`message` 完全相同 |
| 8 | 评论列表不泄露 | 响应里全文不含 `password_hash` / `password_algo` / `email` / `user_id` |
| 9 | 越权 | A 删 B 的评论 → `403` 且 B 的评论仍在；未登录删 → `401` |
| 10 | SQL 参数化 | `grep -nE "\+ *[a-zA-Z_]+ *\+|\\$\\{" blog-enter/server/lib/public/*.mjs` 在 SQL 上下文里无命中 |
| 11 | 隔离边界 | 公开服务代码里搜不到 `dev-server` / `lib/auth.mjs` / `posts-store` / `.admin/` / `passphrase` 的**实际使用** |
| 12 | Node v22 与 v24 都能加载 | 服务器 Node v22 上启动 + 本机 v24 `node --check` |
| 13 | 依赖清单不在发布面 | `deploy/bin/blog-publish.sh` 的 rsync 排除 `server/`，故 `blog-enter/server/package.json` 不出现在站点根；发布后 `http://43.108.100.116/package.json` 必须 404 |
| 14 | 代理密钥三态 | 无密钥 + `--trust-proxy` → 伪造 XFF 不被采纳（生效 IP 为直连对端）；有密钥但头不对 → `403`；`--proxy-secret-file` 指向不存在的路径 → 非 0 退出且 stderr 含该路径 |
| 15 | 缺配置拒绝启动 | 无 `P3_DB_*` 且不带 `--allow-degraded` → 非 0 退出，stderr 列出缺哪些变量名；**不**回退默认口令或 root |

---

## 7. 变更记录

| 日期 | 改动 | 原因 |
|---|---|---|
| t10 | 冻结初版：7 端点 + `/api/comments/mine` + 错误码表 + 限流阈值 + cookie 属性 | t10 交货物 |
| t10（t11 之后） | §4 对齐 `sql/schema.sql`：`sessions.id` = 令牌的 SHA-256 摘要、`expires_at` 是 DATETIME、`last_seen` 无 `ON UPDATE`、用户名/邮箱大小写不敏感、`auth_throttle` 单条 upsert、IP 取直连对端；§4.0.2 说明评论升序与索引的关系 | t11 的 DDL 已冻结列名与语义，契约的**数据层**部分必须与它一致（响应形状不变） |
| t10（t12 交互） | 新增 §2.1 `GET /api/comments/mine`；明确 `register` 的 `email` 必填、登录 `user` 字段接受 `username`/`email`/`login` 别名、**不需要** CSRF token | 前端（t12）需要「我的评论」列表并已按此实现；邮箱是找回口令与验证码的唯一通道，事后补字段等于老用户全为 NULL |
| t14 | 新增 §0.7「代理信任与 `--proxy-secret-file`」三态与告警文案；§0.6 补"两道限流闸"与库内 `auth_throttle` 阈值；§5 补依赖清单位置；§6 补验收项 13–15 | t14 把数据层接上 MySQL 并落实代理密钥校验（fail-fast）；`package.json` 曾被发布会同步到站点根目录，必须移进已被发布排除的 `server/` |
| t21（repair r2） | **§0.5 `Path` `/` → `/api`**（含变更影响与旧 cookie 说明）；**§4.0 轮数 210000 → 600000** + 灰度升级四步；**§0.6/§1.2 注册阈值写死 5 次/小时 + 封禁 1 小时 + 「校验失败不计入落库计数」**；§5 明确**没有** `--comments-hold-for-review`；§6 验收项 5 改 `Path=/api` | 审计 S2（会话 cookie 不能交给同源第三方应用）、S5（轮数低于建议值）、S6（413 拿不到）；S4 与 S9 经业主决定**本轮不修、只留风险记录**，故契约里必须把"恒为 5 次/只计失败""没有审核开关"钉住，避免下一轮再漂 |
