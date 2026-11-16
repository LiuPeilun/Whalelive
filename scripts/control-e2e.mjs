// 控制台按钮端到端(WT-P0-001 修复验证):从真实页面点击 暂停/恢复/紧急停止,
// 请求为无体 POST,修复前会因 JSON Content-Type 被拒(400),修复后应生效。
// 用法:先启动服务,再执行 node scripts/control-e2e.mjs

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 3210);
const access = JSON.parse(fs.readFileSync(path.join(root, 'data', 'access.json'), 'utf8'));
const controlUrl = `http://127.0.0.1:${port}/control#${access.control}`;

const edgeCandidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const edgePath = edgeCandidates.find((p) => fs.existsSync(p));
if (!edgePath) throw new Error('未找到 Edge');

const EDGE_PROFILE_TAG = 'controle2e';

function killEdgeTree(pid) {
  // taskkill /T 在部分环境杀不干净 Chromium 进程树,再用 profile 过滤兜底,
  // 否则残留页面会重连 /ws 并持续续租,干扰后续验证(WT-P0-007/009 验证环境)。
  try {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  } catch { /* ignore */ }
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\" | " +
      "Where-Object { $_.CommandLine -match 'edge-profile-controle2e' } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { stdio: 'ignore' });
  } catch { /* ignore */ }
}


const debugPort = 9334;
const edge = spawn(edgePath, [
  '--headless', '--disable-gpu', '--no-sandbox',
  `--user-data-dir=${root}\.tools\edge-profile-controle2e`,
  '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${debugPort}`,
  '--window-size=1280,900',
  controlUrl,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('/control'));
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('CDP 目标页未找到');
}

async function main() {
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
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(`页面异常: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? '')}`);
    return r.result?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(2500); // 等待认证与首个状态推送

  // 紧急停止带 window.confirm,无头环境自动确认
  await evaluate('window.confirm = () => true; window.__pinned = true;');
  const pinned = await evaluate('window.__pinned === true');
  if (!pinned) throw new Error('页面脚本环境未就绪');

  async function clickAndWait(buttonId, expectText, timeoutMs = 6000) {
    await evaluate(`document.getElementById(${JSON.stringify(buttonId)}).click()`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = await evaluate(`document.getElementById('sched').textContent`);
      if (text === expectText) return true;
      if (Date.now() > deadline) return false;
      await sleep(250);
    }
  }

  const results = {
    pause: await clickAndWait('btn-pause', '调度:已暂停'),
    resume: await clickAndWait('btn-resume', '调度:运行中'),
    stop: await clickAndWait('btn-stop', '调度:已暂停'),
  };
  console.log(`暂停=${results.pause} 恢复=${results.resume} 紧急停止=${results.stop}`);

  // 紧急停止按设计保持暂停;恢复调度后再核对服务端状态,避免影响后续端到端
  const resumedAfterStop = await clickAndWait('btn-resume', '调度:运行中');
  const state = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { authorization: `Bearer ${access.control}` } }).then((r) => r.json());
  console.log(`停止后恢复=${resumedAfterStop} 服务端:paused=${state.paused}`);
  const serverOk = resumedAfterStop && state.paused === false;

  ws.close();
  killEdgeTree(edge.pid);
  const ok = results.pause && results.resume && results.stop && serverOk;
  console.log(ok ? '控制台按钮端到端:通过' : '控制台按钮端到端:未通过');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('控制台 E2E 失败:', err);
  killEdgeTree(edge.pid);
  process.exit(1);
});
