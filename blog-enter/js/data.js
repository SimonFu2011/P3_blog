/* ============================================================
   站点配置 —— 改这里就能变成你自己的博客入口
   ============================================================ */
window.SITE = {
  name: 'SIMON 的个人站',
  tagline: 'PERSONAL SITE / 落水而入',
  /* 子页面侧边栏品牌下的那一行短标语：主界面的 tagline 太长会撑破侧边栏，
     所以单独给一句短的（留空则子页面不显示这一行） */
  brandSub: 'PERSONAL SITE',

  /* 副标题：选中项在这里显示完整说明 */
  command: { jp: 'メニュー', en: 'Command' },

  hints: [
    { key: 'ENTER', text: '決定' },
    { key: 'ESC', text: '閉じる' }
  ],

  /* 扇形菜单 —— 全站唯一的"菜单真源"。
     主界面（index.html）直接读这里渲染；子页面（about / archive / article / 404）
     的侧边栏是手写的静态标记，三者必须与此处的 label / en / href 保持一致。
     angle 单位是度：0 = 正右，负值向上，正值向下。
     只有 3 项时不要沿用 7 项那套 ±30°：条目会在左上角挤成一团、还会把
     可用半径压掉一大截。收到 ±16° 后三条落在一条缓斜线上，横向占用更少，
     半径（也就是字号）能真正放大 —— 风格不变，整体同比增大。 */
  menu: [
    { label: '关于我',   jp: '关于我', en: 'ABOUT',    angle: -16, radius: 1.00, desc: '个人简介 / 技能 / 联系方式', href: 'about.html' },
    { label: '博客文章', jp: '博客文章', en: 'ARTICLES', angle:   0, radius: 1.00, desc: '全部文章 / 分类 / 时间线',   href: 'archive.html' },
    { label: '待定',     jp: '待定',   en: 'TBD',      angle:  16, radius: 1.00, desc: '栏目规划中',                 href: '#' }
  ],

  /* 页脚右栏提示（子页面用；主界面右下角是命令条，不看这里） */
  footNote: '按 ESC 回主界面',
  /* 署名。{year} 是占位：主界面由 boot.js、子页面由 pages.js 在运行时
     换成当前年份，不用每年手改。 */
  footer: '© {year} SIMON 的个人站',

  /* ---- 「关于我」页的抬头信息 ----
     name 同时用在侧边栏品牌、简介标题与页脚品牌三处；
     简介正文直接写在 about.html 里（长文本放 HTML 更容易改排版）。 */
  profile: {
    name: 'SIMON',
    role: 'FRONT-END / INTERACTION'
  },

  /* ---- 动画 / 观感调参 ---- */
  tuning: {
    /* 扇形半径(px)的 1440 基准值：560 → 980。
       与 CSS 里 .fan-link 字号 clamp(38px,4.4vw,76px) 同量级放大（约 1.4 倍），
       保证"文字变大"的同时三条之间的间距也等比拉开、不会叠字。
       实际半径还会被视口宽高与"右边界余量"夹一层（见 menu.js 的 layout），
       所以这个值只是桌面端的上限意图。 */
    fanRadius: 980,
    fanSpread: 1,        // 扇形张角倍率，1 = 按配置角度
    fallDuration: 2400   // 坠落总时长(ms)，同时驱动 CSS 的 --fall 推进
  },

  /* ---- 音乐 / 黑胶（第六项） ----
     没有音源时保持 enabled: false —— 左侧黑胶会显示占位封面与占位歌名
     （"暂无播放"），时钟与唱片照常工作，不引入任何外部资源。
     填入 src 之后：封面换成 cover（留空则用内置占位封面），并且会在
     "入水"这一次用户手势里开始播放；ESC 重置会暂停并归零。
     注意：浏览器禁止无用户手势的自动播放，所以播放一定发生在入水之后。 */
  music: {
    enabled: false,
    src: '',                 // 例如 'audio/bgm.mp3'
    title: '暂无播放',
    artist: 'NO TRACK',
    cover: ''                // 例如 'img/cover.jpg'，留空用内置占位封面
  },

  /* ---- Live2D 接入点（可选） ----
     内置的 SVG 小人已移除，当前默认不显示任何角色。
     若你有自行获得授权的 Cubism 模型，可以：
       1) 引入 pixi-live2d-display + Cubism Core
       2) 把模型的 canvas 挂到 index.html 的 #charStage（已预留空容器）
       3) 实现下方 adapter.load()，然后把 enabled 设为 true
     挂载成功后扇形菜单会自动右移（origin 34% → 46%）给角色让位。
     注意：Live2D 官方示例模型（Hiyori / Shizuku 等）禁止商用发布，
     公开博客请勿直接使用，详见 live2d.com 的素材授权条款。 */
  live2d: {
    enabled: false,
    adapter: null,       // 形如 { load(stageEl, opts) => Promise<{setFocus(x,y),setMouthOpen(v)}> }
    model: null          // 你自己的 .model3.json 地址
  }
};
