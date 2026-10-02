import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
const PORT = 9531;
const OUT = "D:\\DS\\.preview";
const chrome = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new","--remote-debugging-port="+PORT,"--remote-allow-origins=*","--disable-gpu","--no-sandbox","--hide-scrollbars","--window-size=1440,900","--user-data-dir="+OUT+"\\cp-entry2","about:blank"], { stdio: "ignore" });
let ws, seq = 0; const pending = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify(s ? { id, method: m, params: p, sessionId: s } : { id, method: m, params: p })); });
let v = null;
for (let i = 0; i < 60 && !v; i++) { await sleep(250); try { v = await (await fetch("http://127.0.0.1:"+PORT+"/json/version")).json(); } catch {} }
ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S("Page.enable"); await S("Runtime.enable");
await S("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const js = async (x) => { const r = await S("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
await S("Page.navigate", { url: "http://127.0.0.1:8848/index.html" });
await sleep(2600);
const cap = await S("Page.captureScreenshot", { format: "png" });
writeFileSync(OUT + "\\final-entry.png", Buffer.from(cap.data, "base64"));
console.log(JSON.stringify(await js(`(function(){
  const el = document.querySelector(".entry-name");
  const cs = getComputedStyle(el);
  const b = el.getBoundingClientRect();
  const body = getComputedStyle(document.body);
  return { tag: el.tagName, text: el.textContent, dataText: el.getAttribute("data-text"),
           box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
           font: cs.fontFamily.split(",")[0], size: cs.fontSize, weight: cs.fontWeight, style: cs.fontStyle,
           ls: cs.letterSpacing, color: cs.color, margin: cs.margin,
           bodyBg: body.backgroundColor, h1Count: document.querySelectorAll("h1").length };
})()`), null, 2));
ws.close(); chrome.kill(); process.exit(0);
