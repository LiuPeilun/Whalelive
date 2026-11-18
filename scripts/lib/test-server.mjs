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
const PID_FILE = path.join(root, '.tools', 'e2e-server.pid');

export function entryPath() {
  return path.join(root, 'src', 'server', 'main.ts');
}

/** 命令行是否含本项目服务入口的绝对路径(正反斜杠与大小写均可) */
export function commandLineOwnsEntry(cmdLine, entry = entryPath()) {
  if (typeof cmdLine !== 'string' || cmdLine === '') return false;
  const upper = cmdLine.toUpperCase();
  return upper.includes(entry.toUpperCase()) || upper.includes(entry.replaceAll('\\', '/').toUpperCase());
}

/**
 * 启动测试服务并登记 PID。返回 { child, pid, waitHealthy }:
 * 调用方保持自身存活(child 的管道挂在其上),退出前调用 child.kill()。
 */
export function startTestServer(opts) {
  const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsxCli)) throw new Error(`tsx CLI 不存在: ${tsxCli}`);
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  const logFd = fs.openSync(opts.logFile, 'w');
  const redactor = createRedactingWriter(logFd, opts.extraSecrets ?? []);
  const child = spawn(process.execPath, [tsxCli, entryPath()], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(opts.port) },
  });
  child.stdout.on('data', (d) => redactor.push(d));
  child.stderr.on('data', (d) => redactor.push(d));
  child.on('exit', () => {
    redactor.flush();
    try { fs.closeSync(logFd); } catch { /* 已关闭 */ }
    try { if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(child.pid)) fs.rmSync(PID_FILE, { force: true }); } catch { /* 无文件 */ }
  });
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(child.pid));
  const waitHealthy = async (timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${opts.port}/api/health`);
        if (res.ok) return true;
      } catch { /* 未就绪 */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  };
  return { child, pid: child.pid, waitHealthy };
}

/** 停止由 startTestServer 启动的服务;归属校验不通过时抛错且不动任何进程 */
export function stopTestServer() {
  if (!fs.existsSync(PID_FILE)) {
    throw new Error('未找到 .tools/e2e-server.pid:测试服务须由 scripts/e2e-server.mjs(或 startTestServer)启动');
  }
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
  if (!Number.isFinite(pid)) throw new Error('PID 文件内容损坏,请手动清理后重新启动');
  let cmdLine = '';
  try {
    cmdLine = String(execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8' }));
  } catch {
    /* 查询失败按进程不存在处理 */
  }
  if (!commandLineOwnsEntry(cmdLine)) {
    fs.rmSync(PID_FILE, { force: true }); // 进程已退出或 PID 被复用:仅清登记,不动进程
    throw new Error(`PID ${pid} 的命令行不含本项目服务入口,拒绝停止(进程可能已退出或 PID 被复用)`);
  }
  execFileSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`]);
  fs.rmSync(PID_FILE, { force: true });
  return `已停止测试服务 PID ${pid}`;
}
