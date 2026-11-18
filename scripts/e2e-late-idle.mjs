// WT-P0-009 浏览器端到端:延迟待机加载并与动作派发交错。
// 用 CDP Fetch 拦截第一个 idle.webm 请求 3 秒,期间立即派发 dance;
// 修复前两个 prepare 抢占同一缓冲位,dance 结束后页面继续显示 dance.webm;
// 修复后动作在专属缓冲位播放,结束后正确回到持续循环的 idle.webm,且下一次动作正常。
// 用法:先启动服务,再执行 node scripts/e2e-late-idle.mjs

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 3210);
const access = JSON.parse(fs.readFileSync(path.join(root, 'data', 'access.json'), 'utf8'));
const overlayUrl = `http://127.0.0.1:${port}/overlay#${access.playback}`;

const edgeCandidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const edgePath = edgeCandidates.find((p) => fs.existsSync(p));
if (!edgePath) throw new Error('未找到 Edge');

const EDGE_PROFILE_TAG = 'lateidle';

function killEdgeTree(pid) {
  // taskkill /T 在部分环境杀不干净 Chromium 进程树,再用 profile 过滤兜底,
  // 否则残留页面会重连 /ws 并持续续租,干扰后续验证(WT-P0-007/009 验证环境)。
  try {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  } catch { /* ignore */ }
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\" | " +
      "Where-Object { $_.CommandLine -match 'edge-profile-lateidle' } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { stdio: 'ignore' });
  } catch { /* ignore */ }
}


const debugPort = 9335;
const edge = spawn(edgePath, [
  '--headless', '--disable-gpu', '--no-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  `--user-data-dir=${root}\.tools\edge-profile-lateidle`,
  '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${debugPort}`,
  '--window-size=760,560',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      const page = list.find((t) => t.type === 'page');
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
  const fetchPausedWaiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Fetch.requestPaused') {
      for (const w of [...fetchPausedWaiters]) {
        if (w.predicate(msg.params)) {
          fetchPausedWaiters.splice(fetchPausedWaiters.indexOf(w), 1);
          w.resolve(msg.params);
          return;
        }
      }
      // 未被认领的暂停请求直接放行,避免页面卡死
      void send('Fetch.continueRequest', { requestId: msg.params.requestId });
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
  const waitForPaused = (predicate, timeoutMs = 12000) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    fetchPausedWaiters.push({ predicate, resolve: (p) => { clearTimeout(timer); resolve(p); } });
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  // 只拦截待机请求;动作请求不受影响
  await send('Fetch.enable', { patterns: [{ urlPattern: '*idle.webm*', requestStage: 'Request' }] });

  const paused = waitForPaused((p) => p.request.url.includes('idle.webm'), 15000);
  await send('Page.navigate', { url: overlayUrl });

  const held = await paused;
  if (!held) throw new Error('未拦截到待机请求(页面未起播?)');
  console.log('已拦截待机请求,保持 3 秒:', held.request.url.split('/').pop());

  // 待机仍处于预加载时立即派发 dance(复现交错)
  const chat = await fetch(`http://127.0.0.1:${port}/api/mock/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${access.control}` },
    body: JSON.stringify({ type: 'chat', text: '大肥鱼跳个舞', userId: 'late-idle-1', userName: '晚待机员' }),
  }).then((r) => r.json());
  console.log('dance 提交:', JSON.stringify(chat));
  await sleep(1500); // dance 在专属缓冲位加载并起播

  // 放行被扣住的待机请求(此时 dance 正在播放)
  await send('Fetch.continueRequest', { requestId: held.requestId });
  console.log('待机请求已放行(晚于 dance 起播)');

  // 等待 dance 播放结束、页面回到 idle
  let restored = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const snap = await evaluate(`(() => {
      const v = document.querySelector('#videos video:not(.hidden)');
      const ph = document.getElementById('placeholder');
      return v ? { src: v.src.split('/').pop(), loop: v.loop, paused: v.paused, ph: ph.style.display } : null;
    })()`);
    if (snap && snap.src === 'idle.webm' && snap.loop === true && snap.paused === false && snap.ph === 'none') {
      restored = true;
      break;
    }
  }
  console.log(`dance 结束后回到循环待机(WT-P0-009): ${restored ? '通过' : '未通过'}`);
  await screenshot('e2e-late-idle.png');

  // 下一次动作仍正常:wave 播放结束后再次回到 idle
  await fetch(`http://127.0.0.1:${port}/api/mock/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${access.control}` },
    body: JSON.stringify({ type: 'chat', text: '挥挥手', userId: 'late-idle-2', userName: '晚待机员' }),
  }).then((r) => r.json());
  let sawWave = false;
  let secondRestore = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const snap = await evaluate(`(() => {
      const v = document.querySelector('#videos video:not(.hidden)');
      return v ? { src: v.src.split('/').pop(), loop: v.loop, paused: v.paused } : null;
    })()`);
    if (snap?.src === 'wave.webm') sawWave = true;
    if (sawWave && snap?.src === 'idle.webm' && snap.loop === true && snap.paused === false) {
      secondRestore = true;
      break;
    }
  }
  console.log(`后续动作播放并再次回待机: sawWave=${sawWave} restored=${secondRestore}`);

  ws.close();
  killEdgeTree(edge.pid);
  const ok = restored && sawWave && secondRestore;
  console.log(ok ? '晚待机交错端到端:通过' : '晚待机交错端到端:未完全通过');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('晚待机端到端失败:', err);
  killEdgeTree(edge.pid);
  process.exit(1);
});
