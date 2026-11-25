// 成片缓存:确定性文件名(标题规范化 sha1)复用 audioCacheDir 与 /media/audio 路由。
// 命中=同文件已存在(二次点歌秒出);eviction 由 audioCache 的 MAX_ENTRIES 兜底。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 规范化标题做缓存键:大小写/空白差异视为同一首歌。 */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 影响成片内容的配置指纹(WT-P3-005):任一项变更后旧缓存不再命中,强制重新生成。 */
export function settingsFingerprint(s: {
  clipStartRatio: number; clipSeconds: number; targetHz: number;
  keyMin: number; keyMax: number; indexRate: number; protect: number; rmsMixRate: number;
}): string {
  return [
    s.clipStartRatio, s.clipSeconds, s.targetHz,
    s.keyMin, s.keyMax, s.indexRate, s.protect, s.rmsMixRate,
  ].join('|');
}

const SONG_MAX_FILES = 30;
/** WT-P3-005 复审:新近写入豁免窗口——已入队/在播的成片(必然是新近生成的)不被淘汰。 */
const SONG_RECENT_MS = 10 * 60_000;

/** 歌曲成片容量约束:超出按最旧淘汰;10 分钟内写入的保留(硬超限时才强制删最旧)。 */
function pruneSongs(audioDir: string, keep: string, recentWindowMs: number): void {
  let entries: { name: string; mtime: number }[];
  try {
    entries = fs
      .readdirSync(audioDir)
      .filter((name) => /^song-[0-9a-f]{12}\.mp3$/.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(audioDir, name)).mtimeMs }));
  } catch {
    return;
  }
  const excess = entries.length - SONG_MAX_FILES + 1;
  if (excess <= 0) return;
  entries.sort((a, b) => a.mtime - b.mtime);
  const recentCutoff = Date.now() - recentWindowMs;
  const hard = recentWindowMs <= 0 || entries.length > SONG_MAX_FILES + 20;
  let removed = 0;
  for (const entry of entries) {
    if (removed >= excess) break;
    if (entry.name === keep) continue;
    if (!hard && entry.mtime > recentCutoff) continue; // 新近豁免
    try {
      fs.rmSync(path.join(audioDir, entry.name));
      removed += 1;
    } catch {
      /* 清理失败不影响写入 */
    }
  }
}

export function songCacheId(title: string, fingerprint: string): string {
  const hash = crypto
    .createHash('sha1')
    .update(normalizeTitle(title) + '\n' + fingerprint, 'utf8')
    .digest('hex')
    .slice(0, 12);
  return `song-${hash}.mp3`;
}

export type SongCache = {
  /** 命中返回 audioId(可直接拼 /media/audio/<id>),未命中返回 null。 */
  lookup(title: string, fingerprint: string): string | null;
  /** 成片落盘(原子写+容量约束),返回 audioId。 */
  store(mp3: Buffer, title: string, fingerprint: string): string;
};

export function createSongCache(deps: { audioDir: string; recentWindowMs?: number }): SongCache {
  const { audioDir } = deps;
  const recentWindowMs = deps.recentWindowMs ?? 10 * 60_000;
  fs.mkdirSync(audioDir, { recursive: true });

  function filePath(audioId: string): string {
    return path.join(audioDir, audioId);
  }

  function lookup(title: string, fingerprint: string): string | null {
    const id = songCacheId(title, fingerprint);
    try {
      fs.accessSync(filePath(id));
      return id;
    } catch {
      return null;
    }
  }

  function store(mp3: Buffer, title: string, fingerprint: string): string {
    const id = songCacheId(title, fingerprint);
    pruneSongs(audioDir, id, recentWindowMs);
    const target = filePath(id);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, mp3);
    fs.renameSync(tmp, target);
    return id;
  }

  return { lookup, store };
}
