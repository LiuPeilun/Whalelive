// WT-P1-010 闭环实测:握手悬挂(WS 层卡死)与页面文档同时暂不可用(503)时,
// 自愈不得把页面留在错误文档上;文档恢复后自动重载并恢复登记。
// 阶段:①注入 503(CDP Fetch 拦截 /overlay 文档与探测请求)→ 观察自愈触发但
// 不重载(探针仍在、无 wtWsReloadAt);②解除拦截 → 下一轮自愈重载 → 待机恢复。
// 前置:stage1 已执行(服务已死,Edge 保留)。用法:node scripts/e2e-selfheal-503.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

// 起服务(日志落盘前过滤凭据,WT-P1-011)
const access = JSON.parse(fs.readFileSync(path.join(root, 'data', 'access.json'), 'utf8'));
const serverLog = fs.openSync(path.join(root, '.tools', 'selfheal503-server.log'), 'w');
const redact = (chunk) => String(chunk).replaceAll(access.playback, '[playback-cred]').replaceAll(access.control, '[control-cred]');
const server = spawn('npm', ['start'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
server.stdout.on('data', (d) => { try { fs.writeSync(serverLog, redact(d)); } catch { /* ignore */ } });
server.stderr.on('data', (d) => { try { fs.writeSync(serverLog, redact(d)); } catch { /* ignore */ } });
log(`服务启动(pid=${server.pid})`);
await sleep(8000);

const cdp = await attach();
log('已 attach');

// 注入 503:拦截 /overlay 文档与同路径探测请求
await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*127.0.0.1*overlay*' }] });
const pausedHandler = (msg) => {
  if (msg.method === 'Fetch.requestPaused') {
    void cdp.send('Fetch.fulfillRequest', { requestId: msg.params.requestId, responseCode: 503, body: '' }).catch(() => {});
  }
};
cdp.ws.on('message', (d) => pausedHandler(JSON.parse(String(d))));
log('503 注入开启(文档与探测均 503),观察 65s(覆盖一次完整自愈周期)…');

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
server.kill();
console.log(failures === 0 ? '503 自愈闭环:全部通过' : `503 自愈闭环:${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
