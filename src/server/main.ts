import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createApp } from './app.js';

// 读取启动参数、启动与信号退出(PROJECT_STRUCTURE 目标目录注释)。

function parseArgs(argv: string[]): { port?: number; host?: string; resetAccess?: boolean } {
  const result: { port?: number; host?: string; resetAccess?: boolean } = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--reset-access') result.resetAccess = true;
    else if (arg === '--port' && value !== undefined && value !== '') {
      const port = Number(value);
      if (Number.isInteger(port) && port > 0 && port < 65536) result.port = port;
      i += 1;
    } else if (arg === '--host' && value !== undefined && value !== '') {
      result.host = value;
      i += 1;
    }
  }
  return result;
}

const args = parseArgs(process.argv);

// .env.local 存在则加载;进程内已有环境变量优先(dotenv 默认不覆盖)。
const envLocal = fileURLToPath(new URL('../../.env.local', import.meta.url));
dotenv.config({ path: envLocal, quiet: true });

const env: Record<string, string | undefined> = { ...process.env };
if (args.port !== undefined) env.PORT = String(args.port);
if (args.host !== undefined) env.HOST = args.host;

const app = await createApp({ env, resetAccess: args.resetAccess === true });

const line = '─'.repeat(58);
console.log(`
${line}
  WhaleTalk P0 本地服务已启动
  runId:  ${app.runId}
  控制台(含凭据,请勿外传):
    ${app.urls.control}
  OBS 播放页(含凭据,可粘贴到 OBS 浏览器源):
    ${app.urls.overlay}
  健康检查: ${app.urls.base}/api/health
  媒体与 API 仅监听本机;停止服务请按 Ctrl+C
${line}
`);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`\n收到 ${signal},正在停止…`);
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    console.error('停止时出错:', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
