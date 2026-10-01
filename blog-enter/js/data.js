/* ============================================================
   站点配置 —— 改这里就能变成你自己的博客入口
   ============================================================ */
window.SITE = {
  name: 'YOUR NAME',
  tagline: 'PERSONAL SITE / 落水而入',

  /* 副标题：选中项在这里显示完整说明 */
  command: { jp: 'メニュー', en: 'Command' },

  hints: [
    { key: 'ENTER', text: '決定' },
    { key: 'ESC', text: '閉じる' }
  ],

  /* 扇形菜单。angle 单位是度：0 = 正右，负值向上，正值向下。
     张角越大越"放射"，但条目会更快跑出屏幕，建议控制在 ±30° 内。
     href 支持站内相对路径或外链；外链请自行加 target。 */
  menu: [
    { jp: '記事',     en: 'ARTICLES',  angle: -30, radius: 1.00, desc: '長文と考察',           href: '#articles' },
    { jp: '制作物',   en: 'PROJECTS',  angle: -20, radius: 0.98, desc: 'つくったもの',          href: '#projects' },
    { jp: '断章',     en: 'NOTES',     angle: -10, radius: 1.00, desc: '短い記録',              href: '#notes' },
    { jp: '道のり',   en: 'TIMELINE',  angle:   0, radius: 0.96, desc: 'これまでとこれから',    href: '#timeline' },
    { jp: '素顔',     en: 'ABOUT',     angle:  10, radius: 1.00, desc: '私について',            href: '#about' },
    { jp: '接続',     en: 'LINKS',     angle:  20, radius: 0.98, desc: '外へつながる',          href: '#links' },
    { jp: '便り',     en: 'CONTACT',   angle:  30, radius: 1.00, desc: '連絡を取る',            href: '#contact' }
  ],

  footer: '© ' + new Date().getFullYear() + ' YOUR NAME',

  /* ---- 动画 / 观感调参 ---- */
  tuning: {
    fanRadius: 560,      // 扇形半径(px)，会被视口尺寸自动缩放
    fanSpread: 1,        // 扇形张角倍率，1 = 按配置角度
    fallDuration: 2400   // 坠落总时长(ms)，同时驱动 CSS 的 --fall 推进
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
