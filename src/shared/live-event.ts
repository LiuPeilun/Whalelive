// 标准事件契约(ARCHITECTURE §5)。quantity 一律表示本次新增数量,累计快照在适配器中换算为增量。

export type LiveEventSource = 'mock' | 'bilibili-web' | 'bilibili-open';

export type LiveEventType = 'chat' | 'gift' | 'guard' | 'superchat' | 'enter' | 'like';

export type LiveEventGift = {
  id: string;
  name: string;
  quantity: number;
  comboId?: string;
  /**
   * 已确认实付单价(毫元,1000=1 元,正整数);免费/实付未确认/未知价格为 undefined(WT-P2-004)。
   * 适配器按官方口径归一:paid=true 且有实际价值(r_price)才计价;仅有标价或盲盒爆出价值
   * 属于现金实付未确认,保留普通感谢不计金额。
   */
  paidMilliYuan?: number;
};

export type LiveEvent = {
  id: string;
  sourceKey: string;
  source: LiveEventSource;
  roomId: string;
  type: LiveEventType;
  user: { id: string; name: string };
  text?: string;
  gift?: LiveEventGift;
  receivedAt: number;
};

export type LiveEventValidation =
  | { ok: true; event: LiveEvent }
  | { ok: false; reason: string };

const EVENT_TYPES: ReadonlySet<string> = new Set(['chat', 'gift', 'guard', 'superchat', 'enter', 'like']);
const SOURCES: ReadonlySet<string> = new Set(['mock', 'bilibili-web', 'bilibili-open']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** 浏览器与服务端共用的结构校验,不依赖 Node API。 */
export function validateLiveEvent(value: unknown): LiveEventValidation {
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'event 必须是对象' };
  const v = value as Record<string, unknown>;
  if (!isNonEmptyString(v.id)) return { ok: false, reason: '缺少 id' };
  if (!isNonEmptyString(v.sourceKey)) return { ok: false, reason: '缺少 sourceKey' };
  if (!isNonEmptyString(v.source) || !SOURCES.has(v.source)) return { ok: false, reason: 'source 不受支持' };
  if (!isNonEmptyString(v.roomId)) return { ok: false, reason: '缺少 roomId' };
  if (!isNonEmptyString(v.type) || !EVENT_TYPES.has(v.type)) return { ok: false, reason: 'type 不受支持' };
  const user = v.user;
  if (typeof user !== 'object' || user === null || !isNonEmptyString((user as Record<string, unknown>).id) || !isNonEmptyString((user as Record<string, unknown>).name)) {
    return { ok: false, reason: '缺少 user.id / user.name' };
  }
  if (typeof v.receivedAt !== 'number' || !Number.isFinite(v.receivedAt)) return { ok: false, reason: 'receivedAt 必须是数值' };
  if (v.type === 'gift') {
    const gift = v.gift;
    if (typeof gift !== 'object' || gift === null) return { ok: false, reason: '礼物事件缺少 gift' };
    const g = gift as Record<string, unknown>;
    if (!isNonEmptyString(g.id) || !isNonEmptyString(g.name)) return { ok: false, reason: 'gift 缺少 id / name' };
    if (typeof g.quantity !== 'number' || !Number.isInteger(g.quantity) || g.quantity < 1) {
      return { ok: false, reason: 'gift.quantity 必须是不小于 1 的整数(本次新增数量)' };
    }
    if (g.paidMilliYuan !== undefined && (!Number.isInteger(g.paidMilliYuan) || (g.paidMilliYuan as number) < 1)) {
      return { ok: false, reason: 'gift.paidMilliYuan 必须是正整数毫元(1000=1元);免费/未确认实付请省略该字段' };
    }
  }
  return { ok: true, event: v as unknown as LiveEvent };
}
