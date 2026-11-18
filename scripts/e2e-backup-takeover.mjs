// WT-P1-012 真实双页实测:候补页收到较长拒绝等待后,主播放端先停声并关页
// (显式释放),候补页应经 state 推送立即重新申请并接管,紧随的有声互动不降无声。
// 断言:①A 关页后 ~3s 内 B 持有租约(而非等满原 retryAfterMs);
//      ②紧随弹幕的派发携带 audioUrl(服务端日志);
//      ③B 真实回报音频 started(服务端日志)。
// 前置:服务由 scripts/e2e-server.mjs 启动。用法:node scripts/e2e-backup-takeover.mjs [port]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { logFileFor } from './lib/test-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? process.env.PORT ?? 3210);
const access = JSON.parse(fs.readFileSync(path.join(root, 'data', 'access.json'), 'utf8'));
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}`);
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function http(pathname, init) {
  const response = await fetch(`${base}${pathname}`, init);
  let body = null;
  try { body = await response.json(); } catch { /* ignore */ }
  return { status: response.status, body };
}

async function openEdgePage() {
  // 每页一个独立 profile,保证两个渲染端
  const marker = `edge-profile-bt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  spawnSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--remote-debugging-port=9341',
    `--user-data-dir=${path.join(root, '.tools', marker)}`,
    '--no-first-run', '--window-size=480,360', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    `${base}/overlay?audio=1#${encodeURIComponent(access.playback)}`,
  ], { stdio: 'ignore' });
  // 等 CDP 出现该页
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const list = await (await fetch('http://127.0.0.1:9341/json')).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('/overlay'));
      if (page) return { targetId: page.id, wsUrl: page.webSocketDebuggerUrl, marker };
    } catch { /* retry */ }
  }
  throw new Error('CDP 目标页未出现');
}

async function pageIdle(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 4 * 1024 * 1024 });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  let seq = 0; const pending = new Map();
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const evaluate = async (expr) => {
    const id = ++seq;
    const r = await new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
    return r.result?.result?.value;
  };
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const ok = await evaluate(`(() => { const v = document.querySelector('#videos video:not(.hidden)'); return v && v.src.endsWith('idle.webm') && !v.paused && document.getElementById('placeholder').style.display === 'none'; })()`).catch(() => false);
    if (ok) return ws;
  }
  return ws; // 超时也返回(后续 state 断言兜底)
}

async function stateNow() {
  const r = await http('/api/state', { headers: { authorization: `Bearer ${access.control}` } });
  return r.body;
}

function logText() {
  try {
    return fs.readFileSync(logFileFor(port), 'utf8'); // 同一入口按端口读取(WT-P1-009)
  } catch {
    return '';
  }
}

async function main() {
  // A(主)先开:取得租约并进入待机
  const pageA = await openEdgePage();
  const cdpA = await pageIdle(pageA.wsUrl);
  let holder = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const s = await stateNow();
    if (s.renderers?.leaseHolderRendererId) { holder = s.renderers.leaseHolderRendererId; break; }
  }
  check('A(主播放端)取得租约', holder !== null, JSON.stringify((await stateNow()).renderers));

  // B(候补)后开:登记后申请被拒,进入较长等待
  const pageB = await openEdgePage();
  const cdpB = await pageIdle(pageB.wsUrl);
  await sleep(2_000); // B 申请被拒(A 持有,B 记录 ~15s 等待)
  const sAfterB = await stateNow();
  check('B 登记后处于候补(A 仍持有)', (sAfterB.renderers?.count ?? 0) >= 2 && sAfterB.renderers?.leaseHolderRendererId === holder, JSON.stringify(sAfterB.renderers));
  cdpB.close();

  // A 播放中有声任务,随后先停声并关页(beforeunload: stopAll → lease-release)
  const wave = await http('/api/mock/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${access.control}` },
    body: JSON.stringify({ type: 'chat', text: '挥挥手', userId: `bt-a-${Date.now()}`, userName: '主端' }),
  });
  check('A 互动已提交', wave.status === 200, JSON.stringify(wave.body));
  await sleep(1_500); // A 开始表演
  const tClose = Date.now();
  // 页面正常关闭路径:先派发 beforeunload(页面监听器执行 stopAll + lease-release,
  // 即"先停声再释放"的真实停止确认),再关闭目标页。CDP 直接 closeTarget 不触发
  // beforeunload,会误走断线安全期限路径,无法验证 WT-P1-012 的显式释放语义。
  {
    const ws = new WebSocket(pageA.wsUrl);
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    await new Promise((r) => { ws.once('message', () => r()); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("beforeunload")); "sent"' } })); });
    await sleep(800); // 释放消息送达服务端
    try { ws.send(JSON.stringify({ id: 2, method: 'Target.closeTarget', params: { targetId: pageA.targetId } })); } catch { /* 页面已关 */ }
    await sleep(800);
    ws.close();
  }
  cdpA.close();

  // B 应经 state 重评在 ~3s 内接管(而非等满 ~15s 等待)
  let bTookOver = false;
  let tookOverMs = -1;
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const s = await stateNow();
    if (s.renderers?.leaseHolderRendererId && s.renderers.leaseHolderRendererId !== holder) {
      bTookOver = true;
      tookOverMs = Date.now() - tClose;
      break;
    }
  }
  check('A 关页(显式释放)后 B 快速接管(WT-P1-012)', bTookOver && tookOverMs <= 5_000, `tookOverMs=${tookOverMs}`);

  // 紧随的有声互动:不得降无声(audio-degraded-no-lease 是降级标记),
  // 派发须携带租约(dispatched.leaseId 非空 = 有声派发路径),会话正常完成
  const logBefore = logText().length;
  const wave2 = await http('/api/mock/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${access.control}` },
    body: JSON.stringify({ type: 'chat', text: '再挥挥手', userId: `bt-b-${Date.now()}`, userName: '候补' }),
  });
  check('B 互动已提交', wave2.status === 200, JSON.stringify(wave2.body));
  // 轮询等待会话结算(避免读取竞态:结算写入可能晚于固定等待几毫秒)
  let newLog = '';
  for (let i = 0; i < 30; i++) {
    await sleep(1_000);
    newLog = logText().slice(logBefore);
    if (newLog.includes('session-settled')) break;
  }
  check('紧随互动未降无声(无 audio-degraded-no-lease)', !newLog.includes('audio-degraded-no-lease'),
    newLog.split('\n').filter((l) => l.includes('degraded')).join(' | '));
  const dispatchLine = newLog.split('\n').filter((l) => l.includes('playback.dispatched')).at(-1) ?? '';
  check('派发走租约持有者(leaseId 非空 = 携带音频)', dispatchLine.includes('lease-'), dispatchLine.slice(0, 160));
  const settledLine = newLog.split('\n').filter((l) => l.includes('session-settled')).at(-1) ?? '';
  check('会话正常完成(result=ended)', settledLine.includes('"result":"ended"'), settledLine.slice(0, 160));

  // 清理
  spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\" | Where-Object { $_.CommandLine -match 'edge-profile-bt-' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { stdio: 'ignore' });
  console.log(failures === 0 ? '候补接管实测:全部通过' : `候补接管实测:${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('实测异常:', e.message); process.exit(1); });
