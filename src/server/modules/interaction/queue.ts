// 唯一待播队列:优先级、有效期、容量与丢弃记录(PROJECT_STRUCTURE《模块职责》)。
// 腾位策略:只有普通聊天可被挤出(可替换性);新事件优先级不低于被挤出者时
// 选“优先级最低、同优先级最旧”的聊天腾位;队内无聊天或优先级不足时拒绝新条目。
// 缩容时按同一规则淘汰至新上限,淘汰原因 capacity-shrink。

export type QueueItemType = 'chat' | 'gift' | 'guard' | 'superchat' | 'enter' | 'follow' | 'share' | 'manual' | 'idle' | 'song';

export type QueueItem = {
  eventId: string;
  type: QueueItemType;
  priority: number;
  enqueuedAt: number;
  expiresAt: number;
  say: string;
  action: string;
  /** 语义弹幕的原始文本(指令/礼物为 null,文本在出队后生成)。 */
  text: string | null;
  /** true = 出队时不再调用回复提供方(指令/礼物/人工已确定文本)。 */
  isCommand: boolean;
  userKey: string | null;
  /** 礼物答谢档位(仅 type=gift,内部调度字段,不进状态快照协议)。 */
  giftTier?: 'small' | 'mid' | 'large';
  /** 礼物观众显示名(内部字段,供高峰合并取人名)。 */
  userName?: string;
  /** 高峰合并产物(内部字段):退出后续合并候选,原点名不参与再次合并(WT-P2-006)。 */
  merged?: boolean;
  /** 唱歌成片地址(仅 type=song):say 恒空,say 外的音频从这里来。 */
  songAudioUrl?: string;
};

export type DropRecord = { eventId: string; reason: string; at: number };

export type PushResult = { ok: true } | { ok: false; reason: string };

const DROP_LOG_LIMIT = 50;

/**
 * 低优先级问候/冷场条目的腾位阈值(WT-P2-012):优先级 ≤ 此值的条目
 * (关注/分享 30、进场 25、闲聊 10)与普通聊天一样可被更高优先级入队挤出——
 * 防止低价值问候占满队列挡住弹幕/高档答谢/人工试播。
 */
const EVICTABLE_LOW_PRIORITY = 30;

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

  /** 选出最可被挤出的条目索引:普通聊天与低优先级问候,优先级最低、同优先级最旧;无则 -1。 */
  function evictableIndex(): number {
    let victimIndex = -1;
    for (let i = 0; i < items.length; i++) {
      const candidate = items[i]!;
      // WT-P3-003:song 成片与问候一样属可腾位条目——满队列时高优先级互动(弹幕/高档)不得被堵死
      if (candidate.type !== 'chat' && candidate.type !== 'song' && candidate.priority > EVICTABLE_LOW_PRIORITY) continue;
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

  /** WT-P3-007 复审:共享准入判定(push 与 wouldAccept 干跑共用,杜绝预判漂移)。
   *  extraCount=模拟未来将入队的更高优先级条目数(如点歌确认语),预判其占位后本条目能否入队。 */
  function admitDecision(item: QueueItem, extraCount = 0): { ok: boolean; reason?: string; victimIndex: number } {
    if (item.expiresAt <= opts.now()) {
      return { ok: false, reason: 'expired-on-arrival', victimIndex: -1 };
    }
    const effectiveLength = items.length + extraCount;
    if (effectiveLength < capacity) return { ok: true, victimIndex: -1 };
    const victimIndex = evictableIndex();
    const victim = victimIndex >= 0 ? items[victimIndex] : null;
    // 新事件优先级不低于被挤出者才允许腾位;礼物/大航海/人工可进满载的聊天队列,
    // 弹幕/高档答谢/人工也可挤出低优先级问候(WT-P2-012)。
    if (victim && item.priority >= victim.priority) {
      return { ok: true, victimIndex };
    }
    return { ok: false, reason: 'queue-full', victimIndex };
  }

  function push(item: QueueItem): PushResult {
    if (item.expiresAt <= opts.now()) {
      recordDrop(item.eventId, 'expired-on-arrival');
      return { ok: false, reason: 'expired-on-arrival' };
    }
    sweepExpired();
    const decision = admitDecision(item);
    if (!decision.ok) {
      // queue-full 不在此处记录(WT-P2-006 复审):腾位/合并调用方可能重试成功,
      // 最终拒收由调用方经 recordReject 记入丢弃视图,避免"已入队却显示已丢弃"的误报。
      return { ok: false, reason: decision.reason ?? 'queue-full' };
    }
    if (decision.victimIndex >= 0) {
      const victim = items[decision.victimIndex]!;
      items.splice(decision.victimIndex, 1);
      recordDrop(victim.eventId, victim.type === 'song' ? 'capacity-evict-song' : victim.type === 'chat' ? 'capacity-evict-chat' : 'capacity-evict-greeting');
    }
    items.push(item);
    return { ok: true };
  }

  /** WT-P3-007 复审:顺序干跑模拟——按实际入队顺序依次判定多条目能否入队
   *  (前一条占位会改变后一条的腾位候选,独立单条判定会误判)。
   *  镜像 queue 的 push/腾位规则,规则变更时须同步本函数。 */
  function wouldAcceptSequence(probes: QueueItem[]): { allOk: boolean; results: { ok: boolean; reason?: string }[] } {
    let list: QueueItem[] = items.filter((it) => it.expiresAt > opts.now()); // 镜像 sweepExpired
    const results: { ok: boolean; reason?: string }[] = [];
    for (const item of probes) {
      if (item.expiresAt <= opts.now()) {
        results.push({ ok: false, reason: 'expired-on-arrival' });
        break;
      }
      if (list.length < capacity) {
        list = [...list, item];
        results.push({ ok: true });
        continue;
      }
      // 腾位:选 list 中最可挤出(优先级最低、同优先级最旧),规则镜像 evictableIndex
      let victimIndex = -1;
      for (let i = 0; i < list.length; i++) {
        const c = list[i]!;
        if (c.type !== 'chat' && c.type !== 'song' && c.priority > 30) continue;
        if (victimIndex === -1) {
          victimIndex = i;
          continue;
        }
        const v = list[victimIndex]!;
        if (c.priority < v.priority || (c.priority === v.priority && c.enqueuedAt < v.enqueuedAt)) victimIndex = i;
      }
      if (victimIndex === -1 || item.priority < list[victimIndex]!.priority) {
        results.push({ ok: false, reason: 'queue-full' });
        break;
      }
      list = list.filter((_, i) => i !== victimIndex);
      list.push(item);
      results.push({ ok: true });
    }
    return { allOk: results.every((r) => r.ok), results };
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

  /**
   * 按 ID 批量移除(高峰合并取回待播小额答谢用):命中者记 drop 原因并返回,
   * 未命中的 ID 忽略;保持剩余条目的相对顺序。
   */
  function removeMany(eventIds: ReadonlySet<string>, reason: string): QueueItem[] {
    const removed: QueueItem[] = [];
    const kept: QueueItem[] = [];
    for (const item of items) {
      if (eventIds.has(item.eventId)) {
        removed.push(item);
        recordDrop(item.eventId, reason);
      } else {
        kept.push(item);
      }
    }
    if (removed.length > 0) items = kept;
    return removed;
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

  return { push, popBest, clear, removeMany, sweepExpired, setCapacity, getCapacity, length, snapshot, dropLog, wouldAcceptSequence };
}
