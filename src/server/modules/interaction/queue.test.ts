import { describe, expect, it } from 'vitest';
import { createQueue } from './queue.js';
import type { QueueItem } from './queue.js';

function makeItem(id: string, priority = 40, type: QueueItem['type'] = 'chat'): QueueItem {
  return {
    eventId: id,
    type,
    priority,
    enqueuedAt: Number(id.split('-')[1] ?? 0),
    expiresAt: 1_000_000,
    say: `say-${id}`,
    action: 'talk',
    userKey: null,
  };
}

describe('interaction 有界队列', () => {
  it('容量上限:50 条进入容量 20 的队列,只保留 20 条并记录挤出原因', () => {
    let t = 0;
    const queue = createQueue({ capacity: 20, now: () => t });
    for (let i = 0; i < 50; i++) {
      queue.push(makeItem(`evt-${i}`, 40));
      t += 1;
    }
    expect(queue.length()).toBe(20);
    // 丢弃记录有界展示(最近 20 条),全部为容量挤出
    const drops = queue.dropLog();
    expect(drops.length).toBe(20);
    expect(drops.every((d) => d.reason === 'capacity-evict-chat')).toBe(true);
  });

  it('全是高优先级时拒绝新条目并记录 queue-full', () => {
    let t = 0;
    const queue = createQueue({ capacity: 2, now: () => t });
    queue.push(makeItem('g-1', 80, 'gift'));
    queue.push(makeItem('g-2', 80, 'gift'));
    const rejected = queue.push(makeItem('chat-3', 40, 'chat'));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.reason).toBe('queue-full');
    }
    expect(queue.dropLog().at(-1)?.reason).toBe('queue-full');
    expect(queue.length()).toBe(2);
  });

  it('弹出顺序:优先级高者先出,同优先级先入队者先出', () => {
    let t = 0;
    const queue = createQueue({ capacity: 10, now: () => t });
    queue.push(makeItem('c-1', 40));
    t += 1;
    queue.push(makeItem('g-2', 80, 'gift'));
    t += 1;
    queue.push(makeItem('c-3', 40));
    expect(queue.popBest()?.eventId).toBe('g-2');
    expect(queue.popBest()?.eventId).toBe('c-1');
    expect(queue.popBest()?.eventId).toBe('c-3');
    expect(queue.popBest()).toBeNull();
  });

  it('过期条目在弹出时被清理并记录原因', () => {
    let t = 1000;
    const queue = createQueue({ capacity: 10, now: () => t });
    const item = makeItem('c-1', 40);
    item.expiresAt = 1500;
    queue.push(item);
    t = 1600;
    expect(queue.popBest()).toBeNull();
    expect(queue.dropLog().at(-1)?.reason).toBe('expired');
  });

  it('clear 记录所有被清空的条目', () => {
    let t = 0;
    const queue = createQueue({ capacity: 10, now: () => t });
    queue.push(makeItem('a-1'));
    queue.push(makeItem('b-2'));
    expect(queue.clear('stopped')).toBe(2);
    expect(queue.dropLog().filter((d) => d.reason === 'stopped').length).toBe(2);
    expect(queue.length()).toBe(0);
  });
});
