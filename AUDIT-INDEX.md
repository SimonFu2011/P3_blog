# 审计报告索引（2026-10-06）

三路独立审计的发现与处理状态。**审计时点是「远端模式」改造进行中**，
报告里的部分行号反映的是中间修订；下面按主题归档结论。

| 报告 | 范围 | 文件 |
| --- | --- | --- |
| 服务端 | `blog-enter/server/**`（9 个文件） | `AUDIT-server-security.md` |
| 前端 | `blog-enter/*.html`、`js/`、`css/`、`admin/`、`p3-menu/` | `AUDIT-frontend-security.md` |
| 部署运维 | `deploy/**`、`.gitignore`、`.gitattributes` | `AUDIT-deploy-ops.md` |

共 52 条发现。本轮已处理与**仍开放**的清单见各报告末尾的「本轮处理」一节。

## 已确认并修复的三类真漏洞（均经实测复现）

1. **HTML 校验可绕过 → 存储型 XSS**（`lib/validate.mjs`）
   未闭合标签 / HTML 实体 / 换行 / 制表符 / NUL 前缀五种写法全部骗过原正则。
   已改为线性分词器 + 归一化后再判协议。

2. **ReDoS**（`lib/validate.mjs`、`lib/images.mjs`）
   43 字节输入实测 1288ms，指数增长。`validate.mjs` 已修；`images.mjs`
   的 `sanitizeSvg` **仍开放**。

3. **vm 不是安全边界**（`lib/posts-store.mjs`）
   `window.constructor.constructor("return process")()` 实测能拿到宿主 process，
   `window.__proto__` 就是宿主 Object.prototype。已改为上下文内建对象 +
   上下文内 JSON 序列化；注释已改成如实说明。

另有若干「失败开放」缺陷（缺代理密钥仍启动、备份失败仍写、乐观锁可绕过）
已改为失败关闭。

> 这些报告是**审计台账**，不是待办清单的全部。处理状态以每份报告末尾为准。
