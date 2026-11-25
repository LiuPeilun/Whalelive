// 点歌面板取数调度:自适应轮询,不含 DOM(Node 环境可回归)。
// 任务阶段只在服务端内部推进(不产生 WS 状态推送),所以面板靠轮询取数:
// - 有在途任务时每 intervalMs 取一次,空闲时退到 idleMs 兜底;
// - 状态推送到达时调用 refresh() 立即取数(新点歌的确认入队会触发推送),
//   操作者点歌后不必等空闲轮询周期;
// - 同一时刻最多一个在途请求(响应不会乱序覆盖),请求间隔不小于 intervalMs,
//   密集触发只节流不饿死;在途期间收到的刷新请求合并为一次补刷。

export type PollResponse = { ok: boolean; status: number; body: unknown };

export type SingingPoller = {
  /** 请求一次刷新;取数中则记为待刷。已停止后无效。 */
  refresh(): void;
  /** 终止调度并丢弃待刷请求(凭据失效、页面卸载)。 */
  stop(): void;
};

export function createSingingPoller(deps: {
  request(): Promise<PollResponse>;
  onData(body: unknown): void;
  /** 非 2xx 或网络异常后的去向:stop 终止轮询,continue 按当前节奏重试。 */
  onFailure(response: PollResponse | null): 'stop' | 'continue';
  /** 最近一次成功取数后是否仍有在途任务(决定下一次间隔)。 */
  isActive(): boolean;
  timings?: { intervalMs: number; idleMs: number };
}): SingingPoller {
  const intervalMs = deps.timings?.intervalMs ?? 1000;
  const idleMs = deps.timings?.idleMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let stopped = false;
  let queued = false;
  let lastFetchAt = -Infinity;

  function schedule(delay: number): void {
    if (stopped || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, delay);
  }

  async function poll(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    queued = false;
    lastFetchAt = Date.now();
    let response: PollResponse | null = null;
    try {
      response = await deps.request();
    } catch {
      response = null; // 网络异常(服务重启中等):交给 onFailure 决定去向
    }
    inFlight = false;
    if (stopped) return;
    if (response !== null && response.ok) {
      try {
        deps.onData(response.body);
      } catch (err) {
        // 渲染异常记录到控制台,不中断后续取数
        console.error('singing jobs view render failed', err);
      }
      schedule(nextDelay());
      return;
    }
    if (deps.onFailure(response) === 'stop') {
      stopped = true; // 之后 refresh() 不再触发请求(状态推送到达也不行)
      return;
    }
    schedule(nextDelay());
  }

  function nextDelay(): number {
    return queued || deps.isActive() ? intervalMs : idleMs;
  }

  return {
    refresh(): void {
      if (stopped) return;
      if (inFlight) {
        queued = true;
        return;
      }
      // 距上次取数不足 intervalMs 则延后到间隔期满;已排定的更晚空闲轮询被提前
      if (timer !== null) clearTimeout(timer);
      timer = null;
      schedule(Math.max(0, intervalMs - (Date.now() - lastFetchAt)));
    },
    stop(): void {
      stopped = true;
      queued = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
