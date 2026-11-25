import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSingingPoller, type PollResponse } from './singing-poller.js';

// 点歌面板取数调度回归:单在途、节流不饿死、自适应节奏、凭据失效停轮询。
// 假计时器下驱动;Date.now() 同步被假时钟替换,间隔断言确定。

const OK: PollResponse = { ok: true, status: 200, body: { jobs: [] } };
const TIMINGS = { intervalMs: 1000, idleMs: 10_000 };

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** 手动兑现的请求队列:可制造"在途"窗口。 */
function manualHarness(opts: { active?: boolean } = {}) {
  const pending: Array<(r: PollResponse) => void> = [];
  const data: unknown[] = [];
  let active = opts.active ?? false;
  let policy: 'stop' | 'continue' = 'continue';
  const poller = createSingingPoller({
    request: () => new Promise<PollResponse>((resolve) => { pending.push(resolve); }),
    onData: (body) => { data.push(body); },
    onFailure: () => policy,
    isActive: () => active,
    timings: TIMINGS,
  });
  return {
    poller, pending, data,
    setActive: (v: boolean) => { active = v; },
    setPolicy: (p: 'stop' | 'continue') => { policy = p; },
    resolveAll: () => { for (const r of pending.splice(0)) r(OK); },
  };
}

/** 自动兑现的请求,记录各次取数时刻(相对首次取数的毫秒数;假时钟起点是真实当前时间)。 */
function autoHarness(opts: { active?: () => boolean } = {}) {
  const stamps: number[] = [];
  const poller = createSingingPoller({
    request: async () => { stamps.push(Date.now()); return OK; },
    onData: () => {},
    onFailure: () => 'continue',
    isActive: opts.active ?? (() => false),
    timings: TIMINGS,
  });
  return {
    poller,
    get times(): number[] {
      return stamps.map((t) => t - (stamps[0] ?? t));
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('singing-poller 取数调度', () => {
  it('同一时刻最多一个在途请求;在途期间的刷新请求合并为一次补刷', async () => {
    const h = manualHarness();
    h.poller.refresh();
    await tick(0);
    expect(h.pending).toHaveLength(1);
    for (let i = 0; i < 5; i += 1) h.poller.refresh();
    expect(h.pending).toHaveLength(1);
    h.resolveAll();
    await tick(0);
    expect(h.data).toHaveLength(1);
    // 补刷按最小间隔延后:999ms 时不发,满 1000ms 才发,且只发一次
    await tick(999);
    expect(h.pending).toHaveLength(0);
    await tick(1);
    expect(h.pending).toHaveLength(1);
    h.resolveAll();
    await tick(0);
    // 无在途任务、无待刷:回到空闲节奏(10s)
    await tick(9999);
    expect(h.pending).toHaveLength(0);
    await tick(1);
    expect(h.pending).toHaveLength(1);
  });

  it('密集刷新只节流不饿死:持续触发下仍按最小间隔取数', async () => {
    const h = autoHarness();
    h.poller.refresh();
    await tick(0);
    for (let i = 0; i < 20; i += 1) {
      h.poller.refresh();
      await tick(250);
    }
    // 5 秒内每 250ms 触发一次刷新:取数不被无限推迟,间隔也不小于最小间隔
    expect(h.times.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < h.times.length; i += 1) {
      expect((h.times[i] ?? 0) - (h.times[i - 1] ?? 0)).toBeGreaterThanOrEqual(1000);
    }
  });

  it('有在途任务时每秒取数,空闲后退到 10 秒兜底', async () => {
    let active = true;
    const h = autoHarness({ active: () => active });
    h.poller.refresh();
    await tick(0);
    await tick(3000);
    expect(h.times).toEqual([0, 1000, 2000, 3000]);
    active = false;
    await tick(1000); // 已排定的一次间隔轮询照常发生,此后按空闲节奏
    expect(h.times).toEqual([0, 1000, 2000, 3000, 4000]);
    await tick(9999);
    expect(h.times).toHaveLength(5);
    await tick(1);
    expect(h.times).toHaveLength(6);
  });

  it('凭据失效(401/403)后停止:状态推送触发的刷新也不再发请求', async () => {
    for (const status of [401, 403]) {
      let count = 0;
      const seen: Array<PollResponse | null> = [];
      const poller = createSingingPoller({
        request: async () => { count += 1; return { ok: false, status, body: { code: 'AUTH_REJECTED' } }; },
        onData: () => { throw new Error('不应到达'); },
        onFailure: (response) => { seen.push(response); return 'stop'; },
        isActive: () => true,
        timings: TIMINGS,
      });
      poller.refresh();
      await tick(0);
      expect(count).toBe(1);
      expect(seen[0]).toMatchObject({ status });
      await tick(60_000);
      poller.refresh(); // 等价于此期间到达的状态推送
      await tick(60_000);
      expect(count).toBe(1);
    }
  });

  it('网络异常后按节奏重试,恢复后正常送达', async () => {
    let attempt = 0;
    const data: unknown[] = [];
    const seen: Array<PollResponse | null> = [];
    const poller = createSingingPoller({
      request: async () => {
        attempt += 1;
        if (attempt <= 2) throw new Error('ECONNREFUSED');
        return { ok: true, status: 200, body: 'jobs' };
      },
      onData: (body) => { data.push(body); },
      onFailure: (response) => { seen.push(response); return 'continue'; },
      isActive: () => true,
      timings: TIMINGS,
    });
    poller.refresh();
    await tick(0);
    expect(seen).toEqual([null]); // 网络异常以 null 交给 onFailure
    expect(data).toEqual([]);
    await tick(1000);
    expect(seen).toEqual([null, null]);
    await tick(1000);
    expect(data).toEqual(['jobs']);
  });

  it('渲染异常记录到控制台,不中断后续取数', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const poller = createSingingPoller({
      request: async () => { calls += 1; return OK; },
      onData: () => { throw new Error('render boom'); },
      onFailure: () => 'stop',
      isActive: () => true,
      timings: TIMINGS,
    });
    poller.refresh();
    await tick(0);
    expect(calls).toBe(1);
    await tick(2000);
    expect(calls).toBe(3);
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it('stop() 取消已排定的轮询', async () => {
    const h = autoHarness();
    h.poller.refresh();
    await tick(0);
    h.poller.stop();
    await tick(60_000);
    expect(h.times).toHaveLength(1);
  });
});
