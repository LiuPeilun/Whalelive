import { describe, expect, it } from 'vitest';
import { mockEvent } from './mock.js';

// WT-P2-007:模拟入口的付费礼物案例——paidYuan(元)归一为整数毫元后进入标准事件。

describe('mock 礼物金额归一(WT-P2-007)', () => {
  const now = () => 1_000;
  const seq = () => 1;

  it('paidYuan 5 元 → paidMilliYuan 5000', () => {
    const e = mockEvent({ type: 'gift', userId: 'u', userName: '甲', gift: { id: 'g', name: '礼花', quantity: 1, paidYuan: 5 } }, now, seq);
    expect(e.gift?.paidMilliYuan).toBe(5000);
  });

  it('paidYuan 0.5 元 → paidMilliYuan 500(小数归一不截断)', () => {
    const e = mockEvent({ type: 'gift', userId: 'u', userName: '甲', gift: { id: 'g', name: '礼花', quantity: 1, paidYuan: 0.5 } }, now, seq);
    expect(e.gift?.paidMilliYuan).toBe(500);
  });

  it('无 paidYuan 或非法值不计价(免费/未知价格语义)', () => {
    const free = mockEvent({ type: 'gift', userId: 'u', userName: '甲', gift: { id: 'g', name: '小心心', quantity: 1 } }, now, seq);
    expect(free.gift?.paidMilliYuan).toBeUndefined();
    const invalid = mockEvent({ type: 'gift', userId: 'u', userName: '甲', gift: { id: 'g', name: '小心心', quantity: 1, paidYuan: -3 } }, now, seq);
    expect(invalid.gift?.paidMilliYuan).toBeUndefined();
  });
});
