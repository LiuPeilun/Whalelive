// 一次性诊断:重演服务重启竞态,抓取页面 ws-client 状态机轨迹 + 页面导航 + CDP 目标。
// 前置:Edge 已以 --remote-debugging-port=9336 打开 /overlay 页,服务运行中。
// 用法:node scripts/e2e-reconnect-trace.mjs [port]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? process.env.PORT ?? 3210);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9336/json')).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('/overlay'));
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('CDP 目标页未找到');
}

async function attach() {
  const ws = new WebSocket(await findTarget(), { maxPayload: 16 * 1024 * 1024 });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  let seq = 0;
  const pending = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  return { ws, evaluate };
}

function killServer() {
  spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | " +
    `Where-Object { $_.ProcessId -ne ${process.pid} -and $_.CommandLine -match 'tsx' } | ` +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'], { stdio: 'ignore' });
}

async function listTargets() {
  try {
    const list = await (await fetch('http://127.0.0.1:9336/json')).json();
    return list.map((t) => `${t.type}:${(t.url || '').slice(0, 60)}`).join(' | ');
  } catch {
    return 'CDP 不可达';
  }
}

const t0 = Date.now();
const log = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const { ws: cdp, evaluate } = await attach();
log('已 attach 目标页');

const probe0 = await evaluate('window.__wtWs ? {status: window.__wtWs.status, r: window.__wtWs.reconnects} : null');
log(`初始探针: ${JSON.stringify(probe0)}`);

killServer();
log('服务已杀,等待断线占位…');
await sleep(6000);
const probe1 = await evaluate('window.__wtWs ? {status: window.__wtWs.status, r: window.__wtWs.reconnects, ev: window.__wtWs.events} : null');
log(`杀后探针: ${JSON.stringify(probe1)}`);

// 后台重启服务(独立日志)
const serverLog = fs.openSync(path.join(root, '.tools', 'trace-server.log'), 'w');
const server = spawn('npm', ['start'], { cwd: root, stdio: ['ignore', serverLog, serverLog], shell: true, detached: false });
log(`服务重启中(pid=${server.pid}),观察 40s…`);

let lastSnapshot = '';
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  let snap;
  try {
    snap = await evaluate(`JSON.stringify({
      url: location.href.slice(0, 70),
      nav: (performance.getEntriesByType('navigation')[0] || {}).type ?? 'none',
      probe: window.__wtWs ? { s: window.__wtWs.status, r: window.__wtWs.reconnects, le: window.__wtWs.lastError } : null,
      ph: (document.getElementById('placeholder') || {}).style?.display ?? '?',
      label: (document.getElementById('placeholder-label') || {}).textContent ?? '?'
    })`);
  } catch (err) {
    snap = `EVAL-ERR ${String(err).slice(0, 80)}`;
  }
  const line = `${snap}`;
  if (line !== lastSnapshot) {
    log(line);
    lastSnapshot = line;
  }
}

log('---- 最终探针事件环形缓冲 ----');
const ev = await evaluate('window.__wtWs ? window.__wtWs.events.join("\\n") : null').catch(() => null);
console.log(ev ?? '(不可达)');
log(`CDP 目标: ${await listTargets()}`);
const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.status).catch(() => 'down');
log(`服务健康: ${health}`);
cdp.close();
server.kill();
process.exit(0);
