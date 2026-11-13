// 连击累计快照 → 增量换算:同一连击维护“已见高水位”,重复或乱序快照不产生增量(ARCHITECTURE §5)。
// 供平台适配器使用;mock 适配器直发增量,也可用本工具模拟“快照语义”来源。

export function createComboTracker(opts: { maxCombos?: number } = {}) {
  const maxCombos = opts.maxCombos ?? 1000;
  const highWater = new Map<string, number>();

  /** 返回本次新增数量;快照不大于高水位时返回 0(重复/乱序)。 */
  function toIncrement(comboKey: string, snapshotTotal: number): number {
    if (!Number.isFinite(snapshotTotal) || snapshotTotal < 0) return 0;
    const prev = highWater.get(comboKey) ?? 0;
    if (snapshotTotal <= prev) return 0;
    if (!highWater.has(comboKey) && highWater.size >= maxCombos) {
      const oldest = highWater.keys().next().value;
      if (oldest !== undefined) highWater.delete(oldest);
    }
    highWater.set(comboKey, snapshotTotal);
    return snapshotTotal - prev;
  }

  function waterline(comboKey: string): number {
    return highWater.get(comboKey) ?? 0;
  }

  return { toIncrement, waterline };
}
