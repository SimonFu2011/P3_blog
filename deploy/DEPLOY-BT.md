# 部署到宝塔面板服务器 —— simonfu.xin

针对你实际的环境写的，命令可以直接复制。**不要和执行 `DEPLOY.md` 里的
`apt-get install nginx`** —— 宝塔自己编译的 nginx 在 `/www/server/nginx`，
再装一个系统 nginx 会抢 80 端口，把面板的网站功能搞坏。

| 项 | 值 |
| --- | --- |
| 域名 | `simonfu.xin`（+ `www.simonfu.xin` 作为别名） |
| 服务器公网 IP | `43.108.100.116` |
| 地域 | 境外 → **不需要 ICP 备案** |
| 面板 | 宝塔（nginx 由面板管理，证书在面板申请） |
| 站点根目录 | `/www/wwwroot/simonfu.xin` |
| 发布源（git 镜像） | `/srv/blog/repo` |
| 发布用户 | `blog`（在 `www` 组里，用于写入站点目录） |

---

## ⚠️ 当前真正的阻塞点：域名处于 clientHold

2026-10-02 实测（RDAP 记录，注册商阿里云 / HiChina）：

| 查到的事实 | 值 |
| --- | --- |
| 域名状态 | **`client hold`** ← 注册商暂停了解析，这才是 DNS 返回 NXDOMAIN 的原因 |
| 注册时间 | 2026-10-02 11:21 UTC（当天刚注册） |
| 到期时间 | 2027-10-02 |
| NS | `dns7.hichina.com` / `dns8.hichina.com`（= 阿里云云解析） |

**`clientHold` 的含义**：注册局那边根本没有这个域名的 NS 记录，所以任何解析请求
都得到 NXDOMAIN —— 不是"你还没加 A 记录"那么简单，**现在加 A 记录也不会生效**。

新注册的国内域名出现 clientHold，最常见的原因是**实名认证未完成**（阿里云对未实名
域名会暂停解析）。处理顺序：

1. 登录阿里云 → 域名 → 域名列表 → `simonfu.xin`，看状态提示
2. 完成**实名认证**（上传证件；一般几小时内通过，慢的到 1 个工作日）
3. 认证通过后 `clientHold` 解除，NS 生效，**这时才轮到下面第 0 步加 A 记录**

验证解除：

```powershell
Resolve-DnsName simonfu.xin -Type NS -Server 8.8.8.8
# 能返回 dns7.hichina.com / dns8.hichina.com 就说明 clientHold 已解除
```

---

## 方案 A（推荐）：先用 IP 上线，域名就绪后再切

**`clientHold` 只挡域名，不挡 IP。** 站点是纯静态、全相对路径、没有任何
`canonical` / `og:url` 硬编码 —— 我逐页核对过 5 个公开 HTML 的资源引用，缺失为 0。
所以**同一份产物**在 IP 下和域名下表现完全一致，切换时**不需要重新发布**。

唯一代价：**没有 HTTPS**。Let's Encrypt 不为裸 IP 签证书（2025 年有过 IP 证书的
短期试点，宝塔面板不支持这套流程），所以 IP 阶段是纯 HTTP，浏览器会显示"不安全"。
对公开博客可接受，但别在这上面提交敏感信息。

纯 HTTP 下功能是否完整？我查过了：全站唯一的 secure-context 依赖是 `pages.js:160`
的复制按钮，而代码里**已经显式降级**到 `document.execCommand('copy')`，注释就写着
"http:// 局域网地址" —— 作者本来就考虑过这种场景。没有 Service Worker、没有
`getUserMedia`、没有 `crypto.subtle`。

### 怎么建站（关键：第一个域名决定根目录名）

宝塔 → 网站 → 添加站点，**域名一栏填三个（换行分隔，IP 放第一个）**：

```
43.108.100.116
simonfu.xin
www.simonfu.xin
```

PHP 版本选「纯静态」，不建数据库/FTP。这样：

* 现在就能用 `http://43.108.100.116/` 访问
* 站点根目录 = `/www/wwwroot/43.108.100.116`，伪静态文件 = `43.108.100.116.conf`
* 域名一解析通就自动生效，**不用再改面板**

> 如果面板不接受 IP 作站点域名：先随便填 `simonfu.xin` 把站建出来，然后在
> 网站 → 设置 → 配置文件里把 `server_name` 那行改成
> `server_name simonfu.xin www.simonfu.xin 43.108.100.116;`。
> 告诉我一声我也可以帮你改。

### 然后一条命令

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\deploy-from-windows.ps1 -IpOnly -All
```

`-IpOnly` 做的事：跳过 DNS 检查（域名还没解析），站点名用 IP，校验
`http://43.108.100.116/`。443 在这个模式下不作为失败条件。

### 域名就绪后切换（3 步，不用重新发布）

1. 阿里云实名认证通过 → `clientHold` 解除
2. 云解析加两条 A 记录（`@` 和 `www` → `43.108.100.116`）
3. 面板 → 网站 → 设置 → SSL → Let's Encrypt → 申请 → 打开「强制 HTTPS」

---

## 一键部署助手（Windows 侧）

`deploy/deploy-from-windows.ps1` 把"从你这台机器能自动化的部分"串起来了：
预检 → 推送 `deploy/` 到 GitHub → SSH 到服务器跑引导 → 验证公网页面
（含 `/admin/` 必须 404）。

> 你这台机器的 PowerShell **禁止运行脚本**（实测报 `UnauthorizedAccessException`），
> 所以必须带 `-ExecutionPolicy Bypass`：

```powershell
# 只做预检 + 验证（只读，默认行为）
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\deploy-from-windows.ps1

# 前置条件都就绪后，跑全流程
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\deploy-from-windows.ps1 -All
```

脚本不保存也不询问任何密码，SSH 认证由 `ssh` 自己交互。DNS、安全组、面板建站
这三件事只能在浏览器里做，脚本会在预检里明确告诉你缺哪一个。

> ⚠️ 这个 `.ps1` 文件**必须保存为 UTF-8 with BOM**。你这台机器是 Windows
> PowerShell 5.1，它会把无 BOM 的 UTF-8 当 ANSI 读，中文注释被解码错后会
> **吞掉换行**，直接导致 `语法错误: 函数参数列表中缺少"）"`。实测踩过一次：
> 用某些编辑器（或脚本）改完文件后 BOM 会丢失。

```powershell
# BOM 丢失时一条命令补回来
$p='deploy\deploy-from-windows.ps1'; $b=[IO.File]::ReadAllBytes($p)
if (-not ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)) { [IO.File]::WriteAllBytes($p, ([byte[]](0xEF,0xBB,0xBF))+$b) }
```

---

## 服务器现状（2026-10-02 实测）

| 探测项 | 结果 | 说明 |
| --- | --- | --- |
| TCP 80 | 通 | nginx 在跑，但返回的是**默认页**（2017 年的 `index.html`）→ 还没为这个域名建站 |
| TCP 443 | 通（拒绝连接） | 端口可达但**没有监听** → 还没配 SSL，属正常 |
| TCP 22 | 通 | SSH 接受**密码**认证；本机 `id_ed25519` 公钥**尚未**装到服务器 |
| TCP 8888 | 通 | ⚠️ 宝塔面板暴露在公网 —— 见文末安全提醒 |

---

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

### 在本地配一把免密登录（建议，也是让我能替你操作服务器的前提）

你机器上已经有密钥（`~/.ssh/id_ed25519`，注释 `simon-blog`），但**服务器还不认它**
（实测 `Permission denied (publickey)`）。Windows 版 OpenSSH **没有 `ssh-copy-id`**，
用下面这条 PowerShell 命令装公钥，它会提示你输一次服务器密码：

```powershell
# 装给 root：我（或你自己）才能在服务器上跑引导脚本
$key = Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"
ssh root@43.108.100.116 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$key' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo KEY_INSTALLED"
```

看到 `KEY_INSTALLED` 后验证：

```powershell
ssh -o BatchMode=yes root@43.108.100.116 "echo OK"
```

日常发布用的是 `blog` 用户（引导脚本会创建它）。装了 root 的密钥之后，
`blog` 的密钥可以由引导脚本或一条 root 命令代装：

```powershell
ssh root@43.108.100.116 "install -d -m 700 -o blog -g blog /home/blog/.ssh && cat >> /home/blog/.ssh/authorized_keys && chown blog:blog /home/blog/.ssh/authorized_keys && chmod 600 /home/blog/.ssh/authorized_keys" < "$env:USERPROFILE\.ssh\id_ed25519.pub"
ssh blog@43.108.100.116 blog-publish    # 应直接打印 published <sha>
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
