// WT-P0-010 两段式端到端(分两次调用,由外部在两次之间重启服务):
//   stage1: attach 常驻 Edge → 等待机正常播放(缓存建立)→ 精确杀服务(tsx)→ 断言断线占位出现 → 退出(Edge 保留)
//   stage2: 服务已由外部重启 → 断言:无任何新互动,待机画面自动恢复(可见/loop/非暂停/无占位)→ 补一发互动健康度 → 清理 Edge
// 用法:node scripts/e2e-reconnect-idle.mjs stage1|stage2 [port]
// Edge 由外部以 --remote-debugging-port=9336 与独立 user-data-dir 启动(跨命令存活)。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = process.argv[2] ?? 'stage1';
const port = Number(process.argv[3] ?? process.env.PORT ?? 3210);
const access = JSON.parse(fs.readFileSync(path.join(root, 'data', 'access.json'), 'utf8'));
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function http(pathname, init) {
  const response = await fetch(`${base}${pathname}`, init);
  let body = null;
  try { body = await response.json(); } catch { /* ignore */ }
  return { status: response.status, body };
}

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9336/json')).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('/overlay'));
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('CDP 目标页未找到(Edge 未启动或已退出)');
}

async function attach() {
  const target = await findTarget();
  const ws = new WebSocket(target, { maxPayload: 64 * 1024 * 1024 });
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
  const screenshot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(root, '.tools', name), Buffer.from(r.result.data, 'base64'));
    console.log(`截图 .tools/${name}`);
  };
  await send('Page.enable');
  await send('Runtime.enable');
  return { ws, send, evaluate, screenshot };
}

async function readState(evaluate) {
  return evaluate(`(() => {
    const v = document.querySelector('#videos video:not(.hidden)');
    return v ? { src: v.src.split('/').pop(), loop: v.loop, paused: v.paused, ph: document.getElementById('placeholder').style.display } : { ph: document.getElementById('placeholder').style.display, label: document.getElementById('placeholder-label').textContent };
  })()`);
}

function idleVisible(snap) {
  return snap !== null && typeof snap.src === 'string' && snap.src === 'idle.webm' && snap.loop === true && snap.paused === false && snap.ph === 'none';
}

async function stage1() {
  const { ws, evaluate, screenshot } = await attach();
  // 等待待机起播(缓存建立)
  let snap = null;
  const deadline = Date.now() + 25_000;
  for (;;) {
    await sleep(500);
    snap = await readState(evaluate);
    if (idleVisible(snap) || Date.now() > deadline) break;
  }
  check('重连前待机正常播放(缓存已建立)', idleVisible(snap), JSON.stringify(snap));

  // 精确杀服务(tsx 命令行),排除本脚本进程;页面业务 WS 断开
  spawnSyncKillServer();

  // 断言断线占位出现(stopAll 路径)
  let offlineSeen = false;
  const offlineDeadline = Date.now() + 12_000;
  for (;;) {
    await sleep(400);
    const s = await readState(evaluate);
    const probe = await evaluate('window.__wtWs ?? null');
    if (probe && probe.status === 'disconnected' && s.ph === 'flex') { offlineSeen = true; break; }
    if (Date.now() > offlineDeadline) break;
  }
  check('服务停止后进入断线占位', offlineSeen, JSON.stringify(await readState(evaluate)));
  await screenshot('e2e-reconnect-offline.png');

  // 观察窗内(服务仍停止)不应恢复 —— 若此时恢复说明服务未真正停止
  const still = await readState(evaluate);
  const serverDown = await (async () => {
    try {
      const h = await http('/api/health');
      return h.status !== 200;
    } catch {
      return true;
    }
  })();
  check('服务确认已停止', serverDown, `health=${serverDown ? 'down' : 'up'}`);
  check('断线期间画面保持占位(未误恢复)', still.ph === 'flex', JSON.stringify(still));

  ws.close();
  console.log(failures === 0 ? 'STAGE1-PASS(Edge 保留,服务已停止)' : 'STAGE1-FAIL');
  process.exit(failures === 0 ? 0 : 1);
}

function spawnSyncKillServer() {
  // WT-P1-009:只停止由 scripts/e2e-server.mjs 登记的测试服务(PID + 命令行
  // 含本项目入口绝对路径双重校验),不再按进程名/端口匹配全机进程。
  const r = spawnSync('node', [path.join(root, 'scripts', 'e2e-server.mjs'), '--stop'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(String(r.stderr ?? r.stdout ?? '').trim());
    throw new Error('杀服务失败:测试服务须由 node scripts/e2e-server.mjs 启动');
  }
  console.log(String(r.stdout ?? '').trim());
}

async function stage2() {
  const { ws, evaluate, screenshot } = await attach();
  // 服务已由外部重启;无任何新互动:轮询观察画面自动恢复。
  // 窗口需覆盖 socket 层卡死自愈时序:3 次悬挂守卫(约 30s,退避拉长)→ 防风暴
  // 重载 → 新页面握手与待机起播(实测 2026-11-18:Edge 服务硬杀后 WS 全挂,
  // 仅 HTTP 正常,页面不重载则 65s+ 不恢复;重载后立即恢复)。
  let after = null;
  let restored = false;
  const deadline = Date.now() + 70_000;
  for (;;) {
    await sleep(500);
    after = await readState(evaluate);
    if (idleVisible(after)) { restored = true; break; }
    if (Date.now() > deadline) break;
  }
  console.log('重连后状态:', JSON.stringify(after));
  console.log('WS probe:', JSON.stringify(await evaluate('window.__wtWs ?? null')));
  check('断线重连后无互动即恢复循环待机(WT-P0-010)', restored, JSON.stringify(after));
  await screenshot('e2e-reconnect-idle.png');

  // 健康度:新互动仍正常播放并回待机
  const waveSubmit = await http('/api/mock/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${access.control}` },
    body: JSON.stringify({ type: 'chat', text: '挥挥手', userId: `reconnect-${Date.now()}`, userName: '重连员' }),
  });
  console.log('wave 提交:', JSON.stringify(waveSubmit.body));
  let sawWave = false;
  let backAgain = false;
  const waveDeadline = Date.now() + 25_000;
  for (;;) {
    await sleep(500);
    const snap = await readState(evaluate);
    if (typeof snap.src === 'string' && snap.src === 'wave.webm') sawWave = true;
    if (sawWave && idleVisible(snap)) { backAgain = true; break; }
    if (Date.now() > waveDeadline) break;
  }
  check('重连后新互动仍正常', sawWave && backAgain, `sawWave=${sawWave} restored=${backAgain}`);

  ws.close();
  // 清理 Edge(外部启动的 headless 实例)
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\" | " +
      "Where-Object { $_.CommandLine -match 'edge-profile-reconnectidle' } | " +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'], { stdio: 'ignore' });
  } catch { /* ignore */ }
  console.log(failures === 0 ? 'STAGE2-PASS' : 'STAGE2-FAIL');
  process.exit(failures === 0 ? 0 : 1);
}

if (stage === 'stage1') void stage1();
else void stage2();
