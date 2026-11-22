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
    text: null,
    isCommand: true,
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

  it('满载拒收不写入丢弃记录;queue-full 由调用方在最终拒收时记录(WT-P2-006 复审)', () => {
    let t = 0;
    const queue = createQueue({ capacity: 2, now: () => t });
    queue.push(makeItem('g-1', 80, 'gift'));
    queue.push(makeItem('g-2', 80, 'gift'));
    const rejected = queue.push(makeItem('chat-3', 40, 'chat'));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.reason).toBe('queue-full');
    }
    // 拒收不再写入队列丢弃记录——腾位重试成功的条目不会残留误报,
    // 最终拒收由 interaction 层 recordReject 统一记入丢弃视图
    expect(queue.dropLog().some((d) => d.reason === 'queue-full')).toBe(false);
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

  it('满载聊天队列:礼物(60)与人工动作(100)可挤出普通聊天(WT-P0-004)', () => {
    let t = 0;
    const queue = createQueue({ capacity: 2, now: () => t });
    queue.push(makeItem('c-1', 40, 'chat'));
    t += 1;
    queue.push(makeItem('c-2', 40, 'chat'));
    t += 1;
    const gift = queue.push(makeItem('g-3', 60, 'gift'));
    expect(gift.ok).toBe(true);
    expect(queue.length()).toBe(2);
    expect(queue.dropLog().at(-1)?.reason).toBe('capacity-evict-chat');
    expect(queue.snapshot().some((item) => item.eventId === 'g-3')).toBe(true);
    const manual = queue.push(makeItem('m-4', 100, 'manual'));
    expect(manual.ok).toBe(true);
    expect(queue.snapshot().some((item) => item.eventId === 'm-4')).toBe(true);
    expect(queue.snapshot().every((item) => item.type !== 'gift' || item.eventId === 'g-3')).toBe(true);
  });

  it('满载且无普通聊天时,礼物被拒绝(WT-P0-004)', () => {
    let t = 0;
    const queue = createQueue({ capacity: 2, now: () => t });
    queue.push(makeItem('g-1', 60, 'gift'));
    queue.push(makeItem('m-2', 100, 'manual'));
    const rejected = queue.push(makeItem('g-3', 60, 'gift'));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toBe('queue-full');
    expect(queue.length()).toBe(2);
  });

  it('缩容:容量 2→1 保留高优先级,挤出普通聊天并记录 capacity-shrink(WT-P0-008)', () => {
    let t = 0;
    const queue = createQueue({ capacity: 2, now: () => t });
    queue.push(makeItem('c-1', 40, 'chat'));
    t += 1;
    queue.push(makeItem('g-2', 80, 'gift'));
    queue.setCapacity(1);
    expect(queue.length()).toBe(1);
    const kept = queue.snapshot();
    expect(kept[0]?.eventId).toBe('g-2');
    expect(queue.dropLog().at(-1)?.reason).toBe('capacity-shrink');
  });
});

describe('低优先级问候腾位(WT-P2-012)', () => {
  function makeGreeting(id: string): QueueItem {
    return { eventId: id, type: 'follow', priority: 30, enqueuedAt: 1, expiresAt: 9_999_999, say: '', action: 'wave', text: null, isCommand: true, userKey: null };
  }

  it('低优先级问候占满队列时,弹幕/高档/人工可挤出问候入队,被挤出者记录 capacity-evict-greeting', () => {
    let t = 0;
    const queue = createQueue({ capacity: 5, now: () => t });
    for (let i = 0; i < 5; i++) queue.push(makeGreeting(`g-${i}`));
    expect(queue.length()).toBe(5);
    queue.push({ eventId: 'chat-x', type: 'chat', priority: 40, enqueuedAt: 2, expiresAt: 9_999_999, say: '', action: 'talk', text: 'hi', isCommand: false, userKey: null });
    queue.push({ eventId: 'guard-x', type: 'guard', priority: 80, enqueuedAt: 3, expiresAt: 9_999_999, say: '', action: 'celebrate', text: null, isCommand: true, userKey: null });
    queue.push({ eventId: 'manual-x', type: 'manual', priority: 100, enqueuedAt: 4, expiresAt: 9_999_999, say: '', action: 'wave', text: null, isCommand: true, userKey: null });
    expect(queue.length()).toBe(5);
    const types = queue.snapshot().map((i) => i.type);
    expect(types).toContain('chat');
    expect(types).toContain('guard');
    expect(types).toContain('manual');
    expect(queue.dropLog().filter((d) => d.reason === 'capacity-evict-greeting').length).toBe(3);
  });
});
