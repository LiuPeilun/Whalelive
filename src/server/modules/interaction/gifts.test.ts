import { describe, expect, it } from 'vitest';
import { createGiftAggregator } from './gifts.js';

describe('interaction 礼物合并窗口', () => {
  it('同一用户同一礼物在窗口内累计,窗口关闭产出合并感谢', () => {
    let t = 0;
    const agg = createGiftAggregator({ mergeWindowMs: () => 2000, now: () => t });
    for (let i = 0; i < 10; i++) {
      agg.add({ userKey: 'u1', userName: '观众甲', giftId: 'xinxin', giftName: '小心心', quantity: 1 });
      t += 100;
    }
    expect(agg.sweep()).toEqual([]); // 窗口未关闭
    t += 2000;
    const emitted = agg.sweep();
    expect(emitted.length).toBe(1);
    expect(emitted[0]?.totalQuantity).toBe(10);
    expect(agg.size()).toBe(0);
  });

  it('不同用户分别累计,互不合并', () => {
    let t = 0;
    const agg = createGiftAggregator({ mergeWindowMs: () => 2000, now: () => t });
    agg.add({ userKey: 'u1', userName: '甲', giftId: 'xinxin', giftName: '小心心', quantity: 1 });
    agg.add({ userKey: 'u2', userName: '乙', giftId: 'xinxin', giftName: '小心心', quantity: 2 });
    t += 2000;
    const emitted = agg.sweep();
    expect(emitted.length).toBe(2);
  });

  it('窗口结束后同一键的新礼物进入新窗口', () => {
    let t = 0;
    const agg = createGiftAggregator({ mergeWindowMs: () => 1000, now: () => t });
    agg.add({ userKey: 'u1', userName: '甲', giftId: 'xinxin', giftName: '小心心', quantity: 1 });
    t += 1500;
    agg.add({ userKey: 'u1', userName: '甲', giftId: 'xinxin', giftName: '小心心', quantity: 1 });
    const emitted = agg.sweep();
    expect(emitted.length).toBe(1); // 第一笔已到期
    expect(emitted[0]?.totalQuantity).toBe(1);
    t += 1000;
    expect(agg.sweep()[0]?.totalQuantity).toBe(1); // 第二笔独立成窗
  });

  it('跨窗口后清空:待产出的旧感谢一并清理(WT-P0-006)', () => {
    let t = 0;
    const agg = createGiftAggregator({ mergeWindowMs: () => 1000, now: () => t });
    agg.add({ userKey: 'u1', userName: '甲', giftId: 'xinxin', giftName: '小心心', quantity: 3 });
    t += 1500; // 旧窗口过期:新礼物开新窗,旧累计转入待产出
    agg.add({ userKey: 'u1', userName: '甲', giftId: 'xinxin', giftName: '小心心', quantity: 1 });
    agg.clear();
    expect(agg.sweep()).toEqual([]); // 旧结果不再产出
    t += 1000;
    expect(agg.sweep()).toEqual([]); // 清空后的新窗口同样不产出
  });

  it('金瓜子礼物按增量×单价累计实付金额(P2 第二批)', () => {
    let t = 0;
    const agg = createGiftAggregator({ mergeWindowMs: () => 2000, now: () => t });
    // 连击 3 次 × 1,单价 0.1 元/个:0.3 元
    for (let i = 0; i < 3; i++) {
      agg.add({ userKey: 'u1', userName: '甲', giftId: 'jinhua', giftName: '金花', quantity: 1, coinType: 'gold', unitPriceYuan: 0.1 });
      t += 100;
    }
    t += 2000;
    const emitted = agg.sweep();
    expect(emitted[0]?.totalQuantity).toBe(3);
    expect(emitted[0]?.totalPaidYuan).toBeCloseTo(0.3, 6);
    expect(emitted[0]?.paidKnown).toBe(true);
  });

  it('银瓜子与未知价格不计金额,按小额普通感谢处理', () => {
    let t = 0;
    const agg = createGiftAggregator({ mergeWindowMs: () => 2000, now: () => t });
    agg.add({ userKey: 'u1', userName: '甲', giftId: 'xinxin', giftName: '小心心', quantity: 5, coinType: 'silver', unitPriceYuan: 0.1 });
    agg.add({ userKey: 'u2', userName: '乙', giftId: 'mofa', giftName: '魔法棒', quantity: 2 });
    t += 2000;
    const emitted = agg.sweep();
    for (const e of emitted) {
      expect(e.totalPaidYuan).toBe(0);
      expect(e.paidKnown).toBe(false);
    }
  });

  it('跨窗口的金额随旧累计转入待产出,不丢失', () => {
    let t = 0;
    const agg = createGiftAggregator({ mergeWindowMs: () => 1000, now: () => t });
    agg.add({ userKey: 'u1', userName: '甲', giftId: 'lida', giftName: '礼花', quantity: 2, coinType: 'gold', unitPriceYuan: 5 });
    t += 1500; // 旧窗口过期,金额转入待产出
    agg.add({ userKey: 'u1', userName: '甲', giftId: 'lida', giftName: '礼花', quantity: 1, coinType: 'gold', unitPriceYuan: 5 });
    expect(agg.sweep()[0]?.totalPaidYuan).toBe(10);
    t += 1000;
    expect(agg.sweep()[0]?.totalPaidYuan).toBe(5);
  });
});
