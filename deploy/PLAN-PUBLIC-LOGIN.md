# 公开登录 / 注册 / 评论上线计划（P3_blog，MySQL 版）

> 适用：服务器 `root@43.108.100.116`，站点根 `/www/wwwroot/43.108.100.116`，仓库 `/srv/blog/repo`
> 目标：把 `p3-public`（回环 `127.0.0.1:8850`）挂到公网 `http://43.108.100.116` 的
> `/api/auth/*` 与 `/api/comments*`，替换页面上原有的 Waline 评论区。
> 本文件是**执行清单**：按顺序做，每步都有「验证」。实测结果由 t18 填进
> `deploy/DEPLOY-RECORD.md` 第 9 节。
> 关系：t10 冻结 API 契约（`blog-enter/server/CONTRACT-public-api.md`）、t11 冻结表结构
> （`blog-enter/server/sql/schema.sql`）、t13 已把库与账号放在服务器上、t15 出部署件（本文件
> + `deploy/systemd/p3-public.service` + `deploy/bt/nginx-locations.conf`）。
>
> ⚠️ 总原则：**这一步只动 `/etc/systemd/system/p3-public.service` 与宝塔伪静态文件**。
> 不要改主配置、不要动 `p3-admin` / `p3-admin-proxy` / `p3-waline` 三个单元、不要动 `.admin/`。

---

## 0. 开工前的现状与备份点（t13 已完成的部分不用重做）

已经就位、**不要重复建设**：

| 项 | 现状（t13 实测） |
| --- | --- |
| MySQL 5.7.40 | `systemctl is-active mysqld` = active、`is-enabled` = enabled；`ss -ltnp` 只看到 `127.0.0.1:3306` |
| 库 / 账号 | 库 `p3blog`（6 表、4 条外键、InnoDB + utf8mb4_unicode_ci）；`'p3app'@'127.0.0.1'` 仅 `SELECT/INSERT/UPDATE/DELETE` |
| 配置 | `/etc/p3blog/public.env`（**600 root:blog**，含 `P3_DB_HOST/P3_DB_PORT/P3_DB_NAME/P3_DB_USER/P3_DB_PASSWORD/P3_SESSION_MAX_AGE_DAYS=30`） |
| root 凭据 | `/root/p3-mysql-root.txt`(600) 且已同步进 `/etc/my.cnf` 的 `[client]`（`mysql` 免密可用） |
| 运行环境 | `node v22.12.0` 在 `/usr/local/bin/node`，`npm` 也在 `/usr/local/bin/npm`（实测存在） |
| nginx | `nginx/1.28.3`，二进制 `/www/server/nginx/sbin/nginx`；站点伪静态文件 `/www/server/panel/vhost/rewrite/43.108.100.116.conf` |
| 已有单元 | `p3-admin`、`p3-admin-proxy`、`p3-waline`、`p3-firewall`（**没有** `p3-public`） |

先做一次备份点（回滚要用）：

```bash
RW=/www/server/panel/vhost/rewrite/43.108.100.116.conf
cp -a "$RW" "/root/p3-rewrite.bak-$(date +%Y%m%d-%H%M%S)"
ls -la /root/p3-rewrite.bak-* /www/backup/p3-mysql-pre-reset-*.sql.gz
```

**验证**：能列出上面两类备份文件各至少一个。数据库侧的重置前全库备份在
`/www/backup/p3-mysql-pre-reset-20261006-162241.sql.gz`（t13 留的）。

---

## 1. 把新代码同步到服务器

代码文件（`blog-enter/server/**`、`blog-enter/js/**`、`blog-enter/css/**`、`blog-enter/*.html`、
`blog-enter/server/package.json`、`blog-enter/server/package-lock.json`、`deploy/**`）
**必须显式提交**再同步：`blog-publish` 只会自动提交
「内容白名单」（`js/posts.js`、`img/uploads/` 等），不会替你提交代码。

> ⚠️ Node 依赖清单**只能放在 `blog-enter/server/` 下**（连同 `node_modules/`）：发布用的
> rsync 以 `--filter='-s /server/'` 整体排除 `server/`，所以放这里的构建物结构上就不会
> 上线；放到 `blog-enter/` 顶层则会被同步到站点根目录（`http://43.108.100.116/package.json`）
> 泄漏依赖与运行时信息 —— 发布自检会以 `exit 5` 拦下，但别靠它兜底。

```bash
# 本机（D:\DS）
git add -A && git commit -m "feat(public): 登录/注册/评论（MySQL）" && git push

# 服务器
sudo -u blog git -C /srv/blog/repo fetch --all
sudo -u blog git -C /srv/blog/repo reset --hard origin/main
sudo -u blog git -C /srv/blog/repo log --oneline -3
```

注意：**别用 root 在 `/srv/blog/repo` 里跑 git**（会在 `.git/objects` 留下 root 文件，
之后 blog 身份的自动提交必然失败；真踩了就跑 `bash deploy/bin/fix-repo-ownership.sh`）。

**验证**：`git log --oneline -3` 能看到本次代码提交；且
`ls -la /srv/blog/repo/blog-enter/server/public-server.mjs /srv/blog/repo/deploy/systemd/p3-public.service`
两个文件都存在。

---

## 2. 装运行依赖（mysql2）

依赖清单放在 **`blog-enter/server/`**（与 `public-server.mjs` 同级），不是 `blog-enter/` 顶层：
`server/` 被发布脚本整体排除，`node_modules/` 跟着它一起落在里面，结构上就不会上公网。

```bash
cd /srv/blog/repo/blog-enter/server
sudo -u blog env PATH=/usr/local/bin:/usr/bin:/bin npm ci --omit=dev 2>/dev/null \
  || sudo -u blog env PATH=/usr/local/bin:/usr/bin:/bin npm install --omit=dev
sudo -u blog env PATH=/usr/local/bin:/usr/bin:/bin node --check public-server.mjs
```

**验证**：
```bash
ls -d /srv/blog/repo/blog-enter/server/node_modules/mysql2 && echo mysql2-ok
sudo -u blog env PATH=/usr/local/bin:/usr/bin:/bin node -e "require('/srv/blog/repo/blog-enter/server/node_modules/mysql2')" && echo require-ok
# 顶层不许有依赖清单（有的话发布自检会 exit 5；这里提前查一次更便宜）
ls /srv/blog/repo/blog-enter/package.json /srv/blog/repo/blog-enter/package-lock.json 2>/dev/null && echo 'PROBLEM: 顶层残留，挪到 server/ 下'
```

**失败怎么办**：npm 装不上（无外网 / 私有 registry）时**停下来报告**，不要改代码去绕过
（契约要求真库；回退到骨架模式等于 503 全站）。可选办法：本机 `npm pack` 出离线 tarball，
`scp` 上去后在 `/srv/blog/repo/blog-enter/server/` 里 `npm install ./mysql2-x.y.z.tgz`。

---

## 3. 确认配置文件的权限与内容（**不要放宽成 644**）

```bash
stat -c '%a %U %G %n' /etc/p3blog/public.env      # 必须是 600 root blog
sudo grep -c '^P3_DB_' /etc/p3blog/public.env     # 6
sudo sed -E 's/^(P3_DB_PASSWORD=).*/\1<masked>/' /etc/p3blog/public.env
```

**验证**：权限行与上表一致、6 个 `P3_DB_*`（含 `P3_SESSION_MAX_AGE_DAYS`）。
读这个文件的是 systemd（PID1，root），所以 600 足够；**放宽到 644 等于把库口令给全机用户**。

---

## 4. 生成代理共享密钥（**先做这一步**：后端与 nginx 两头都要读它）

为什么需要它：`--trust-proxy` 让后端相信 `X-Forwarded-For`，但 8850 只绑回环 ——
本机任何进程（被入侵的低权限服务、SSRF）都能直连它并自塞
`X-Forwarded-For: 1.2.3.4`。因为后端取**最后一段**，伪造的 IP 会直接进限流键与
`auth_log`（限流形同虚设、审计记假地址）。所以要用一个只有 root 能读的共享密钥，
证明"请求确实来自我们那份 nginx"——管理面用的是同一套机制
（`lib/security.mjs` 的代理密钥校验 + `X-Admin-Proxy-Secret`）。

```bash
# ⓪ 先建公开服务的专用系统账号（服务单元里 User=p3public；**必须先建**，
#    否则后面的 chown -g p3public 会因组不存在而失败，第 6 步服务也起不来）
#    为什么不用 blog：blog 与管理面 p3-admin 同 uid，而 p3-admin 的运行时数据
#    （.admin/passphrase.json、session.json）对 blog 是可读的 ——
#    公开面一旦被拿下就等于管理面被拿下。独立 uid 是把这条链断开的唯一办法。
id -u p3public >/dev/null 2>&1 || \
  useradd --system --no-create-home --shell /usr/sbin/nologin p3public
getent passwd p3public                     # 应打印一行（uid 在系统号段）

# ① 后端读的那份：640 root:p3public —— 服务以 p3public 运行，必须让它读到
#    ⚠️ 组是 **p3public**，不是 blog：进程以 User=p3public 运行，
#       只靠属主 root 的 640 它读不到，后端会按 fail-fast 直接 exit 7 起不来。
#
#    ⚠️⚠️ 目录模式必须是 **755**，**绝不能**收紧成 750 —— 这一条会打坏管理面：
#      /etc/p3blog 里还住着**管理面**要读的 proxy-secret（640 root:blog），
#      而 p3-admin.service 以 User=blog 运行、靠
#      `--proxy-secret-file /etc/p3blog/proxy-secret` 启动
#      （public-server 读不到它不算问题，dev-server 读不到就 exit 5）。
#      目录一旦是 750 root:p3public，blog 连**遍历**都做不到 ——
#      哪怕文件本身是 640 root:blog 且 blog 在组里，也读不到：
#        750 root:springboot 目录 + 640 root:blog 文件 → sudo -u blog 读 = DENIED
#        改回 755                                      → OK
#      （评审在服务器上实测过这两组对照。）
#      本步骤**只需要新建目录**，不需要改它的模式：若 /etc/p3blog 已存在
#      （t13 已建），`install -d` 也不会改它的权限；这里写 755 是为了
#      保证"首次创建时"就是对的，且与现状一致（现为 755 root:blog）。
install -d -m 755 -o root -g blog /etc/p3blog
openssl rand -hex 32 > /etc/p3blog/public-proxy-secret
chown root:p3public /etc/p3blog/public-proxy-secret
chmod 640 /etc/p3blog/public-proxy-secret

# ② nginx 读的那份：内容只有一行 proxy_set_header（600 root:root）
#    由 root 的 master 在配置解析期读，所以 worker 是 www 也不影响
printf 'proxy_set_header X-Admin-Proxy-Secret "%s";\n' "$(cat /etc/p3blog/public-proxy-secret)" \
  > /etc/p3blog/public-proxy-header.conf
chown root:root /etc/p3blog/public-proxy-header.conf
chmod 600 /etc/p3blog/public-proxy-header.conf
```

**验证**：

```bash
stat -c '%a %U %G %n' /etc/p3blog                          # 755 root blog —— 不能是 750（见 ① 的警告）
stat -c '%a %U %G %n' /etc/p3blog/public-proxy-secret        # 640 root p3public
stat -c '%a %U %G %n' /etc/p3blog/public-proxy-header.conf   # 600 root root
wc -l /etc/p3blog/public-proxy-header.conf                   # 1（只允许这一行指令）
# 两份文件必须是同一个值（下面这条打印 same-value-ok）
h=$(sed -E 's/^proxy_set_header X-Admin-Proxy-Secret "(.*)";$/\1/' /etc/p3blog/public-proxy-header.conf)
[ "$h" = "$(cat /etc/p3blog/public-proxy-secret)" ] && echo same-value-ok
[ ${#h} -eq 64 ] && echo hex32-ok
# 服务账号必须能读（这是第 6 步能起来的前提）；用户是 p3public，不是 blog
sudo -u p3public test -r /etc/p3blog/public-proxy-secret && echo p3public-can-read-ok
# 反过来：公开进程**必须读不到**管理面凭据（S3 的判据，期望两条都非 0）
sudo -u p3public test -r /srv/blog/repo/.admin/passphrase.json || echo admin-pass-not-readable-ok
sudo -u p3public test -r /etc/p3blog/proxy-secret || echo admin-proxy-secret-not-readable-ok
# 【管理面不得被这次改动打坏】团队目标里"管理员本机后台保持不变"就靠这两条守：
#   ① blog 必须仍能读管理面的代理密钥 —— 否则 p3-admin 下次重启直接 exit 5 起不来；
#      这条同时验证 /etc/p3blog 目录是 755（750 时下面会失败，正是要抓的回归）。
sudo -u blog test -r /etc/p3blog/proxy-secret && echo blog-can-read-admin-proxy-secret-ok
#   ② 管理面服务必须还在跑（若刚被弄坏，这里会显示 inactive/failed）
systemctl is-active p3-admin && echo p3-admin-active-ok
# 密钥绝不进仓库：仓库里只有模板与说明，没有这个值
grep -rn "$h" /srv/blog/repo && echo 'PROBLEM: 密钥出现在仓库' || echo 'repo-clean-ok'
```

**失败怎么办**：`p3public-can-read-ok` 没打印 → 服务读不到密钥，后端会因此**直接启动失败**
（fail-fast，见第 6 步；不会静默降级）；检查属主/权限是否是 `640 root:p3public`。
反过来若 `admin-pass-not-readable-ok` 没打印（即公开账号**能**读 `.admin/passphrase.json`），
那是 S3 没修好：先确认 `.admin` 是 `00700 blog:blog`（**五位**，见 `p3-fix-repo-perms.sh` 的说明）、
服务确实是 `User=p3public`。
**若 `blog-can-read-admin-proxy-secret-ok` 没打印**：说明 `/etc/p3blog` 的目录模式被收紧了
（多半是被改成了 `750`）—— blog 无法遍历该目录 → `p3-admin` 启动时读不到 `proxy-secret`
→ `dev-server.mjs:932-939` 报错 → **exit 5，管理面起不来**。改回 `chmod 755 /etc/p3blog`
并 `systemctl restart p3-admin` 复核；这正是本步骤把 `install -d` 写成 `-m 755` 的原因。
头文件缺失时第 5 步的 `nginx -t` 会失败（fail-closed），所以**这两份文件必须在第 5 步之前
都建好** —— 这正是"一次建两份、零中间态"的关键。

---

## 5. 追加 nginx 反代段（用仓库里的模板整段替换）

顺序上**本步在读第 6 步（装后端）之前**，这不是排版错误：密钥头必须在后端开始要求它
**之前**就让 nginx 送上，否则会出现"后端要密钥、nginx 没送"的 403 中间态
（本步末尾的「顺序要求」有三步口径）。

伪静态文件里已经有 `# ==== P3_blog 规则开始 ====` 标记。**引导脚本
`blog-bootstrap-bt.sh` 遇到该标记会跳过，不会更新**，所以这里手工整段替换：

```bash
# 0) 前置检查：密钥头文件必须已经存在（第 4 步一次建好两份）。缺了它 nginx -t 会
#    直接失败（fail-closed：reload 不执行、线上保持原状），但别指望 reload 能成功。
test -r /etc/p3blog/public-proxy-header.conf || { echo '缺 public-proxy-header.conf：先做第 4 步'; exit 1; }
head -1 /etc/p3blog/public-proxy-header.conf | sed -E 's/"(.*)"/"<masked>"/'

RW=/www/server/panel/vhost/rewrite/43.108.100.116.conf
cp -a "$RW" "/root/p3-rewrite.bak2-$(date +%Y%m%d-%H%M%S)"     # 再留一个备份点
sed -i '/^# ==== P3_blog 规则开始/,/^# ==== P3_blog 规则结束/d' "$RW"
printf '\n' >> "$RW"
cat /srv/blog/repo/deploy/bt/nginx-locations.conf >> "$RW"
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
```

**验证（公网入口，逐条打）**：

```bash
B=http://43.108.100.116
# /api/* 这两条：首次部署时后端还没起（第 6 步才装）→ 期望 502，证明反代已经生效；
# 升级场景后端已在跑 → 期望 200（此刻后端还没要求密钥，会忽略多出来的头）。
printf '%-26s %s\n' /api/auth/me      "$(curl -s -o /dev/null -w '%{http_code}' $B/api/auth/me)"
printf '%-26s %s\n' '/api/comments'   "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/comments?slug=x")"
# 下面这些与后端在不在无关，必须立刻正确：
printf '%-26s %s\n' '/_admin/'        "$(curl -s -o /dev/null -w '%{http_code}' $B/_admin/)"           # 404（既有拒绝规则没被削弱）
printf '%-26s %s\n' '/server/'        "$(curl -s -o /dev/null -w '%{http_code}' $B/server/)"           # 404
printf '%-26s %s\n' '/evil.mjs'       "$(curl -s -o /dev/null -w '%{http_code}' $B/evil.mjs)"          # 404
printf '%-26s %s\n' '/api/auth/xyz'   "$(curl -s -o /dev/null -w '%{http_code}' $B/api/auth/xyz)"      # 404（白名单兜底）
printf '%-26s %s\n' '/api/comments/abc' "$(curl -s -o /dev/null -w '%{http_code}' $B/api/comments/abc)" # 404（id 形状不符）
printf '%-26s %s\n' '/comments/ui/'   "$(curl -s -o /dev/null -w '%{http_code}' $B/comments/ui/)"      # 403（Waline 段原样保留）
```

**失败怎么办**：`nginx -t` 报 `duplicate location "/api/"` 说明面板主配置里已有同名前缀
location —— 把模板末尾那条兜底 `location /api/ { return 404; }` 删掉再试（其余段保留），
并在记录里写明。任何情况下 **`nginx -t` 不过就不要 reload**，直接恢复备份：

```bash
cp -a /root/p3-rewrite.bak2-<时间戳> "$RW" && /www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
```

> ### 顺序要求：三步、零中间态（这是本改动唯一的真实风险）
> 1. **第 4 步**：`openssl rand -hex 32` 一次把**两份**文件都建好
>    （`public-proxy-secret` 640 root:p3public + `public-proxy-header.conf` 600 root:root）；
>    **前置**：公开服务的系统账号 `p3public` 必须先存在（第 4 步 ⓪ 的 `useradd`）。
> 2. **本步**：`nginx -t` 通过后 reload —— 此刻后端要么还没起（首次部署），
>    要么还没要求密钥（升级），多出来的头被忽略，**不会**产生任何 403；
> 3. **第 6 步**：`systemctl enable --now p3-public`（升级场景 `systemctl restart p3-public`）
>    —— 此刻密钥文件一定已在，后端**必然**校验成功。
>
> 关键就是第 1 步**一次建两份**：于是"后端要密钥但 nginx 没注入"与"nginx 注入但后端
> 不校验"这两个中间态**都不存在** —— 窗口是 0，而不是 0.5 秒或 30 秒。反过来，如果生成
> 密钥只绑在 nginx 这一侧、让应用先跑在"有参数、没文件"的状态上，就会开出"短暂全站
> 403"的窗口，不要那样做。
>
> 若第 6 步做完公网仍不是 200：先确认头文件的值与 `public-proxy-secret` **完全一致**
> （第 4 步有 same-value-ok 检查）、reload 真的发生了（`nginx -t` 成功却忘了 `-s reload`
> 是常见疏漏）、以及服务真的用了新单元（`systemctl show p3-public -p ExecStart`）。
> 注意唯一剩下的"中间态"是**头文件缺失**：那会让本步 `nginx -t` 失败、reload 不执行 ——
> 这是 fail-closed，不是窗口（线上保持原状，不会半配置地对外服务）。
>
> ### 回滚（去掉 nginx 那行 + reload）
> ```bash
> # ① 恢复伪静态（把 include 行整段带走；密钥文件本身可以留着，不影响）
> cp -a /root/p3-rewrite.bak2-<时间戳> "$RW"
> /www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
> # ② 若连后端也要退回：手工删掉 ExecStart 里的 --proxy-secret-file，再重启
> #    （退回到"本机任意进程可伪造 IP"的旧状态，只作应急）
> systemctl daemon-reload && systemctl restart p3-public
> systemctl is-active p3-public
> # ③ 最后才考虑删密钥文件（删了以后 nginx 侧 include 会失败，必须先做 ①）
> ```
> 只回退 ① 不回退 ② 会让公网 `/api/*` 全部 403：后端仍要求密钥、而 nginx 不再注入。
> 这是"不匹配就拒绝"的 fail-closed 行为，属预期，不是故障 —— 补做 ② 即可恢复。

---

## 6. 装 systemd 单元并启动

```bash
install -m 644 /srv/blog/repo/deploy/systemd/p3-public.service /etc/systemd/system/p3-public.service
systemctl daemon-reload
systemctl enable --now p3-public                # 首次部署；升级场景用 systemctl restart p3-public
systemctl status p3-public --no-pager | head -15
```

**验证（5 条一起看）**：

```bash
systemctl is-active p3-public      # active
systemctl is-enabled p3-public     # enabled
ss -ltnp | grep 8850               # 只能出现 127.0.0.1:8850，出现别的地址就是错的
journalctl -u p3-public -n 30 --no-pager   # 启动横幅应列出 Host/Origin 白名单与 mode
curl -sS -o /dev/null -w 'public=%{http_code}\n' http://43.108.100.116/api/auth/me   # 期望 200
```

启动横幅里应当能看到 `127.0.0.1`、`43.108.100.116` 在 Host 名单里，
`http://43.108.100.116` 在 Origin 名单里，以及 `mysql`（真库）而不是 `skeleton`。
最后那条 `public=200` 是整套链路（nginx 注入密钥头 → 后端校验 → 反代 → 库）第一次闭环。

> **三条与任务书原本给的 ExecStart 不同的地方，是故意的，别"修回去"**：
> * `--public-host 43.108.100.116`：nginx 反代传的是 `Host: 43.108.100.116`，
>   而后端 Host 白名单**默认只含回环名**。漏了这条 → 所有 API 403 `host not allowed`。
> * `--trust-proxy`：不开的话每个请求对端都是 `127.0.0.1`，`auth.login` 的
>   「每 IP 15 分钟 10 次」会退化成**全站共享一个桶**（任何人连错 10 次就把所有人
>   锁在 429 外面一小时）。它与 nginx 段里的 `$proxy_add_x_forwarded_for` 是一对。
> * `--proxy-secret-file /etc/p3blog/public-proxy-secret`：与 nginx 注入的
>   `X-Admin-Proxy-Secret` 是**另一对**。只开 `--trust-proxy` 不注入密钥 = 本机任意
>   进程都能伪造客户端 IP（第 4 步解释了为什么）。**改一个必须改另一个。**
>
> **`--proxy-secret-file` 的语义（t14 定稿，别改成"软降级"）**：
> * 给了这个参数 → 密钥文件**必须存在且非空**，否则**启动失败**（fail-fast）。所以本步
>   能起来，本身就说明第 4 步两份文件都对 —— 这条链路一次 `restart` 就能验通；
> * 完全不给这个参数 → 允许启动，但**强制关闭代理信任**并打告警（仅本机开发/无 nginx 调试）；
> * **不存在**"给了参数、文件没了、于是悄悄不校验"的软化状态。
>
> 单元里的沙箱比 `p3-admin` **更紧**：`ProtectSystem=strict` 且**不给任何
> `ReadWritePaths`**（本服务不写文件；数据在 MySQL，日志进 journal）。

**失败怎么办**：看 `journalctl -u p3-public -n 50`。常见三类：
① `Cannot open EnvironmentFile` → 权限/路径问题（回第 3 步）；
② 退出码 4 + `拒绝启动：公开服务只能监听回环` → `--listen` 被改坏了；
③ 明确报"代理密钥文件不存在/为空" → 第 4 步没做完或文件被删（`ls -la /etc/p3blog/public-proxy-secret`）。

---

## 7. 回环冒烟（不经 nginx，先把服务本身验干净）

后端这下要求密钥头了，所以直连也必须带上它（密钥从第 4 步的文件读）：

```bash
SEC=$(cat /etc/p3blog/public-proxy-secret)

# 0) 先验 fail-fast：密钥文件不在，服务必须**起不来**（不是静默降级）
cp -a /etc/p3blog/public-proxy-secret /root/p3-proxy-secret.keep
mv /etc/p3blog/public-proxy-secret /tmp/p3-proxy-secret.moved
systemctl restart p3-public; echo "missing_rc=$?"            # 期望非 0
systemctl is-active p3-public                                # 期望 failed
journalctl -u p3-public -n 20 --no-pager | tail -5           # 应看到明确原因（密钥文件不存在）
# 空文件同样必须失败
: > /tmp/p3-proxy-empty && install -m 640 -o root -g p3public /tmp/p3-proxy-empty /etc/p3blog/public-proxy-secret
systemctl restart p3-public; echo "empty_rc=$?"              # 期望非 0
rm -f /tmp/p3-proxy-empty
# 复原并确认服务回来
mv /tmp/p3-proxy-secret.moved /etc/p3blog/public-proxy-secret
chown root:p3public /etc/p3blog/public-proxy-secret; chmod 640 /etc/p3blog/public-proxy-secret
systemctl restart p3-public && systemctl is-active p3-public  # active

# 1) 正常请求：公网那个 Host + 正确密钥，期望 200 且 db:"up"
curl -sS -i -H 'Host: 43.108.100.116' -H "X-Admin-Proxy-Secret: $SEC" \
     http://127.0.0.1:8850/api/auth/me | head -20

# 2) 不带密钥必须 403 —— 这就是"本机进程无法冒充 nginx"的证据
curl -sS -o /dev/null -w 'no-secret=%{http_code}\n' -H 'Host: 43.108.100.116' \
     http://127.0.0.1:8850/api/auth/me

# 3) 伪造密钥也必须 403
curl -sS -o /dev/null -w 'bad-secret=%{http_code}\n' -H 'Host: 43.108.100.116' \
     -H 'X-Admin-Proxy-Secret: forged' http://127.0.0.1:8850/api/auth/me

# 4) Host 白名单真的在工作
curl -sS -o /dev/null -w 'bad-host=%{http_code}\n' -H 'Host: evil.example.com' \
     -H "X-Admin-Proxy-Secret: $SEC" http://127.0.0.1:8850/api/auth/me

# 5) 需要库的端点：未登录写评论应 401 UNAUTHENTICATED（而不是 503/500）
curl -sS -X POST -H 'Host: 43.108.100.116' -H "X-Admin-Proxy-Secret: $SEC" \
     -H 'Content-Type: application/json' -d '{"slug":"smoke","content":"x"}' \
     http://127.0.0.1:8850/api/comments
```

**验证**：⓪ `missing_rc`/`empty_rc` 非 0、`is-active` 为 failed、journal 里有明确原因
（密钥文件语义是 fail-fast，不是降级）；① 200 且含 `"ok":true`、`"user":null`、`"db":"up"`
（`db` 是 `"down"` 说明连不上库，回第 0/3 步查 MySQL 与 `P3_DB_*`）；② `no-secret=403`；
③ `bad-secret=403`；④ `bad-host=403`；⑤ `401` + `{"ok":false,"error":{"code":"UNAUTHENTICATED"...}}`。
⓪②③ 是这次新增的判据：②③ 只要不是 403，就说明密钥校验没落地；⓪ 起不来才是对的
（能起来反而说明 fail-fast 没实现）—— 任一条不符就**停下来排查，别继续做公网**。

---

## 8. 发布静态产物（登录入口 + 新评论组件）

```bash
sudo -u blog blog-publish            # 会自动提交内容白名单并同步到站点根目录
```

**验证**：

```bash
B=http://43.108.100.116
for u in / /index.html /article.html /archive.html /about.html /404.html \
         /js/auth-ui.js /js/comments.js /css/comments.css; do
  printf '%-22s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' $B$u)"; done   # 全 200
curl -s $B/article.html | grep -ci 'waline'      # 期望 0：文章页不再引用 Waline
curl -s $B/index.html  | grep -ci 'auth-ui.js'   # 期望 ≥1：登录入口已挂上
```

---

## 9. 端到端验收（真公网入口）

用 t16 的脚本或等价 curl/浏览器流程，逐条记录到 `DEPLOY-RECORD.md` 第 9 节：

1. 注册 → 拿 cookie → 登录 → 发评论 → 列表可见 → 删自己的评论 → 列表不可见 → 登出后再删返回 401；
2. 两个账号验证 A 不能删 B 的评论（403）；
3. 错误口令连打触发限流（第 11 次 429 + `Retry-After`），且**不同来源 IP 不互相牵连**
   （这条同时在验 `--trust-proxy`、`--proxy-secret-file` 与 nginx 的 XFF 追加三者配对）；
4. 响应体全文不含 `password_hash` / `email` / `user_id`；
5. `ss -ltnp | grep -E '8850|3306'` 都只绑 `127.0.0.1`；
6. **直连 8850 不能冒充 nginx**：不带密钥头（或带伪造头）打 8850 必须 403，
   而经公网走 nginx 的同一请求必须 200（缺一不可）。

```powershell
# 本机（D:\DS）：真浏览器 15 项
node blog-enter/server/tests/verify-public-live.mjs
```

**验证**：上面 5 条逐条有结论（通过与失败都要写），失败项必须附最小复现命令；
脚本退出码 0 且报告里没有"跳过/未测"的条目。

---

## 10. 记录与交接

* 把实测结果（含失败项与最小复现）填进 `deploy/DEPLOY-RECORD.md` 第 9 节；
* 记下部署前后的 commit、伪静态备份文件名、全库备份路径；
* 回滚动作见 `DEPLOY-RECORD.md` 第 9 节（停用 `p3-public` / 回退 nginx 段 /
  重新启用 Waline / 库的备份与删除），**别临时想**。

**验证**：`DEPLOY-RECORD.md` 第 9 节的 TODO 全部被替换成实测值（不允许留
"待确认"），且 9.2 表里 commit、伪静态备份文件名、全库备份路径三项都能在原机
对上（`ls -la` 一下即可）。

## 11. 已知风险（本轮不解决，必须写进记录）

| 风险 | 说明 |
| --- | --- |
| 明文 HTTP | `--public-origin http://…` → cookie 不带 `Secure`，口令与会话在公网明文传输。域名 + 证书就绪后改 `https://…` 并补 `--public-host <域名>`。 |
| 限流共享桶 | 只在 `--trust-proxy` 被误删时才发生（见第 6 步的说明）——所以那一条是硬要求。 |
| 本机伪造 IP | 只在 `--proxy-secret-file` 或 nginx 的密钥头**任缺其一**时才发生：直连回环的进程可以自塞 XFF 伪造客户端 IP，限流与审计一起失效。两者是一对，见第 4/5/6 步。 |
| MySQL 托管方式 | `mysqld` 是**宝塔生成的 SysV 脚本**（`/etc/rc.d/init.d/mysqld`），不是原生 systemd 单元。将来升级/重装宝塔可能覆盖启动链，症状是「3306 又连不上」。异常先看 `/etc/init.d/mysqld` 与 `/www/server/data/mysql-bin.index`。 |
| 库口令存储 | `p3app` 口令只在 `/etc/p3blog/public.env`(600 root:blog)；root 口令在 `/root/p3-mysql-root.txt`(600) 与 `/etc/my.cnf [client]`(600 mysql:mysql)。仓库里**不得**出现任何口令。 |
| 邮箱验证码 | SMTP 未配置：本轮只建了 `email_verify` 表，服务不接入发信。 |
