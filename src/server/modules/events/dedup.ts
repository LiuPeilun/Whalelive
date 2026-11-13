import type { LiveEvent } from '../../../shared/live-event.js';
import { validateLiveEvent } from '../../../shared/live-event.js';

// 有界来源去重窗口:按 来源|房间|sourceKey 记录已见键,容量与时间窗均有界。

export type DedupOptions = {
  now(): number;
  ttlMs?: number;
  maxKeys?: number;
};

export function createDedupWindow(opts: DedupOptions) {
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  const maxKeys = opts.maxKeys ?? 5000;
  const seen = new Map<string, number>();

  /** 首次出现返回 true;重复返回 false。过期键按时间窗清理。 */
  function admit(key: string): boolean {
    const now = opts.now();
    if (seen.has(key)) {
      const at = seen.get(key)!;
      if (now - at <= ttlMs) return false;
      seen.delete(key);
    }
    if (seen.size >= maxKeys) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    seen.set(key, now);
    return true;
  }

  function size(): number {
    return seen.size;
  }

  function clear(): void {
    seen.clear();
  }

  return { admit, size, clear };
}
