// 礼物合并感谢:同一用户同一礼物的连击在固定时间窗内累计,窗口关闭时生成一条合并感谢。
// P2 互动第二批:同步累计"已确认实付金额"——只有事件带 paidMilliYuan(适配器归一后的
// 实付单价)才计价;免费/实付未确认/未知价格为 undefined,金额保持 0 且 paidKnown=false。
// WT-P2-004:金额用整数毫元(1000=1 元)累计,避免浮点累加误差(0.1×10 须精确等于 1 元)。

export type GiftEmission = {
  userKey: string;
  userName: string;
  giftId: string;
  giftName: string;
  totalQuantity: number;
  /** 累计已确认实付金额(毫元,1000=1 元,整数);免费/未确认实付/未知价格恒为 0。 */
  totalPaidMilliYuan: number;
  /** 累计已确认实付金额(元,由整数毫元换算)。 */
  totalPaidYuan: number;
  /** 是否出现过已确认计价的事件(区分"确实免费"与"价格未知")。 */
  paidKnown: boolean;
};

type GiftInput = {
  userKey: string;
  userName: string;
  giftId: string;
  giftName: string;
  quantity: number;
  /** 已确认实付单价(毫元,1000=1 元,整数);免费/实付未确认/未知价格为 undefined。 */
  paidMilliYuan?: number | undefined;
};

type Pending = GiftEmission & { firstAt: number; windowEnd: number };

/** 单条增量的实付金额(毫元,整数);无有效单价返回 0。 */
function paidMilliOf(input: GiftInput): number {
  const unit = input.paidMilliYuan;
  if (unit === undefined || unit <= 0) return 0;
  return unit * input.quantity;
}

function toEmission(p: {
  userKey: string; userName: string; giftId: string; giftName: string;
  totalQuantity: number; totalPaidMilliYuan: number; paidKnown: boolean;
}): GiftEmission {
  return {
    userKey: p.userKey,
    userName: p.userName,
    giftId: p.giftId,
    giftName: p.giftName,
    totalQuantity: p.totalQuantity,
    totalPaidMilliYuan: p.totalPaidMilliYuan,
    totalPaidYuan: p.totalPaidMilliYuan / 1000,
    paidKnown: p.paidKnown,
  };
}

export function createGiftAggregator(opts: { mergeWindowMs(): number; now(): number }) {
  let pending = new Map<string, Pending>();
  let ready: GiftEmission[] = [];

  /** 事件 quantity 已是增量语义,直接累计;感谢在窗口结束时由 sweep 产出。 */
  function add(input: GiftInput): void {
    const now = opts.now();
    const key = `${input.userKey}|${input.giftId}`;
    const paidMilli = paidMilliOf(input);
    const paidKnown = paidMilli > 0;
    const existing = pending.get(key);
    if (!existing) {
      pending.set(key, {
        userKey: input.userKey,
        userName: input.userName,
        giftId: input.giftId,
        giftName: input.giftName,
        totalQuantity: input.quantity,
        totalPaidMilliYuan: paidMilli,
        totalPaidYuan: paidMilli / 1000,
        paidKnown,
        firstAt: now,
        windowEnd: now + opts.mergeWindowMs(),
      });
      return;
    }
    if (now >= existing.windowEnd) {
      // 旧窗口已关闭:旧累计转入待产出,新礼物开启新窗口(不静默丢弃)。
      ready.push(toEmission(existing));
      pending.set(key, {
        userKey: input.userKey,
        userName: input.userName,
        giftId: input.giftId,
        giftName: input.giftName,
        totalQuantity: input.quantity,
        totalPaidMilliYuan: paidMilli,
        totalPaidYuan: paidMilli / 1000,
        paidKnown,
        firstAt: now,
        windowEnd: now + opts.mergeWindowMs(),
      });
      return;
    }
    existing.totalQuantity += input.quantity;
    existing.totalPaidMilliYuan += paidMilli;
    existing.totalPaidYuan = existing.totalPaidMilliYuan / 1000;
    existing.paidKnown = existing.paidKnown || paidKnown;
  }

  /** 取出到期的合并结果;由调度循环周期性调用。 */
  function sweep(): GiftEmission[] {
    const now = opts.now();
    const emitted = ready;
    ready = [];
    const next = new Map<string, Pending>();
    for (const [key, p] of pending) {
      if (now >= p.windowEnd) {
        emitted.push(toEmission(p));
      } else {
        next.set(key, p);
      }
    }
    pending = next;
    return emitted;
  }

  function clear(): void {
    pending.clear();
    ready = []; // 跨窗口待产出的旧感谢一并清理,防止停止后旧结果重新入队
  }

  function size(): number {
    return pending.size;
  }

  return { add, sweep, clear, size };
}
