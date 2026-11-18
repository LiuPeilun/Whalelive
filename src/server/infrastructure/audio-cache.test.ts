import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAudioCache } from './audio-cache.js';
import type { Logger } from './logger.js';

// P1 音频缓存:原子写入、ID 防穿越、容量淘汰。

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whaletalk-audiocache-'));
const dirs: string[] = [];
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => ({ ...silentLogger, child: () => silentLogger }),
};

function newCache(): { cache: ReturnType<typeof createAudioCache>; dir: string } {
  const dir = path.join(tmpRoot, `case-${dirs.length}`);
  dirs.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  const cache = createAudioCache({ audioDir: dir, logger: silentLogger, now: () => Date.now() });
  return { cache, dir };
}

describe('audio-cache 原子写入与解析', () => {
  it('put 后 resolve 返回文件与 MIME,内容完整', () => {
    const { cache, dir } = newCache();
    const data = Buffer.from([1, 2, 3, 4, 5]);
    const id = cache.put(data, 'wav');
    expect(id).toMatch(/\.wav$/);
    const resolved = cache.resolve(id);
    expect(resolved).not.toBeNull();
    expect(resolved?.mime).toBe('audio/wav');
    expect(fs.statSync(path.join(dir, id)).size).toBe(5);
    expect(fs.readFileSync(resolved!.file).equals(data)).toBe(true);
    // 目录内无 .tmp 残留(原子写)
    expect(fs.readdirSync(dir).some((name) => name.includes('.tmp'))).toBe(false);
  });

  it('resolve 拒绝路径穿越与不合规 ID', () => {
    const { cache } = newCache();
    expect(cache.resolve('../evil.wav')).toBeNull();
    expect(cache.resolve('..\\evil.wav')).toBeNull();
    expect(cache.resolve('no-ext')).toBeNull();
    expect(cache.resolve('a/b.wav')).toBeNull();
    expect(cache.resolve('不存在.wav')).toBeNull();
  });

  it('容量有界:超过上限按最旧淘汰', () => {
    const { cache, dir } = newCache();
    const first = cache.put(Buffer.from([1]), 'wav');
    // 拉旧文件的 mtime,使其成为最旧
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(dir, first), past, past);
    for (let i = 0; i < 210; i++) cache.put(Buffer.from([i]), 'wav');
    expect(cache.size()).toBeLessThanOrEqual(200);
    expect(cache.resolve(first)).toBeNull(); // 最旧者被淘汰
  });
});
