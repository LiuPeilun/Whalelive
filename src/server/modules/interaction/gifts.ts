// 礼物合并感谢:同一用户同一礼物的连击在固定时间窗内累计,窗口关闭时生成一条合并感谢。

export type GiftEmission = {
  userKey: string;
  userName: string;
  giftId: string;
  giftName: string;
  totalQuantity: number;
};

type Pending = GiftEmission & { firstAt: number; windowEnd: number };

export function createGiftAggregator(opts: { mergeWindowMs(): number; now(): number }) {
  let pending = new Map<string, Pending>();
  let ready: GiftEmission[] = [];

  /** 事件 quantity 已是增量语义,直接累计;感谢在窗口结束时由 sweep 产出。 */
  function add(input: { userKey: string; userName: string; giftId: string; giftName: string; quantity: number }): void {
    const now = opts.now();
    const key = `${input.userKey}|${input.giftId}`;
    const existing = pending.get(key);
    if (!existing) {
      pending.set(key, {
        userKey: input.userKey,
        userName: input.userName,
        giftId: input.giftId,
        giftName: input.giftName,
        totalQuantity: input.quantity,
        firstAt: now,
        windowEnd: now + opts.mergeWindowMs(),
      });
      return;
    }
    if (now >= existing.windowEnd) {
      // 旧窗口已关闭:旧累计转入待产出,新礼物开启新窗口(不静默丢弃)。
      ready.push({ userKey: existing.userKey, userName: existing.userName, giftId: existing.giftId, giftName: existing.giftName, totalQuantity: existing.totalQuantity });
      pending.set(key, {
        userKey: input.userKey,
        userName: input.userName,
        giftId: input.giftId,
        giftName: input.giftName,
        totalQuantity: input.quantity,
        firstAt: now,
        windowEnd: now + opts.mergeWindowMs(),
      });
      return;
    }
    existing.totalQuantity += input.quantity;
  }

  /** 取出到期的合并结果;由调度循环周期性调用。 */
  function sweep(): GiftEmission[] {
    const now = opts.now();
    const emitted = ready;
    ready = [];
    const next = new Map<string, Pending>();
    for (const [key, p] of pending) {
      if (now >= p.windowEnd) {
        emitted.push({ userKey: p.userKey, userName: p.userName, giftId: p.giftId, giftName: p.giftName, totalQuantity: p.totalQuantity });
      } else {
        next.set(key, p);
      }
    }
    pending = next;
    return emitted;
  }

  function clear(): void {
    pending.clear();
  }

  function size(): number {
    return pending.size;
  }

  return { add, sweep, clear, size };
}
