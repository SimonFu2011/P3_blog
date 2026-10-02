/* ============================================================
   极简测试装置（零依赖、零子进程）
   ------------------------------------------------------------
   为什么不用 node:test：
   它的 runner 会 spawn 子进程来跑测试文件，而受限沙箱禁止子进程使用管道
   （EPERM），于是"测试跑不起来"会变成一个假故障，掩盖真正的问题。
   这里只用 node:assert 提供断言，用例的收集与执行全在当前进程内。

   用法（在每个 test 文件末尾）：
     await harness.run();            // 直接 node file.test.mjs
   或者由 run-all.mjs 统一调用：
     await harness.run({ quiet: true })

   harness.test(name, fn) 里的 fn 可以是同步函数或 async 函数；
   抛错即失败，assert 的消息会原样打出来。
   ============================================================ */
export const createHarness = (title) => {
  const cases = [];
  const harness = {
    title,
    test(name, fn) { cases.push({ name, fn }); return harness; },
    cases,
    async run(opts) {
      const o = opts || {};
      const results = [];
      for (const c of cases) {
        try {
          await c.fn();
          results.push({ name: c.name, ok: true });
          if (!o.quiet) console.log('  ok   ' + c.name);
        } catch (err) {
          results.push({ name: c.name, ok: false, err });
          console.log('  FAIL ' + c.name);
          const msg = String((err && err.message) || err);
          console.log('       ' + msg.split('\n').slice(0, 6).join('\n       '));
          if (err && err.actual !== undefined && !/AssertionError/.test(msg)) {
            console.log('       actual:   ' + JSON.stringify(err.actual));
            console.log('       expected: ' + JSON.stringify(err.expected));
          }
        }
      }
      const pass = results.filter((r) => r.ok).length;
      const fail = results.length - pass;
      if (!o.quiet) {
        console.log('  ---');
        console.log('  ' + title + '：' + pass + ' 通过 / ' + fail + ' 失败');
      }
      return { pass, fail, results };
    }
  };
  return harness;
};

/** 判断"这个文件是不是被直接执行的"（而不是被 run-all 引入） */
export const isMain = (importMetaUrl) => {
  try {
    const self = new URL(importMetaUrl).pathname.replace(/^\//, '').replace(/\//g, '\\').toLowerCase();
    const arg = (process.argv[1] || '').toLowerCase();
    return arg.endsWith(self) || self.endsWith(arg);
  } catch { return false; }
};
