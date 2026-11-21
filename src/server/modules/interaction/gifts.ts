// 礼物合并感谢:同一用户同一礼物的连击在固定时间窗内累计,窗口关闭时生成一条合并感谢。
// P2 互动第二批:同步累计"已确认实付金额"——仅金瓜子(gold)计价;银瓜子/免费/未知价格
// 金额保持 0 且 paidKnown=false,分层时一律按小额普通感谢处理(v1.1 修正 2)。

export type GiftEmission = {
  userKey: string;
  userName: string;
  giftId: string;
  giftName: string;
  totalQuantity: number;
  /** 累计已确认实付金额(元);免费/银瓜子/未知价格恒为 0。 */
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
  /** 计价币种:仅 'gold' 参与实付金额累计。 */
  coinType?: string | undefined;
  /** 单价(元)。 */
  unitPriceYuan?: number | undefined;
};

type Pending = GiftEmission & { firstAt: number; windowEnd: number };

/** 单条增量的实付金额:非金瓜子或无有效单价返回 0。 */
function paidYuanOf(input: GiftInput): number {
  if (input.coinType !== 'gold') return 0;
  const unit = input.unitPriceYuan ?? 0;
  return unit > 0 ? unit * input.quantity : 0;
}

export function createGiftAggregator(opts: { mergeWindowMs(): number; now(): number }) {
  let pending = new Map<string, Pending>();
  let ready: GiftEmission[] = [];

  /** 事件 quantity 已是增量语义,直接累计;感谢在窗口结束时由 sweep 产出。 */
  function add(input: GiftInput): void {
    const now = opts.now();
    const key = `${input.userKey}|${input.giftId}`;
    const paid = paidYuanOf(input);
    const paidKnown = paid > 0;
    const existing = pending.get(key);
    if (!existing) {
      pending.set(key, {
        userKey: input.userKey,
        userName: input.userName,
        giftId: input.giftId,
        giftName: input.giftName,
        totalQuantity: input.quantity,
        totalPaidYuan: paid,
        paidKnown,
        firstAt: now,
        windowEnd: now + opts.mergeWindowMs(),
      });
      return;
    }
    if (now >= existing.windowEnd) {
      // 旧窗口已关闭:旧累计转入待产出,新礼物开启新窗口(不静默丢弃)。
      ready.push({ ...existing });
      pending.set(key, {
        userKey: input.userKey,
        userName: input.userName,
        giftId: input.giftId,
        giftName: input.giftName,
        totalQuantity: input.quantity,
        totalPaidYuan: paid,
        paidKnown,
        firstAt: now,
        windowEnd: now + opts.mergeWindowMs(),
      });
      return;
    }
    existing.totalQuantity += input.quantity;
    existing.totalPaidYuan += paid;
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
        emitted.push({
          userKey: p.userKey,
          userName: p.userName,
          giftId: p.giftId,
          giftName: p.giftName,
          totalQuantity: p.totalQuantity,
          totalPaidYuan: p.totalPaidYuan,
          paidKnown: p.paidKnown,
        });
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
