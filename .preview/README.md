# .preview —— 本地预览与验证工具

不是站点内容，只是一组可复现的检查脚本。默认假设仓库就在 `D:\DS`，
Chrome 在默认安装路径；换路径用下面的环境变量覆盖。

## 浏览器级验证（推荐，真实渲染）

先起静态服务器（另开一个终端），再跑检查：

```powershell
node .preview/serve.mjs                     # http://127.0.0.1:8848
node .preview/verify-dock.mjs               # 17 组断言 + 截图（时钟/黑胶/倾斜/拖拽/重置）
node .preview/check-layout.mjs              # 15 种窗口尺寸的溢出与重叠体检
node .preview/check-mobile-rm.mjs           # 移动端折叠展开 / reduced-motion / 二次入水
node .preview/verify-pages.mjs              # 内页 108 项功能断言 + 截图（关于我/归档/详情/404）
node .preview/verify-geo.mjs                # 极简几何页 47 项视觉体检（底板残留 / 悬停位移 / 对比度 / 7 种宽度）
node .preview/verify-final.mjs              # 收尾自检 35 项（资源与链接完整性 / 2560 与 320 边界 / 矮窗口抽屉 / reduced-motion / 键盘可达性）
```

### 管理端（上传 / 更改文章）

管理端自带一套验签，**不依赖浏览器**那部分可以直接跑：

```powershell
node blog-enter/server/tests/run-all.mjs          # 48 项：存储层 / 接口 / 页面草稿与别名逻辑
```

浏览器那一段需要 Chrome，并且要先把服务器起起来（它会真的点按钮、真的传图、真的删文章，
跑完自动还原 `posts.js`）：

```powershell
node blog-enter/server/dev-server.mjs             # 站点 + 管理页，http://127.0.0.1:8848/
node blog-enter/server/tests/verify-admin-ui.mjs  # CDP 无头 Chrome 全流程
```

两点值得记一下：

- **不要用 `node --test <目录>` 跑这套测试。** `node:test` 的 runner 要 spawn 子进程，
  在受限沙箱里会以 `spawn EPERM` 失败，看起来像"测试坏了"，其实是环境限制。
  `run-all.mjs` 改在当前进程内 import 测试文件（见 `server/tests/harness.mjs`），零 spawn。
- 服务端脚本（`blog-enter/server/**`）与被服务的站点无关：**删掉整个 `server/` 目录，
  站点照常工作**。管理页文件在 `blog-enter/admin/`，不被任何公开页面引用，
  静态托管时访问不到。


| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `SERVE_ROOT` | `D:\DS\blog-enter` | `serve.mjs` 服务的目录 |
| `PORT` | `8848` | 静态服务器端口 |
| `CHROME_PATH` | Chrome 默认安装路径 | 各 `.mjs` 用的浏览器 |
| `DOCK_URL` | `http://127.0.0.1:8848/index.html` | 被测页面 |
| `PREVIEW_OUT` | `D:\DS\.preview` | 截图输出目录（也可用第一个命令行参数） |

`verify-dock.mjs` 走 headless Chrome + CDP（Node 内置 WebSocket，无第三方依赖），
会用 `Input.dispatchMouseEvent` 派发真实鼠标事件、用 `DataTransfer` 造真实
`File` 测拖拽播放、结束时逐项打印 ok/FAIL。

> 无头渲染里 `requestAnimationFrame` 被强节流（每秒只有几帧），因此断言都写成
> "方向 + 量级"而不是"等缓动跑完"；复位路径直接派发 Chrome 离开元素时真正会发的
> `pointerleave`。这是测试环境的限制，不是页面行为。
>
> 另外 `vw` 在无头里可能比 `innerWidth` 小约 2%，所以尺寸断言留了余量。

## 截图 / 量测工具

```powershell
node .preview/shoot.mjs      # 静止 / 入场 / 倾斜 三张局部图（dial-rest|dial-intro|dial-tilt）
node .preview/tiltshot.mjs   # 强制满值倾斜，抓 dial-tilt-max / dial-tilt-opposite / page-tilt-max
node .preview/introshot.mjs  # 点亮后连拍，检查入场动画的过冲（f0..f9 与实时 scale/rotate）
node .preview/measure.mjs    # 打印表壳各层相对方盒的尺寸百分比，便于诊断占比/层级问题
node .preview/shots-pages.mjs     # 内页细节图：代码块 / 引用 / 配图 / 联系方式 / 时间线 / 移动端
node .preview/shot-entry.mjs      # 首屏（未入水那一屏）现状图 final-entry.png + 标题排版参数
node .preview/measure-fan.mjs 1440 900   # 扇形菜单几何：半径 / 字号 / 右边界余量 / 与时钟的间隙
node .preview/measure-contrast.mjs       # 页面头部背景的真实渲染亮度 vs 各文字色的对比度
node .preview/audit-geo.mjs              # 极简页的"深色底板漏网"审计（旧皮肤填充色是否还压在新皮肤上）
```

## 内页（关于我 / 归档 / 文章详情 / 404）

两套皮肤，同一批 HTML 骨架：

| 皮肤 | 用于 | 样式表 | 语言 |
| --- | --- | --- | --- |
| 深水底 | 404 | `css/pages.css` | 深青底 + 冷色玻璃面板，与"入水之后"衔接 |
| 极简几何 | 关于我、归档、文章详情 | `css/pages.css` + `css/geo.css`（+ 文章页再加 `css/prose-light.css`） | 纯白 + 发丝线 + 描边几何，与"入水之前"的首屏衔接 |

换肤的做法是**后加载一份同权重规则去覆盖**深色版，不是删掉深色样式。
于是漏覆盖的表现不是报错，而是"某一块还是深色的"。检查手段：

```powershell
node blog-enter/server/tests/check-light-skin.mjs   # 覆盖完整性：从 article.html 实际用到的 class 反推需求
```

它做四件事：① 逐条确认 `pages.css` 里文章页用到的颜色规则都有覆盖
（来源是 `geo.css` + `prose-light.css` 两份之和）；② 覆盖文件里不许出现深色背景；
③ 语法高亮每个 token 在白底代码块上的对比度必须 ≥ 4.5:1（现有 6.08~8.50:1）；
④ 职责分离 —— 正文排版不进 `geo.css`，骨架规则不重复进 `prose-light.css`。

**文章页的语法高亮是另一套色值**：深色版那组（`#ff7085` / `#8fe3a8` / `#ffd479` …）
在 `--g-paper` 上只有 1.5~2:1，等于看不清，所以不是微调而是换了一组深色 token。

`geo.css` 与 `pages.css` 同优先级、靠 `<link>` 顺序取胜，所以只覆盖它声明的部分；
**凡是要清掉旧皮肤填充色的地方必须显式写 `background: none` / `border-radius: 0` 等**
（`verify-geo.mjs` 的审计就是专门盯这类漏网的深色底板、卡片壳与投影）。

| 文件 | 作用 |
| --- | --- |
| `about.html` | 个人简介、技能分级、联系方式（邮箱 / GitHub / X）、圆形头像占位图 |
| `archive.html` | 分类（单选）+ 标签（多选，可叠加）筛选；列表 / 时间线双视图 |
| `article.html?slug=…` | 文章详情：元信息、标签、正文（代码块高亮 / 引用 / 图片）、评论区占位 |
| `404.html` | 与站点同风格的不存在页 |

几个容易踩的点，验证脚本里都有对应断言：

- **扇形菜单的右边界**：半径不是"最宽那条"能塞下就算 —— 扇形里一定有一条落在
  0°（正右方），且选中项还带 `scale(1.06)`。第一版按 max(width) 套 cos 角，
  1440 下最右只剩 18px、1600 以上直接溢出。现在逐条解、取最小（见 `menu.js` 的
  `layout()`），并额外把 `--spread` 折算回半径。
- **`.fan-list` 必须是 `width: 0`**（桌面端）：里面全是绝对定位子项，容器本身就是
  扇形的原点。但绝对定位子项在 0 宽包含块里会退化，所以 `.fan-item` 要显式
  `width: max-content`；而窄屏的堆叠态又要把这两个值都还回 `auto`，否则菜单整条跑出屏幕。
- **`article.html` 的两种 404**：slug 无效 → 就地渲染空状态（页面外壳与评论区都还在）；
  路径本身不存在 → 交给托管平台的 `404.html`。
- **浅底上的颜色档位**（`verify-geo.mjs` 用真实渲染像素复核）：
  `--sky #38bdf8` 在白底只有 2.14:1，只配做图形；小字一律用 `--sky-deep #0284c7`
  一档的深色（项目里叫 `--g-cyan-dk #0b6a97`，5.96:1）。
- **`currentColor` 的陷阱**：汉堡按钮第二根横线要与第一根不同色，必须显式写颜色 ——
  继承 `currentColor` 时它解析成按钮的 `color`，只改宽度不会变色。

## 静态检查（无需浏览器）

```powershell
python .preview/check.py           # SVG 合法性 / url(#id) 引用 / 图层顺序 / JS↔HTML↔CSS 交叉引用 / CSS 括号
python .preview/preview-dial.py    # 用 PIL 把表盘近似渲染成 dial-preview.png
python .preview/radius-check.py    # 表盘各圆环的半径与线宽覆盖关系
python .preview/handpath.py        # 三根指针的路径生成（见下）
python .preview/handprofile.py     # 从附图量出指针的"沿轴宽度剖面"（调造型时用）
```

### 指针造型（`handpath.py`）

指针不是手画的，而是按附图量出来的比例生成的：

1. `handprofile.py` 给出附图里两根针的轴（转轴 → 针尖），沿轴每 1.6% 取一条垂线，
   量出左右边界的宽度剖面 —— 时针 592px、分针 678px（附图里的像素长）。
2. `handpath.py` 把剖面归一化后乘上目标长度（时针 70 / 分针 94 / 秒针 100 用户单位），
   节点走 Catmull-Rom 转三次贝塞尔，左右镜像，镂空用 `fill-rule="evenodd"` 的子路径。
   脚本同时输出 `hand-paths.txt`（粘进 index.html 的 `d`）与
   `hands-{hour,minute,second,all}.png`（由生成的 `d` 采样渲染的预览）。

改造型只要改脚本里的 `*_PROFILE` 节点表，重跑后把 `hand-paths.txt` 覆盖回 index.html。

`preview-dial.py` 是"几何 + 配色"的近似，字体、混合模式、渐变都做了简化 ——
有浏览器时应以 `verify-dock.mjs` 的截图为准。

## 表壳几何参考（viewBox 240×240）

| 元素 | 半径 / 线宽 | 说明 |
| --- | --- | --- |
| `.dial-bplate` | r 114.5，圆心下移 8 | 厚度侧面，只在 3D 倾斜时露出来 |
| `.dial-bezel` | r 112，线宽 16（104~120） | 金属表圈，外径占方盒 93.3% |
| `.dial-knurl-line` | r 106~118，每 2° 一根 | 滚花细齿，明暗交替 |
| `.dial-face` | r 74，线宽 44（52~96） | 盘面，中心 r<46 挖空留给黑胶 |
| `.dial-q` | r 85，线宽 12（79~91） | 四象限分段色环 |
| `.dial-numeral` | r 76 | 罗马数字 |
| `.dial-rail` | r 53~90，每 3° 一根 | 放射状阴影线 |
| `.vinyl-disc` | 方盒的 44% | 黑胶，r=52.8（正好盖住盘面挖空） |
| `#dialHour` | 长 70（针尾 -10.85） | 叶形时针 |
| `#dialMin` | 长 94（针尾 -14.1） | 镂空卷草分针 |
| `#dialSec` | 长 100（针尾 -24） | 细针秒针 |

层级：`.dial-scene` 里三层同级子元素 —— `.dial-clock`（表壳，z=auto）、
`.dial-vinyl`（黑胶，z=2）、`.dial-hands`（指针，z=3，`pointer-events: none`）。

倾斜：外层满值 `rotateX/rotateY` 16deg、黑胶反向 8deg、指针层取中间 12deg（CSS 里的
`--tilt-x/--tilt-y` 由 `dock.js` 写入的 `--mx/--my` 推导），透视 620px。

指针角度不走 SVG 的 `transform` 属性，而是 `dock.js` 写 `--rot-h / --rot-m / --rot-s`、
CSS 算 `rotate()` —— 在 SVG 元素上 CSS 的 `transform` 会整体盖掉属性，
写成属性的话三根针会永远停在 12 点。

## 产物

截图（`dial-*.png`、`dock-*.png`、`page-*.png`、`dial-preview.png`）与 CDP 的
浏览器 profile 目录都被 `.gitignore` 排除，不会入库。
