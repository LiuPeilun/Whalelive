// WT-P1-009 回归(2026-11-18_231846 复审验收口径):
// 场景1:PID 写入失败(EIO 注入)→ 启动报错、端口不再监听、可立即重试;
// 场景2:他人新取得的启动锁(存活持有者+新 mtime)不被等待方删除;
// 场景3:两个启动器争抢陈旧启动锁 → 仅一个服务、败者退出 1、胜者可停止。
// 用法:node scripts/e2e-startlock-regression.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const START_LOCK = path.join(root, '.tools', 'e2e-server-start.lock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}`);
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function execPowerShell(command) {
  try {
    return String(execFileSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' }));
  } catch {
    return '';
  }
}

function listenerPid(port) {
  const out = execPowerShell(`(Get-NetTCPConnection -LocalPort ${port} -LocalAddress 127.0.0.1 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`);
  const pid = Number(out.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function killListener(port) {
  const pid = listenerPid(port);
  if (pid !== null) execPowerShell(`Stop-Process -Id ${pid} -Force`);
}

// PID 写入 EIO 注入:模块按属性访问 fs.writeFileSync,调用时查找,可被替换
const origWriteFileSync = fs.writeFileSync;
let injectPidEio = false;
fs.writeFileSync = function (p, ...rest) {
  if (injectPidEio && String(p).endsWith('.pid')) {
    injectPidEio = false;
    throw Object.assign(new Error('inject EIO'), { code: 'EIO' });
  }
  return origWriteFileSync.call(this, p, ...rest);
};

const { startTestServer, stopTestServer } = await import('./lib/test-server.mjs');

async function scenario1() {
  console.log('---- 场景1:PID 写入失败 ----');
  const port = 3210;
  killListener(port);
  try { stopTestServer(port); } catch { /* 无登记 */ }
  await sleep(500);
  fs.rmSync(path.join(root, '.tools', `e2e-server-${port}.pid`), { force: true });

  injectPidEio = true;
  let threw = null;
  try {
    await startTestServer({ port });
  } catch (err) {
    threw = err;
  }
  check('PID 写入失败时启动函数报错', threw !== null, threw === null ? '未报错' : threw.message.slice(0, 80));
  injectPidEio = false;

  await sleep(1_500); // 等待子进程被终止并退出
  check('失败后端口不再监听(子进程已终止)', listenerPid(port) === null, `listener=${listenerPid(port)}`);
  check('失败后登记已释放', !fs.existsSync(path.join(root, '.tools', `e2e-server-${port}.pid`)));

  // 可立即重试
  let retried = null;
  try {
    retried = await startTestServer({ port });
  } catch (err) {
    retried = { error: err };
  }
  const healthy = retried.child ? await retried.waitHealthy(20_000) : false;
  check('立即重试可正常启动', Boolean(retried.child) && healthy, JSON.stringify(retried.error?.message ?? '').slice(0, 80));
  if (healthy) {
    stopTestServer(port);
    await sleep(500);
  }
  check('重试实例可正常停止', listenerPid(port) === null);
}

async function scenario2() {
  console.log('---- 场景2:他人的新锁不被删除 ----');
  const port = 3211;
  killListener(port);
  try { stopTestServer(port); } catch { /* 无登记 */ }
  fs.rmSync(START_LOCK, { force: true });

  // 他人新取得的锁:存活持有者(本进程)+ 新 mtime + 随机 nonce
  const phantomNonce = `${process.pid} phantom-${Date.now()}`;
  fs.writeFileSync(START_LOCK, phantomNonce);

  let threw = null;
  try {
    await startTestServer({ port, startLockTimeoutMs: 4_000 });
  } catch (err) {
    threw = err;
  }
  check('他人的活跃锁使启动等待超时报错', threw !== null && /启动锁获取超时/.test(String(threw.message)), threw?.message?.slice(0, 80) ?? '未报错');
  const current = fs.existsSync(START_LOCK) ? fs.readFileSync(START_LOCK, 'utf8').trim() : '';
  check('他人的新锁未被删除(内容原样保留)', current === phantomNonce, `content=${current.slice(0, 50)}`);
  fs.rmSync(START_LOCK, { force: true });
}

async function scenario3() {
  console.log('---- 场景3:两个启动器争抢陈旧锁 ----');
  const port = 3210;
  killListener(port);
  try { stopTestServer(port); } catch { /* 无登记 */ }
  fs.rmSync(START_LOCK, { force: true });
  fs.rmSync(path.join(root, '.tools', `e2e-server-${port}.pid`), { force: true });

  // 陈旧启动锁:持有者 PID 已死 + mtime 70s 前
  fs.writeFileSync(START_LOCK, `999999 stale-${Date.now()}`);
  const past = new Date(Date.now() - 70_000);
  fs.utimesSync(START_LOCK, past, past);

  const logA = fs.openSync(path.join(root, '.tools', 'lockrace-a.log'), 'w');
  const logB = fs.openSync(path.join(root, '.tools', 'lockrace-b.log'), 'w');
  const a = spawn(process.execPath, [path.join(root, 'scripts', 'e2e-server.mjs'), '--port', String(port)], { stdio: ['ignore', logA, logA] });
  const b = spawn(process.execPath, [path.join(root, 'scripts', 'e2e-server.mjs'), '--port', String(port)], { stdio: ['ignore', logB, logB] });

  // 轮询等待一个启动器退出(胜者保持前台运行)
  let loserExit = null;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await sleep(500);
    if (a.exitCode !== null && b.exitCode === null) { loserExit = { code: a.exitCode, log: 'lockrace-a.log' }; break; }
    if (b.exitCode !== null && a.exitCode === null) { loserExit = { code: b.exitCode, log: 'lockrace-b.log' }; break; }
    if (a.exitCode !== null && b.exitCode !== null) break; // 双双退出:异常,下方断言捕获
  }
  check('争抢陈旧锁:恰好一个启动器存活(胜者)', loserExit !== null, `exitA=${a.exitCode} exitB=${b.exitCode}`);
  if (loserExit !== null) {
    const loserText = fs.readFileSync(path.join(root, '.tools', loserExit.log), 'utf8');
    check('败者以拒绝信息退出 1', loserExit.code === 1 && /已有活跃测试服务/.test(loserText), loserText.slice(-160));
  }

  // 胜者服务健康、可停止
  const healthy = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok).catch(() => false);
  check('胜者服务健康', healthy);
  try { stopTestServer(port); } catch (err) { /* 已退出 */ }
  await sleep(800);
  check('胜者可正常停止', listenerPid(port) === null);
  fs.rmSync(START_LOCK, { force: true });
}

try {
  await scenario1();
  await scenario2();
  await scenario3();
} catch (err) {
  failures += 1;
  console.error('harness 异常:', err);
}
console.log(failures === 0 ? '启动锁回归:全部通过' : `启动锁回归:${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
