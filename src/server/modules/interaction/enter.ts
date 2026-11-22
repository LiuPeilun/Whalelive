// 进场欢迎聚合(互动第三批,v1.1 定稿):同一时间窗内去重累计观众,窗口关闭时产出——
// 人数 ≤ 上限逐个念名;超出上限改发全房欢迎,且全房欢迎受最小间隔限流
// (被限流的欢迎直接过期不排队)。同一观众窗口内重复进场只计一次。

export type EnterEmission = {
  kind: 'named' | 'all';
  /** named 时的去重观众名列表(按进场顺序,≤ 上限);all 时为空数组。 */
  names: string[];
};

type Pending = { name: string; firstAt: number; windowEnd: number };

export function createEnterAggregator(opts: {
  windowMs(): number;
  maxNamedCount(): number;
  allRoomIntervalMs(): number;
  now(): number;
}) {
  let pending = new Map<string, Pending>();
  let lastAllRoomAt = -Infinity;

  function add(input: { userKey: string; userName: string }): void {
    if (pending.has(input.userKey)) return;
    const now = opts.now();
    pending.set(input.userKey, { name: input.userName, firstAt: now, windowEnd: now + opts.windowMs() });
  }

  function sweep(): EnterEmission[] {
    const now = opts.now();
    const next = new Map<string, Pending>();
    const matured: { userKey: string; name: string }[] = [];
    for (const [key, p] of pending) {
      if (now >= p.windowEnd) matured.push({ userKey: key, name: p.name });
      else next.set(key, p);
    }
    pending = next;
    if (matured.length === 0) return [];
    const maxNamed = Math.max(0, Math.floor(opts.maxNamedCount()));
    if (maxNamed > 0 && matured.length <= maxNamed) {
      return [{ kind: 'named', names: matured.map((m) => m.name) }];
    }
    // 超出念名上限 → 全房欢迎;受最小间隔限流,被限流的直接过期(v1.1「过时欢迎直接过期」)
    if (now - lastAllRoomAt >= opts.allRoomIntervalMs()) {
      lastAllRoomAt = now;
      return [{ kind: 'all', names: [] }];
    }
    return [];
  }

  function clear(): void {
    pending.clear();
  }

  function size(): number {
    return pending.size;
  }

  return { add, sweep, clear, size };
}
