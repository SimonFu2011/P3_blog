# 站点外壳 —— 收起侧边栏 / 访问统计 / 标签云

这份文件说明三个"跨页部件"怎么用、怎么改、怎么关。
实现只有两个文件，五页都加载，并且**必须排在每一份皮肤之后**：

```
css/shell.css   组件与三种皮肤的别名（--ui-*）
js/shell.js     收起偏好、统计计数、文案镜像
```

加载顺序（以"文章详情"举例，其余页面少哪份皮肤就跳过哪份；`shell.css` 永远收尾）：

```
pages.css → geo.css → prose-light.css → comments.css → shell.css → </head>
<script src="js/shell.js"></script>        ← 在 <head>，不能加 defer
```

`js/shell.js` 用同步脚本是**故意的**：收起偏好要在首屏绘制之前写进
`<html data-nav>`，否则每次刷新都会看到侧边栏"先展开、再收起"地抽一下。
它开头只做一次 localStorage 读取，不碰 DOM，其余都延后到 DOMContentLoaded。

---

## 1. 侧边栏收起 / 展开（桌面端 ≥981px）

- 按钮：`<button class="nav-rail" data-nav-collapse>`，挂在 `.nav-bar` 里；
  ≤980px 由 `shell.css` 隐藏 —— 那一档侧边栏是顶部抽屉（MENU 按钮），两件事互不干扰。
- 状态：`<html data-nav="collapsed|open">`；偏好存 `localStorage['p3.shell.nav']`。
- 展开 = 完整文字菜单（268 / 292px）；收起 = 76px 图标栏：品牌缩写 + 三枚图标 + 返回箭头。
- 图标来自每条 `.nav-link` 里的 `<span class="nl-ic"><svg …></svg></span>`，
  颜色/线宽由 CSS 给（`stroke: currentColor`，`shell.css` 里再钉一道可见色），
  所以换页面皮肤不用改 SVG。
- 悬停 / 键盘聚焦时，图标右侧浮出 `data-tip` 气泡（文字由 `shell.js` 从导航文案镜像，
  不额外维护一份清单）；品牌缩写取站名首字（`SITE.name` → "S"）。
- 快捷键：`[` 收起/展开（输入框里打字、以及移动端抽屉打开时不接管）。
- 要加一个新栏目：在 `.nav-list` 里加一条 `<a class="nav-link">`（含 `.nl-en`、`.nl-cn`、
  `.nl-ic`），并在 `js/data.js` 的 `SITE.menu` 里同步 —— 两边条数必须相等，
  否则 `pages.js` 的文案同步会整块跳过并告警。

## 2. 访问统计

位置：内页插在页脚之前（文档流里一行，不压任何东西）；首屏挂在 `.world` 左下角、
入水后才淡入。开关与数据源都在 `js/data.js`：

```js
stats: {
  enabled: true,
  endpoint: '',      // 例如 '/api/stats'；留空 = 只用本机记录
  timeout: 4000,     // 后端请求超时(ms)
  keepDays: 60       // 本机记录只保留最近多少天
}
```

- **默认（本机记录）**：`localStorage['p3.shell.visits']` 累计 PV 与每日 PV，
  界面右下角如实写"本机记录 · 未接后端"。三个槽位是
  总访问量 / 今日访问量 / **已记录天数** —— 本机数不出真 UV，就不摆一个假的 1。
- **接后端**：把 `endpoint` 指到一个同源接口，返回
  `{ "total": 1234, "today": 56, "visitors": 789 }`（三个都必须是非负数字，
  缺一个就当没拿到）。拿到之后槽位换成 总访问量 / 今日访问量 / **访客数**，
  来源标注变成"数据来自站点后端"。
- 请求失败或超时会静默退回本机记录 —— 统计条永远不会因此空掉或报错。
- 关闭：`stats.enabled = false`（`shell.js` 直接不注入）。

## 3. 标签云（归档页）

- 容器：`archive.html` 的 `.filters` 里 `<div class="tagcloud" id="tagCloud">`；
  渲染与交互在 `js/archive.js` 的 `renderCloud()`。
- 与上面的"标签"胶囊是**同一个维度**的两种画法，共用 `State.tags`：
  胶囊是精确开关，云是按热度浏览；任何一边点完，另一边的高亮立刻同步。
- 热度 = 该标签下的文章数，归一化成 `--heat`（0~1）写在按钮上；
  字号 = `--tc-min + --heat × --tc-range`（两端由 CSS 定，脚本只给热度），
  颜色分三档（`data-heat="cool|warm|hot"`）—— CSS 没法对变量做区间判断，
  三档色 + 连续字号既够表达热度，也更好控对比度。
- `全部` = 清空**所有**筛选（含分类），也就是"恢复完整列表"，调 `clearAll()`；
  它与胶囊里的"不限"含义不同，别合并。
- 重画后焦点会还给同一枚标签（键盘用户按回车不会掉焦点）；
  悬停是"变红 + 抬起 2px + 浅底"，选中是"浅底 + 下沿重音线"。
- 一个标签都没有时整行自动隐藏。

---

## 改样式时的注意

- 组件只认 `--ui-*` 别名（`--ui-fg / --ui-fg-2 / --ui-mute / --ui-cyan / --ui-accent /
  --ui-line / --ui-line-2 / --ui-panel-2 / --ui-tip-*`）。
  新增皮肤只要覆盖这组别名，组件规则一条都不用动。
- 三级圆角是统一的：`--ui-r-card` 2px（面板 / 气泡）、`--ui-r-pill` 999px（胶囊）、
  寄存器行保持直角 0（靠发丝线分隔，不靠边框）。
- 间距/字号走 `--ui-sect-gap / --ui-head-gap / --ui-body-gap / --ui-fs-xs / --ui-fs-sm`，
  两页的小节节奏因此同源。
- 别在 `shell.css` 里写评论区或登录入口的样式：
  `.preview/check-static.mjs` 有一条断言盯着这件事（它保证 `shell.css` 可以
  收尾在 `comments.css` 之后而不破坏"comments.css 覆盖旧评论区"的前提）。

## 验证

```powershell
node .preview/serve.mjs            # 另开一个终端：http://127.0.0.1:8848
node .preview/verify-shell.mjs     # 64 项：收起 / 统计 / 标签云 / 两页一致性 / 13 种宽度 + 截图
```
