// WT-P1-009/013 回归(2026-11-19_002908 复审验收口径):
// 本 harness 自选系统临时端口,不做任何按端口强停与公共文件清理;
// 以无关本地 TCP 替身作哨兵,验证执行前后均正常响应(测试未误伤无关进程)。
// 场景1:PID 写入失败(EIO 注入)→ 启动报错、端口不再监听、可立即重试;
// 场景2:无关程序占用启动协调端口 → 启动明确失败且替身不受影响;
// 场景3:空端口并发两个启动器 → 仅一个服务、败者退出 1、胜者可停止。
// 场景4:与本工作区固定协调端口不一致的环境配置 → 启动明确拒绝(共享配置互斥)。
// 用法:node scripts/e2e-startlock-regression.mjs

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

/** 向系统申请一个当前空闲的回环端口(WT-P1-013:测试自选端口,不强占) */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** 无关本地 TCP 替身(WT-P1-013 回归哨兵):监听并回应 'ok' */
function startSentinel(port) {
  const server = net.createServer((socket) => {
    socket.end('ok');
    socket.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function sentinelResponds(port) {
  return await new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setTimeout(1_500);
    socket.once('data', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
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

async function scenario1(port) {
  console.log(`---- 场景1:PID 写入失败(端口 ${port}) ----`);
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
  if (healthy) stopTestServer(port);
  await sleep(500);
  check('重试实例可正常停止', listenerPid(port) === null);
}

async function scenario2(port, lockPort) {
  console.log(`---- 场景2:无关程序占用启动协调端口 ${lockPort} ----`);
  // lockPort 由调用方从 .tools/startlock-port 读取(工作区共享配置的实际值)
  const squatter = await startSentinel(lockPort); // 替身占用协调端口
  let threw = null;
  try {
    await startTestServer({ port, startLockTimeoutMs: 4_000 });
  } catch (err) {
    threw = err;
  }
  check('协调端口被占时启动明确失败', threw !== null && /启动锁获取超时/.test(String(threw.message)), threw?.message?.slice(0, 90) ?? '未报错');
  const alive = await sentinelResponds(lockPort);
  check('占用协调端口的替身不受影响(未误杀)', alive);
  squatter.close();
  await sleep(300);
}

async function scenario3(port) {
  console.log(`---- 场景3:并发两个启动器(端口 ${port}) ----`);
  const logA = fs.openSync(path.join(root, '.tools', 'lockrace-a.log'), 'w');
  const logB = fs.openSync(path.join(root, '.tools', 'lockrace-b.log'), 'w');
  const env = { ...process.env }; // 协调端口由工作区共享配置统一(WT-P1-009)
  const a = spawn(process.execPath, [path.join(root, 'scripts', 'e2e-server.mjs'), '--port', String(port)], { stdio: ['ignore', logA, logA], env });
  const b = spawn(process.execPath, [path.join(root, 'scripts', 'e2e-server.mjs'), '--port', String(port)], { stdio: ['ignore', logB, logB], env });

  // 轮询等待一个启动器退出(胜者保持前台运行)
  let loserExit = null;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await sleep(500);
    if (a.exitCode !== null && b.exitCode === null) { loserExit = { code: a.exitCode, log: 'lockrace-a.log' }; break; }
    if (b.exitCode !== null && a.exitCode === null) { loserExit = { code: b.exitCode, log: 'lockrace-b.log' }; break; }
    if (a.exitCode !== null && b.exitCode !== null) break; // 双双退出:异常,下方断言捕获
  }
  check('并发启动:恰好一个启动器存活(胜者)', loserExit !== null, `exitA=${a.exitCode} exitB=${b.exitCode}`);
  if (loserExit !== null) {
    const loserText = fs.readFileSync(path.join(root, '.tools', loserExit.log), 'utf8');
    check('败者以拒绝信息退出 1', loserExit.code === 1 && /已有活跃测试服务/.test(loserText), loserText.slice(-160));
  }

  // 胜者服务健康、可停止(仅通过归属校验的 stopTestServer,无强停)
  const healthy = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok).catch(() => false);
  check('胜者服务健康', healthy);
  try { stopTestServer(port); } catch (err) { /* 已退出 */ }
  await sleep(800);
  check('胜者可正常停止', listenerPid(port) === null);
}

/** 场景4:与本工作区固定协调端口不一致的环境配置被拒绝(共享配置互斥) */
async function scenario4(port) {
  console.log(`---- 场景4:不一致的协调端口环境配置(端口 ${port}) ----`);
  const shared = Number(fs.readFileSync(path.join(root, '.tools', 'startlock-port'), 'utf8').trim());
  const mismatched = shared === 32110 ? 32111 : 32110; // 任取一个不同的有效端口
  const proc = spawn(process.execPath, [path.join(root, 'scripts', 'e2e-server.mjs'), '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WHALETALK_STARTLOCK_PORT: String(mismatched) },
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => { proc.on('exit', (c) => resolve(c)); });
  check('不一致的协调端口配置被明确拒绝', code !== 0 && /不一致/.test(out), `code=${code} out=${out.slice(-140)}`);
  check('该配置下未创建服务子进程', listenerPid(port) === null, `listener=${listenerPid(port)}`);
}

// 主流程:哨兵首尾验证 + 临时端口
const sentinelPort = await pickFreePort();
const sentinel = await startSentinel(sentinelPort);
check('哨兵替身启动并可响应(执行前)', await sentinelResponds(sentinelPort));

const port1 = await pickFreePort();
const port2 = await pickFreePort();
const port3 = await pickFreePort();
try {
  await scenario1(port1);
  const sharedLockPort = Number(fs.readFileSync(path.join(root, '.tools', 'startlock-port'), 'utf8').trim());
  await scenario2(port2, sharedLockPort);
  await scenario3(port3);
  await scenario4((await pickFreePort()));
} catch (err) {
  failures += 1;
  console.error('harness 异常:', err);
}
check('哨兵替身仍正常响应(执行后,测试未误伤无关进程)', await sentinelResponds(sentinelPort));
sentinel.close();
console.log(failures === 0 ? '启动锁回归:全部通过' : `启动锁回归:${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
