// 唯一待播队列:优先级、有效期、容量与丢弃记录(PROJECT_STRUCTURE《模块职责》)。
// 腾位策略:只有普通聊天可被挤出(可替换性);新事件优先级不低于被挤出者时
// 选“优先级最低、同优先级最旧”的聊天腾位;队内无聊天或优先级不足时拒绝新条目。
// 缩容时按同一规则淘汰至新上限,淘汰原因 capacity-shrink。

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

  /** 选出最可被挤出的条目索引:仅普通聊天,优先级最低、同优先级最旧;无则 -1。 */
  function evictableIndex(): number {
    let victimIndex = -1;
    for (let i = 0; i < items.length; i++) {
      const candidate = items[i]!;
      if (candidate.type !== 'chat') continue;
      if (victimIndex === -1) {
        victimIndex = i;
        continue;
      }
      const victim = items[victimIndex]!;
      if (candidate.priority < victim.priority || (candidate.priority === victim.priority && candidate.enqueuedAt < victim.enqueuedAt)) {
        victimIndex = i;
      }
    }
    return victimIndex;
  }

  function push(item: QueueItem): PushResult {
    const now = opts.now();
    if (item.expiresAt <= now) {
      recordDrop(item.eventId, 'expired-on-arrival');
      return { ok: false, reason: 'expired-on-arrival' };
    }
    sweepExpired();
    if (items.length >= capacity) {
      const victimIndex = evictableIndex();
      const victim = victimIndex >= 0 ? items[victimIndex] : null;
      // 新事件优先级不低于被挤出者才允许腾位;礼物/大航海/人工因此可进满载的聊天队列。
      if (victim && item.priority >= victim.priority) {
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

  /** 缩容:按“优先级最低、同优先级先挤普通聊天、再按最旧”淘汰至新上限。 */
  function setCapacity(next: number): void {
    capacity = next;
    while (items.length > capacity) {
      let worstIndex = 0;
      for (let i = 1; i < items.length; i++) {
        const worst = items[worstIndex]!;
        const cur = items[i]!;
        if (cur.priority < worst.priority) {
          worstIndex = i;
          continue;
        }
        if (cur.priority === worst.priority) {
          const curChat = cur.type === 'chat';
          const worstChat = worst.type === 'chat';
          if (curChat && !worstChat) {
            worstIndex = i;
            continue;
          }
          if (curChat === worstChat && cur.enqueuedAt < worst.enqueuedAt) {
            worstIndex = i;
          }
        }
      }
      const [removed] = items.splice(worstIndex, 1);
      if (removed) recordDrop(removed.eventId, 'capacity-shrink');
    }
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
