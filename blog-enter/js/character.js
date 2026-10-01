/* ============================================================
   角色挂载器（内置 SVG 小人已移除）
   ------------------------------------------------------------
   这里现在只做一件事：在你想接入真实 Live2D / Cubism 模型时，
   把模型挂到 index.html 的 #charStage 上。
   未配置时整个模块是空操作，页面不会因为缺少角色而出错。

   接入方式：
     1) 引入 pixi-live2d-display + Cubism Core
     2) 在 data.js 的 live2d 段里实现 adapter.load(stageEl, opts)
     3) 把 live2d.enabled 设为 true，并填上你自己的 .model3.json

   注意：Live2D 官方示例模型（Hiyori / Shizuku 等）禁止商用发布，
   公开博客请使用你自行获得授权的模型。
    ============================================================ */
(() => {
  'use strict';

  const Character = {
    stage: null,
    mounted: false,
    model: null,

    init() {
      this.stage = document.getElementById('charStage');
      /* 默认不挂载任何东西；配置齐全时再异步接入 */
      const cfg = window.SITE && window.SITE.live2d;
      if (cfg && cfg.enabled) this.mount();
    },

    async mount() {
      const cfg = window.SITE.live2d;
      if (!this.stage || !cfg || !cfg.adapter || !cfg.model) {
        console.warn('[character] Live2D 未启用或缺少 adapter/model，跳过挂载');
        return false;
      }
      try {
        this.model = await cfg.adapter.load(this.stage, { model: cfg.model });
        this.mounted = true;
        this.stage.classList.add('is-mounted');
        return true;
      } catch (err) {
        console.warn('[character] Live2D 挂载失败:', err);
        this.mounted = false;
        return false;
      }
    },

    /* 给外部留的钩子：接入后可以让模型跟着指针看 */
    setFocus(x, y) {
      if (this.mounted && this.model && this.model.setFocus) this.model.setFocus(x, y);
    },

    /* 水下时可以把模型整体压暗/后退 */
    setDepth(fall) {
      if (!this.mounted || !this.stage) return;
      this.stage.style.setProperty('--model-fall', String(fall));
    }
  };

  window.Character = Character;
})();
