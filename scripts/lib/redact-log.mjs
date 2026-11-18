// 子进程日志脱敏(WT-P1-011):
// - 行缓冲:流块可在任意位置分割,同一行(含完整凭据)绝不被分块处理——
//   逐块 replaceAll 会漏掉跨块分割的凭据;
// - 启动链接模式:URL fragment 中 16 位以上随机段即凭据形态,按模式替换,
//   不依赖调用方提供凭据值(子进程用自定义数据目录时同样免疫);
// - extraSecrets 双保险:调用方已知的确切凭据值(如从 access.json 读到)额外整串替换。
// 尾部无换行的最后一块由 flush() 落盘。

import fs from 'node:fs';

const FRAGMENT_RE = /(#[A-Za-z0-9_-]{16,})/g;

export function redactLine(line, extraSecrets = []) {
  let out = String(line);
  for (const secret of extraSecrets) {
    if (secret) out = out.replaceAll(secret, '[cred]');
  }
  return out.replace(FRAGMENT_RE, '#[redacted]');
}

export function createRedactingWriter(fd, extraSecrets = []) {
  let buffer = '';
  return {
    /** 追加一个流块;完整行立即脱敏落盘,不完整行留待后续 */
    push(chunk) {
      buffer += String(chunk);
      for (;;) {
        const idx = buffer.indexOf('\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        try {
          fs.writeSync(fd, `${redactLine(line, extraSecrets)}\n`);
        } catch {
          /* fd 已关闭:忽略 */
        }
      }
    },
    /** 结束时冲刷尾部不完整行(无换行也完整脱敏) */
    flush() {
      if (buffer === '') return;
      try {
        fs.writeSync(fd, `${redactLine(buffer, extraSecrets)}\n`);
      } catch {
        /* fd 已关闭:忽略 */
      }
      buffer = '';
    },
  };
}
