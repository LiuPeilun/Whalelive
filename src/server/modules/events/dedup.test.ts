import { describe, expect, it } from 'vitest';
import { createDedupWindow } from './dedup.js';

describe('events 有界去重窗口', () => {
  it('首次出现接受,重复出现拒绝', () => {
    let t = 0;
    const win = createDedupWindow({ now: () => t, ttlMs: 1000 });
    expect(win.admit('a')).toBe(true);
    expect(win.admit('a')).toBe(false);
    expect(win.size()).toBe(1);
  });

  it('时间窗过期后同一键重新接受', () => {
    let t = 0;
    const win = createDedupWindow({ now: () => t, ttlMs: 1000 });
    expect(win.admit('a')).toBe(true);
    t = 1001;
    expect(win.admit('a')).toBe(true);
  });

  it('容量有界:超出上限时移出最旧的键', () => {
    let t = 0;
    const win = createDedupWindow({ now: () => t, ttlMs: 10_000, maxKeys: 2 });
    expect(win.admit('k1')).toBe(true);
    expect(win.admit('k2')).toBe(true);
    expect(win.admit('k3')).toBe(true); // 挤出最旧的 k1
    expect(win.size()).toBe(2);
    expect(win.admit('k1')).toBe(true); // k1 已被移出,重新接受(挤出 k2)
    expect(win.admit('k3')).toBe(false); // k3 仍在窗口内
  });
});
