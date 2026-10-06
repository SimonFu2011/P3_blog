# comments-assets/ —— 评论系统的客户端资源（第三方文件，自托管）

> **⚠️ 现状（本轮之后）：这个目录里的文件已经不再被任何页面引用。**
> 站点评论换成了自建组件（`js/comments.js` + `css/comments.css` + 右上角的
> `js/auth-ui.js`），数据走公开服务的 `/api/comments`，落到 MySQL。
> 三个文件仍然留在磁盘上，是**有意的**，理由与回滚办法见下面
> 「本轮之后：为什么留着、怎么回滚」一节。

这三个文件不是本项目写的，是从 npm 上原样取下来的 **Waline 客户端与后台**。
放进来是为了**不依赖 unpkg**：本站的定位是"没有任何第三方运行时依赖"，
而 unpkg 在国内不稳定 —— 更麻烦的是，它挂了的话评论区是**运行时**才一片空白，
本地根本测不出来。

| 文件 | 来源 | 版本 | 许可 |
| --- | --- | --- | --- |
| `waline.js` | `@waline/client` 的 `dist/waline.js`（ESM，完整版） | 3.16.0 | MIT |
| `waline.css` | `@waline/client` 的 `dist/waline.css` | 3.16.0 | MIT |
| `waline-admin.js` | `@waline/admin` 的 `dist/admin.js`（后台 UI，单个 bundle） | 0.36.0 | MIT |

服务端不在这里：它是 `@waline/vercel`（服务器上的 `/srv/waline/app`），
只监听 `127.0.0.1:8360`，由 nginx 的 `/comments/` 反代出去。
数据在 `/srv/waline/data/waline.sqlite`（**不在仓库里**）。

## 本轮之后：为什么留着、怎么回滚

### 现状

| 项 | 本轮之前 | 现在 |
| --- | --- | --- |
| 客户端 | `comments-assets/waline.js` + `waline.css`（自托管） | `js/comments.js` + `css/comments.css`（本站自己写的，零依赖） |
| 服务端 | Waline（`127.0.0.1:8360`） | `server/public-server.mjs`（`127.0.0.1:8850`，nginx 反代 `/api/`） |
| 存储 | `/srv/waline/data/waline.sqlite` | MySQL `p3blog`（`users` / `sessions` / `comments`，外键关联） |
| 登录 | `login: 'disable'`（游客留昵称+邮箱即可发） | 站点账号，`/api/auth/*`，右上角同一枚登录入口 |
| 资源引用 | `article.html` 里 `import('./comments-assets/waline.js')` | **没有任何页面引用本目录的文件**（可 grep 复核） |

复核命令（期望：只命中本 README 与历史提交记录）：

```powershell
Select-String -Path blog-enter\*.html,blog-enter\js\*.js,blog-enter\css\*.css -Pattern 'waline'
```

### 为什么文件不删

1. **删除不是本轮的目的，且不可逆。** 本轮的验收判据是"页面不再加载/初始化
   它"，不是"仓库里不许存在这个文件"。少一个文件并不会让线上更安全，
   却会让回滚多一步"重新下载"。
2. **回滚窗口。** 换评论系统是站内第一次把"外部服务"换成"自己的服务 +
   自己的库"。真出问题时，最省事的回滚是恢复 `article.html` 里那一段引用，
   而那时磁盘上的两个文件还在，回滚不需要联网、不需要重新对齐版本号。
3. **`waline-admin.js` 的 URL 写在服务器环境变量里**
   （`WALINE_ADMIN_MODULE_ASSET_URL`，见下面「一条纪律」）。只要那台机器上
   还有旧服务在跑、或用旧后台查历史数据，这个文件就仍然需要能被静态规则
   命中 —— 仓库里删掉它，等于给线上留一个静默 404。

等确认不再需要回滚（建议观察一个发布周期），由运维一次性删除本目录即可；
**注意**：删之前先确认旧的 Waline 服务已停、`waline.env` 里的
`WALINE_ADMIN_MODULE_ASSET_URL` 也已撤掉，否则旧后台页面会加载不出自己的 UI。

### 怎么回滚

回滚是"恢复被改掉的那几行"，不是删新代码（新文件是纯增量，留着不影响）：

```powershell
# 0) 先看这一段的改动历史，挑出上一版提交
git log --oneline -n 5 -- blog-enter/article.html blog-enter/server/tests/verify-comments-live.mjs

# 1) 文章页：把评论区那一段（<link>/<script>/模块脚本）整体恢复成 Waline 版
git checkout <改动前的提交> -- blog-enter/article.html

# 2) 对应的浏览器验签脚本也恢复（它同时在验旧评论系统的资源与接口）
git checkout <改动前的提交> -- blog-enter/server/tests/verify-comments-live.mjs

# 3) 另外四个页面（index/archive/about/404）只是**新增**了右上角登录入口，
#    它们与评论系统无关；要一起退掉就把 .auth-entry 那段标记与
#    js/auth-ui.js 的 <script> 行删掉即可（不影响正文与导航）。

# 4) 服务器侧：旧的 Waline 服务（127.0.0.1:8360）与 nginx 的 /comments/ 反代
#    必须还在，否则评论区会空白。本轮不动它们 —— 别在回滚时才发现服务已经停了。
```

回滚后请照旧跑一次浏览器验签（`verify-comments-live.mjs` 的旧版本），
它会检查自托管的 `waline.*` 是否真的被加载、以及 `/comments/api/` 是否被请求 ——
只看"页面上有评论区"是不够的：资源 404 时那种失败是静默的。

## 为什么目录名不是 `comments/`

nginx 里 `location ^~ /comments/` **整段**反代给 Waline（接口 `/comments/api/`、
后台 `/comments/ui/`、邮件验证链接 `/comments/verification`，都是 Waline 自己
注册的路由，逐一列举迟早会漏）。静态资源要是放在 `/comments/` 下，会被一起
转给 Waline，然后 404 —— 所以它们单独放在 `/comments-assets/`，
由站点自己的静态规则提供。

## 怎么更新

> 只有在你打算**回滚**到 Waline 客户端时才需要做这一步 —— 现在站点已经不再
> 加载它（见上面的「本轮之后」）。

```powershell
# 版本号按需改；unpkg 只是下载源，站点本身不依赖它
curl.exe -sSL -o blog-enter/comments-assets/waline.js       https://unpkg.com/@waline/client@3.16.0/dist/waline.js
curl.exe -sSL -o blog-enter/comments-assets/waline.css      https://unpkg.com/@waline/client@3.16.0/dist/waline.css
curl.exe -sSL -o blog-enter/comments-assets/waline-admin.js https://unpkg.com/@waline/admin@0.36.0/dist/admin.js
```

改完把上表的版本号一起改掉，然后照常发布（`blog-publish`）。

## 一条纪律

**`waline-admin.js` 的 URL 写在服务器环境变量里**
（`WALINE_ADMIN_MODULE_ASSET_URL`，值是**绝对地址**
`http://43.108.100.116/comments-assets/waline-admin.js`）。
必须是绝对地址，因为评论后台（`/comments/ui/`）只能经 SSH 隧道从
`127.0.0.1:8360` 打开 —— 那种情况下相对路径会解析到 Waline 自己身上（404），
而管理端 API 与页面都留在本机（走公网明文传口令是不可接受的）。

改文件名或部署到新域名，都要同步改 `/etc/p3blog/waline.env` 再重启服务。

## 表情包：现在是关掉的（有原因）

> 这一节描述的是**旧的 Waline 客户端**的行为，保留下来是为了回滚时不用重新
> 查一遍；当前的自建评论组件没有表情功能，也就不存在外部请求。

Waline 客户端的表情选项卡默认会去 `https://unpkg.com/@waline/emojis@1.1.0/...` 拉数据。
这不是猜的：`verify-comments-live.mjs` 在真浏览器里跑的时候，网络面板里就有这条外部请求。
本站的定位是"零外部运行时依赖"，所以 `article.html` 里写的是 `emoji: false`。

要开就得连表情包一起自托管：把 `@waline/emojis` 里那一套（`<set>/info.json`
加上每个表情一个 png）下载到 `blog-enter/comments-assets/emojis/`，再把 `emoji: false`
换成指向该目录的路径（写法见 <https://waline.js.org/guide/features/emoji.html>）。
代价是仓库里多出上百个二进制小文件 —— 值不值，你自己权衡。

> `*.md` 在发布时被排除（`blog-publish.sh` 的 `--filter='-s *.md'`），
> 所以这份说明不会被发到线上。
