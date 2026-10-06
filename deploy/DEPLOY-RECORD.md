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
| 代码版本 | commit `2639a52`（本机 / 服务器 / GitHub 三方一致） |
| 后台服务 | `p3-admin.service`，`active`，**只监听 `127.0.0.1:8848`** |
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

隧道下请求对端仍是回环、`Host` 仍是 `127.0.0.1`，现有四道闸（反代密钥 /
对端 / Host / 同源）**全部满足** —— 这也是为什么隧道模式下不需要放宽任何判据。

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
| Waline 评论区 | **方案已写（`PLAN-COMMENTS-WALINE.md`），服务器上一行都没部署** |
| 服务器回推 GitHub | 服务器**没有**写凭据，所以它在管理页保存后产生的 commit 只在本地。<br>当前靠"本机 push + 服务器 ff-only 拉取"同步；需要"服务器是唯一写入方"时<br>再给它配一把带写权限的 Deploy Key（`PLAN-ADMIN-LIVE.md` §9.1） |
| `images.mjs` 的 SVG `<style>` 文本未净化 | 未修（ReDoS 只修了 `validate.mjs`） |
| 图片像素上限 / 登录并发上限 / `/api/session` 性能 | 未修，见 `AUDIT-INDEX.md` |
| 前端渲染期转义（审计 F5/F6/F7） | 现在只靠保存期白名单挡 |
| 宝塔面板访问 | 已从公网摘掉（firewalld 移除 `8888/tcp`），改走 `ssh -L 8888:127.0.0.1:8888` |
| SSH 允许 root 口令登录 | **仍未关**（`permitrootlogin yes` + `passwordauthentication yes`），<br>且未装 fail2ban。密钥已可免密登录 root，关掉是安全的，但需你确认 |
| 域名与 TLS | `simonfu.xin` NXDOMAIN、443 未监听 |

---

## 7. 踩过的坑（改法都已在代码里）

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
