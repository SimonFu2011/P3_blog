/* ============================================================
   跑完所有不需要浏览器的验签
   ------------------------------------------------------------
   用法：node blog-enter/server/tests/run-all.mjs

   为什么不用 `node --test <目录>`：
   本项目的运行环境（例如受限沙箱）里 node:test 的 runner 需要 spawn 子进程，
   而子进程管道在那种环境下会被拒绝（EPERM），于是"测试跑不起来"会变成
   一个假故障，掩盖真正的问题。这里改为在当前进程内逐个 import 测试文件，
   由 tests/harness.mjs 收集并执行用例 —— 零 spawn。

   浏览器那一层（verify-admin-ui.mjs）故意不在这里跑：
   它需要 Chrome 与一个已启动的服务器。见 ADMIN.md。
   ============================================================ */
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const files = (await readdir(HERE))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

let pass = 0;
let fail = 0;
const failures = [];

for (const file of files) {
  console.log('\n=== ' + file + ' ===');
  /* 每个测试文件在被 import 时会用 harness 收集用例，并导出它 */
  const mod = await import(new URL('./' + file, import.meta.url).href);
  const harness = mod.H || mod.default;
  if (!harness || !harness.run) {
    console.log('  （这个文件没有导出 harness，跳过）');
    continue;
  }
  const r = await harness.run({ quiet: true });
  pass += r.pass;
  fail += r.fail;
  r.results.filter((x) => x.ok).forEach((x) => console.log('  ok   ' + x.name));
  r.results.filter((x) => !x.ok).forEach((x) => {
    failures.push(file + ' → ' + x.name);
    console.log('  FAIL ' + x.name);
    console.log('       ' + String((x.err && x.err.message) || x.err).split('\n').slice(0, 6).join('\n       '));
  });
}

console.log('\n------------------------------');
console.log('合计：' + pass + ' 通过 / ' + fail + ' 失败');
if (failures.length) failures.forEach((f) => console.log('  ✖ ' + f));
process.exit(fail ? 1 : 0);
