import { describe, expect, it } from 'vitest';
import { createComboTracker } from './combo.js';

describe('平台连击快照 → 增量换算(高水位单调)', () => {
  it('递增快照产生正确增量', () => {
    const tracker = createComboTracker();
    expect(tracker.toIncrement('combo-1', 3)).toBe(3);
    expect(tracker.toIncrement('combo-1', 7)).toBe(4);
    expect(tracker.toIncrement('combo-1', 10)).toBe(3);
    expect(tracker.waterline('combo-1')).toBe(10);
  });

  it('重复快照不产生增量', () => {
    const tracker = createComboTracker();
    expect(tracker.toIncrement('c', 5)).toBe(5);
    expect(tracker.toIncrement('c', 5)).toBe(0);
    expect(tracker.toIncrement('c', 5)).toBe(0);
  });

  it('乱序(回退)快照不产生增量,水位保持单调', () => {
    const tracker = createComboTracker();
    expect(tracker.toIncrement('c', 8)).toBe(8);
    expect(tracker.toIncrement('c', 6)).toBe(0); // 乱序回退
    expect(tracker.toIncrement('c', 9)).toBe(1); // 从高水位 8 继续
    expect(tracker.waterline('c')).toBe(9);
  });

  it('不同连击互不影响', () => {
    const tracker = createComboTracker();
    expect(tracker.toIncrement('c1', 2)).toBe(2);
    expect(tracker.toIncrement('c2', 5)).toBe(5);
    expect(tracker.toIncrement('c1', 4)).toBe(2);
  });
});
