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
```

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
```

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
