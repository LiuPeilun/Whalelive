// 唯一待播队列:优先级、有效期、容量与丢弃记录(PROJECT_STRUCTURE《模块职责》)。
// 容量满时先移出过期的普通聊天,再按“最旧的低优先级聊天”腾位,腾不出则拒绝新条目。

export type QueueItemType = 'chat' | 'gift' | 'guard' | 'superchat' | 'manual' | 'idle';

export type QueueItem = {
  eventId: string;
  type: QueueItemType;
  priority: number;
  enqueuedAt: number;
  expiresAt: number;
  say: string;
  action: string;
  userKey: string | null;
};

export type DropRecord = { eventId: string; reason: string; at: number };

export type PushResult = { ok: true } | { ok: false; reason: string };

const DROP_LOG_LIMIT = 50;

export function createQueue(opts: { capacity: number; now(): number }) {
  let capacity = opts.capacity;
  let items: QueueItem[] = [];
  let drops: DropRecord[] = [];

  function recordDrop(eventId: string, reason: string): void {
    drops.push({ eventId, reason, at: opts.now() });
    if (drops.length > DROP_LOG_LIMIT) drops = drops.slice(-DROP_LOG_LIMIT);
  }

  function sweepExpired(): void {
    const now = opts.now();
    const alive: QueueItem[] = [];
    for (const item of items) {
      if (item.expiresAt <= now) recordDrop(item.eventId, 'expired');
      else alive.push(item);
    }
    items = alive;
  }

  function push(item: QueueItem): PushResult {
    const now = opts.now();
    if (item.expiresAt <= now) {
      recordDrop(item.eventId, 'expired-on-arrival');
      return { ok: false, reason: 'expired-on-arrival' };
    }
    sweepExpired();
    if (items.length >= capacity) {
      // 容量满:优先挤掉最旧的普通聊天(低优先级、可放弃),否则拒绝新条目。
      let victimIndex = -1;
      for (let i = 0; i < items.length; i++) {
        const candidate = items[i]!;
        if (candidate.type === 'chat' && (victimIndex === -1 || candidate.priority <= (items[victimIndex]?.priority ?? Infinity))) {
          victimIndex = i;
        }
      }
      const victim = victimIndex >= 0 ? items[victimIndex] : null;
      const comparable = item.type === 'chat';
      if (victim && comparable && (victim.priority <= item.priority || victim.enqueuedAt <= now - 10_000)) {
        items.splice(victimIndex, 1);
        recordDrop(victim.eventId, 'capacity-evict-chat');
      } else {
        recordDrop(item.eventId, 'queue-full');
        return { ok: false, reason: 'queue-full' };
      }
    }
    items.push(item);
    return { ok: true };
  }

  /** 弹出下一条:先清理过期,再取最高优先级,同优先级取最早入队。 */
  function popBest(): QueueItem | null {
    sweepExpired();
    if (items.length === 0) return null;
    let bestIndex = 0;
    for (let i = 1; i < items.length; i++) {
      const best = items[bestIndex]!;
      const cur = items[i]!;
      if (cur.priority > best.priority || (cur.priority === best.priority && cur.enqueuedAt < best.enqueuedAt)) {
        bestIndex = i;
      }
    }
    const [picked] = items.splice(bestIndex, 1);
    return picked ?? null;
  }

  function clear(reason: string): number {
    const cleared = items.length;
    for (const item of items) recordDrop(item.eventId, reason);
    items = [];
    return cleared;
  }

  function setCapacity(next: number): void {
    capacity = next;
  }

  function getCapacity(): number {
    return capacity;
  }

  function length(): number {
    return items.length;
  }

  function snapshot(): QueueItem[] {
    return [...items].sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
  }

  function dropLog(): DropRecord[] {
    return [...drops].slice(-20);
  }

  return { push, popBest, clear, sweepExpired, setCapacity, getCapacity, length, snapshot, dropLog };
}
