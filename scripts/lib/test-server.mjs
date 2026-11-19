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
import net from 'node:net';
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

/** PID 是否仍存活且命令行含本项目入口(活跃登记判定) */
function pidAliveOwnsEntry(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  const cmdLine = execPowerShell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`);
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

/** 健康地址(127.0.0.1)上的端口监听者 PID(无监听时 null)。
 * 只筛端口会先命中 IPv6(::1)监听者,与健康地址不符导致误判未就绪(WT-P1-009)。 */
function listenerPidFor(port) {
  const out = execPowerShell(`(Get-NetTCPConnection -LocalPort ${port} -LocalAddress 127.0.0.1 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`);
  const pid = Number(out.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// 启动互斥锁(WT-P1-009):绑定专用回环端口的监听 socket —— 绑定是内核原子
// 操作,谁绑上谁持有;持有者崩溃时操作系统立即释放端口,无需文件回收,不存在
// 「读到旧状态后按路径删除他人新锁」与「空占位被判陈旧」的竞态(前两轮
// 文件锁方案的残留窗口)。
//
// 协调端口属于工作区共享配置:首次使用发布到 .tools/startlock-port,此后本
// 工作区的启动器一律使用该端口(WT-P1-009)——否则同一工作区内不同环境变量
// 配置的终端会在各自锁下同时操作同一份 PID 登记,互斥失效。
// 首次发布是原子操作(wx 独占创建,WT-P1-009,2026-11-19_093710):并发首次
// 启动时只有一方能创建文件,败者读取已发布的完整值并做冲突检查——不存在
// 「双方都看到缺失、各自发布不同端口」的窗口。已发布的值与环境变量冲突时
// 明确报错,不回退。
const START_LOCK_PORT_FILE = path.join(root, '.tools', 'startlock-port');

function sharedStartLockPort() {
  const wanted = Number(process.env.WHALETALK_STARTLOCK_PORT ?? 0);
  const chosen = wanted > 0 ? wanted : 32109;
  fs.mkdirSync(path.dirname(START_LOCK_PORT_FILE), { recursive: true });
  for (;;) {
    // 已发布:读取完整值并做一致性检查(与 wanted 冲突时明确拒绝)
    if (fs.existsSync(START_LOCK_PORT_FILE)) {
      const shared = Number(fs.readFileSync(START_LOCK_PORT_FILE, 'utf8').trim());
      if (Number.isFinite(shared) && shared > 0) {
        if (wanted > 0 && wanted !== shared) {
          throw new Error(`本工作区启动协调端口已固定为 ${shared}(.tools/startlock-port),与环境变量 WHALETALK_STARTLOCK_PORT=${wanted} 不一致;如需更换请先删除该文件并确保没有正在进行的启动`);
        }
        return shared;
      }
      // 内容无效:极少见(写入中断),按未发布处理,由下方独占创建重写
    }
    // 未发布:原子发布 —— wx 独占创建,只有一个进程能成功
    try {
      const fd = fs.openSync(START_LOCK_PORT_FILE, 'wx');
      fs.writeSync(fd, String(chosen));
      fs.closeSync(fd);
      return chosen;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // 另一启动器已抢先发布:回到读取分支,用已发布的值(可能触发冲突拒绝)
    }
  }
}

class StartLock {
  constructor(port) { this.server = null; this.port = port; }

  async acquire(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const bound = await new Promise((resolve) => {
        const server = net.createServer((socket) => {
          // 立即挂断探测/无关连接:不让已接受连接阻塞 close 回调(Node 的
          // net.Server 等待所有连接关闭才触发 close,WT-P1-009 有界收尾)
          socket.destroy();
        });
        server.once('error', () => resolve(false));
        server.listen(this.port, '127.0.0.1', () => {
          this.server = server;
          resolve(true);
        });
      });
      if (bound) return;
      if (Date.now() > deadline) {
        throw new Error(`启动锁获取超时:协调端口 ${this.port} 被其他程序占用;若确认非本工作区启动器占用,可删除 .tools/startlock-port 后更换端口重试`);
      }
      await sleepMs(200);
    }
  }

  async release() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    // 有界收尾:close 回调最多等 3 秒(连接均已即时销毁,正常远快于此),
    // 超时强制 destroy 并继续 —— 不让启动调用的 finally 无限等待
    await new Promise((resolve) => {
      const timer = setTimeout(() => { server.close(() => {}); server.closeAllConnections?.(); resolve(); }, 3_000);
      server.close(() => { clearTimeout(timer); resolve(); });
    });
  }
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
  const lock = new StartLock(sharedStartLockPort());
  await lock.acquire(opts.startLockTimeoutMs ?? 30_000);
  let occupied = false; // 本次启动是否已持有端口登记(任一步失败时释放)
  let logFd = null;
  let child = null;
  let childExited = false;
  try {
    // --- 临界区:陈旧回收 + 独占登记(启动锁内,无并发窗口) ---
    try {
      fs.closeSync(fs.openSync(pidFile, 'wx')); // 创建即独占
      occupied = true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const raw = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '';
      const registered = Number(raw);
      if (raw !== '' && Number.isFinite(registered) && pidAliveOwnsEntry(registered)) {
        throw new Error(`端口 ${opts.port} 已有活跃测试服务(PID ${registered}):请先 node scripts/e2e-server.mjs --stop --port ${opts.port}`);
      }
      // 空 PID 文件 = 前一持有者在写入 PID 前崩溃的残留(启动锁内无并发,
      // 不可能属于正在进行的启动);非本项目入口 = PID 被复用。均回收后重占。
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
    await lock.release();
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
