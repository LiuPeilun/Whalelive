import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from './logger.js';

// P1 音频存储、过期与清理(PROJECT_STRUCTURE 目标目录注释)。
// 写入采用临时文件 + rename 原子发布:URL 只会指向完整文件;
// 目录容量有界,超出按最旧淘汰;audioId 仅允许安全字符,杜绝路径穿越。

const MAX_ENTRIES = 200;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}\.(wav|mp3)$/;

export type AudioCache = {
  /** 原子写入音频数据,返回可直接作为 URL 使用的 audioId。 */
  put(data: Buffer, ext?: 'wav' | 'mp3'): string;
  /** 解析 audioId → 文件与 MIME;不合规或不存在返回 null。 */
  resolve(audioId: string): { file: string; mime: string } | null;
  /** 当前条目数(诊断用)。 */
  size(): number;
};

const MIME: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg' };

export function createAudioCache(deps: { audioDir: string; logger: Logger; now(): number }): AudioCache {
  const { audioDir, logger } = deps;
  fs.mkdirSync(audioDir, { recursive: true });

  function evictIfNeeded(): void {
    let entries: { name: string; mtime: number }[];
    try {
      entries = fs
        .readdirSync(audioDir)
        .filter((name) => SAFE_ID.test(name))
        .map((name) => ({ name, mtime: fs.statSync(path.join(audioDir, name)).mtimeMs }));
    } catch {
      return;
    }
    if (entries.length < MAX_ENTRIES) return;
    entries.sort((a, b) => a.mtime - b.mtime);
    const excess = entries.length - MAX_ENTRIES + 1;
    for (const entry of entries.slice(0, excess)) {
      try {
        fs.rmSync(path.join(audioDir, entry.name));
        logger.info('audio-cache.evicted', { file: entry.name });
      } catch {
        /* 清理失败不影响写入 */
      }
    }
  }

  function put(data: Buffer, ext: 'wav' | 'mp3' = 'wav'): string {
    const audioId = `${deps.now().toString(36)}-${randomUUID().slice(0, 8)}.${ext}`;
    const target = path.join(audioDir, audioId);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
    evictIfNeeded();
    return audioId;
  }

  function resolve(audioId: string): { file: string; mime: string } | null {
    if (!SAFE_ID.test(audioId)) return null;
    const file = path.join(audioDir, audioId);
    // 双保险:join 后仍在目录内,防符号链接外逃
    const realDir = fs.realpathSync(audioDir);
    try {
      const realFile = fs.realpathSync(file);
      if (realFile !== realDir && !realFile.startsWith(realDir + path.sep)) return null;
    } catch {
      return null;
    }
    return { file, mime: MIME[audioId.split('.').pop() ?? 'wav'] ?? 'audio/wav' };
  }

  function size(): number {
    try {
      return fs.readdirSync(audioDir).filter((name) => SAFE_ID.test(name)).length;
    } catch {
      return 0;
    }
  }

  return { put, resolve, size };
}
