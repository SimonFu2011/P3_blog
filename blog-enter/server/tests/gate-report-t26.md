# t25 部署前闸门报告：确认 t24 两处修复已闭环

- 任务：t25（验证/闸门），attempt 2，attempt_id `858d2cd1-9cf5-42e9-9e2c-1dae2290605e`
- 执行者：verifier（独立于实现者）
- 时间：2026-10-06 18:10–18:15
- 被测文件（快照，读取时未改动）：
  - `deploy/bin/p3-fix-repo-perms.sh` — sha256 `EEA56B064299ABEBD342415DE1034C14D7D4A99F5ACC74AD5736ED964D60E8CC`，mtime 2026-10-06 18:10:50，247 行（LF，无 CR）
  - `deploy/PLAN-PUBLIC-LOGIN.md` — sha256 `F84B2B7D685AA9B66CB4171AB4253E40D4965E19E32CE95132BF860249978D47`，mtime 2026-10-06 18:11:12
- 行为证据的边界：**服务器上只在 `/tmp` 建临时目录做 `chmod`/`stat`**，不碰 `/srv/blog/repo`、不改任何配置或产品文件；本任务未修改任何产品文件（唯一的写操作是本报告文件）。
- 证据标注约定：每条判据显式标注 **[服务器实测]** 或 **[静态阅读/grep]**；未实测的写在末尾「未实测」小节，不以静态结论冒充行为验证。

## 结论

**四项修复是否全部到位：是（4/4 到位）。** 其中第 1 条（setgid 语义）已用 Linux coreutils 实测闭环；第 2/3/4 条为静态核对（第 3 条的退出码语义是静态判读，理由见「未实测」）。无阻塞项。

| # | 被判定的修复 | 判据 | 方法 | 结论 |
|---|---|---|---|---|
| 1 | `p3-fix-repo-perms.sh`：`ADMIN_MODE=00700` + `chmod a-s` 兜底 | 2775→`0700` 停在 2700（缺陷）；`00700` 与 `0700`+`a-s` 得到 700（修复） | **[服务器实测]** | 到位 |
| 2 | `PLAN-PUBLIC-LOGIN.md`：`-m 755 -o root -g blog` + 两条守护验证 | 含 755、不含 750；两条守护验证在场 | **[静态阅读/grep]** | 到位 |
| 3 | `--check` 按 `failures` 返回非 0 | 分支代码按 `failures` 决定 exit 1/0 | **[静态阅读/grep]** | 到位 |
| 4 | 脚本头注释 `root:blog` → `blog:blog` | 指示性语句均为 blog:blog；残留 2 处 `root:blog` 是否定句 | **[静态阅读/grep]** | 到位（附 1 条观察） |

---

## 判据 1：Linux 上实测 setgid 语义 **[服务器实测]**

命令（单行，无 CRLF；PowerShell 单引号包裹，`$` 原样传给远端 shell）：

```bash
ssh root@43.108.100.116 'uname -s; stat --version | head -1; T=$(mktemp -d) && mkdir -p $T/x && chmod 2775 $T/x && echo after-2775=$(stat -c %a $T/x) && chmod 0700 $T/x && echo four-digit-0700=$(stat -c %a $T/x) && chmod 2775 $T/x && chmod 00700 $T/x && echo five-digit-00700=$(stat -c %a $T/x) && mkdir -p $T/y && chmod 2775 $T/y && D=00700 && chmod "$D" $T/y && echo var-00700=$(stat -c %a $T/y) && mkdir -p $T/z && chmod 2775 $T/z && D4=0700 && chmod "$D4" $T/z && echo var-0700=$(stat -c %a $T/z) && chmod a-s $T/z && echo after-a-s=$(stat -c %a $T/z) && ls -ld $T/x $T/y $T/z && rm -rf $T && echo cleaned=$(test -d $T && echo no || echo yes)'
```

原始输出（逐字）：

```
Linux
stat (GNU coreutils) 8.30
after-2775=2775
four-digit-0700=2700
five-digit-00700=700
var-00700=700
var-0700=2700
after-a-s=700
drwx------ 2 root root 4096 Oct  6 18:13 /tmp/tmp.FDlHUxsEax/x
drwx------ 2 root root 4096 Oct  6 18:13 /tmp/tmp.FDlHUxsEax/y
drwx------ 2 root root 4096 Oct  6 18:13 /tmp/tmp.FDlHUxsEax/z
cleaned=yes
```

判读：

- `after-2775=2775`：前置状态确实带上 setgid（测试装置有效，不是空操作）。
- `four-digit-0700=2700`：**四位数 `chmod 0700` 清不掉 setgid，停在 2700** —— t24 缺陷 1 被复现。
- `five-digit-00700=700`：脚本现在的写法（`ADMIN_MODE=00700`）得到精确 700。
- `var-00700=700`：用**引用变量**（`chmod "$D"`，与脚本第 197 行 `chmod "$ADMIN_MODE" "$ADMIN_DIR"` 同构）同样是 700 → 修复在实际写法下成立，而不只是字面量成立。
- `var-0700=2700` + `after-a-s=700`：即使将来有人把 `ADMIN_MODE` 改回四位数，第 199 行的 `chmod a-s` 兜底仍能把特殊位清掉 → 兜底有效。
- `ls -ld` 三个目录都是 `drwx------`（700）；`cleaned=yes` 临时目录已删。

### 判据 1 补充：在 `/tmp` 复刻脚本的完整两步（含 `find -type d` 与 `.admin` 复位）**[服务器实测]**

命令：

```bash
ssh root@43.108.100.116 'T=$(mktemp -d) && mkdir -p $T/repo/.admin $T/repo/blog-enter/js && touch $T/repo/.admin/passphrase.json && chmod 0777 $T/repo/blog-enter && echo initial-dir=$(stat -c %a $T/repo/blog-enter) && echo initial-admin=$(stat -c %a $T/repo/.admin) && find $T/repo -type d -exec chmod 2775 {} + && echo after-find-admin=$(stat -c %a $T/repo/.admin) && echo after-find-dir=$(stat -c %a $T/repo/blog-enter) && chmod 00700 $T/repo/.admin && echo after-00700=$(stat -c %a $T/repo/.admin) && chmod a-s $T/repo/.admin && echo after-a-s=$(stat -c %a $T/repo/.admin) && echo COUNTERFACTUAL: && chmod 2775 $T/repo/.admin && chmod 0700 $T/repo/.admin && echo four-digit-only=$(stat -c %a $T/repo/.admin) && ls -ld $T/repo $T/repo/.admin && rm -rf $T && echo cleaned=$(test -d $T && echo no || echo yes)'
```

原始输出（逐字；注意 `ls -ld` 在「反例」之后执行，所以 `.admin` 显示的是反例状态 2700）：

```
initial-dir=777
initial-admin=755
after-find-admin=2775
after-find-dir=2775
after-00700=700
after-a-s=700
COUNTERFACTUAL:
four-digit-only=2700
drwxrwsr-x 4 root root 4096 Oct  6 18:13 /tmp/tmp.qVwqWkO6m1/repo
drwx--S--- 2 root root 4096 Oct  6 18:13 /tmp/tmp.qVwqWkO6m1/repo/.admin
cleaned=yes
```

判读：`find -type d` 把 `.admin` 一起置成 2775（复刻脚本第 187 行的副作用，注释里说的就是这个坑）→ 第 197 行 `00700` + 第 199 行 `a-s` 之后为 `700`；反例仍停在 `2700`（`drwx--S---` 的 S 就是 setgid 位置保留的直观证据）。

---

## 判据 2/3/4：静态核对 **[静态阅读/grep]**

### 2.1 `bash -n`（语法）

命令与输出：

```
$ "C:/Program Files/Git/bin/bash.exe" -n deploy/bin/p3-fix-repo-perms.sh
exit=0
```

### 2.2 脚本关键行（行号 = 按 LF 切分的 1-based 行号，与 `Select-String` 一致；文件 247 行、0 个 CR）

| 行 | 内容 | 对应判据 |
|---|---|---|
| 66 | `ADMIN_MODE=00700` | 修复 1（五位数） |
| 187 | `find "$REPO" -type d -exec chmod "$DIRMODE" {} +` | 复位必须在它**之后** |
| 197 | `chmod "$ADMIN_MODE" "$ADMIN_DIR"` | 修复 1（复位段；187 之后 ✓） |
| 199 | `chmod a-s "$ADMIN_DIR"` | 修复 1（兜底；187 之后 ✓） |
| 200 | `echo "  .admin：$(stat -c '%a' "$ADMIN_DIR") $OWNER:$OWNER（…）"` | 打印**实际模式**（`stat`），不是回显变量 ✓ |
| 121–124 | `if [ "$(stat -c '%a %U %G' "$ADMIN_DIR" …)" = "700 $OWNER $OWNER" ]` → `verdict …` | 行为校验用 `stat` 实测值 ✓ |
| 228–231 | `if [ "$failures" -gt 0 ]; then … exit 1` | 主（修复）分支按 failures 非 0 退出 ✓ |
| 241–243 | `--check)` … `if [ "$failures" -gt 0 ]; then … exit 1; fi` / `echo "== --check 结论：PASS =="; exit 0` | 修复 3：`--check` 按 failures 返回非 0 ✓ |
| 245 | `*) echo "用法：p3-fix-repo-perms [--check]" >&2; exit 2 ;;` | 未知参数 exit 2 |

- 「`.admin` 复位段位于 `find -type d` 之后」：`find` = 187，复位 = 197/199/200 → **成立**（且 191–193 的注释明确写了「这一步必须在 find -type d 之后」）。
- 「`stat -c '%a'` 用于打印实际模式」：第 200 行用的是 `$(stat -c '%a' …)`；脚本里没有把 `$ADMIN_MODE` 当结果回显的地方。

### 2.3 修复 4：属主注释

- 指示性语句全部是 `blog:blog`（第 11、33、35、38、40 行等）。
- 仍存在 **2 处** 字符串 `root:blog`，均为**否定句**，不构成未修：
  - 第 12 行：`#      不做 chown -R root:blog —— 属主本来就是 blog，见下面「为什么属主保持」）`
  - 第 33 行：`# 【为什么属主保持 blog:blog，不做 chown -R root:blog】`
- 结论：修复 4 到位；**观察**见下节第 1 条（给做 grep 审计的人）。

### 2.4 PLAN 核对

命令与输出：

```
install -d -m 755 命中: 1
install -d -m 750 命中: 0

130: useradd --system --no-create-home --shell /usr/sbin/nologin p3public
150: install -d -m 755 -o root -g blog /etc/p3blog
182: sudo -u blog test -r /etc/p3blog/proxy-secret && echo blog-can-read-admin-proxy-secret-ok
184: systemctl is-active p3-admin && echo p3-admin-active-ok
```

- `install -d -m 755` 在场、`install -d -m 750` **0 命中** ✓（口径：`755` = root 拥有、其他可读，`blog` 组成员可读；避免 `-g p3public` 让 `p3-admin` 重启后读不到 `proxy-secret` 而 exit 5）
- 两条守护验证在场（182/184）✓
- `useradd --system --no-create-home --shell /usr/sbin/nologin p3public` 在场（130）✓

---

## 观察（非阻塞，供审计口径参考）

1. **[静态阅读/grep]** 若用「`grep -c root:blog` 必须为 0」这种零命中口径审计修复 4，会得到 2（第 12、33 行）。这两处是否定句（"不做 chown -R root:blog"），语义正确；但若希望审计脚本能机械判定，可把它们改写成不含 `root:blog` 字面量的说法（例如「不做 chown -R 到 root」）。
2. **[静态阅读/grep]** 字符串 `chmod a-s` 在脚本里出现两次：第 63–65 行是**说明文字**（解释五位 vs 四位的差别），第 199 行才是**命令**。按「必须含 `chmod a-s`」做 grep 审计时请以第 199 行（命令位）为准，避免误把注释当实现。
3. **[静态阅读/grep]** `DIRMODE=2775`（第 52 行）/ `FILEMODE=664`（第 53 行）本轮未变，不在四项修复范围内；它们正是"会把 `.admin` 一起放开、所以必须复位"的前提。

## 未实测（不得视为已验证）

1. **`--check` 退出码的运行时行为**：仅静态判读（第 241–243 行）。脚本第 44–49 行把 `REPO=/srv/blog/repo`、`ETC=/etc/p3blog`、`SECRET=$ETC/public-proxy-secret` 写死为绝对路径，本任务的边界是"只在 `/tmp` 做 chmod/stat、不碰 `/srv/blog/repo`"，因此没有对生产树跑 `--check`，也没有为了跑它去改脚本副本（改副本得到的结论不能代表真文件）。按契约，本条的**唯一行为判据**是 setgid 语义，已实测。
2. **`p3-fix-repo-perms.sh` 修复模式（无参数）在真实树上的端到端结果**：未实测（属部署动作，由 t18 执行；本任务不得触碰 `/srv/blog/repo`）。部署时应观察：脚本退出码为 0、且 `.admin` 为 `700 blog:blog`。
3. **`p3public` / `blog` 账号在真实环境下的读权限**（`verdict` ③④ 的运行结果）：未实测（需要真实账号与真实文件，属 t18 的部署验收）。
