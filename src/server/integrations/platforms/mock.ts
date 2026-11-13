import { randomUUID } from 'node:crypto';
import type { LiveEvent } from '../../../shared/live-event.js';

// P0 模拟事件入口:把控制台提交的输入转换为标准事件。
// quantity 一律是本次新增数量;连击语义用 combo.ts 的快照换算测试覆盖。

export type MockEventInput = {
  type: 'chat' | 'gift' | 'guard' | 'superchat';
  text?: string;
  userName?: string;
  userId?: string;
  gift?: { id?: string; name?: string; quantity?: number; comboSnapshotTotal?: number };
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
    return {
      ...base,
      type: 'gift',
      gift: {
        id: input.gift?.id?.trim() || 'mock-gift',
        name: input.gift?.name?.trim() || '小心心',
        quantity,
      },
    };
  }
  if (input.type === 'guard' || input.type === 'superchat') {
    return { ...base, type: input.type };
  }
  return { ...base, type: 'chat', text: input.text?.slice(0, 200) ?? '' };
}
