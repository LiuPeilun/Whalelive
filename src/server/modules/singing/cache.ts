// 成片缓存:确定性文件名(标题规范化 sha1)复用 audioCacheDir 与 /media/audio 路由。
// 命中=同文件已存在(二次点歌秒出);eviction 由 audioCache 的 MAX_ENTRIES 兜底。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 规范化标题做缓存键:大小写/空白差异视为同一首歌。 */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function songCacheId(title: string): string {
  const hash = crypto.createHash('sha1').update(normalizeTitle(title), 'utf8').digest('hex').slice(0, 12);
  return `song-${hash}.mp3`;
}

export type SongCache = {
  /** 命中返回 audioId(可直接拼 /media/audio/<id>),未命中返回 null。 */
  lookup(title: string): string | null;
  /** 成片落盘(原子写),返回 audioId。 */
  store(mp3: Buffer, title: string): string;
};

export function createSongCache(deps: { audioDir: string }): SongCache {
  const { audioDir } = deps;
  fs.mkdirSync(audioDir, { recursive: true });

  function filePath(audioId: string): string {
    return path.join(audioDir, audioId);
  }

  function lookup(title: string): string | null {
    const id = songCacheId(title);
    try {
      fs.accessSync(filePath(id));
      return id;
    } catch {
      return null;
    }
  }

  function store(mp3: Buffer, title: string): string {
    const id = songCacheId(title);
    const target = filePath(id);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, mp3);
    fs.renameSync(tmp, target);
    return id;
  }

  return { lookup, store };
}
