# 本地文章管理（上传 / 更改 / 删除 / 图片）

离线写文章、改文章、传图片，然后 `git push` 发布。**只有你的这台机器能改** ——
不是"藏起来的管理页"，而是公开发布的那份产物里根本不存在管理页与写接口。

---

## 1. 启动

```powershell
node blog-enter/server/dev-server.mjs
```

打开 <http://127.0.0.1:8848/_admin/>。

| 命令 | 作用 |
| --- | --- |
| `node blog-enter/server/dev-server.mjs` | 起服务（站点 + 管理页），端口 8848 |
| `... --port 9000` | 换端口 |
| `... --set-pass --pass "你的口令"` | 设访问口令（可选，见第 5 节） |
| `... --clear-pass` | 清除口令 |
| `... --runtime <目录>` | 换运行时目录（默认 `.admin/`） |

管理页里的操作：

* **新建 / 编辑**：左边选文章，右边改字段与正文，预览区实时渲染。
* **正文是 HTML 片段**（跟原来一样），工具条负责插入常用结构：
  段落 / 小标题 / 列表 / 引用 / 代码块 / 配图 / 链接。
  刻意**不做 Markdown 隐式转换** —— 那种转换会在"你写的"和"页面渲染的"
  之间插一层，出问题时最难查。
* **图片**：点「上传图片」，或者直接把图**拖进正文框**，或者 `Ctrl+V` 粘贴。
  服务端按文件内容判断类型（png/jpeg/gif/webp/svg），重新起一个安全文件名，
  存进 `blog-enter/img/uploads/`，并自动插入 `<figure>`。SVG 会过一遍净化。
* **草稿**：勾上「草稿」后，归档页不会列出它、也不计数；
  详情页需要 `article.html?slug=xxx&preview=xxx` 才能看。
* **改 slug**：旧地址会自动记进 `aliases`，老外链仍然能打开，并自动跳转到新地址。
* **删除**：内容先搬进 `.admin/trash/`，需要时可以手动恢复。
* **提交**：左栏底部「提交到 git」。提交前会先复核所有文章
  （能求值、正文能过安全检查），不通过就拒绝提交。**push 仍然由你在终端做。**

快捷键：`Ctrl/⌘+S` 保存（其实写完就落盘了），`Esc` 关抽屉。

---

## 2. 数据写到哪里

唯一真源还是 **`blog-enter/js/posts.js`**。保存时：

1. 解析出每篇文章在源码里的字符区间；
2. **只替换被改动的那几篇**，其余文章逐字节保留（注释、缩进、空行都不动）；
3. 重新求值复核，逐字段比对上一步的预期；
4. 备份旧文件 → 原子写（临时文件 + rename）。

任何一步不过就**拒绝保存**，宁可让你重来一次，也不把文件写坏。
旧文件都在 `.admin/backups/`（滚动保留 20 份），管理页的「备份 / 图片 / 日志」
面板里可以一键恢复。

---

## 3. 权限：为什么只有你能改

| 层次 | 做法 |
| --- | --- |
| 不出现在产物里 | 管理页与 `/api/*` 只在这个本地进程的路由里存在；静态发布时没有它们 |
| 只监听本机 | 服务只绑 `127.0.0.1`，没有"顺手绑 0.0.0.0"的开关 |
| 拒绝被转发进来 | 每个请求都检查对端地址必须是回环 |
| 防 DNS rebinding | `Host` 头必须是本机名 + 本次端口 |
| 防跨站请求 | `Origin` / `Referer` / `Sec-Fetch-Site` 必须同源 |
| 防误触 | 所有写操作要一次性会话令牌，令牌每次启动重新生成，只发给本站页面 |
| 可选第二把锁 | 口令用 PBKDF2-SHA256（21 万轮 + 随机盐）存哈希；失败退避 1s→30s 冷却 |
| 输入校验 | 每个字段 + 正文 HTML 都过一遍检查（脚本标签、事件属性、`javascript:` 一律拒） |
| 图片 | 按魔数判类型、服务端重新命名、SVG 走标签白名单净化 |
| 发布 | `git add/commit` 只跑白名单子命令、参数以数组传递（不过 shell） |

**没做的**：没有把管理页做成"带登录的后台"。纯静态站点前端做鉴权是假安全，
所以这里的边界是**本机文件系统 + git 权限**，口令只是本机上的第二道锁。

---

## 4. 验证

```powershell
# 单元 + 接口 + 页面逻辑，共 48 项，不需要浏览器
node blog-enter/server/tests/run-all.mjs

# 真实浏览器走完整个流程（需要 Chrome，且要先把服务器起起来）
node blog-enter/server/dev-server.mjs
node blog-enter/server/tests/verify-admin-ui.mjs
```

`verify-admin-ui.mjs` 会用无头 Chrome 真的点按钮、真的上传一张图、
真的删掉一篇文章，然后验证公开页面（归档 / 详情 / 草稿可见性），
跑完自动还原 `posts.js` 并清理测试图片。

覆盖到的判据（`api.test.mjs` 里逐条有对应用例）：

* Host 白名单：`evil.example`、端口不符、缺 Host → 403
* 跨站：`Origin` / `Sec-Fetch-Site: cross-site|same-site` → 403
* 令牌：缺失 401、错误 403；口令模式未解锁 → 401，冷却期内正确口令也 429
* 路径：`%2e%2e` 越界、`.admin`/`.preview` 等隐藏目录 → 403/404
* 校验：坏 slug、非法日期、`<script>`、事件属性、`javascript:`、重复 slug → 422 且文件不动
* 并发：过期版本号 → 409（不静默覆盖）
* 图片：伪装成 `.png` 的 HTML → 422；`../../` 文件名 → 被净化
* 写坏防线：手工把危险正文塞进 `posts.js` → 提交被拒

---

## 5. 口令（可选）

不设口令时，安全性完全依赖"只监听本机 + 同源判定 + 会话令牌"，对单人机器足够。
如果这台机器别人也用（或你常开着管理页），建议加口令：

```powershell
node blog-enter/server/dev-server.mjs --set-pass --pass "一串只有你知道的口令"
```

之后打开管理页需要输入口令。忘了就 `--clear-pass` 清掉（这相当于"本机物理访问
即可重置"，符合本机工具的定位）。

---

## 6. 回滚

| 场景 | 做法 |
| --- | --- |
| 刚保存完发现写错了 | 管理页「备份 / 图片 / 日志」→ 选上一份备份 → 恢复 |
| 已提交 | `git revert <sha>` 或 `git checkout <sha> -- blog-enter/js/posts.js` |
| 误删了文章 | 内容在 `.admin/trash/`，把 JSON 里的字段粘贴回管理页即可 |
| 图片传错了 | `blog-enter/img/uploads/` 下直接删文件；正文里的引用自己清一下 |

---

## 7. 文件一览

| 路径 | 说明 |
| --- | --- |
| `blog-enter/server/dev-server.mjs` | 服务入口（也是模块：`createApp()` 可供测试同进程启动） |
| `blog-enter/server/lib/posts-store.mjs` | 文章源码的读 / 改 / 写（区间替换 + 沙箱求值 + 复核） |
| `blog-enter/server/lib/validate.mjs` | 字段校验与正文 HTML 检查 |
| `blog-enter/server/lib/images.mjs` | 魔数判类型、文件名净化、SVG 净化 |
| `blog-enter/server/lib/security.mjs` | 对端 / Host / Origin / Sec-Fetch-Site 判定与安全头 |
| `blog-enter/server/lib/auth.mjs` | 会话令牌、口令哈希、失败退避 |
| `blog-enter/server/lib/backup.mjs` | 备份与回收站 |
| `blog-enter/server/lib/git.mjs` | 白名单 git 操作（不可用时自动降级） |
| `blog-enter/admin/` | 管理页 UI（随仓库走；不被任何公开页面引用） |
| `blog-enter/server/tests/` | 48 项验签 + 浏览器段脚本 |
| `.admin/` | 运行时数据：会话、口令哈希、备份、回收站（**已 gitignore**） |
