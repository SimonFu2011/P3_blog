# 部署到宝塔面板服务器 —— simonfu.xin

针对你实际的环境写的，命令可以直接复制。**不要和执行 `DEPLOY.md` 里的
`apt-get install nginx`** —— 宝塔自己编译的 nginx 在 `/www/server/nginx`，
再装一个系统 nginx 会抢 80 端口，把面板的网站功能搞坏。

| 项 | 值 |
| --- | --- |
| 域名 | `simonfu.xin`（+ `www.simonfu.xin` 作为别名） |
| 服务器公网 IP | `43.108.100.116` |
| 地域 | 境外 → **不需要 ICP 备案**，DNS 生效即可访问 |
| 面板 | 宝塔（nginx 由面板管理，证书在面板申请） |
| 站点根目录 | `/www/wwwroot/simonfu.xin` |
| 发布源（git 镜像） | `/srv/blog/repo` |
| 发布用户 | `blog`（在 `www` 组里，用于写入站点目录） |

整体链路：

```
Windows 本地                          43.108.100.116
┌───────────────────────┐            ┌────────────────────────────────┐
│ 管理页 127.0.0.1:8848 │            │ 宝塔 nginx                     │
│   ↓ 写                 │            │   root /www/wwwroot/simonfu.xin│
│ js/posts.js + img/    │            │        ↑ rsync（排除 admin/     │
│   ↓ git push           │──GitHub──→ │ /srv/blog/repo   server/）      │
└───────────────────────┘            └────────────────────────────────┘
```

---

## 第 0 步：加 DNS 解析（先做，因为它要等生效）

在 `simonfu.xin` 的 DNS 管理页面加两条 A 记录：

| 记录类型 | 主机记录 | 记录值 | TTL |
| --- | --- | --- | --- |
| A | `@` | `43.108.100.116` | 600 |
| A | `www` | `43.108.100.116` | 600 |

**阿里云云解析**：控制台 → 域名 → 域名列表 → 点 `simonfu.xin` 的「解析设置」→ 添加记录。

**腾讯云 DNSPod**：控制台 → DNSPod → 我的域名 → `simonfu.xin` → 「记录管理」→ 添加记录
（线路选「默认」，TTL 600）。

加完在**本地 Windows** 验证（不要信浏览器缓存）：

```powershell
Resolve-DnsName simonfu.xin -Type A -Server 8.8.8.8
Resolve-DnsName www.simonfu.xin -Type A -Server 8.8.8.8
# 两条都应该返回 43.108.100.116
```

> `.xin` 域名如果是在国内注册商买的且**没完成实名认证**，会被置为 serverHold
> （解析不生效）。域名列表里看到「实名认证」未完成就先去传证件。

---

## 第 1 步：放行 80 / 443，先确认 HTTP 能通

三处都要开，缺一处就是"配完了打不开"：

1. **云厂商安全组**：入方向放行 TCP `80`、`443`（以及你自己的 SSH 端口）。
2. **宝塔 → 安全**：放行 `80`、`443`。
3. 服务器自身防火墙（宝塔的防火墙插件会接管，面板里放行即可）。

在本地验证：

```powershell
curl.exe -I http://simonfu.xin
# 现在还没建站，返回宝塔默认页/404 都算"通了"；
# 连不上（超时/拒绝）就是上面三处有一处没开。
```

---

## 第 2 步：面板建站

宝塔 → **网站 → 添加站点**：

| 字段 | 填什么 |
| --- | --- |
| 域名 | `simonfu.xin` 一行，再加一行 `www.simonfu.xin` |
| 根目录 | `/www/wwwroot/simonfu.xin`（默认值，别改） |
| FTP | 不创建 |
| 数据库 | 不创建 |
| PHP 版本 | **纯静态** |

本站没有后端，选「纯静态」就不会生成 `enable-php-*.conf` 之类的多余配置。

> ⚠️ 站点根目录**不要**指向 `blog-enter/`，也不要整个仓库丢进 `wwwroot`。
> 只把 `blog-enter/` 里的**内容**发布到站点根 —— 这样 `admin/` 和 `server/`
> 根本不存在于公网目录里。

---

## 第 3 步：服务器上跑引导脚本

SSH 上服务器（root）：

```bash
mkdir -p /srv/blog
git clone https://github.com/SimonFu2011/P3_blog.git /srv/blog/repo

DOMAIN=simonfu.xin bash /srv/blog/repo/deploy/bin/blog-bootstrap-bt.sh
```

> 私有仓库的话这一步的 clone 会要凭据，先按 `DEPLOY.md` 第 1.3 节配一把
> **只读 Deploy Key**。

脚本做这些事（幂等，可重复跑）：

1. 只装 `git` / `rsync` / `sudo`，**不碰你面板的 nginx**
2. 建发布用户 `blog`，并加入 `www` 组
3. 装发布脚本到 `/usr/local/bin/blog-publish`
4. 把 `/www/wwwroot/simonfu.xin` 设成 `www:www` + 目录 `2775`（setgid）
   —— 面板按自己期望的属主工作，`blog` 靠 `www` 组拿到写权限
5. 把站点规则**追加**进 `/www/server/panel/vhost/rewrite/simonfu.xin.conf`
   （就是面板的「伪静态」，带标记，重复跑不会重复写）
6. `nginx -t` → reload → 首次发布
7. 打印面板里剩下的两步

脚本会打印站点已发布的 commit。此时访问 `http://simonfu.xin` 应该已经能看到首页。

### 在本地配一把免密发布（建议）

```powershell
ssh-keygen -t ed25519          # 如果还没有密钥
ssh-copy-id blog@43.108.100.116
ssh blog@43.108.100.116 blog-publish    # 应直接打印 published <sha>
```

没有 `ssh-copy-id` 的话：

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@43.108.100.116 "install -d -m 700 -o blog -g blog /home/blog/.ssh; cat >> /home/blog/.ssh/authorized_keys; chown blog:blog /home/blog/.ssh/authorized_keys; chmod 600 /home/blog/.ssh/authorized_keys"
```

---

## 第 4 步：面板申请证书

宝塔 → **网站 → simonfu.xin → SSL → Let's Encrypt**：

1. 勾选 `simonfu.xin` 和 `www.simonfu.xin`
2. 点申请（文件验证，需要 80 端口从公网可达）
3. 签发成功后打开 **「强制 HTTPS」**

申请失败的常见原因，按概率排：

| 现象 | 原因 |
| --- | --- |
| 验证超时 | 安全组/面板没放行 80；或 DNS 还没生效 |
| 提示验证失败 | `simonfu.xin` 与 `www` 有一条解析没加 |
| 短时间连续失败 | Let's Encrypt 有速率限制，等 1 小时再用**DNS 验证**（面板支持填阿里云 DNS API，正好你有阿里云账号） |

---

## 第 5 步：上线自检

```powershell
curl.exe -sI https://simonfu.xin/                      # 期望 200
curl.exe -sI https://www.simonfu.xin/                  # 期望 200
curl.exe -sI http://simonfu.xin/                       # 开了强制HTTPS → 301
curl.exe -sI https://simonfu.xin/archive.html          # 期望 200
curl.exe -sI https://simonfu.xin/admin/                # 期望 404  ← 关键
curl.exe -sI https://simonfu.xin/server/dev-server.mjs # 期望 404  ← 关键
curl.exe -s  https://simonfu.xin/archive.html | Select-String "posts.js"  # 要能搜到
```

后两条是这个项目最该验的：管理页和本地服务**必须不在公网**。

---

## 日常发布流程

```powershell
# 1) 本地写文章（管理页只监听 127.0.0.1，云端没有后台，这是刻意设计）
node blog-enter/server/dev-server.mjs     # → http://127.0.0.1:8848/_admin/

# 2) 管理页左栏底部「提交到 git」，然后自己 push
git push origin main

# 3) 让服务器跟上
ssh blog@43.108.100.116 blog-publish
```

第 3 步会打印发出去的 commit。改完 HTML/JS/CSS 后浏览器可能要 `Ctrl+F5`
（配置里 JS/CSS 只缓 5 分钟，最多等 5 分钟自然生效）。

发布脚本的排除清单就是"公开产物"的定义：

```
/server/   本地服务（只绑 127.0.0.1）与测试
/admin/    管理页 UI
/tests/    测试
*.md       文档（含 ADMIN.md）
.admin/    会话令牌 / 口令哈希 / 备份 / 回收站
.user.ini  面板生成的站点文件
.well-known/  证书续期验证目录（面板用）
```

---

## 宝塔专属的坑

| 现象 | 原因与处理 |
| --- | --- |
| 装完系统 nginx 后，面板网站打不开 | 宝塔的 nginx 与 apt 版抢 80 端口。`apt remove nginx`，或重装面板的 nginx（面板 → 软件商店 → Nginx → 卸载重装）。**别混用两套步骤。** |
| 手动改的主配置过阵子"变回去了" | 面板在切换 SSL、改运行目录、改站点目录时会重新生成主配置。站点规则我们放**伪静态**，不受影响。 |
| 发完文章自己看不到新的 | 面板默认给 `.*\.(js|css)?$` 加 12 小时缓存，而 `js/posts.js` 装的是**文章正文**。伪静态里的 `expires 5m` 已经把它盖掉了；确认伪静态那段在。 |
| 面板报 `duplicate error_page 404` | 面板主配置里已经启用了 404 页。把伪静态片段里的 `error_page 404 /404.html;` 删掉。 |
| 发布报权限拒绝 | 确认 `blog` 在 `www` 组（`id blog`）、站点目录是 `www:www` 且目录为 `2775`。重跑引导脚本可自动修好。 |
| 企业版"网站防篡改"拦住发布 | 把 `/www/wwwroot/simonfu.xin` 加入白名单，或对该目录关闭防篡改。 |
| 站点根目录被别人塞进整个仓库 | 那样 `https://simonfu.xin/admin/` 会暴露管理页 UI。伪静态里有 404 兜底，但正确做法是只发布 `blog-enter/` 的内容。 |
| 面板 8888 被扫描爆破 | 面板 → 设置：改面板端口、绑定只允许你的 IP 访问、开启面板 SSL。**公网暴露的宝塔面板是常见入侵入口。** |

顺手提醒：**服务器是只读镜像**，不要在服务器上直接改文件 —— 下次 `blog-publish`
会 `git reset --hard` 覆盖掉。要改内容请在本地管理页改。

---

## 上线前建议顺手修两处

1. `blog-enter/about.html:216` 还是占位符 `https://x.com/yourname`。
2. `blog-enter/404.html` 用相对路径 `css/pages.css`。nginx 是在原 URL 上内部
   重写的（地址栏停在 `/foo/bar`），相对路径会解析成 `/foo/css/pages.css`
   → **404 页面丢样式**。在 `<head>` 里加一行即可（确认本站挂在域名根目录）：

   ```html
   <base href="/">
   ```

---

## 附：本方案用到的文件

| 文件 | 作用 |
| --- | --- |
| `deploy/DEPLOY-BT.md` | 本文档 |
| `deploy/bin/blog-bootstrap-bt.sh` | 宝塔版一次性引导（不装 nginx、不装 certbot） |
| `deploy/bt/nginx-locations.conf` | 追加进「伪静态」的站点规则 |
| `deploy/bin/blog-publish.sh` | 发布脚本（两套方案共用） |
| `deploy/DEPLOY.md` | 非宝塔（纯 nginx）方案，备用 |
