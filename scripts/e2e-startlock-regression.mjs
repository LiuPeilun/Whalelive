// WT-P1-009/013/014 回归(2026-11-19_103853 复审验收口径):
// 全部场景在各自的临时工作区(WHALETALK_TOOLS_DIR)运行,不读取、不创建、不改写
// 调用者工作区的共享协调配置与登记——配置缺失和已有有效值两种初始状态下脚本
// 都通过且初始状态保留(WT-P1-014)。哨兵替身验证测试未误伤无关进程(WT-P1-013)。
// 场景1:PID 写入失败(EIO 注入)→ 启动报错、端口不再监听、可立即重试;
// 场景2:无关程序占用启动协调端口 → 启动明确失败且替身不受影响;
// 场景3:空端口并发两个启动器 → 仅一个服务、败者退出 1、胜者可停止;
// 场景4:与共享配置不一致的环境配置 → 启动明确拒绝;
// 场景5:首次发布竞争,第二方晚于第一方取得锁后发布 → 覆盖被禁止(EEXIST),
//        败者读回获胜值,胜者保有登记并可正常停止(WT-P1-009 验收口径)。
// 用法:node scripts/e2e-startlock-regression.mjs

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
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

/** 每个场景独立的临时工作区 */
function freshTools(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wt-${tag}-`));
}

/** 在指定工具目录环境内启动 CLI,等待健康;返回 { ok, child, out } */
async function launchCli(tools, port, extraEnv = {}, timeoutMs = 20_000) {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'e2e-server.mjs'), '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WHALETALK_TOOLS_DIR: tools, ...extraEnv },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { ok: true, child, out };
    } catch { /* 未就绪 */ }
    if (child.exitCode !== null) return { ok: false, child, out, code: child.exitCode };
  }
  return { ok: false, child, out, timeout: true };
}

/** 在指定工具目录环境内停止 CLI 服务;返回退出码 */
async function stopCli(tools, port) {
  const proc = spawn(process.execPath, [path.join(root, 'scripts', 'e2e-server.mjs'), '--stop', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WHALETALK_TOOLS_DIR: tools },
  });
  return await new Promise((resolve) => { proc.on('exit', (c) => resolve(c)); });
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

const { startTestServer } = await import('./lib/test-server.mjs');

/** 进程内临时切换工具目录(影响本进程 import 的 lib) */
async function withToolsDir(tools, fn) {
  const prev = process.env.WHALETALK_TOOLS_DIR;
  process.env.WHALETALK_TOOLS_DIR = tools;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.WHALETALK_TOOLS_DIR;
    else process.env.WHALETALK_TOOLS_DIR = prev;
  }
}

async function scenario1(port) {
  console.log(`---- 场景1:PID 写入失败(端口 ${port},隔离工作区) ----`);
  const tools = freshTools('s1');
  const result = await withToolsDir(tools, async () => {
    injectPidEio = true;
    let threw = null;
    try {
      await startTestServer({ port });
    } catch (err) {
      threw = err;
    }
    check('PID 写入失败时启动函数报错', threw !== null, threw === null ? '未报错' : threw.message.slice(0, 80));
    injectPidEio = false;
    await sleep(1_500);
    check('失败后端口不再监听(子进程已终止)', listenerPid(port) === null, `listener=${listenerPid(port)}`);
    check('失败后登记已释放', !fs.existsSync(path.join(tools, `e2e-server-${port}.pid`)));
    let retried = null;
    try {
      retried = await startTestServer({ port });
    } catch (err) {
      retried = { error: err };
    }
    const healthy = retried.child ? await retried.waitHealthy(20_000) : false;
    check('立即重试可正常启动', Boolean(retried.child) && healthy, JSON.stringify(retried.error?.message ?? '').slice(0, 80));
    return healthy;
  });
  if (result) {
    const code = await stopCli(tools, port);
    await sleep(800);
    check('重试实例可正常停止', code === 0 && listenerPid(port) === null, `stopCode=${code}`);
  }
  fs.rmSync(tools, { recursive: true, force: true });
}

async function scenario2(port) {
  console.log(`---- 场景2:无关程序占用启动协调端口(隔离工作区) ----`);
  const tools = freshTools('s2');
  const lockPort = 32297;
  const squatter = await startSentinel(lockPort);
  let threw = null;
  await withToolsDir(tools, async () => {
    const prevLock = process.env.WHALETALK_STARTLOCK_PORT;
    process.env.WHALETALK_STARTLOCK_PORT = String(lockPort);
    try {
      await startTestServer({ port, startLockTimeoutMs: 4_000 });
    } catch (err) {
      threw = err;
    } finally {
      if (prevLock === undefined) delete process.env.WHALETALK_STARTLOCK_PORT;
      else process.env.WHALETALK_STARTLOCK_PORT = prevLock;
    }
  });
  check('协调端口被占时启动明确失败', threw !== null && /启动锁获取超时/.test(String(threw.message)), threw?.message?.slice(0, 90) ?? '未报错');
  check('占用协调端口的替身不受影响(未误杀)', await sentinelResponds(lockPort));
  squatter.close();
  fs.rmSync(tools, { recursive: true, force: true });
  await sleep(300);
}

async function scenario3(port) {
  console.log(`---- 场景3:并发两个启动器(端口 ${port},隔离工作区) ----`);
  const tools = freshTools('s3');
  fs.writeFileSync(path.join(tools, 'startlock-port'), '32295'); // 预置共享配置,双方同锁
  const a = spawn(process.execPath, [path.join(root, 'scripts', 'e2e-server.mjs'), '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WHALETALK_TOOLS_DIR: tools },
  });
  let outA = '';
  a.stdout.on('data', (d) => { outA += d; });
  a.stderr.on('data', (d) => { outA += d; });
  const b = spawn(process.execPath, [path.join(root, 'scripts', 'e2e-server.mjs'), '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WHALETALK_TOOLS_DIR: tools },
  });
  let outB = '';
  b.stdout.on('data', (d) => { outB += d; });
  b.stderr.on('data', (d) => { outB += d; });

  let loserExit = null;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await sleep(500);
    if (a.exitCode !== null && b.exitCode === null) { loserExit = { code: a.exitCode, out: outA }; break; }
    if (b.exitCode !== null && a.exitCode === null) { loserExit = { code: b.exitCode, out: outB }; break; }
    if (a.exitCode !== null && b.exitCode !== null) break;
  }
  check('并发启动:恰好一个启动器存活(胜者)', loserExit !== null, `exitA=${a.exitCode} exitB=${b.exitCode}`);
  if (loserExit !== null) {
    check('败者以拒绝信息退出 1', loserExit.code === 1 && /已有活跃测试服务/.test(loserExit.out), loserExit.out.slice(-160));
  }
  let healthy = false;
  for (let i = 0; i < 20 && !healthy; i += 1) {
    healthy = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok).catch(() => false);
    if (!healthy) await sleep(1_000);
  }
  check('胜者服务健康', healthy);
  const stopCode = await stopCli(tools, port);
  await sleep(800);
  check('胜者可正常停止', stopCode === 0 && listenerPid(port) === null, `stopCode=${stopCode}`);
  fs.rmSync(tools, { recursive: true, force: true });
}

async function scenario4(port) {
  console.log(`---- 场景4:不一致的协调端口环境配置(端口 ${port},隔离工作区) ----`);
  const tools = freshTools('s4');
  fs.writeFileSync(path.join(tools, 'startlock-port'), '32222');
  const proc = spawn(process.execPath, [path.join(root, 'scripts', 'e2e-server.mjs'), '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WHALETALK_TOOLS_DIR: tools, WHALETALK_STARTLOCK_PORT: '32233' },
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => { proc.on('exit', (c) => resolve(c)); });
  check('不一致的协调端口配置被明确拒绝', code !== 0 && /不一致/.test(out), `code=${code} out=${out.slice(-140)}`);
  check('该配置下未创建服务子进程', listenerPid(port) === null, `listener=${listenerPid(port)}`);
  check('隔离工作区的预置配置未被改写', fs.readFileSync(path.join(tools, 'startlock-port'), 'utf8').trim() === '32222');
  fs.rmSync(tools, { recursive: true, force: true });
}

async function scenario5(port) {
  console.log(`---- 场景5:首次发布竞争,第二方晚于第一方取得锁(端口 ${port},隔离工作区) ----`);
  const tools = freshTools('s5'); // 无预置配置 = 双方都将进入首次发布
  const portA = 32211;
  const portB = 32213;

  // 固定调度(复审验收口径):第一方先启动并等待其取得锁且服务健康
  // (= 已读取自己的值并绑定协调端口),第二方在此之后才发起首次发布
  const first = await launchCli(tools, port, { WHALETALK_STARTLOCK_PORT: String(portA) });
  check('第一方(先发布)启动成功并取得锁', first.ok, first.out.slice(-120));

  const second = spawn(process.execPath, [path.join(root, 'scripts', 'e2e-server.mjs'), '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WHALETALK_TOOLS_DIR: tools, WHALETALK_STARTLOCK_PORT: String(portB) },
  });
  let outB2 = '';
  second.stdout.on('data', (d) => { outB2 += d; });
  second.stderr.on('data', (d) => { outB2 += d; });
  const secondCode = await new Promise((resolve) => { second.on('exit', (c) => resolve(c)); });

  // link 禁止覆盖:配置仍是第一方的值,第二方读回获胜值后因环境变量冲突退出
  const published = Number(fs.readFileSync(path.join(tools, 'startlock-port'), 'utf8').trim());
  check('第二方发布被禁止,配置保留第一方的完整值', published === portA, `published=${published}`);
  check('第二方以不一致冲突退出 1', secondCode === 1 && /不一致/.test(outB2), `code=${secondCode} out=${outB2.slice(-140)}`);

  // 获胜实例必须保有登记并可正常停止(复审验收口径)
  const registered = fs.existsSync(path.join(tools, `e2e-server-${port}.pid`));
  check('获胜实例登记保留(未消失)', registered);
  const healthy = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok).catch(() => false);
  check('获胜实例持续健康', healthy);
  const stopCode = await stopCli(tools, port);
  await sleep(800);
  check('获胜实例可正常停止', stopCode === 0 && listenerPid(port) === null, `stopCode=${stopCode}`);
  fs.rmSync(tools, { recursive: true, force: true });
}

// 主流程:哨兵 + 调用者工作区初始状态(缺失或已有值)在执行前后保持一致
const sentinelPort = await pickFreePort();
const sentinel = await startSentinel(sentinelPort);
check('哨兵替身启动并可响应(执行前)', await sentinelResponds(sentinelPort));

const mainCfg = path.join(root, '.tools', 'startlock-port');
const cfgBefore = fs.existsSync(mainCfg) ? fs.readFileSync(mainCfg, 'utf8').trim() : null;

try {
  await scenario1(await pickFreePort());
  await scenario2(await pickFreePort());
  await scenario3(await pickFreePort());
  await scenario4(await pickFreePort());
  await scenario5(await pickFreePort());
} catch (err) {
  failures += 1;
  console.error('harness 异常:', err);
}

check('哨兵替身仍正常响应(执行后,测试未误伤无关进程)', await sentinelResponds(sentinelPort));
sentinel.close();
const cfgAfter = fs.existsSync(mainCfg) ? fs.readFileSync(mainCfg, 'utf8').trim() : null;
check('调用者工作区共享协调配置初始状态保留(缺失或已有值不变,WT-P1-014)', cfgBefore === cfgAfter, `before=${cfgBefore} after=${cfgAfter}`);
console.log(failures === 0 ? '启动锁回归:全部通过' : `启动锁回归:${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
