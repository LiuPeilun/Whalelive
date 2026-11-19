// P2 顺序回归驱动:每步前清理 Edge 与遗留状态,等服务空闲,再逐个跑 e2e。
// 解决连续快跑时的租约/安全窗/Edge 残留干扰(既有现象)。
// 用法:node scripts/e2e-sequence.mjs [port]

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? process.env.PORT ?? 3290);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd) {
  try { return spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).status; }
  catch { return 1; }
}

function killEdge() {
  spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\" | Where-Object { $_.CommandLine -match 'edge-profile|lateidle' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { stdio: 'ignore' });
}

function serverHealthy() {
  try {
    const r = spawnSync('curl', ['-s', '--max-time', '3', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${port}/api/health`], { encoding: 'utf8' });
    return r.stdout.trim() === '200';
  } catch { return false; }
}

function runScript(script, args = []) {
  const r = spawnSync('node', [path.join(root, 'scripts', script), ...args], {
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, PORT: String(port) },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

function lastLine(out, pattern) {
  const lines = out.split('\n').filter((l) => pattern.test(l));
  return lines.at(-1) ?? out.slice(-120);
}

// ---- 前置:启动隔离服务 ----
sh(`$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force }`);
fs.rmSync(path.join(root, '.tools', `e2e-server-${port}.pid`), { force: true });
const server = spawn(process.execPath, [path.join(root, 'scripts', 'e2e-server.mjs'), '--port', String(port)], {
  stdio: ['ignore', fs.openSync(path.join(root, '.tools', 'seq-server.log'), 'w'), fs.openSync(path.join(root, '.tools', 'seq-server.log'), 'a')],
  env: { ...process.env, PORT: String(port) },
});
await sleep(12_000);
const results = [];
function record(name, ok) {
  results.push({ name, ok });
  console.log((ok ? '✓ ' : '✗ ') + name);
}

// ---- 1. smoke ×2 ----
{
  const a = runScript('ws-smoke.mjs');
  record('smoke 第1轮 ' + lastLine(a.out, /冒烟结果/), a.code === 0);
  const b = runScript('ws-smoke.mjs');
  record('smoke 第2轮 ' + lastLine(b.out, /冒烟结果/), b.code === 0);
}

// ---- 2. 平台适配器单测已在 vitest 覆盖;此处跑交互类 ----
{
  killEdge();
  await sleep(16_000);
  const a = runScript('e2e-disconnect-safety.mjs');
  record('断线安全窗 ' + lastLine(a.out, /实测/), a.code === 0);
}

{
  await sleep(16_000);
  const a = runScript('e2e-dual-backup.mjs');
  record('双候补风暴 ' + lastLine(a.out, /实测/), a.code === 0);
}

{
  killEdge();
  await sleep(16_000);
  const a = runScript('e2e-backup-takeover.mjs');
  record('候补接管 ' + lastLine(a.out, /实测/), a.code === 0);
}

{
  killEdge();
  await sleep(16_000);
  const a = runScript('browser-e2e.mjs');
  record('浏览器端到端 ' + lastLine(a.out, /通过|失败/), a.code === 0);
}

{
  killEdge();
  await sleep(16_000);
  const a = runScript('control-e2e.mjs');
  record('控制台按钮 ' + lastLine(a.out, /通过|失败/), a.code === 0);
}

{
  killEdge();
  await sleep(16_000);
  const a = runScript('e2e-late-idle.mjs');
  record('晚待机交错 ' + lastLine(a.out, /通过|未完全/), a.code === 0);
}

{
  killEdge();
  await sleep(16_000);
  const a = runScript('lease-lost-e2e.mjs');
  record('租约失效 ' + lastLine(a.out, /验证:/), a.code === 0);
}

{
  const a = runScript('e2e-startlock-regression.mjs');
  record('启动锁回归 ' + lastLine(a.out, /全部通过|项失败/), a.code === 0);
}

{
  // 断线重连完整两段:起服务→起 Edge→stage1(杀服务)→起服务→stage2
  killEdge();
  await sleep(16_000);
  const server1 = spawn(process.execPath, [path.join(root, 'scripts', 'e2e-server.mjs'), '--port', String(port)], { stdio: 'ignore', env: { ...process.env, PORT: String(port) } });
  await sleep(12_000);
  const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--remote-debugging-port=9336',
    '--user-data-dir=' + path.join(root, '.tools', 'edge-profile-reconnectidle'),
    '--no-first-run', '--window-size=480,360', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    `http://127.0.0.1:${port}/overlay?audio=1#${JSON.parse(fs.readFileSync(path.join(root, 'data', 'access.json'), 'utf8')).playback}`,
  ], { stdio: 'ignore', detached: true });
  edge.unref();
  await sleep(10_000);
  const s1 = runScript('e2e-reconnect-idle.mjs', ['stage1']); // 杀服务,Edge 保留
  const server2 = spawn(process.execPath, [path.join(root, 'scripts', 'e2e-server.mjs'), '--port', String(port)], { stdio: 'ignore', env: { ...process.env, PORT: String(port) } });
  await sleep(12_000);
  const s2 = runScript('e2e-reconnect-idle.mjs', ['stage2']);
  record('断线重连 stage1+2 ' + lastLine(s1.out + s2.out, /STAGE/), s1.code === 0 && s2.code === 0);
  try { spawnSync('node', [path.join(root, 'scripts', 'e2e-server.mjs'), '--stop', '--port', String(port)]); } catch { /* 已停 */ }
  killEdge();
}

{
  // 自愈重载:前置 stage1(服务死,Edge 保留),verify 自己起服务并恢复
  const server3 = spawn(process.execPath, [path.join(root, 'scripts', 'e2e-server.mjs'), '--port', String(port)], { stdio: 'ignore', env: { ...process.env, PORT: String(port) } });
  await sleep(12_000);
  const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--remote-debugging-port=9336',
    '--user-data-dir=' + path.join(root, '.tools', 'edge-profile-reconnectidle'),
    '--no-first-run', '--window-size=480,360', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    `http://127.0.0.1:${port}/overlay?audio=1#${JSON.parse(fs.readFileSync(path.join(root, 'data', 'access.json'), 'utf8')).playback}`,
  ], { stdio: 'ignore', detached: true });
  edge.unref();
  await sleep(10_000);
  const s1 = runScript('e2e-reconnect-idle.mjs', ['stage1']);
  const a = runScript('e2e-selfheal-verify.mjs');
  record('自愈重载 ' + lastLine(a.out, /恢复/), s1.code === 0 && a.code === 0);
  try { spawnSync('node', [path.join(root, 'scripts', 'e2e-server.mjs'), '--stop', '--port', String(port)]); } catch { /* 已停 */ }
}

{
  // 503 自愈闭环:前置 stage1(服务死,Edge 保留),503 脚本自己起服务
  killEdge();
  await sleep(16_000);
  const server4 = spawn(process.execPath, [path.join(root, 'scripts', 'e2e-server.mjs'), '--port', String(port)], { stdio: 'ignore', env: { ...process.env, PORT: String(port) } });
  await sleep(12_000);
  const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--remote-debugging-port=9336',
    '--user-data-dir=' + path.join(root, '.tools', 'edge-profile-reconnectidle'),
    '--no-first-run', '--window-size=480,360', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    `http://127.0.0.1:${port}/overlay?audio=1#${JSON.parse(fs.readFileSync(path.join(root, 'data', 'access.json'), 'utf8')).playback}`,
  ], { stdio: 'ignore', detached: true });
  edge.unref();
  await sleep(10_000);
  const s1 = runScript('e2e-reconnect-idle.mjs', ['stage1']);
  const a = runScript('e2e-selfheal-503.mjs');
  record('503 自愈闭环 ' + lastLine(a.out, /全部通过|项失败/), s1.code === 0 && a.code === 0);
  try { spawnSync('node', [path.join(root, 'scripts', 'e2e-server.mjs'), '--stop', '--port', String(port)]); } catch { /* 已停 */ }
}

// ---- 收尾 ----
try { spawnSync('node', [path.join(root, 'scripts', 'e2e-server.mjs'), '--stop', '--port', String(port)]); } catch { /* 已停 */ }
killEdge();
await sleep(1_000);

const failed = results.filter((r) => !r.ok);
console.log('\n==== 顺序回归汇总 ====');
for (const r of results) console.log((r.ok ? '✓ ' : '✗ ') + r.name);
console.log(failed.length === 0 ? '全部通过' : `${failed.length} 项失败: ${failed.map((f) => f.name).join(', ')}`);
process.exit(failed.length === 0 ? 0 : 1);
