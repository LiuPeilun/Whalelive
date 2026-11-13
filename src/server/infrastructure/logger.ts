import fs from 'node:fs';
import path from 'node:path';

// 结构化日志:事件 ID、阶段、时间与错误码;敏感值经 redact 处理后才能进入日志。
// 输出 JSON 行到 stdout,并追加到 data/logs/server-<date>.log(尽力而为,失败不打断业务)。

export type LogFields = Record<string, unknown>;

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

export type Logger = {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
};

/** 保留前 4 个字符用于人工辨认,其余打码。空值原样返回。 */
export function redact(secret: string | undefined | null): string {
  if (typeof secret !== 'string' || secret.length === 0) return '';
  return secret.length <= 4 ? '****' : `${secret.slice(0, 4)}…(已脱敏)`;
}

/** 对携带凭据的完整访问链接脱敏(fragment 部分整体打码)。 */
export function redactUrl(url: string): string {
  const hashIndex = url.indexOf('#');
  return hashIndex >= 0 ? `${url.slice(0, hashIndex)}#<凭据已脱敏>` : url;
}

export function createLogger(opts: { logsDir: string; minLevel?: LogLevel }): Logger {
  const min = LEVELS[opts.minLevel ?? 'info'];
  const logFile = path.join(opts.logsDir, `server-${new Date().toISOString().slice(0, 10)}.log`);

  function write(level: LogLevel, event: string, fields: LogFields): void {
    if (LEVELS[level] < min) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields });
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level](line);
    try {
      fs.mkdirSync(opts.logsDir, { recursive: true });
      fs.appendFileSync(logFile, line + '\n');
    } catch {
      /* 日志落盘失败不影响业务 */
    }
  }

  function make(base: LogFields): Logger {
    return {
      debug: (event, fields) => write('debug', event, { ...base, ...fields }),
      info: (event, fields) => write('info', event, { ...base, ...fields }),
      warn: (event, fields) => write('warn', event, { ...base, ...fields }),
      error: (event, fields) => write('error', event, { ...base, ...fields }),
      child: (fields) => make({ ...base, ...fields }),
    };
  }

  return make({});
}
