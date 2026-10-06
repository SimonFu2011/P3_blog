#!/usr/bin/env node
/* ============================================================
   本地反代（SSH 隧道专用）
   ------------------------------------------------------------
   为什么需要它：
     管理面（/_admin/ 与 /api/*）要求请求带 X-Admin-Proxy-Secret
     （用来证明"只有我们的 nginx 能到管理面"）。而**浏览器走 SSH 隧道时
     无法自己加这个头** —— 导航请求不能自定义头。所以隧道不能直连后台
     进程，必须指向一个会注入该头的反代。

   拓扑：
     本地浏览器 → ssh -L 8848 → 服务器 127.0.0.1:8848【本进程，注入密钥】
                                    ↓
                              服务器 127.0.0.1:8849【后台 node】

   为什么不用 nginx：
     这台机器上的 nginx 是宝塔编译的 **OpenResty**，独立配置会缺
     load_module / Lua 环境而启动失败；而且沙箱收紧后它写不了自己的
     错误日志。这个项目本来就是零依赖 Node —— 四十行 Node 比迁就
     OpenResty 的模块体系更可控。

   用法：
     node tunnel-proxy.mjs --listen 8848 --target 8849 \
       --secret-file /etc/p3blog/proxy-secret
   ============================================================ */
import http from 'node:http';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const value = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};

const LISTEN_PORT = Number(value('listen', 8848));
const TARGET_PORT = Number(value('target', 8849));
const LISTEN_HOST = value('listen-host', '127.0.0.1');
const TARGET_HOST = value('target-host', '127.0.0.1');
const SECRET_FILE = value('secret-file', '/etc/p3blog/proxy-secret');
/* 改写 Host 成后台白名单里的公网名。
   为什么必须改写：浏览器走隧道时发的是 `Host: 127.0.0.1:8848`，而后台监听
   8849 —— 它的 Host 校验里有一条"回环名必须等于本次监听端口"，于是 403。
   与其去放宽那条判据（那会让"本地直连"和"隧道"分不清），不如在反代这一层
   把 Host 换成后台认识的公网名。这样应用的校验逻辑一个字都不用动。 */
const PUBLIC_HOST = value('public-host', '');

let secret = '';
try {
  secret = readFileSync(SECRET_FILE, 'utf8').trim();
} catch (err) {
  console.error('[tunnel-proxy] 读不到密钥文件 ' + SECRET_FILE + '：' + err.message);
  process.exit(5);
}
if (!secret) {
  console.error('[tunnel-proxy] 密钥文件是空的：' + SECRET_FILE);
  process.exit(5);
}

const log = (...args) => console.log('[tunnel-proxy]', ...args);

const server = http.createServer((req, res) => {
  const headers = Object.assign({}, req.headers);

  /* 关键：注入密钥。这里**覆盖**客户端可能自带的同名头 ——
     否则隧道外的人可以自己伪造一个头来测试应用的行为。 */
  headers['x-admin-proxy-secret'] = secret;

  /* 让 X-Forwarded-For 反映真实来源（隧道场景下就是 127.0.0.1） */
  headers['x-forwarded-for'] = req.socket.remoteAddress || '127.0.0.1';
  headers['x-forwarded-proto'] = 'http';

  /* 改写 Host 成后台白名单里的公网名（见文件头的说明） */
  if (PUBLIC_HOST) headers.host = PUBLIC_HOST;

  const up = http.request({
    host: TARGET_HOST,
    port: TARGET_PORT,
    method: req.method,
    path: req.url,
    headers
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });

  up.on('error', (err) => {
    log('上游错误：' + err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end('后台不可达：' + err.message + '\n');
  });

  req.pipe(up);
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* 已断 */ }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log('监听 ' + LISTEN_HOST + ':' + LISTEN_PORT + ' → ' + TARGET_HOST + ':' + TARGET_PORT + '（已注入反代密钥）');
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
