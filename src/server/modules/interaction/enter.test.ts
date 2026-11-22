import { describe, expect, it } from 'vitest';
import { createEnterAggregator } from './enter.js';

// P2 互动第三批:进场欢迎聚合——窗口去重、念名上限、全房欢迎间隔限流。

describe('进场欢迎聚合(互动第三批)', () => {
  it('窗口内 3 人逐个念名,窗口关闭产出一条念名播报', () => {
    let t = 0;
    const agg = createEnterAggregator({ windowMs: () => 10_000, maxNamedCount: () => 3, allRoomIntervalMs: () => 60_000, now: () => t });
    agg.add({ userKey: 'u1', userName: '甲' });
    t += 100;
    agg.add({ userKey: 'u2', userName: '乙' });
    t += 100;
    agg.add({ userKey: 'u3', userName: '丙' });
    t += 10_000;
    expect(agg.sweep()).toEqual([{ kind: 'named', names: ['甲', '乙', '丙'] }]);
    expect(agg.size()).toBe(0);
  });

  it('同一观众窗口内重复进场只计一次', () => {
    let t = 0;
    const agg = createEnterAggregator({ windowMs: () => 10_000, maxNamedCount: () => 3, allRoomIntervalMs: () => 60_000, now: () => t });
    agg.add({ userKey: 'u1', userName: '甲' });
    agg.add({ userKey: 'u1', userName: '甲' });
    t += 10_000;
    expect(agg.sweep()).toEqual([{ kind: 'named', names: ['甲'] }]);
  });

  it('窗口内超出念名上限改发全房欢迎', () => {
    let t = 0;
    const agg = createEnterAggregator({ windowMs: () => 10_000, maxNamedCount: () => 3, allRoomIntervalMs: () => 60_000, now: () => t });
    for (const u of ['甲', '乙', '丙', '丁']) agg.add({ userKey: u, userName: u });
    t += 10_000;
    expect(agg.sweep()).toEqual([{ kind: 'all', names: [] }]);
  });

  it('错峰到达共享同一窗口:4 人各隔 100ms 进入,首个窗口单次结算为一条全房欢迎(WT-P2-014)', () => {
    let t = 0;
    const agg = createEnterAggregator({ windowMs: () => 10_000, maxNamedCount: () => 3, allRoomIntervalMs: () => 60_000, now: () => t });
    for (const u of ['访客0', '访客1', '访客2', '访客3']) {
      agg.add({ userKey: u, userName: u });
      t += 100;
    }
    t += 10_000;
    const emissions = agg.sweep();
    expect(emissions.length).toBe(1); // 单次结算,不再逐批念名
    expect(emissions[0]).toEqual({ kind: 'all', names: [] });
    expect(agg.sweep()).toEqual([]); // 窗口已结算,无残留
  });

  it('全房欢迎受最小间隔限流:间隔内的新批次直接过期不产出', () => {
    let t = 0;
    const agg = createEnterAggregator({ windowMs: () => 10_000, maxNamedCount: () => 3, allRoomIntervalMs: () => 60_000, now: () => t });
    for (const u of ['甲', '乙', '丙', '丁']) agg.add({ userKey: u, userName: u });
    t += 10_000;
    expect(agg.sweep().length).toBe(1); // 第一批:全房欢迎产出
    for (const u of ['戊', '己', '庚', '辛']) agg.add({ userKey: u, userName: u });
    t += 10_000;
    expect(agg.sweep()).toEqual([]); // 间隔未到:直接过期
    for (const u of ['壬', '癸', '子', '丑']) agg.add({ userKey: u, userName: u });
    t += 61_000;
    expect(agg.sweep().length).toBe(1); // 间隔已过:再次产出
  });

  it('念名上限为 0 时一律全房欢迎', () => {
    let t = 0;
    const agg = createEnterAggregator({ windowMs: () => 10_000, maxNamedCount: () => 0, allRoomIntervalMs: () => 60_000, now: () => t });
    agg.add({ userKey: 'u1', userName: '甲' });
    t += 10_000;
    expect(agg.sweep()).toEqual([{ kind: 'all', names: [] }]);
  });

  it('clear 清空未出窗的进场累计', () => {
    let t = 0;
    const agg = createEnterAggregator({ windowMs: () => 10_000, maxNamedCount: () => 3, allRoomIntervalMs: () => 60_000, now: () => t });
    agg.add({ userKey: 'u1', userName: '甲' });
    agg.clear();
    t += 10_000;
    expect(agg.sweep()).toEqual([]);
  });
});

describe('窗口到期归属(WT-P2-014 复审)', () => {
  it('窗口到期后、下一次结算前到达的观众计入新窗:首窗念三人,第四人进下一窗', () => {
    let t = 0;
    const agg = createEnterAggregator({ windowMs: () => 10_000, maxNamedCount: () => 3, allRoomIntervalMs: () => 60_000, now: () => t });
    agg.add({ userKey: 'u1', userName: '访客0' }); // t=0 开窗
    t += 5_000;
    agg.add({ userKey: 'u2', userName: '访客1' });
    t += 4_980;
    agg.add({ userKey: 'u3', userName: '访客2' }); // t=9980,仍在首窗
    t += 21;
    agg.add({ userKey: 'u4', userName: '访客3' }); // t=10001,首窗已到期:惰性结算旧窗后开新窗
    t += 249;
    const first = agg.sweep(); // t=10250 首次结算
    expect(first).toEqual([{ kind: 'named', names: ['访客0', '访客1', '访客2'] }]);
    t += 10_000;
    const second = agg.sweep(); // 第四人自己的窗口结算
    expect(second).toEqual([{ kind: 'named', names: ['访客3'] }]);
  });

  it('到期后到达的重复观众不与旧窗合并,新窗内正常去重', () => {
    let t = 0;
    const agg = createEnterAggregator({ windowMs: () => 10_000, maxNamedCount: () => 3, allRoomIntervalMs: () => 60_000, now: () => t });
    agg.add({ userKey: 'u1', userName: '甲' });
    t += 10_100;
    agg.add({ userKey: 'u1', userName: '甲' }); // 旧窗已到期:惰性结算旧窗后进入新窗
    agg.add({ userKey: 'u2', userName: '乙' });
    t += 10_000;
    // 同一轮结算产出两条:旧窗(到期惰性结算)的甲、新窗(去重后)的甲乙
    expect(agg.sweep()).toEqual([
      { kind: 'named', names: ['甲'] },
      { kind: 'named', names: ['甲', '乙'] },
    ]);
  });
});
