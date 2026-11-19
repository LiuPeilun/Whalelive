// WT-P0-009 浏览器端到端:延迟待机加载并与动作派发交错。
// 用 CDP Fetch 拦截第一个 idle.webm 请求，期间立即派发 dance;
// 修复前两个 prepare 抢占同一缓冲位,dance 结束后页面继续显示 dance.webm;
// 修复后动作在专属缓冲位播放,结束后正确回到持续循环的 idle.webm,且下一次动作正常。
// 用法：先生成占位素材，再执行 node scripts/e2e-late-idle.mjs。脚本自启隔离服务。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const edgeCandidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const edgePath = edgeCandidates.find((p) => fs.existsSync(p));
if (!edgePath) throw new Error('未找到 Edge');

const toolsDir = path.join(root, '.tools');

function killEdgeTree(edge, profileTag) {
  if (edge.pid === undefined) return;
  // taskkill /T 在部分环境杀不干净 Chromium 进程树,再用 profile 过滤兜底,
  // 否则残留页面会重连 /ws 并持续续租,干扰后续验证(WT-P0-007/009 验证环境)。
  try {
    if (edge.exitCode === null && edge.signalCode === null) {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' });
    }
  } catch { /* ignore */ }
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\" | " +
      `Where-Object { $_.CommandLine -like '*${profileTag}*' } | ` +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { stdio: 'ignore' });
  } catch { /* ignore */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget(edge, edgeProfile) {
  let edgeError;
  edge.on('error', (err) => { edgeError = err; });
  for (let i = 0; i < 15; i++) {
    if (edgeError) throw edgeError;
    // Windows 的 Edge 启动进程可在调试浏览器就绪前以 0 退出。
    if (edge.exitCode !== null && edge.exitCode !== 0) throw new Error(`Edge 启动失败 (退出码 ${edge.exitCode})`);
    try {
      // 从本次浏览器配置读取调试端口，避免连到其他测试或正在使用的浏览器。
      const [debugPort] = fs.readFileSync(path.join(edgeProfile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`, { signal: AbortSignal.timeout(1_000) })).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('CDP 目标页未找到');
}

function prepareFixture(dataDir) {
  const settingsDir = path.join(dataDir, 'config');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
    formatVersion: 1,
    savedVersion: 1,
    settings: { tts: { provider: 'fixed-local' } },
  }));

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'config', 'pet-defaults', 'manifest.json'), 'utf8'));
  const targetPet = path.join(dataDir, 'pets', manifest.petId);
  for (const { file } of manifest.actions) {
    const source = path.join(root, 'data', 'pets', manifest.petId, file);
    if (!fs.existsSync(source)) throw new Error('缺少占位动画素材，请先运行 npm run gen:test-assets');
    const target = path.join(targetPet, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

async function main() {
  // 服务与脚本同进程，强制停止脚本也会释放测试端口。只复制占位动画到独立数据目录。
  const tempRoot = fs.realpathSync(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(tempRoot, 'whaletalk-late-idle-'));
  if (path.dirname(fixture) !== tempRoot) throw new Error('测试目录不在系统临时目录下');
  // WebSocket 关闭回调可能在 app.close 返回后补写日志，等进程退出时再同步清理。
  process.once('exit', () => fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5 }));
  const dataDir = path.join(fixture, 'data');
  const edgeProfile = path.join(fixture, 'edge');
  let app;
  let edge;
  try {
    prepareFixture(dataDir);
    const { createApp } = await tsImport('../src/server/app.ts', import.meta.url);
    app = await createApp({ env: { WHALETALK_DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', PLATFORM: 'mock' } });
    edge = spawn(edgePath, [
      '--headless', '--disable-gpu', '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${edgeProfile}`,
      '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=0',
      '--window-size=760,560',
      'about:blank',
    ], { stdio: 'ignore', windowsHide: true });
    const target = await findTarget(edge, edgeProfile);
    const ws = new WebSocket(target, { maxPayload: 64 * 1024 * 1024, handshakeTimeout: 5_000 });
    try {
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.on('error', reject); });
      return await runScenario(ws, app.urls);
    } finally {
      ws.terminate();
    }
  } finally {
    if (edge) killEdgeTree(edge, path.basename(fixture));
    await app?.close();
  }
}

async function runScenario(ws, urls) {
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
      void send('Fetch.continueRequest', { requestId: msg.params.requestId }).catch((err) => {
        console.error('放行页面资源失败:', err);
      });
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} 响应超时`));
    }, 5_000);
    pending.set(id, (result) => { clearTimeout(timer); resolve(result); });
    ws.send(JSON.stringify({ id, method, params }), (err) => {
      if (!err) return;
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    });
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    return r.result?.result?.value;
  };
  const screenshot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, name), Buffer.from(r.result.data, 'base64'));
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
  await send('Page.navigate', { url: urls.overlay });

  const held = await paused;
  if (!held) throw new Error('未拦截到待机请求(页面未起播?)');
  console.log('已拦截待机请求:', held.request.url.split('/').pop());

  // 待机仍处于预加载时立即派发 dance(复现交错)
  async function submitAction(text, userId) {
    const response = await fetch(`${urls.base}/api/mock/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${new URL(urls.control).hash.slice(1)}` },
      body: JSON.stringify({ type: 'chat', text, userId, userName: '晚待机员' }),
      signal: AbortSignal.timeout(5_000),
    });
    const result = await response.json();
    if (!response.ok || !result.enqueue?.accepted) {
      throw new Error(`模拟弹幕未入队 (${response.status}): ${JSON.stringify(result)}`);
    }
    return result;
  }
  const chat = await submitAction('大肥鱼跳个舞', 'late-idle-1');
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
  await submitAction('挥挥手', 'late-idle-2');
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

  const ok = restored && sawWave && secondRestore;
  console.log(ok ? '晚待机交错端到端:通过' : '晚待机交错端到端:未完全通过');
  return ok;
}

process.exitCode = await main() ? 0 : 1;
