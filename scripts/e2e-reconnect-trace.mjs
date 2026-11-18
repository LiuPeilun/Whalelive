// 一次性诊断:重演服务重启竞态,抓取页面 ws-client 状态机轨迹 + 页面导航 + CDP 目标。
// 前置:Edge 已以 --remote-debugging-port=9336 打开 /overlay 页,服务运行中。
// 用法:node scripts/e2e-reconnect-trace.mjs [port]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startTestServer } from './lib/test-server.mjs';
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
  // WT-P1-009:只停止由 scripts/e2e-server.mjs 登记的测试服务(PID + 命令行
  // 含本项目入口绝对路径双重校验),不再按进程名/端口匹配全机进程。
  const r = spawnSync('node', [path.join(root, 'scripts', 'e2e-server.mjs'), '--stop', '--port', String(port)], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error('杀服务失败:测试服务须由 node scripts/e2e-server.mjs 启动');
  }
}

async function listTargets() {
  try {
    const list = await (await fetch('http://127.0.0.1:9336/json')).json();
    return list.map((t) => `${t.type}:${(t.url || '').split('#')[0].slice(0, 60)}`).join(' | ');
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

// 后台重启服务(独立日志;行缓冲脱敏,WT-P1-011 —— 启动横幅含完整凭据链接,
// 跨块分割与自定义数据目录均由 redact-log 处理;经 startTestServer 启动并登记
// PID(WT-P1-009),后续 --stop 可管理)
const access = JSON.parse(fs.readFileSync(path.join(root, 'data', 'access.json'), 'utf8'));
const { child: server, waitHealthy } = await startTestServer({ port, extraSecrets: [access.playback, access.control] }); // 日志默认 logFileFor(port)
log(`服务重启中(pid=${server.pid}),观察 40s…`);
void waitHealthy();

let lastSnapshot = '';
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  let snap;
  try {
    snap = await evaluate(`JSON.stringify({
      url: location.pathname + location.search,
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
