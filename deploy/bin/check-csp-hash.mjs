/* ============================================================
   CSP hash 一致性闸（S8 的证据来源，可重复执行）
   ------------------------------------------------------------
   用法：node deploy/bin/check-csp-hash.mjs

   它做一件事：按 CSP 规范算 `blog-enter/404.html` 里**内联脚本**的 hash，
   与 `deploy/bt/nginx-locations.conf` 里声明的 `sha256-…` 逐字符比对。

   为什么需要它：hash 是"对**字节**的承诺"。404.html 是一个会被前端改的源文件，
   任何一次改动（哪怕只是多一个空格）都会让声明失效 —— 而 CSP 在
   Report-Only 模式下**不会**报错，只是把脚本拦掉、在控制台留一条违规。
   症状是"404 页少了路径提示"，很容易被当成别的问题。所以把它变成一条
   能一键重算的闸，而不是靠人记得重算。

   【算法细节，别记错】
     · 取 `<script>` 与 `</script>` **标签之间**的原始字节，**不含标签本身**；
     · 按 UTF-8 编码后 SHA-256，再 base64；
     · 只对**内联**脚本（没有 src 属性的）算；外链脚本由 script-src 'self' 覆盖，不需要 hash。
   取错这两处（把标签算进去、或算错版本的文件）会得到完全不同的值 ——
   这也是"两个人算同一个文件却得出不同 hash"最常见的原因。
   ============================================================ */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const HTML = resolve(ROOT, 'blog-enter/404.html');
const CONF = resolve(ROOT, 'deploy/bt/nginx-locations.conf');

const INLINE_RE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

const html = readFileSync(HTML, 'utf8');
const hashOf = (body) => 'sha256-' + createHash('sha256').update(Buffer.from(body, 'utf8')).digest('base64');

const bodies = [];
let m;
while ((m = INLINE_RE.exec(html)) !== null) bodies.push(m[1]);

const conf = readFileSync(CONF, 'utf8');
const declared = (conf.match(/sha256-[A-Za-z0-9+/=]+/g) || []);

console.log('文件：' + HTML.replace(ROOT + '\\', '').replace(ROOT + '/', ''));
console.log('内联脚本块数：' + bodies.length);
const computed = bodies.map(hashOf);
computed.forEach((h, i) => console.log('  第 ' + (i + 1) + ' 块（' + Buffer.byteLength(bodies[i], 'utf8') + ' 字节）：' + h));
console.log('配置里声明的 hash（' + CONF.replace(ROOT + '\\', '').replace(ROOT + '/', '') + '）：');
declared.forEach((h) => console.log('  ' + h));

let ok = true;
if (!declared.length) {
  console.log('\n结论：**FAIL** —— 配置里没有任何 sha256-… 声明（若改用外链脚本，请删掉本闸）');
  ok = false;
} else if (bodies.length === 0) {
  console.log('\n结论：**FAIL** —— 404.html 里已没有内联脚本，但配置仍声明着 hash（陈旧的 hash 必须删掉）');
  ok = false;
} else {
  for (const d of declared) {
    if (!computed.includes(d)) {
      console.log('\n结论：**FAIL** —— 配置声明 ' + d + ' 与当前文件算出的任何一块都不匹配');
      console.log('  修法：把配置里的 hash 改成上面的值，或按注释把内联脚本挪成外链 .js 后删掉 hash。');
      ok = false;
    }
  }
  if (ok) console.log('\n结论：**PASS** —— 配置里声明的每一个 hash 都对应当前文件的一个内联脚本块');
}

/* 附：如果 404.html 是"改过但没重算"的状态，这里会把两个值都印出来，
   方便排查"我明明算对了却对不上"（往往是算的文件版本不同）。 */
console.log('\n提示：若你算出的值与上面不同，先确认三件事 ——');
console.log('  1) 算的是**标签之间**的字节，不是含 <script> 标签的整段；');
console.log('  2) 算的是**部署将发布的那一版**文件（本机工作区 vs git HEAD vs 线上产物可能三份都不同）；');
console.log('  3) 编码是 UTF-8（本文件是 UTF-8；用 GBK/ANSI 读会得到不同的字节）。');
process.exit(ok ? 0 : 1);
