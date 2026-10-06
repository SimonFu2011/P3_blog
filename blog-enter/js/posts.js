/* ============================================================
   文章数据 —— 归档页与文章详情页的唯一数据源
   ------------------------------------------------------------
   为什么是 .js 而不是 .json：
   本站是纯静态站点，用 file:// 直接双击打开时 fetch('posts.json')
   会被 CORS 拦掉（file:// 下 fetch 基本不可用）。写成全局变量 + <script>
   引进来，双击 HTML 也能正常出内容。
   接真实后端时，把 window.POSTS 换成一次接口请求即可，
   下面每条记录的形状（slug / title / date / category / tags / excerpt / body）
   就是接口该返回的字段。

   date 一律 'YYYY-MM-DD'：归档页的"按年月归档"直接切字符串前 4 位 / 5-7 位，
   不做 Date 解析 —— 避免时区把跨月的那几条推错月份。
   body 是 HTML 片段，由 article.html 交给 js/article.js 注入。
   ============================================================ */
window.POSTS = [  /* pushtest */

  {
  slug: 'verify-image-post',
  title: '图片保留验证',
  date: '2026-10-06',
  category: '测试',
  tags: ['verify'],
  excerpt: '验证图片不会再被发布流程删掉，并会自动同步到 GitHub。',
  body: '<p>这条用来验证图片链路。</p>\n<img src="img/uploads/verify-image.png" alt="验证图片">'
},

  {
  slug: 'post-20261006',
  title: '无题',
  date: '2026-10-06',
  category: '现代诗',
  tags: ['写作'],
  body: '<p>无题\n\n她踏着七六拍的步子向大海走去，\n腰间的随身听放着 Nujabes 的《The Final View》。\n根本没有这样的场景。\n\n海很宽，很广，总是反刍着蓝光。\n好冷。\n\n小帆几许，漂在一片蓝上，对着朵朵白云。\n云，小小的，说是像棉花糖，不如说是像棉花。\n\n"不对。"\n她在水里吐着泡泡，\n"太重了，那本来该是轻的！好轻好轻……"\n\n她在咳嗽，\n水灌进了咽喉。\n每一下都同工厂里的动力锤沉重，有力。\n\n她在水里打着滚，\n是挣扎，还是玩耍？\n\n"我抓住了！"\n\n你抓到了什么？\n\n她摊开左手——那是她的右手。\n\n她站我前面说："帮我拍张照。"\n我拿着相机。\n\n我说："你头低一点。"\n她昂起了头，\n不想抬头也行，你笑一下。\n她还是摆着扑克脸，\n我不想拍了。\n\n"世界本来就没有定义。"\n\n海风吹着淡淡的浪，\n云飘着无题的诗篇。\n我没说话，只是看着。\n\n少女倒挂在水里，吐着一个又一个的泡泡。\n取景器里的还是那片蓝。\n\n我对焦，\n她清晰了，海模糊了。\n我对海对焦，\n她不在了。\n\n于是我向大海走去。\n腰间的随身听放着 Colour 的《Conversations》。\n没有什么拍号，本来就是乱的。</p>\n\n<figure>\n  \n  <figcaption></figcaption>\n</figure>\n'
},

  {
  slug: 'water-entry',
  title: '落水而入：把入场动画交给文档时间轴',
  date: '2025-08-26',
  category: '前端',
  tags: ['CSS', '动画', '性能'],
  excerpt: '入场那段"坠入水中"最早是 JS 每帧写样式驱动的。改成 @property 注册数值 + CSS 动画之后，主线程被节流也不会卡在半途。',
  body: '<p>首屏只有一个动作：从纯白的水面之上，坠入青蓝的水下。看起来是"一个动画"，实际上它由三件互相独立的事情拼成 —— 水位上升、波纹扩散、面板点亮。最早我把三件事全写进一个 rAF 循环里，每帧算一次进度、每帧写一批 CSS 变量。</p>\n<h2>问题出在"谁拥有时间"</h2>\n<p>JS 驱动的动画有一个绕不开的前提：<strong>每一帧都得有人来推</strong>。一旦主线程被长任务占住、或者页面切到后台，推送就断了。表现出来就是水位停在半途、恢复后"跳"一下到终值。</p>\n<p>CSS 动画不一样。它跑在合成器那一侧的时间轴上，主线程忙不忙与它无关（前提是只动 <code>transform</code> / <code>opacity</code> 这类可合成的属性）。所以正确的分工是：</p>\n<ul>\n  <li><strong>可视的连续量</strong>（水位、位移、透明度）→ 交给 CSS 时间轴；</li>\n  <li><strong>不可视的时序</strong>（什么时候爆气泡、什么时候切状态机）→ 留给 JS。</li>\n</ul>\n<h2>让 CSS 能插值一个自定义属性</h2>\n<p>问题在于水位不是元素的属性，它是一个贯穿整棵子树的数值：水体、阳光带、署名都要读它。用 <code>@property</code> 把它注册成<strong>可动画的数值类型</strong>，CSS 动画就能直接把它从 0 推到 1：</p>\n<pre><code class="lang-css">/* 注册之后 --fall 才有"数值"语义，才能被 @keyframes 插值 */\n@property --fall {\n  syntax: "&lt;number&gt;";\n  inherits: true;          /* 关键：整棵子树都要读到它 */\n  initial-value: 0;\n}\n\nbody.is-falling {\n  animation: waterRise var(--fall-dur, 2400ms)\n             cubic-bezier(.42, .02, .68, .55) forwards;\n}\n@keyframes waterRise {\n  from { --fall: 0; }\n  to   { --fall: 1; }\n}</code></pre>\n<p>这里有个容易踩的坑：<strong>动画挂在谁身上，只有谁的后代拿得到插值</strong>。我一开始把 <code>waterRise</code> 挂在 <code>.water</code> 上，于是 <code>.sunbeams</code>（阳光带）作为它的兄弟节点，永远读到 <code>:root</code> 里的 0 —— 阳光带一次都没出现过，而且没有任何报错。</p>\n<blockquote>\n  <p>自定义属性是可继承的，但<em>动画只作用在被动画的那个元素上</em>。兄弟节点不在继承链里。</p>\n  <cite>踩坑记录，2025-08</cite>\n</blockquote>\n<p>把它挂到 <code>body</code> 之后，整棵子树才同步。</p>\n<h2>兜底：@property 不是所有浏览器都认</h2>\n<p><code>@property</code> 属于比较新的能力。不支持的引擎里 <code>--fall</code> 只是普通字符串，CSS 无法插值，动画会直接"跳"到终值。所以还是要留一条轮询兜底：</p>\n<pre><code class="lang-js">// 能注册成功就完全交给 CSS；否则用 rAF 自己推\nconst supportsAnimatableProperty = () =&gt; {\n  if (typeof CSS === "undefined") return false;\n  if (typeof CSS.registerProperty !== "function") return false;\n  try {\n    CSS.registerProperty({\n      name: "--fall-probe",\n      syntax: "&lt;number&gt;",\n      inherits: true,\n      initialValue: 0\n    });\n    return true;\n  } catch (err) {\n    // 重复注册会抛错，说明这个引擎其实支持\n    return true;\n  }\n};</code></pre>\n<figure>\n  <img src="img/diagram-water.svg" alt="水面同心圆波纹示意图：两层波叠加，外层波峰处画出干涉增强区" width="720" height="380">\n  <figcaption>波纹不做真实流体：只画两层同心圆，让第二层与第一层错开半个周期</figcaption>\n</figure>\n<h2>结论</h2>\n<ol>\n  <li>视觉的连续量交给 CSS 时间轴，JS 只做状态机与不可视时序；</li>\n  <li>跨子树共享的动画量用 <code>@property</code> 注册，并挂在共同祖先上；</li>\n  <li>新能力一定要有兜底路径，且兜底路径的性能特征要写进注释。</li>\n</ol>\n<p>改完之后，即使我在坠落过程中切走标签页再切回来，水面也已经稳稳地落在 <code>--fall: 1</code> 了。</p>'
},

  {
    slug: 'fan-menu-geometry',
    title: '扇形菜单的几何：少即是多，也意味着要重算',
    date: '2025-07-02',
    category: '设计',
    tags: ['布局', '交互', 'CSS'],
    excerpt: '菜单从 7 项收到 3 项之后，原来的半径和张角全部失效：条目会在左上角挤成一团。这篇文章记录了重新推导的过程。',
    body: [
      '<p>扇形放射菜单的美感来自"从同一点沿弧线甩出去"。7 项的时候，每项相差 10°，整体铺开 60°，看起来像一把打开的折扇。</p>',
      '<p>减到 3 项之后，如果还沿用原来的参数，会得到两件糟糕的事：</p>',
      '<ul>',
      '  <li>条目集中在上半区，整块视觉重心偏左上，右下大片留白；</li>',
      '  <li>字号没变、间距没变，三项之间的空隙反而显得空旷，<strong>菜单看起来变小了</strong>。</li>',
      '</ul>',

      '<h2>先把"扇形"的参数收敛掉</h2>',
      '<p>参数只有三个：半径 <code>r</code>、单项的角度 <code>θ</code>、相邻项的角度差 <code>Δθ</code>。条目在屏幕上的位置是：</p>',

      '<pre><code class="lang-js">// 外层 .fan-item 负责极坐标定位，内层 .fan-link 只管悬停/选中的微动',
      'const x = r * Math.cos(theta);',
      'const y = r * Math.sin(theta);',
      '',
      '// 相邻两项的纵向间距 —— 字号变大时它必须同比变大，否则会叠字',
      'const gapY = r * Math.abs(Math.sin(theta + dTheta) - Math.sin(theta));',
      'const needY = lineHeight * fontSize * 1.35;',
      'if (gapY &lt; needY) increaseRadiusOrShrinkSpread();</code></pre>',

      '<p>字号 ×1.42，就要求 <code>gapY</code> 至少也 ×1.42。在 <code>Δθ</code> 不变的前提下，唯一的手段是把 <code>r</code> 一起放大：</p>',

      '<pre><code class="lang-css">/* 同比增大：字号与半径同量级放大，风格参数一个没动 */',
      '.fan-link {',
      '  font-size: calc(clamp(38px, 4.4vw, 76px) * var(--font-scale, 1));',
      '}',
      '/* 7 项时是 clamp(28px, 3.2vw, 52px)，半径 560 → 820 */</code></pre>',

      '<h2>张角反而要收</h2>',
      '<p>3 项如果用 ±30° 铺开，整块会甩到屏幕左上角。收到 ±22° 之后，三条的落点大致是一条向右上倾斜的斜线，视觉重心回到画面中部。</p>',
      '<figure>',
      '  <img src="img/diagram-fan.svg" alt="扇形菜单几何示意：同一原点出发的三条射线，标出半径与相邻项间距" width="720" height="380">',
      '  <figcaption>三条射线的角度差决定纵向间距，半径决定整体尺度；两者要一起调</figcaption>',
      '</figure>',

      '<h2>顺序里也有信息</h2>',
      '<p>菜单项的排列顺序不是随意的。落水之后条目是<strong>依次旋出</strong>的，最后停稳的那一条会获得最多注意力。所以初始选中项应该落在"最想让访客点的那一条"上 —— 这里是博客文章，而不是第一项。</p>',
      '<p>实现上不要写死索引，按语义去查：</p>',
      '<pre><code class="lang-js">defaultIndex() {',
      '  // 写死 3 会在条目数变化时指错位置',
      '  const hit = this.items.findIndex(({ data }) =&gt; /archive\\.html/.test(data.href || ""));',
      '  return hit &gt;= 0 ? hit : Math.floor((this.items.length - 1) / 2);',
      '}</code></pre>',
      '<blockquote>',
      '  <p>少即是多，但"少"不会自动变好看。条目减少时必须重新推导几何参数，否则只是把稀疏当成了留白。</p>',
      '</blockquote>'
    ].join('\n')
  },

  {
  slug: 'static-blog-without-framework',
  title: '不用框架的静态博客：文件即数据',
  date: '2025-05-29',
  category: '工程',
  tags: ['静态站点', '构建', '性能'],
  excerpt: '没有打包器、没有依赖、双击 HTML 就能跑。代价是要自己处理数据加载、模板渲染和 404 的兜底。',
  body: '<p>这个站点的全部依赖是零。没有打包器，没有运行时框架，<code>node_modules</code> 不存在。<code>index.html</code> 双击就能打开，扔进任何静态托管也能直接跑。</p>\n<h2>数据放在哪</h2>\n<p>第一版我把文章写成 JSON，用 <code>fetch</code> 读。浏览器里没问题，但 <code>file://</code> 协议下 <code>fetch</code> 会被 CORS 直接拒掉 —— 双击打开就是一片空白。所以改成 <strong>JS 全局变量 + script 标签</strong>：</p>\n<pre><code class="lang-html">&lt;!-- 这样 file:// 与 http:// 的行为完全一致 --&gt;\n&lt;script src="js/posts.js"&gt;&lt;/script&gt;\n&lt;script&gt;\n  const post = window.POSTS.find(p =&gt; p.slug === slug);\n&lt;/script&gt;</code></pre>\n<p>代价是数据不能太大 —— 它会进首屏的解析路径。文章正文全部内联的话，几百篇就会开始拖慢加载。真到那个规模，就该拆成"列表索引"和"按篇正文"两个文件，或者干脆回到服务端渲染。</p>\n<h2>渲染顺序</h2>\n<p>脚本用 <code>defer</code> 加载，DOM 就绪后才拿得到节点。渲染的挂载点要放在脚本之前，且必须显式声明，避免"找不到容器时静默失败"：</p>\n<pre><code class="lang-js">function render(slug) {\n  const host = document.getElementById("articleBody");\n  if (!host) {\n    console.error("[article] 缺少挂载点 #articleBody");\n    return;\n  }\n  const post = (window.POSTS || []).find((p) =&gt; p.slug === slug);\n  if (!post) {\n    // 找不到文章 = 一次 404，但当前页面已经渲染出来了，\n    // 直接跳转会让用户"闪一下"，所以就地画一个空状态\n    host.innerHTML = notFoundMarkup(slug);\n    return;\n  }\n  host.innerHTML = post.body;\n}</code></pre>\n<h2>404 的两种形态</h2>\n<p>静态站点没有服务端路由，404 有两种情况要分开处理：</p>\n<ol>\n  <li><strong>路径本身不存在</strong> —— 由托管平台返回 <code>404.html</code>，所以这个文件必须真的存在；</li>\n  <li><strong>路径存在但参数无效</strong> —— 比如 <code>article.html?slug=不存在</code>。这时页面框架是好的，就地渲染一个"文章不存在"的空状态，比整页跳走更自然。</li>\n</ol>\n<blockquote>\n  <p>静态站点的可靠性来自"没有东西可以挂"。少了构建步骤，也少了构建失败、依赖漂移和 hydration 不匹配。</p>\n  <cite>关于取舍</cite>\n</blockquote>'
},

  {
    slug: 'color-layering',
    title: '叠印式文字效果：三层阴影做出分色印刷感',
    date: '2025-04-08',
    category: '设计',
    tags: ['CSS', '排版'],
    excerpt: '红、青、白三层偏移阴影叠在深色字上，得到类似套印错位的观感。关键不是颜色，而是三层的偏移量必须成比例。',
    body: [
      '<p>站里所有大标题都用了同一个手法：深色字 + 三层偏移的 <code>text-shadow</code>。看起来像老式印刷的套印错位，实际只是三个偏移量不同的阴影。</p>',

      '<pre><code class="lang-css">.fan-link {',
      '  color: var(--teal);',
      '  text-shadow:',
      '    .02em  .03em  0 var(--red),      /* 红：偏移最小，压在字脚下 */',
      '    .066em .082em 0 var(--cyan),     /* 青：中间层 */',
      '    .098em .12em  0 rgba(255,255,255,.92);  /* 白：最远，像纸的底色 */',
      '}</code></pre>',

      '<h2>偏移量用 em，不用 px</h2>',
      '<p>用 <code>em</code> 的好处是整块效果随字号自动缩放 —— 菜单从 28px 放大到 76px 时，三层阴影的间距同步放大，不用改任何一个数。用 <code>px</code> 的话，字号一大阴影就会"糊"在字上。</p>',
      '<p>三层之间的间距也必须是<strong>近似等比</strong>的。比例大约是 1 : 3.3 : 4.9。如果随手写成 2px / 3px / 20px，观感会立刻散掉：中间那层会像脏点而不是套印。</p>',

      '<h2>为什么最远那层是白色</h2>',
      '<p>因为水下的底色是深青蓝。白色阴影在最远处，等于给整块字镶了一道"亮底"，字因此从背景里浮起来；换成同色系的浅蓝，字会陷进背景里。</p>',
      '<blockquote>',
      '  <p>分色印刷的观感来自<em>层与层之间的偏移关系</em>，不是来自颜色的数量。加第四层只会让它变糊。</p>',
      '</blockquote>',

      '<h2>选中态反转</h2>',
      '<p>选中项需要更亮，但不是简单地把颜色调白 —— 那样会丢掉层次。做法是把"最远的白色"换成实心白，把原来的青色换到中间，红色保留，于是整块字从深色底变成浅色底：</p>',
      '<pre><code class="lang-css">.fan-item.is-active .fan-link {',
      '  color: var(--ink);',
      '  text-shadow:',
      '    .02em  .03em  0 var(--cyan),',
      '    .066em .082em 0 var(--white),',
      '    .098em .12em  0 rgba(11, 52, 70, .9);   /* 最远层换成深色 */',
      '}</code></pre>',
      '<p>偏移量一个没动，只是三层颜色整体"倒过来"。这就是同一套几何参数能同时支撑深底与浅底两种状态的原因。</p>'
    ].join('\n')
  },

  {
    slug: 'canvas-water-notes',
    title: '用波方程做水波：一次不算成功的性能实验',
    date: '2025-03-19',
    category: '前端',
    tags: ['Canvas', '性能', '数学'],
    excerpt: '在降采样网格上用波方程推进，再放大到全屏。效果不错，但一次折射滤镜的尝试把帧率拖垮了。',
    body: [
      '<p>水面波光的做法如下：维护一张比屏幕小得多的网格，在每个格子上按二维波方程推进，然后把结果放大绘制到全屏 canvas。<strong>模拟分辨率与显示分辨率解耦</strong>，这是整件事能跑起来的前提。</p>',

      '<h2>波方程的离散形式</h2>',
      '<p>连续形式是 <code>∂²u/∂t² = c²∇²u</code>。离散化之后每个格子只需要前两帧的值：</p>',

      '<pre><code class="lang-js">// u0 上一帧、u1 当前帧、u2 下一帧；c 是波速，damping 是阻尼',
      'const lap = u1[y][x - 1] + u1[y][x + 1] + u1[y - 1][x] + u1[y + 1][x] - 4 * u1[y][x];',
      'u2[y][x] = (2 * u1[y][x] - u0[y][x] + c * c * lap) * damping;',
      '',
      '// 每一帧结束后滚动一下引用，不需要真的拷贝数组',
      '[u0, u1, u2] = [u1, u2, u0];</code></pre>',

      '<p>边界用固定边界（边缘恒为 0），波会从边缘反射回来。在 60×34 这样的网格上，反射周期大约一两秒，观感刚好是"水在轻轻晃"。</p>',

      '<h2>失败的那一半：折射滤镜</h2>',
      '<p>我试过给整个水下世界挂一层 SVG <code>feTurbulence</code> + <code>feDisplacementMap</code> 做真实折射。视觉上成立，但代价是<strong>每帧对整屏重新计算一次逐像素噪声</strong>：</p>',
      '<ul>',
      '  <li>滤镜区域还要外扩 6%、再放大到 130% 参与合成；</li>',
      '  <li>层里的焦散每帧都在变，所以这笔开销每帧都要重付；</li>',
      '  <li>结果是 1080p 下帧率直接腰斩。</li>',
      '</ul>',
      '<p>最后的处理是：<strong>保留滤镜定义但默认不启用</strong>，并在 CSS 里写清楚启用方式和成本，需要入水冲击这种短瞬间效果时再挂上去。</p>',

      '<blockquote>',
      '  <p>一段被注释掉的代码如果没有写明"为什么不用、什么条件下可以用"，下一个人只会把它当成垃圾删掉，然后再踩一遍同样的坑。</p>',
      '</blockquote>',

      '<h2>真正省下来的钱</h2>',
      '<p>把折射层关掉、把逐帧的湍流计算去掉之后，剩下的开销是：一张 60×34 的网格推进 + 一次全屏 <code>drawImage</code>。这部分在集显上也能稳在满帧。</p>',
      '<figure>',
      '  <img src="img/diagram-water.svg" alt="波方程网格示意：中心扰动向外扩散的同心波前，标注网格步长与波前半径" width="720" height="380">',
      '  <figcaption>网格步长决定波长，波速决定扩散快慢；两者都只是观感参数</figcaption>',
      '</figure>'
    ].join('\n')
  },

  {
    slug: 'reduced-motion',
    title: '把"减少动态效果"当成一条真实路径',
    date: '2025-02-11',
    category: '前端',
    tags: ['无障碍', 'CSS', '动画'],
    excerpt: 'prefers-reduced-motion 不是把动画调快就行。落水动画一类的位移效果，正确的降级是直接跳到终态。',
    body: [
      '<p>系统里打开"减少动态效果"的用户，诉求通常不是"动画快一点"，而是<strong>不要有大面积的位移与闪烁</strong>。前庭功能障碍的用户会因为全屏位移而眩晕。所以降级的目标不是"更快的动画"，而是"没有动画"。</p>',

      '<h2>最常见的错误写法</h2>',
      '<pre><code class="lang-css">/* 反例：时长压到 1ms，但延迟还在 */',
      '@media (prefers-reduced-motion: reduce) {',
      '  * { animation-duration: .001ms !important; }',
      '}</code></pre>',
      '<p>这个写法会留下一个隐蔽的坑：<strong>animation-delay 不受 duration 影响</strong>。开场文案是 0 / 180 / 360ms 依次淡入的，压掉时长之后，用户会先看到 360ms 的空白，然后三段文字同时"啪"地出现。比原效果更糟。</p>',

      '<h2>正确做法：显式写 none</h2>',
      '<pre><code class="lang-css">@media (prefers-reduced-motion: reduce) {',
      '  *, *::before, *::after {',
      '    animation-duration: .001ms !important;',
      '    animation-iteration-count: 1 !important;',
      '    transition-duration: .12s !important;',
      '  }',
      '  /* 这类元素要单独写：直接显示、不做位移 */',
      '  .entry-name, .entry-tag, .entry-hint, .enter-arrow {',
      '    animation: none;',
      '    opacity: 1;',
      '    translate: none;',
      '  }',
      '}</code></pre>',

      '<h2>JS 那一侧也要分叉</h2>',
      '<p>有些效果不是 CSS 动画，比如"坠落"的过程本身。这时要在入口处就读一次媒体查询，直接走终态分支：</p>',
      '<pre><code class="lang-js">this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;',
      '',
      'dive() {',
      '  this.state = "falling";',
      '  if (this.reduced) {',
      '    // 不做 2.4s 的位移，直接落到水下终态',
      '    this.finish();',
      '    return;',
      '  }',
      '  // 正常路径……',
      '}</code></pre>',

      '<h2>还有一条容易漏：切到后台时暂停</h2>',
      '<p><code>visibilitychange</code> 里把持续动画停掉，既省电，也避免"回到页面时看到一片乱跳"。CSS 侧用 <code>animation-play-state: paused</code>，canvas 侧在 rAF 里跳过绘制：</p>',
      '<pre><code class="lang-js">document.addEventListener("visibilitychange", () =&gt; {',
      '  const hidden = document.hidden;',
      '  document.body.classList.toggle("is-page-hidden", hidden);',
      '  Water.setPaused(hidden);',
      '});</code></pre>',
      '<blockquote>',
      '  <p>无障碍不是"额外加一层"，而是同一个效果的第二条路径。两条路径的终态必须一致。</p>',
      '</blockquote>'
    ].join('\n')
  },

  {
    slug: 'css-variable-tokens',
    title: '设计令牌：让颜色只有一个出处',
    date: '2024-12-05',
    category: '设计',
    tags: ['CSS', '设计系统'],
    excerpt: '同一个青色在四个文件里被写成四种相近的值，是这类小站点最常见的腐化方式。把颜色收敛到一层变量上。',
    body: [
      '<p>小站点最容易发生的事：主色 <code>#35d3ff</code>，过两周在另一个文件里写成 <code>#37d0fa</code>，再过两周出现 <code>rgba(53,211,255,.9)</code>。肉眼几乎看不出差别，但改色的时候就是找不到全部出处。</p>',

      '<h2>收敛到 :root</h2>',
      '<pre><code class="lang-css">:root {',
      '  --red:   #ff1f3d;   /* 强调色只有这一个红 */',
      '  --cyan:  #35d3ff;',
      '  --sky:   #38bdf8;   /* 深色底上的天蓝 */',
      '  --sky-deep: #0284c7; /* 浅色底上的同一个蓝，才够对比度 */',
      '}</code></pre>',

      '<p>注意最后一行：<strong>同一个颜色在深底和浅底上需要两个值</strong>。<code>#38BDF8</code> 放在白底上对比度只有 2.2:1，作为 UI 组件边框是不够的（WCAG 对非文本组件要求 3:1）；换成 <code>#0284C7</code> 大约 4.4:1，才安全。把这件事写进令牌注释里，比写在设计规范文档里有用 —— 因为写代码的人会看到它。</p>',

      '<h2>什么时候可以重复</h2>',
      '<p>本站有两套样式表：主界面（沉浸式单屏）和内页（可滚动）。它们各自持有一份令牌副本。这是<strong>刻意的重复</strong>：主界面的样式表把 <code>html,body</code> 钉成 <code>overflow: hidden</code>，内页无法直接复用它。与其为了共享 20 行变量而引入一个构建步骤，不如接受这份重复，并在两边都写上"改色时两处一起改"。</p>',

      '<blockquote>',
      '  <p>能被接受的重复，必须同时满足两条：重复的内容足够小，且重复的地方有明确的同步提示。</p>',
      '</blockquote>',

      '<h2>变量的命名要带语义</h2>',
      '<p><code>--blue-500</code> 这种命名描述的是"它长什么样"，<code>--red</code> / <code>--sky-deep</code> 描述的是"它用在哪"。前者在改主题时会全部失效，后者至少还能保留"这是一个强调色"的信息。</p>',
      '<pre><code class="lang-css">/* 反例：只有色值信息，换主题时全废 */',
      '--blue-500: #38bdf8;',
      '',
      '/* 正例：带上用途，换主题时知道该换成什么 */',
      '--sky: #38bdf8;        /* 深色底 */',
      '--sky-deep: #0284c7;   /* 浅色底 */</code></pre>'
    ].join('\n')
  },

  {
    slug: 'why-write',
    title: '为什么还要写：把决定写下来，而不是把结论写下来',
    date: '2024-10-27',
    category: '随笔',
    tags: ['写作', '习惯'],
    excerpt: '技术笔记的价值不在"正确"，而在于把当时的信息、约束和取舍固定下来 —— 三个月后的自己需要的是这些。',
    body: [
      '<p>我写得最多的不是教程，是"当时为什么这么定"。这类文字有一个特点：它<strong>不追求正确</strong>。三个月后回头看，结论可能已经被推翻，但只要当时的约束、备选项和取舍理由还在，这篇记录就仍然有用。</p>',

      '<h2>结论会过期，约束不会</h2>',
      '<p>"用 A 而不用 B"这句话，离开上下文之后毫无价值。有价值的是它后面那半句：</p>',
      '<ul>',
      '  <li>B 在什么条件下更合适；</li>',
      '  <li>我们当时的约束是什么（时间、人力、兼容性、性能预算）；</li>',
      '  <li>哪一条约束一旦消失，这个决定就该重新评估。</li>',
      '</ul>',

      '<blockquote>',
      '  <p>如果一条笔记里没有任何"当时放弃了什么"，那它大概率是一篇翻译过来的文档，而不是一次真实的决策。</p>',
      '</blockquote>',

      '<h2>写给三个月后的自己</h2>',
      '<p>判断标准很简单：三个月后你打开这段代码，是希望看到"实现了 X 功能"，还是希望看到"这里试过 Y，帧率掉一半，所以退回 Z，条件允许时值得再试"?</p>',
      '<p>所以我在代码里留注释的标准是：<strong>只留那些"删掉之后别人会重新踩坑"的内容</strong>。剩下的交给版本历史和提交信息。</p>',

      '<h2>不写什么</h2>',
      '<ol>',
      '  <li>API 用法 —— 官方文档比自己写得好，而且不会过期得那么快；</li>',
      '  <li>显而易见的事 —— 注释复述代码只会增加噪音；</li>',
      '  <li>情绪 —— "这个库真难用"没有信息量，但"这个库在 SSR 下会重复注册全局样式"有。</li>',
      '</ol>',
      '<p>把这三类去掉之后，笔记会短很多，也会活得久很多。</p>'
    ].join('\n')
  }
];
