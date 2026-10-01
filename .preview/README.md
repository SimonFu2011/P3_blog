# .preview —— 本地预览与验证工具

不是站点内容，只是一组可复现的检查脚本。默认假设仓库就在 `D:\DS`，
Chrome 在默认安装路径；换路径用下面的环境变量覆盖。

## 浏览器级验证（推荐，真实渲染）

先起静态服务器（另开一个终端），再跑检查：

```powershell
node .preview/serve.mjs                     # http://127.0.0.1:8848
node .preview/verify-dock.mjs               # 15 组断言 + 截图
node .preview/check-layout.mjs              # 15 种窗口尺寸的溢出/重叠体检
node .preview/check-mobile-rm.mjs           # 移动端折叠展开 / reduced-motion / 二次入水
```

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `SERVE_ROOT` | `D:\DS\blog-enter` | `serve.mjs` 服务的目录 |
| `PORT` | `8848` | 静态服务器端口 |
| `CHROME_PATH` | Chrome 默认安装路径 | `verify-dock.mjs` / `check-*.mjs` 用的浏览器 |
| `DOCK_URL` | `http://127.0.0.1:8848/index.html` | 被测页面 |
| `PREVIEW_OUT` | `D:\DS\.preview` | 截图输出目录（也可用第一个命令行参数） |

前两个 `.mjs` 走 headless Chrome + CDP（用 Node 内置 WebSocket，无第三方依赖），
会用 `Input.dispatchMouseEvent` 派发真实鼠标事件、用 `DataTransfer` 造真实
`File` 测拖拽播放、并在结束时打印逐项 ok/FAIL。

> 无头渲染里 `requestAnimationFrame` 会被强节流，因此断言都写成"方向 + 量级"
> 而不是"等缓动跑完"；复位路径则直接派发 Chrome 离开元素时真正会发的
> `pointerleave`。这是测试环境的限制，不是页面行为。

## 静态检查（无需浏览器）

```powershell
python .preview/check.py           # SVG 合法性 / url(#id) 引用 / 图层顺序 / JS↔HTML↔CSS 交叉引用 / CSS 括号
python .preview/preview-dial.py    # 用 PIL 把表盘近似渲染成 dial-preview.png
python .preview/radius-check.py    # 表盘各圆环的半径与线宽覆盖关系
```

`preview-dial.py` 是"几何 + 配色"的近似，字体、混合模式、渐变都做了简化 ——
有浏览器时应以 `verify-dock.mjs` 的截图为准。

## 产物

截图（`dock-hover-tilt.png`、`dock-playing.png`、`dock-drop-reject.png`、
`dock-mobile-open.png`、`dial-preview.png`）与 CDP 的浏览器 profile 目录
都被 `.gitignore` 排除，不会入库。
