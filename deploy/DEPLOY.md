# 部署到云服务器（静态站点 + 本地写作）

> **用宝塔面板？**
> 请看 [`deploy/DEPLOY-BT.md`](DEPLOY-BT.md) —— 宝塔自带的 nginx 与本文第 1 节的
> `apt-get install nginx` 会互相冲突，两套步骤不能混着用。

这份文档描述**现在这个仓库**怎么落到云服务器上。所有命令都按 Debian/Ubuntu +
nginx 写；CentOS / 宝塔面板的差异在文末单列。

---

## 0. 先看结论：架构只有两段

```
你的 Windows 机器                     云服务器
┌──────────────────────────┐          ┌───────────────────────────┐
│ blog-enter/server/       │          │ nginx（只做静态文件）      │
│   dev-server.mjs         │          │   root /var/www/blog      │
│   127.0.0.1:8848/_admin/ │          │                           │
│        ↓ 写                │          │        ↑ rsync            │
│ blog-enter/js/posts.js   │          │ /srv/blog/repo（git 镜像） │
│ blog-enter/img/uploads/  │          │        ↑ git pull         │
│        ↓ git push        │──GitHub──│                           │
└──────────────────────────┘          └───────────────────────────┘
```

三句话概括：

1. **服务器上不需要 Node.js**。公开站点是纯 HTML/CSS/JS，没有任何 `/api/*`
   调用（`admin/admin.js` 里的 fetch 只服务于本地管理页）。
2. **`admin/` 和 `server/` 永远不上服务器**。管理端硬编码只绑 `127.0.0.1`，
   它的安全边界是"本机文件系统 + git 权限"（见 `blog-enter/ADMIN.md` 第 3 节）。
   发布脚本和 nginx 各排一遍，是双保险。
3. **发布 = `git push` → 服务器 `git pull` + rsync**。文章、图片都是仓库内容，
   所以"写文章"和"发布"是同一件事。

---

## 1. 服务器上要做的（一次性，约 5 分钟）

需要准备：

| 项 | 示例 | 说明 |
| --- | --- | --- |
| 域名 | `blog.example.com` | 一条 A 记录指向服务器公网 IP |
| 部署用户 | `blog` | 普通用户，不给你 root 之外的东西 |
| 仓库地址 | `https://github.com/SimonFu2011/P3_blog.git` | 本仓库的 origin |
| 邮箱 | `you@example.com` | 只有要签 Let's Encrypt 证书时才用 |

### 1.1 克隆 + 跑引导脚本

SSH 上服务器，用 root 执行：

```bash
# 1) 放代码（这一份就是服务器上的"发布源"）
sudo mkdir -p /srv/blog
sudo git clone https://github.com/SimonFu2011/P3_blog.git /srv/blog/repo

# 2) 装 nginx、建用户和目录、发布一次
sudo DOMAIN=blog.example.com \
     LETSENCRYPT_EMAIL=you@example.com \
     bash /srv/blog/repo/deploy/bin/blog-bootstrap.sh
```

`LETSENCRYPT_EMAIL` 留空则跳过签证书，只起 HTTP（先验证站点、再上 HTTPS 也行）。

脚本会依次做这些事，都是幂等的，可以重复跑：

1. `apt-get install nginx git rsync sudo certbot python3-certbot-nginx`
2. 建用户 `blog`（无密码、可登录但只能干发布的事，不用 sudo）
3. 建目录 `/srv/blog/repo`（代码）、`/var/www/blog`（对外根目录，属主 `blog:www-data`）
4. 把 `deploy/nginx/blog.conf` 装成 `/etc/nginx/sites-available/blog.conf`，
   替换 `__DOMAIN__`，启用站点、**禁用默认站点**
5. 装发布脚本到 `/usr/local/bin/blog-publish`
6. `nginx -t` → reload → 首次发布
7. 有 `LETSENCRYPT_EMAIL` 就 `certbot --nginx` 签证书并强制跳 HTTPS
8. 如果 ufw 是开着的，放行 `Nginx Full`

### 1.2 让本地能免密发布（可选，但强烈建议）

上面第 2 步的便利路径 `ssh blog@server blog-publish` 需要 `blog` 用户认得你的公钥。
在**本地 Windows** 上执行（没有密钥就先 `ssh-keygen -t ed25519`）：

```powershell
# Windows 版 OpenSSH 没有 ssh-copy-id，用这条（会提示输一次服务器密码）
$key = Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"
ssh root@blog.example.com "install -d -m 700 -o blog -g blog /home/blog/.ssh && echo '$key' >> /home/blog/.ssh/authorized_keys && chown blog:blog /home/blog/.ssh/authorized_keys && chmod 600 /home/blog/.ssh/authorized_keys && echo KEY_INSTALLED"
```

验证：`ssh blog@blog.example.com blog-publish` 应该直接打印 published 的 commit。

> GitHub Actions 自动部署也走这套密钥；把**私钥**放到仓库 Secrets 的 `SSH_KEY` 里。

### 1.3 私有仓库怎么办

仓库若是私有的，第 1 步的 clone 会要凭据。用**只读 Deploy Key**：

```bash
sudo -u blog ssh-keygen -t ed25519 -N "" -f /home/blog/.ssh/id_ed25519
sudo -u blog cat /home/blog/.ssh/id_ed25519.pub
# 把这把公钥贴到 GitHub → 仓库 → Settings → Deploy keys（不勾写权限）
sudo -u blog git clone git@github.com:SimonFu2011/P3_blog.git /srv/blog/repo
```

`git@` 走 22 端口；被占的话在 `/home/blog/.ssh/config` 里加
`Host github.com` + `Port 443` + `HostName ssh.github.com`。

### 1.4 云厂商安全组

到控制台放行 **80 / 443**（以及你自己的 SSH 端口）。ufw 只管服务器内部，
安全组不开，外面一律连不上 —— 这是最常见的"配完了打不开"。

---

## 2. nginx 配置要点

完整文件：`deploy/nginx/blog.conf`。几处值得单独说明：

### 2.1 双保险挡住 admin 与 server

```nginx
location ^~ /admin/  { return 404; }
location ^~ /server/ { return 404; }
```

发布脚本本来就排除了这两个目录，这里再挡一层。**即使**哪天手抖把整个仓库
rsync 上去，管理页 UI 和后端源码也不会被下载。`^~` 前缀匹配优先于正则，
所以不会被下面的 `\.js$` 规则抢走。

### 2.2 缓存：`expires` 而不是 `add_header`

```nginx
location ~* \.html$ { expires -1; }        # HTML：每次都回源校验
location ~* \.js$   { expires 5m; }        # 注意：posts.js 是"内容"
location ~* \.css$  { expires 5m; }
location ~* \.(jpg|jpeg|png|gif|webp|svg|ico)$ { expires 7d; }
```

两个坑：

* **`add_header` 不叠加**。location 里只要出现一条 `add_header`，server 块里
  的**全部** `add_header` 都会被丢弃。所以缓存用 `expires`（不带 add_header），
  安全头只在 server 块写一次。
* **`js/posts.js` 装的是文章正文**，不是"代码资源"。给它 `immutable` 一年，
  发完新文章自己看不到、还会以为发布失败。5 分钟是个够用又不难受的值。

### 2.3 安全头

`X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` 已经写好。
**CSP 故意没写**：站点有内联样式与运行时注入的节点，直接套 CSP 会把页面打死。
要用就先在 `Content-Security-Policy-Report-Only` 下观察几天再加。

---

## 3. 日常发布流程

### 本地（Windows）

```powershell
# 写文章：起本地管理页（只监听 127.0.0.1）
node blog-enter/server/dev-server.mjs
# 打开 http://127.0.0.1:8848/_admin/
```

管理页左栏底部「提交到 git」只做 `git add/commit`，**push 仍然你自己来**：

```powershell
git push origin main
```

### 服务器

```bash
sudo -u blog blog-publish
```

或者更省事：本地 push 完顺手把服务器也推一下

```powershell
git push origin main; ssh blog@blog.example.com blog-publish
```

`blog-publish` 干的事：`git fetch` → 对齐 `origin/main`（服务器是只读镜像，
用 `reset --hard`，本地不放任何修改）→ `rsync` 到 `/var/www/blog`
→ 打印发出去的那个 commit。

发布脚本的排除清单（这就是"公开产物"的定义）：

```
/server/   本地服务与测试
/admin/    管理页 UI
/tests/    测试
*.md       文档（含 ADMIN.md）
.admin/    运行时数据（会话 / 口令哈希 / 备份 / 回收站）
.user.ini / .well-known/   面板（宝塔）生成的站点文件与证书验证目录
```

**内容**（`js/`、`css/`、`img/`、`*.html`）全量发布，其中 `img/uploads/`
里上传的图片随 git 一起走。

### 想全自动？

仓库在 GitHub 上，加一个 Action 即可（自己复制到
`.github/workflows/deploy.yml`，别让它默认生效）：

```yaml
name: deploy
on:
  push:
    branches: [main]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SSH_HOST }}
          username: blog
          key: ${{ secrets.SSH_KEY }}
          script: blog-publish
```

需要在该仓库配 `SSH_HOST` 与 `SSH_KEY`（一把新的、只用于发布的私钥）。
注意：**发布即上线**，自动部署意味着本地一个手滑的 push 就直接改变公网内容。

---

## 4. 部署后自检

```bash
DOMAIN=blog.example.com

curl -sI "https://$DOMAIN/"                    | head -1   # 期望 200
curl -sI "https://$DOMAIN/archive.html"        | head -1   # 期望 200
curl -sI "https://$DOMAIN/about.html"          | head -1   # 期望 200
curl -sI "https://$DOMAIN/admin/"              | head -1   # 期望 404
curl -sI "https://$DOMAIN/server/dev-server.mjs" | head -1 # 期望 404
curl -sI "https://$DOMAIN/nope"                | head -1   # 期望 404

# 页面真的读到了文章数据（不是空壳）
curl -s "https://$DOMAIN/archive.html" | grep -c 'posts.js'   # 期望 ≥1

# 证书与跳转
curl -sI "http://$DOMAIN/" | grep -i location                 # 期望 301 → https
```

本地发布前也应该先跑一遍仓库自带的验签（48 项，不需要浏览器）：

```powershell
node blog-enter/server/tests/run-all.mjs
```

---

## 5. 上线前建议顺手修的两处

这两处不是部署阻塞项，但上线后会立刻被看到：

1. **`blog-enter/about.html:216`** 还是占位符
   `https://x.com/yourname` —— 换成你的真实账号，或删掉那一行。
2. **`blog-enter/404.html` 用的是相对路径** `css/pages.css`。
   nginx 是在原 URL 上内部重写到 `/404.html` 的，浏览器地址栏仍停在
   `/foo/bar`，于是相对路径解析成 `/foo/css/pages.css` → **404 页面没样式**。
   一行修掉：

   ```html
   <!-- 404.html 的 <head> 里，<link> 之前加一行 -->
   <base href="/">
   ```

   只在"部署在域名根目录"时成立；如果以后挂到子路径 `/blog/` 下，
   要改成 `<base href="/blog/">`。

---

## 6. CentOS / 宝塔面板的差异

| 环节 | Debian/Ubuntu | CentOS/RHEL | 宝塔 |
| --- | --- | --- | --- |
| 装包 | `apt-get install nginx git rsync` | `dnf install nginx git rsync` | 面板里点装 nginx |
| 站点配置 | `/etc/nginx/sites-available/` | `/etc/nginx/conf.d/blog.conf` | 面板加站点，把规则贴进"配置文件" |
| 证书 | `certbot --nginx` | 同左（先 `dnf install certbot python3-certbot-nginx`） | 面板 SSL → Let's Encrypt |
| 防火墙 | `ufw allow 'Nginx Full'` | `firewall-cmd --add-service={http,https} --permanent && firewall-cmd --reload` | 面板安全 + 云安全组 |

宝塔用户注意：面板默认会往站点配置里塞一堆自己的规则（伪静态、防盗链、
强制 HTTPS）。把 `deploy/nginx/blog.conf` 里 **location 那几段**挑出来贴进
面板的站点配置即可，别整体覆盖面板生成的文件，否则面板"网站"页会显示异常。

---

## 7. 常见坑清单

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 发完文章浏览器还是旧的 | `posts.js` 被长缓存 | 用 `expires 5m`；强制刷新 `Ctrl+F5` 可临时绕过 |
| 安全头"设了但没了" | location 里的 `add_header` 覆盖了 server 的 | 缓存改用 `expires`，或每条 add_header 都重复写 |
| `bad interpreter: /bin/bash^M` | Windows 检出把 `.sh` 转成了 CRLF | 仓库已加 `.gitattributes` 固定 `*.sh` 为 LF；老克隆执行 `git add --renormalize .` |
| `git pull` 报本地有冲突 | 有人在服务器上直接改了文件 | 服务器是只读镜像，`git -C /srv/blog/repo reset --hard origin/main` |
| certbot 签发失败 | DNS 还没生效 / 80 端口被占 | 先 `dig +short $DOMAIN` 确认解析，再签；失败别连着重试（有速率限制） |
| 上传的图片没有 | 图片只存在本地 `.admin/` | 图片必须落到 `blog-enter/img/uploads/` 并 **commit + push** |
| 仓库越来越大 | 图片全在 git 历史里 | 图片多了以后迁到对象存储/CDN，`img/uploads/` 改成本地不进库 |
| 想在另一台电脑写文章 | 管理端只绑本机，云端没有后台 | 那台电脑也 clone 仓库 + 跑 `dev-server.mjs`；云端不提供后台是刻意设计 |

---

## 8. 本目录文件

| 路径 | 用途 |
| --- | --- |
| `deploy/DEPLOY.md` | 本文档 |
| `deploy/nginx/blog.conf` | nginx 站点配置（`__DOMAIN__` 会被引导脚本替换） |
| `deploy/bin/blog-bootstrap.sh` | 服务器一次性引导（装包 / 建用户 / 装配置 / 首发布 / 签证书） |
| `deploy/bin/blog-publish.sh` | 发布：git 对齐远端 + rsync 到 web 根目录 |

服务器上装的最终位置：

```
/usr/local/bin/blog-publish                    ← deploy/bin/blog-publish.sh
/etc/nginx/sites-available/blog.conf           ← deploy/nginx/blog.conf
/srv/blog/repo                                 ← git 镜像（发布源）
/var/www/blog                                  ← nginx root（公开产物）
```
