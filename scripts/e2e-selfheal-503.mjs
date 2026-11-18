// WT-P1-010 闭环实测:握手悬挂(WS 层卡死)与页面文档同时暂不可用(503)时,
// 自愈不得把页面留在错误文档上;文档恢复后自动重载并恢复登记。
// 阶段:①注入 503(CDP Fetch 拦截 /overlay 文档与探测请求)→ 观察自愈触发但
// 不重载(探针仍在、无 wtWsReloadAt);②解除拦截 → 下一轮自愈重载 → 待机恢复。
// 前置:stage1 已执行(服务已死,Edge 保留)。用法:node scripts/e2e-selfheal-503.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer, stopTestServer } from './lib/test-server.mjs';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? process.env.PORT ?? 3210);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}`);
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function attach() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9336/json')).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('/overlay'));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 16 * 1024 * 1024 });
        await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
        let seq = 0;
        const pending = new Map();
        const events = [];
        ws.on('message', (d) => {
          const msg = JSON.parse(String(d));
          if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
          else if (msg.method) events.push(msg);
        });
        const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
        const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
        await send('Runtime.enable');
        return { ws, send, evaluate, events };
      }
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('CDP 目标页未找到');
}

const t0 = Date.now();
const log = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

// 起服务:经 startTestServer 启动并登记 PID(WT-P1-009,日志行缓冲脱敏由其内部
// redact-log 处理),本脚本退出前显式停止,不留无主服务进程
const access = JSON.parse(fs.readFileSync(path.join(root, 'data', 'access.json'), 'utf8'));
const server = startTestServer({ port, extraSecrets: [access.playback, access.control] }); // 日志默认 logFileFor(port)
log(`服务启动(pid=${server.pid})`);
const healthy = await server.waitHealthy(30_000);
if (!healthy) {
  console.error('服务 30 秒内未就绪');
  server.child.kill();
  process.exit(1);
}

const cdp = await attach();
log('已 attach');

// 注入 503:拦截 /overlay 文档与同路径探测请求
// 注入策略(WT-P1-010):按 resourceType 分流——
// - Fetch/XHR(自愈的文档探测 fetch)→ 503:自愈不得重载,原页保留重连能力;
// - Document(导航/Vite 全量重载)→ 放行:文档真实可用时任何重载都应成功,
//   把文档导航拦成 503 只会把页面刷死在错误文档上(包括非本修复管辖的 Vite)。
// 说明:通配 urlPattern 的中间 * 在 CDP 不生效,拦截用前缀 pattern 全量开启,
// 再在 handler 内按类型分流。
await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'http://127.0.0.1:*' }] });
const pausedHandler = (msg) => {
  if (msg.method === 'Fetch.requestPaused') {
    const p = msg.params;
    const isDoc = p.resourceType === 'Document';
    const req = isDoc
      ? cdp.send('Fetch.continueRequest', { requestId: p.requestId })
      : cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 503, body: '' });
    void req.catch(() => {});
  }
};
cdp.ws.on('message', (d) => pausedHandler(JSON.parse(String(d))));
log('503 注入开启(探测请求 503,文档导航放行),观察 65s(覆盖一次完整自愈周期)…');

let probeAliveDuring503 = false;
let reloadDuring503 = false;
for (let i = 0; i < 13; i++) {
  await sleep(5000);
  const probe = await cdp.evaluate('window.__wtWs ? window.__wtWs.status : "GONE"').catch(() => 'GONE');
  const reloadAt = await cdp.evaluate('sessionStorage.getItem("wtWsReloadAt")').catch(() => null);
  if (probe !== 'GONE') probeAliveDuring503 = true;
  if (reloadAt !== null) reloadDuring503 = true;
}
log(`503 阶段:探针存在=${probeAliveDuring503} 重载发生=${reloadDuring503}`);
check('文档暂不可用时自愈不重载(页面保留重连能力,WT-P1-010)', !reloadDuring503, `reloadDuring503=${reloadDuring503}`);
check('503 阶段探针仍存活', probeAliveDuring503);

// 解除注入 → 下一轮自愈应重载并恢复
await cdp.send('Fetch.disable');
log('503 注入解除,等待下一轮自愈(最长 100s)…');
let restored = false;
for (let i = 0; i < 20; i++) {
  await sleep(5000);
  const idle = await cdp.evaluate(`(() => { const v = document.querySelector('#videos video:not(.hidden)'); return v && v.src.endsWith('idle.webm') && !v.paused && document.getElementById('placeholder').style.display === 'none'; })()`).catch(() => false);
  if (idle) { restored = true; break; }
}
check('文档恢复后自动重载并恢复循环待机(WT-P1-010)', restored);

cdp.ws.close();
try { stopTestServer(port); } catch { /* 已退出 */ }
console.log(failures === 0 ? '503 自愈闭环:全部通过' : `503 自愈闭环:${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
