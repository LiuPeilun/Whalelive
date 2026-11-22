// 进场欢迎聚合(互动第三批,v1.1 定稿;WT-P2-014 共享窗口):
// 首位观众开启一个共享的聚合窗口,窗口内所有观众(按 userKey 去重)单次结算——
// 人数 ≤ 上限逐个念名;超出上限改发全房欢迎,且全房欢迎受最小间隔限流
// (被限流的欢迎直接过期不排队)。窗口结算后由下一位观众重新开启。

export type EnterEmission = {
  kind: 'named' | 'all';
  /** named 时的去重观众名列表(按进场顺序,≤ 上限);all 时为空数组。 */
  names: string[];
};

export function createEnterAggregator(opts: {
  windowMs(): number;
  maxNamedCount(): number;
  allRoomIntervalMs(): number;
  now(): number;
}) {
  let windowStart: number | null = null;
  let users = new Map<string, string>();
  let lastAllRoomAt = -Infinity;

  function add(input: { userKey: string; userName: string }): void {
    if (windowStart === null) windowStart = opts.now(); // 首位观众开启共享窗口
    if (!users.has(input.userKey)) users.set(input.userKey, input.userName);
  }

  function sweep(): EnterEmission[] {
    const now = opts.now();
    if (windowStart === null || now < windowStart + opts.windowMs()) return [];
    const names = [...users.values()];
    const count = names.length;
    users = new Map();
    windowStart = null;
    if (count === 0) return [];
    const maxNamed = Math.max(0, Math.floor(opts.maxNamedCount()));
    if (maxNamed > 0 && count <= maxNamed) {
      return [{ kind: 'named', names }];
    }
    // 超出念名上限 → 全房欢迎;受最小间隔限流,被限流的直接过期(v1.1「过时欢迎直接过期」)
    if (now - lastAllRoomAt >= opts.allRoomIntervalMs()) {
      lastAllRoomAt = now;
      return [{ kind: 'all', names: [] }];
    }
    return [];
  }

  function clear(): void {
    windowStart = null;
    users = new Map();
  }

  function size(): number {
    return users.size;
  }

  return { add, sweep, clear, size };
}
