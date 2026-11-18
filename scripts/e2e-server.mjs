// 测试服务启动/停止 CLI(WT-P1-009):
//   node scripts/e2e-server.mjs [--port 3210]   启动并登记 PID,保持前台运行(Ctrl+C 退出)
//   node scripts/e2e-server.mjs --stop          停止登记的服务(校验命令行含本项目入口)
// 重连类 e2e(e2e-reconnect-idle / e2e-reconnect-trace)的杀服务步骤
// 只接受本工具登记的 PID,不再按进程名/端口匹配全机进程。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer, stopTestServer } from './lib/test-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

if (args[0] === '--stop') {
  try {
    console.log(stopTestServer());
    process.exit(0);
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exit(1);
  }
}

const portFlag = args.indexOf('--port');
const port = Number(portFlag >= 0 ? args[portFlag + 1] : (process.env.PORT ?? 3210));
const accessPath = path.join(root, 'data', 'access.json');
const extraSecrets = fs.existsSync(accessPath)
  ? Object.values(JSON.parse(fs.readFileSync(accessPath, 'utf8'))).filter((v) => typeof v === 'string' && v.length > 0)
  : [];

const { child, pid, waitHealthy } = startTestServer({ port, logFile: path.join(root, '.tools', 'e2e-server.log'), extraSecrets });
// 服务进程退出(被 --stop / 崩溃)时本保持器一并退出,不残留
child.on('exit', () => process.exit(0));
console.log(`测试服务已启动 pid=${pid} port=${port}(PID 登记于 .tools/e2e-server.pid,日志脱敏写入 .tools/e2e-server.log)`);

const healthy = await waitHealthy();
if (!healthy) {
  console.error('服务在 30 秒内未就绪,退出(请检查 .tools/e2e-server.log)');
  process.exit(1);
}
console.log(`健康检查通过: http://127.0.0.1:${port}/api/health`);
// 保持前台:进程存活期间子服务存活;Ctrl+C 交由系统连带终止
setInterval(() => {}, 1_000_000);
