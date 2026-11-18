// 自愈重载硬证据采集:服务重启后每 2s 重新 attach,记录探针事件与 wtWsReloadAt。
// 前置:stage1 已执行(服务已死,Edge 保留)。随后本脚本启动服务并观察 60s。
// 用法:node scripts/e2e-selfheal-verify.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attachOnce() {
  try {
    const list = await (await fetch('http://127.0.0.1:9336/json')).json();
    const page = list.find((t) => t.type === 'page' && t.url.includes('/overlay'));
    if (!page) return null;
    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 4 * 1024 * 1024 });
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    let seq = 0;
    const pending = new Map();
    ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
    await send('Runtime.enable');
    const probe = await evaluate('window.__wtWs ? {s:window.__wtWs.status,r:window.__wtWs.reconnects,ev:window.__wtWs.events.slice(-6)} : null');
    const reloadAt = await evaluate('sessionStorage.getItem("wtWsReloadAt")');
    const idle = await evaluate(`(() => { const v = document.querySelector('#videos video:not(.hidden)'); return v && v.src.endsWith('idle.webm') && !v.paused && document.getElementById('placeholder').style.display === 'none'; })()`);
    ws.close();
    return { probe, reloadAt, idle };
  } catch {
    return null;
  }
}

const t0 = Date.now();
const log = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

const server = spawn('npm', ['start'], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'], shell: true });
log(`服务启动(pid=${server.pid}),开始观察…`);

let sawReloadAt = null;
let restoredAt = null;
let lastLine = '';
for (let i = 0; i < 30; i++) {
  await sleep(2000);
  const snap = await attachOnce();
  const line = snap
    ? `reloadAt=${snap.reloadAt ?? '-'} idle=${snap.idle} probe=${JSON.stringify(snap.probe)}`
    : '(attach 失败)';
  if (line !== lastLine) { log(line); lastLine = line; }
  if (snap?.reloadAt && !sawReloadAt) sawReloadAt = Date.now();
  if (snap?.idle && !restoredAt) { restoredAt = Date.now(); log('★ 待机已恢复'); break; }
}

console.log('---- 结论 ----');
console.log(`观察到 wtWsReloadAt 时间戳: ${sawReloadAt ? '是(自愈重载触发)' : '否'}`);
console.log(`待机恢复: ${restoredAt ? `是(+${((restoredAt - t0) / 1000).toFixed(0)}s)` : '否(60s 窗口内未恢复)'}`);
server.kill();
process.exit(0);
