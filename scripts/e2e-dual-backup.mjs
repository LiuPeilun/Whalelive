// WT-P1-012 双候补风暴实测:持有端断线(走安全期限路径)后,两个候补页应按
// 服务端等待建议退避,不得相互触发高频申请-拒绝循环。
// 断言:①断线后 12s 采样窗内服务端租约拒绝次数有界(< 20;修复前 443ms 内 144 次);
//      ②安全期限过后仍有候补取得租约(退避链未死);
//      ③随后有声互动不降无声(链路健康)。
// 前置:服务由 scripts/e2e-server.mjs 启动。用法:node scripts/e2e-dual-backup.mjs [port]

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

function openEdgePage(marker) {
  spawnSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--remote-debugging-port=9342',
    `--user-data-dir=${path.join(root, '.tools', marker)}`,
    '--no-first-run', '--window-size=480,360', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    `${base}/overlay?audio=1#${encodeURIComponent(access.playback)}`,
  ], { stdio: 'ignore' });
}

async function waitHolder(expectedHolder) {
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const r = await http('/api/state', { headers: { authorization: `Bearer ${access.control}` } });
    const h = r.body?.renderers?.leaseHolderRendererId;
    if (expectedHolder === null ? h !== null && h !== undefined : h) return h;
  }
  return null;
}

function logText() {
  try { return fs.readFileSync(logFileFor(port), 'utf8'); } catch { return ''; } // 同一入口按端口读取(WT-P1-009)
}

function killEdgeByMarker(marker) {
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object { $_.CommandLine -match '${marker}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' });
}

async function main() {
  const markerA = `edge-profile-db-a-${Date.now()}`;
  const markerB = `edge-profile-db-b-${Date.now()}`;
  const markerC = `edge-profile-db-c-${Date.now()}`;

  // A 持有租约;B、C 两候补登记并进入等待
  openEdgePage(markerA);
  const holder = await waitHolder(null);
  check('A(持有端)取得租约', holder !== null);
  openEdgePage(markerB);
  await sleep(2_500);
  openEdgePage(markerC);
  await sleep(2_500);
  const r = await http('/api/state', { headers: { authorization: `Bearer ${access.control}` } });
  check('双候补登记完成(≥3 端,A 仍持有)', (r.body?.renderers?.count ?? 0) >= 3 && r.body?.renderers?.leaseHolderRendererId === holder, JSON.stringify(r.body?.renderers));

  // A 断线(杀 Edge 进程:无 beforeunload,走 unregister 安全期限路径)
  const deniedBefore = (logText().match(/ws\.lease-denied/g) ?? []).length;
  killEdgeByMarker(markerA);
  await sleep(12_000); // 安全期限采样窗(修复前 443ms 内即 144 次拒绝)
  const deniedAfter = (logText().match(/ws\.lease-denied/g) ?? []).length;
  const denials = deniedAfter - deniedBefore;
  check(`断线安全窗内候补按建议退避(12s 内拒绝 ${denials} 次 < 20)`, denials < 20, `denials=${denials}`);

  // 安全期限过后:某候补取得租约(退避链未死)
  const newHolder = await waitHolder(null);
  check('安全期限后候补取得租约(退避链未死)', newHolder !== null && newHolder !== holder);

  // 链路健康:有声互动不降无声
  const logBefore = logText().length;
  const wave = await http('/api/mock/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${access.control}` },
    body: JSON.stringify({ type: 'chat', text: '挥挥手', userId: `db-${Date.now()}`, userName: '双候补员' }),
  });
  check('互动已提交', wave.status === 200);
  let newLog = '';
  for (let i = 0; i < 15; i++) {
    await sleep(1_000);
    newLog = logText().slice(logBefore);
    if (newLog.includes('session-settled')) break;
  }
  check('有声互动未降无声', !newLog.includes('audio-degraded-no-lease'));

  killEdgeByMarker(markerB);
  killEdgeByMarker(markerC);
  console.log(failures === 0 ? '双候补风暴实测:全部通过' : `双候补风暴实测:${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('实测异常:', e.message); process.exit(1); });
