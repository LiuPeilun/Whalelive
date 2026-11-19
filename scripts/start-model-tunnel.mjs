// P1 第三批:DeepSeek 模型服务的本地 SSH 隧道。
// 模型部署在公网服务器 218.106.157.54:10019(仅 SSH 开放),vLLM 服务绑在内网
// 172.28.60.19:11104,公网无法直连。本脚本把该端口转发到本地 127.0.0.1:11804,
// 供项目 .env.local 的 DEEPSEEK_BASE_URL 使用。
//
// 用法:
//   node scripts/start-model-tunnel.mjs            前台保持隧道(Ctrl+C 退出)
//   node scripts/start-model-tunnel.mjs --check    只检查隧道是否已就绪
// 密钥路径可用环境变量 WHALETALK_SSH_KEY 覆盖。

import { spawn } from 'node:child_process';

const DEFAULT_KEY = 'C:/Users/13680/Desktop/工作/服务器登陆密钥/KeyPair-10019.pem';
const keyPath = process.env.WHALETALK_SSH_KEY || DEFAULT_KEY;
const host = '218.106.157.54';
const sshPort = 10019;
const user = 'root';
const remoteHost = '172.28.60.19';
const remotePort = 11104;
const localPort = 11804;
const checkUrl = `http://127.0.0.1:${localPort}/v1/models`;

async function tunnelReady() {
  try {
    const res = await fetch(checkUrl, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const body = await res.json();
    return Array.isArray(body?.data) && body.data.length > 0;
  } catch {
    return false;
  }
}

if (process.argv.includes('--check')) {
  const ok = await tunnelReady();
  console.log(ok ? `隧道就绪:${checkUrl}` : `隧道未就绪(请先运行 node scripts/start-model-tunnel.mjs)`);
  process.exit(ok ? 0 : 1);
}

if (await tunnelReady()) {
  console.log(`隧道已就绪,无需重复启动:${checkUrl}`);
  process.exit(0);
}

const args = [
  '-o', 'BatchMode=yes',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-p', String(sshPort),
  '-N', '-L', `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`,
  `${user}@${host}`,
];
const sshPath = 'ssh';
console.log(`启动隧道:127.0.0.1:${localPort} -> ${remoteHost}:${remotePort} (经 ${user}@${host}:${sshPort})`);
console.log(`密钥:${keyPath}`);
const child = spawn(sshPath, ['-i', keyPath, ...args], { stdio: 'inherit', windowsHide: true });

const stop = () => { try { child.kill(); } catch { /* ignore */ } };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

child.on('exit', (code) => {
  console.log(`SSH 隧道退出(code=${code ?? 'null'})`);
  process.exit(code ?? 0);
});

// 等待就绪并打印模型名
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 500));
  if (await tunnelReady()) {
    try {
      const body = await (await fetch(checkUrl, { signal: AbortSignal.timeout(3000) })).json();
      console.log(`隧道就绪:${checkUrl} 模型:${body.data.map((m) => m.id).join(', ')}`);
    } catch { /* ignore */ }
    break;
  }
  if (child.exitCode !== null) break;
}
