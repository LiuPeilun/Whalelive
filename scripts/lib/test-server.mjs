// 测试服务管理(WT-P1-009):e2e 类脚本「杀服务」的归属不再靠进程名/端口猜测,
// 改为只管理由本模块启动并记录 PID 的服务进程。
// - startTestServer:单进程启动(node --import tsx <绝对入口>),命令行携带项目
//   入口绝对路径;PID 按端口写入 .tools/e2e-server-<port>.pid;
// - stopTestServer:读 PID → 校验其命令行含本项目入口绝对路径(正反斜杠、
//   大小写均可)→ 仅校验通过才停止。同端口同名异项目入口、PID 复用均不会命中;
// - commandLineOwnsEntry 导出为纯函数,供合成记录验证(异项目同名入口拒绝、
//   实际 Windows 路径接受)。
// 启动并发与失败路径(WT-P1-009):跨进程启动锁串行化整个临界区;任一步失败
// 终止已创建的子进程并等待退出,再释放登记;锁回收前重新核对内容与文件标识,
// 不按早先读到的状态删除其他启动器新取得的锁;释放核对 nonce。日志统一走
// 行缓冲脱敏(WT-P1-011)。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createRedactingWriter } from './redact-log.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function pidFileFor(port) {
  return path.join(root, '.tools', `e2e-server-${port}.pid`);
}

/** 该端口测试服务的日志文件(行缓冲脱敏写入);回归脚本按同一入口读取 */
export function logFileFor(port) {
  return path.join(root, '.tools', `e2e-server-${port}.log`);
}

function execPowerShell(command) {
  try {
    return String(execFileSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' }));
  } catch {
    return '';
  }
}

/** PID 是否仍存活(不校验入口;用于启动锁持有者检查) */
function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  return execPowerShell(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'dead' }`).trim() === 'alive';
}

/** PID 是否仍存活且命令行含本项目入口(活跃登记判定) */
function pidAliveOwnsEntry(pid) {
  if (!pidAlive(pid)) return false;
  return commandLineOwnsEntry(execPowerShell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`));
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

/** 健康地址(127.0.0.1)上的端口监听者 PID(无监听时 null)。
 * 只筛端口会先命中 IPv6(::1)监听者,与健康地址不符导致误判未就绪(WT-P1-009)。 */
function listenerPidFor(port) {
  const out = execPowerShell(`(Get-NetTCPConnection -LocalPort ${port} -LocalAddress 127.0.0.1 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`);
  const pid = Number(out.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

// 启动互斥锁(WT-P1-009):整个启动临界区(陈旧回收→独占登记→日志→spawn→
// 写 PID)由跨进程锁串行化。锁内容携带持有者 PID 与随机 nonce:
// - 回收陈旧锁前重新核对内容与文件标识(ino),与判定时不一致即放弃 ——
//   绝不按早先读到的状态删除其他启动器新取得的锁;
// - 释放时核对内容仍是自己写入的 nonce,对应不上则不删除(已被换主)。
const START_LOCK = path.join(root, '.tools', 'e2e-server-start.lock');
const STALE_LOCK_MS = 60_000;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function inspectStartLock() {
  try {
    const content = fs.readFileSync(START_LOCK, 'utf8').trim();
    const st = fs.statSync(START_LOCK);
    return { content, ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    return null; // 不存在
  }
}

async function acquireStartLock(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const nonce = `${process.pid} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const fd = fs.openSync(START_LOCK, 'wx');
      fs.writeSync(fd, nonce);
      return { fd, nonce };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const cur = inspectStartLock();
    if (cur !== null) {
      const holderPid = Number(cur.content.split(' ')[0] ?? '');
      const stale = cur.content === ''
        || !Number.isFinite(holderPid) || holderPid <= 0 || !pidAlive(holderPid)
        || Date.now() - cur.mtimeMs > STALE_LOCK_MS;
      if (stale) {
        // 回收前重新核对:内容与文件标识仍与刚才判定的一致才删除。
        // 已被其他启动器收走并重建(ino 或内容变化)则放弃本次回收,回到 wx
        // 重试 —— 不删除他人的新锁(WT-P1-009)。剩余窗口为核对与删除之间的
        // 单次系统调用间隔,需要另一启动器在该间隔内完成整套回收+重建,实践中不可达。
        const re = inspectStartLock();
        if (re !== null && re.ino === cur.ino && re.content === cur.content) {
          try { fs.rmSync(START_LOCK, { force: true }); } catch { /* 竞态:重试即可 */ }
        }
        continue;
      }
    }
    if (Date.now() > deadline) {
      throw new Error('启动锁获取超时(并发启动过多或存在陈旧锁 .tools/e2e-server-start.lock)');
    }
    await sleepMs(300);
  }
}

function releaseStartLock(lock) {
  if (!lock) return;
  // 释放对应当前持有者:内容仍是自己写入的 nonce 才删除;对应不上(被换主)不删
  try {
    if (fs.readFileSync(START_LOCK, 'utf8').trim() === lock.nonce) {
      fs.rmSync(START_LOCK, { force: true });
    }
  } catch { /* 已被收走或不存在 */ }
  try { fs.closeSync(lock.fd); } catch { /* 已关闭 */ }
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
  const lock = await acquireStartLock(opts.startLockTimeoutMs ?? 30_000);
  let occupied = false; // 本次启动是否已持有端口登记(任一步失败时释放)
  let logFd = null;
  let child = null;
  let childExited = false;
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
    child = spawn(process.execPath, ['--import', 'tsx', entryPath()], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(opts.port) },
    });
    child.stdout.on('data', (d) => redactor.push(d));
    child.stderr.on('data', (d) => redactor.push(d));
    const childPidStr = String(child.pid);
    fs.writeFileSync(pidFile, childPidStr); // 失败(如 EIO)进入下方收尾:子进程会被终止
    child.on('exit', () => { childExited = true;
      redactor.flush();
      try { fs.closeSync(logFd); logFd = null; } catch { /* 已关闭 */ }
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
    // 失败收尾(WT-P1-009):已创建的子进程必须终止并等待退出,再释放本次
    // 启动占用的记录 —— 服务不得在启动报错后继续运行(无登记不可停止)。
    if (child !== null && !childExited) {
      try { child.kill(); } catch { /* 已退出 */ }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (occupied) { try { fs.rmSync(pidFile, { force: true }); } catch { /* 已清理 */ } }
    if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* 已关闭 */ } }
    throw err;
  } finally {
    releaseStartLock(lock);
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
  const cmdLine = execPowerShell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`);
  if (!commandLineOwnsEntry(cmdLine)) {
    fs.rmSync(pidFile, { force: true }); // 进程已退出或 PID 被复用:仅清登记,不动进程
    throw new Error(`端口 ${port} 的 PID ${pid} 命令行不含本项目服务入口,拒绝停止(进程可能已退出或 PID 被复用)`);
  }
  execFileSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`]);
  fs.rmSync(pidFile, { force: true });
  return `已停止端口 ${port} 的测试服务 PID ${pid}`;
}
