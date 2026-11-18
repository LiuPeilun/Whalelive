// 测试服务管理(WT-P1-009):e2e 类脚本「杀服务」的归属不再靠进程名/端口猜测,
// 改为只管理由本模块启动并记录 PID 的服务进程。
// - startTestServer:以绝对入口路径启动(node tsx/cli.mjs D:\...\src\server\main.ts),
//   命令行因此携带项目入口绝对路径;PID 写入 .tools/e2e-server.pid;
// - stopTestServer:读 PID → 校验其命令行含本项目入口绝对路径(正反斜杠、
//   大小写均可)→ 仅校验通过才停止。同端口同名异项目入口、PID 复用均不会命中;
// - commandLineOwnsEntry 导出为纯函数,供合成记录验证(异项目同名入口拒绝、
//   实际 Windows 路径接受)。
// 日志统一走行缓冲脱敏(WT-P1-011)。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createRedactingWriter } from './redact-log.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 按端口登记与日志(WT-P1-009):同一工作区可在不同端口并行启动多个测试服务,
// 各自独立登记与日志;停止按目标端口的登记文件核对,互不影响。
function pidFileFor(port) {
  return path.join(root, '.tools', `e2e-server-${port}.pid`);
}

/** 该端口测试服务的日志文件(行缓冲脱敏写入);回归脚本按同一入口读取 */
export function logFileFor(port) {
  return path.join(root, '.tools', `e2e-server-${port}.log`);
}

/** PID 是否仍存活且命令行含本项目入口(活跃登记判定) */
function pidAliveOwnsEntry(pid) {
  let cmdLine = '';
  try {
    cmdLine = String(execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8' }));
  } catch {
    return false;
  }
  return commandLineOwnsEntry(cmdLine);
}

export function entryPath() {
  return path.join(root, 'src', 'server', 'main.ts');
}

/** 命令行是否含本项目服务入口的绝对路径(正反斜杠与大小写均可) */
export function commandLineOwnsEntry(cmdLine, entry = entryPath()) {
  if (typeof cmdLine !== 'string' || cmdLine === '') return false;
  const upper = cmdLine.toUpperCase();
  return upper.includes(entry.toUpperCase()) || upper.includes(entry.replaceAll('\\', '/').toUpperCase());
}

/** 端口在健康 URL 同一地址(127.0.0.1)上的监听者 PID(无监听时 null)。
 * 只筛端口会先命中 IPv6(::1)监听者,与健康地址不符导致误判未就绪(WT-P1-009)。 */
function listenerPidFor(port) {
  try {
    const out = String(execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -LocalAddress 127.0.0.1 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`], { encoding: 'utf8' }));
    const pid = Number(out.trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// 启动互斥锁(WT-P1-009):陈旧登记的"读-校验-删除-重新占用"不是原子的——
// 删除与重新占用之间可能被并发启动器插占,双方都创建服务子进程。把整个
// 启动临界区(陈旧回收 → 独占登记 → 日志 → spawn → 写 PID)放进同一把
// 跨进程锁串行化,所有启动竞态归零。锁超时兜底:持有者崩溃残留时按 mtime
// 超时(60s)视为陈旧可抢。
const START_LOCK = path.join(root, '.tools', 'e2e-server-start.lock');
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquireStartLock(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(START_LOCK, 'wx');
      fs.writeSync(fd, `${process.pid} ${Date.now()}`);
      return fd;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(START_LOCK);
        if (Date.now() - stat.mtimeMs > 60_000) fs.rmSync(START_LOCK, { force: true }); // 陈旧锁
      } catch { /* 竞态中被释放:下轮 wx 即可成功 */ }
      if (Date.now() > deadline) throw new Error('启动锁获取超时(并发启动过多或存在陈旧锁 .tools/e2e-server-start.lock)');
      await sleepMs(300);
    }
  }
}

function releaseStartLock(fd) {
  try { fs.closeSync(fd); } catch { /* 已关闭 */ }
  try { fs.rmSync(START_LOCK, { force: true }); } catch { /* 已释放 */ }
}

/**
 * 启动测试服务并登记 PID。返回 { child, pid, waitHealthy }:
 * 调用方保持自身存活(child 的管道挂在其上),退出前调用 child.kill()。
 */
export async function startTestServer(opts) {
  // 单进程启动:node --import tsx <绝对入口> —— tsx cli 方式会 fork 出真正的
  // 服务子进程,端口监听者与 child.pid 不一致,监听者核对无法成立。
  // 单进程下 child.pid 即监听者,命令行同样携带入口绝对路径。
  if (!fs.existsSync(path.join(root, 'node_modules', 'tsx'))) throw new Error('tsx 依赖不存在(请先 npm install)');
  const pidFile = pidFileFor(opts.port);
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  const lockFd = await acquireStartLock();
  let occupied = false; // 本次启动是否已持有端口登记(任一步失败时释放)
  let logFd = null;
  try {
    // --- 临界区:陈旧回收 + 独占登记(互斥锁内,无插占窗口) ---
    try {
      fs.closeSync(fs.openSync(pidFile, 'wx')); // 创建即独占(空文件 = 占用中)
      occupied = true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const raw = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '';
      const registered = Number(raw);
      if (raw !== '' && Number.isFinite(registered) && pidAliveOwnsEntry(registered)) {
        throw new Error(`端口 ${opts.port} 已有活跃测试服务(PID ${registered}):请先 node scripts/e2e-server.mjs --stop --port ${opts.port}`);
      }
      if (raw === '') {
        throw new Error(`端口 ${opts.port} 的测试服务启动进行中,请稍候`);
      }
      // 锁内无并发:读出的陈旧登记不可能已被换主,可安全回收后重占
      fs.rmSync(pidFile, { force: true });
      fs.closeSync(fs.openSync(pidFile, 'wx'));
      occupied = true;
    }
    // --- 日志打开(失败释放登记,不留空文件卡死后续启动) ---
    const logFile = opts.logFile ?? logFileFor(opts.port);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    logFd = fs.openSync(logFile, 'w');
    const redactor = createRedactingWriter(logFd, opts.extraSecrets ?? []);
    // --- spawn 单进程服务 ---
    const child = spawn(process.execPath, ['--import', 'tsx', entryPath()], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(opts.port) },
    });
    child.stdout.on('data', (d) => redactor.push(d));
    child.stderr.on('data', (d) => redactor.push(d));
    const childPidStr = String(child.pid);
    fs.writeFileSync(pidFile, childPidStr); // 覆写自己占用的文件(writeFileSync 截断)
    let childExited = false;
    child.on('exit', () => { childExited = true;
      redactor.flush();
      try { fs.closeSync(logFd); } catch { /* 已关闭 */ }
      logFd = null;
      // 仅清理本次启动持有的登记(内容仍是自己的 PID);被陈旧清理换主的文件不动
      try { if (fs.readFileSync(pidFile, 'utf8').trim() === childPidStr) fs.rmSync(pidFile, { force: true }); } catch { /* 无文件 */ }
    });
    const waitHealthy = async (timeoutMs = 30_000) => {
      // 就绪判定绑定本次实例(WT-P1-009):健康 URL 同地址(127.0.0.1)的端口
      // 监听者必须是本子进程且健康 200——普通实例占用端口时本子进程
      // EADDRINUSE 退出,监听者永远不是它;IPv6(::1)上的其他监听者不再干扰。
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (childExited) return false;
        if (listenerPidFor(opts.port) === child.pid) {
          try {
            const res = await fetch(`http://127.0.0.1:${opts.port}/api/health`);
            if (res.ok && !childExited) return true;
          } catch { /* 未就绪 */ }
        }
        await sleepMs(400);
      }
      return false;
    };
    return { child, pid: child.pid, waitHealthy };
  } catch (err) {
    // 占用后的任一步失败都释放本次启动拥有的记录(WT-P1-009)
    if (occupied) fs.rmSync(pidFile, { force: true });
    if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* 已关闭 */ } }
    throw err;
  } finally {
    releaseStartLock(lockFd);
  }
}

/** 停止由 startTestServer 启动的指定端口服务;归属校验不通过时抛错且不动任何进程 */
export function stopTestServer(port) {
  const pidFile = pidFileFor(port);
  if (!fs.existsSync(pidFile)) {
    throw new Error(`未找到 ${path.basename(pidFile)}:该端口的测试服务须由 scripts/e2e-server.mjs(或 startTestServer)启动`);
  }
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (!Number.isFinite(pid)) throw new Error('PID 文件内容损坏,请手动清理后重新启动');
  let cmdLine = '';
  try {
    cmdLine = String(execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8' }));
  } catch {
    /* 查询失败按进程不存在处理 */
  }
  if (!commandLineOwnsEntry(cmdLine)) {
    fs.rmSync(pidFile, { force: true }); // 进程已退出或 PID 被复用:仅清登记,不动进程
    throw new Error(`端口 ${port} 的 PID ${pid} 命令行不含本项目服务入口,拒绝停止(进程可能已退出或 PID 被复用)`);
  }
  execFileSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`]);
  fs.rmSync(pidFile, { force: true });
  return `已停止端口 ${port} 的测试服务 PID ${pid}`;
}
