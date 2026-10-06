# comments/ —— 评论系统的客户端资源（第三方文件，自托管）

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
只监听 `127.0.0.1:8360`，由 nginx 的 `/comments/api/` 反代出去。
数据在 `/srv/waline/data/waline.sqlite`（**不在仓库里**）。

## 怎么更新

```powershell
# 版本号按需改；unpkg 只是下载源，站点本身不依赖它
curl.exe -sSL -o blog-enter/comments/waline.js       https://unpkg.com/@waline/client@3.16.0/dist/waline.js
curl.exe -sSL -o blog-enter/comments/waline.css      https://unpkg.com/@waline/client@3.16.0/dist/waline.css
curl.exe -sSL -o blog-enter/comments/waline-admin.js https://unpkg.com/@waline/admin@0.36.0/dist/admin.js
```

改完把上表的版本号一起改掉，然后照常发布（`blog-publish`）。

## 表情包：现在是关掉的（有原因）

Waline 客户端的表情选项卡默认会去 `https://unpkg.com/@waline/emojis@1.1.0/...` 拉数据。
这不是猜的：`verify-comments-live.mjs` 在真浏览器里跑的时候，网络面板里就有这条外部请求。
本站的定位是"零外部运行时依赖"，所以 `article.html` 里写的是 `emoji: false`。

要开就得连表情包一起自托管：把 `@waline/emojis` 里那一套（`<set>/info.json`
加上每个表情一个 png）下载到 `blog-enter/comments/emojis/`，再把 `emoji: false` 换成
指向该目录的路径（写法见 <https://waline.js.org/guide/features/emoji.html>）。
代价是仓库里多出上百个二进制小文件 —— 值不值，你自己权衡。

## 两条纪律

1. **`waline-admin.js` 的路径写在服务器环境变量里**（`WALINE_ADMIN_MODULE_ASSET_URL`，
   值是 `/comments/waline-admin.js`）。改文件名就要同步改 `/etc/p3blog/waline.env`，
   否则 `/comments/ui/` 后台会加载不出来。
2. **nginx 不能把整段 `/comments/` 反代给 Waline**，只反代 `/comments/api/` 与
   `/comments/ui/`。整段反代的话，这三个静态文件会被送到 Waline 那里，结果是 404
   （Waline 只认 `/`、`/ui/`、`/api/`）。规则在
   `/www/server/panel/vhost/rewrite/43.108.100.116.conf` 的 `P3_comments` 段。

> `*.md` 在发布时被排除（`blog-publish.sh` 的 `--filter='-s *.md'`），
> 所以这份说明不会被发到线上。
