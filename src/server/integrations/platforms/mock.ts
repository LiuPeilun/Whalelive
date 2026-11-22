import { randomUUID } from 'node:crypto';
import type { LiveEvent } from '../../../shared/live-event.js';

// P0 模拟事件入口:把控制台提交的输入转换为标准事件。
// quantity 一律是本次新增数量;连击语义用 combo.ts 的快照换算测试覆盖。

export type MockEventInput = {
  type: 'chat' | 'gift' | 'guard' | 'superchat';
  text?: string;
  userName?: string;
  userId?: string;
  gift?: { id?: string; name?: string; quantity?: number; comboSnapshotTotal?: number; paidYuan?: number };
};

export function mockEvent(input: MockEventInput, now: () => number, seq: () => number): LiveEvent {
  const userId = input.userId?.trim() || `mock-user-${seq()}`;
  const userName = input.userName?.trim() || `观众${seq()}`;
  const base = {
    id: `evt-${randomUUID().slice(0, 8)}`,
    sourceKey: `mock-${randomUUID()}`,
    source: 'mock' as const,
    roomId: 'mock-room',
    user: { id: userId, name: userName },
    receivedAt: now(),
  };
  if (input.type === 'gift') {
    const quantity = Math.max(1, Math.trunc(input.gift?.quantity ?? 1));
    // WT-P2-007:模拟入口支持付费案例——paidYuan(元,可小数)归一为整数毫元(1000=1 元)后送入。
    const paidYuan = input.gift?.paidYuan;
    const paidMilliYuan = typeof paidYuan === 'number' && Number.isFinite(paidYuan) && paidYuan > 0
      ? Math.round(paidYuan * 1000)
      : undefined;
    return {
      ...base,
      type: 'gift',
      gift: {
        id: input.gift?.id?.trim() || 'mock-gift',
        name: input.gift?.name?.trim() || '小心心',
        quantity,
        ...(paidMilliYuan !== undefined ? { paidMilliYuan } : {}),
      },
    };
  }
  if (input.type === 'guard' || input.type === 'superchat') {
    return { ...base, type: input.type };
  }
  return { ...base, type: 'chat', text: input.text?.slice(0, 200) ?? '' };
}
