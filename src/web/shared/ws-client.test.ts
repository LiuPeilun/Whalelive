import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWsClient } from './ws-client.js';

// WT-P0-011 回归:CONNECTING 悬挂守卫触发后,浏览器异步派发的 close 事件
// 不得造成第二次重连调度;被替换连接的消息与迟到事件全部失效。
// FakeWebSocket 忠实复现浏览器异步 close:close() 置 CLOSING,close 事件由测试手动派发。

type FakeEv = { data: string };

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: FakeEv) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState !== FakeWebSocket.CLOSED && this.readyState !== FakeWebSocket.CLOSING) {
      this.readyState = FakeWebSocket.CLOSING;
      this.closeCalls += 1;
    }
  }

  closeCalls = 0;

  // ---- 测试辅助(模拟浏览器事件派发)----
  emitOpen(): void {
    // 浏览器不会对已中止/已关闭的连接派发 open(如守卫 close 后迟到的握手成功)
    if (this.readyState === FakeWebSocket.CLOSED || this.readyState === FakeWebSocket.CLOSING) return;
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitError(): void {
    this.onerror?.();
  }

  emitClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  emitMessage(data: string): void {
    this.onmessage?.({ data });
  }
}

const CRED = 'test-credential';

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('ws-client 重连调度(WT-P0-011)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal('window', {
      location: { hash: `#${CRED}`, protocol: 'http:', host: '127.0.0.1:3210' },
      setTimeout: undefined,
      clearTimeout: undefined,
      __wtWs: undefined,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('CONNECTING 悬挂守卫触发后,浏览器异步 close 只产生一次重连与一个新连接', async () => {
    const client = createWsClient({ role: 'playback', credential: CRED, onMessage: vi.fn(), onStatus: vi.fn() });
    void client;
    const first = FakeWebSocket.instances[0]!;
    expect(first.url.endsWith('/ws')).toBe(true);

    // 首个握手悬挂:不派发 open,推进到守卫触发(10 秒)
    await advance(10_000);
    expect(first.closeCalls).toBe(1); // 守卫主动 close

    // 守卫已调度重连;随后浏览器异步派发 close 事件 —— 不得产生第二次调度
    first.emitClose();
    await advance(1);
    expect(FakeWebSocket.instances.length).toBe(1); // 重连计时器尚未到期

    // 退避到期(800ms):建立第二个连接
    await advance(900);
    expect(FakeWebSocket.instances.length).toBe(2);
    const second = FakeWebSocket.instances[1]!;

    // 第二个连接成功并认证
    second.emitOpen();
    expect(second.sent.some((m) => m.includes('"kind":"auth"'))).toBe(true);

    // 旧连接迟到的消息与 close 全部失效:不处理、不追加连接
    first.emitMessage(JSON.stringify({ kind: 'state', state: { bogus: true } }));
    first.emitClose();
    await advance(5_000);
    expect(FakeWebSocket.instances.length).toBe(2); // 仅初始 + 1 次重连,无第二重连循环
  });

  it('守卫触发后立即到达的 close 与守卫调度幂等,不产生并行重连', async () => {
    createWsClient({ role: 'control', credential: CRED, onMessage: vi.fn(), onStatus: vi.fn() });
    const first = FakeWebSocket.instances[0]!;

    await advance(10_000); // 守卫:close + 调度
    first.emitClose();     // 浏览器异步 close 紧随其后
    first.emitClose();     // 以及重复 close
    await advance(1);
    expect(FakeWebSocket.instances.length).toBe(1);

    await advance(900);
    expect(FakeWebSocket.instances.length).toBe(2); // 仅一次重连
    FakeWebSocket.instances[1]!.emitOpen();
    await advance(5_000);
    expect(FakeWebSocket.instances.length).toBe(2); // 稳定,无新增
  });

  it('被替换连接的迟到 open 被关闭,不产生同页第二业务连接', async () => {
    createWsClient({ role: 'playback', credential: CRED, onMessage: vi.fn(), onStatus: vi.fn() });
    const first = FakeWebSocket.instances[0]!;

    // 首次握手悬挂(CONNECTING 从未 open),守卫触发并调度重连
    await advance(10_000);
    expect(first.closeCalls).toBe(1);
    first.emitClose(); // 浏览器异步 close
    await advance(900);
    const second = FakeWebSocket.instances[1]!;
    second.emitOpen();
    expect(second.sent.some((m) => m.includes('"kind":"auth"'))).toBe(true);

    // 旧连接迟到的成功(守卫 close 与握手完成的竞态窗口):必须被关闭,不能成为第二业务连接
    first.emitOpen();
    expect(first.readyState).not.toBe(FakeWebSocket.OPEN);
    expect(first.sent.every((m) => !m.includes('"kind":"auth"'))).toBe(true); // 迟到连接不发送认证
    await advance(5_000);
    expect(FakeWebSocket.instances.length).toBe(2);
  });
});

describe('ws-client 自愈重载时序(WT-P1-010)', () => {
  let reload: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: ReturnType<typeof createWsClient> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    reload = vi.fn();
    fetchMock = vi.fn();
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal('location', { pathname: '/overlay/', search: '?audio=1', protocol: 'http:', host: '127.0.0.1:3210', reload });
    vi.stubGlobal('sessionStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      location: { hash: `#${CRED}`, protocol: 'http:', host: '127.0.0.1:3210' },
      __wtWs: undefined,
    });
  });

  afterEach(() => {
    client?.close();
    client = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function create(): void {
    client = createWsClient({ role: 'playback', credential: CRED, onMessage: vi.fn(), onStatus: vi.fn() });
  }

  /** 推进一次"守卫 10s 悬挂 + 退避"到下一次 connect 建立 */
  async function hangCycle(): Promise<void> {
    await advance(10_000);
    await advance(3_200); // 覆盖最大退避间隔,确保新 connect 已发起
  }

  it('探测悬置期间重连成功,迟到的 200 不刷新已恢复页面', async () => {
    create();
    let resolveFetch: ((v: { ok: boolean }) => void) | null = null;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveFetch = resolve; }));

    await advance(10_000); await advance(800); // connect#2(悬挂)
    await advance(10_000); await advance(1_600); // connect#3(悬挂)
    await advance(10_000); // 第 3 次守卫:streak=3 → 文档探测发起并悬置
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(3_200); // 悬置期间退避到期:connect#4
    const recovered = FakeWebSocket.instances.at(-1)!;
    recovered.emitOpen(); // 探测尚未返回时连接已恢复
    expect(recovered.readyState).toBe(FakeWebSocket.OPEN);

    // 迟到的探测返回 200:已恢复的页面不得刷新
    const lateResolve = resolveFetch as null | ((v: { ok: boolean }) => void);
    lateResolve?.({ ok: true }); // 迟到的探测 200
    await Promise.resolve();
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled(); // 已恢复的页面不得刷新
  });

  it('恢复后再次断线时,旧周期的探测不触发刷新(WT-P1-010)', async () => {
    create();
    let resolveFetch: ((v: { ok: boolean }) => void) | null = null;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveFetch = resolve; }));

    await advance(10_000); await advance(800);
    await advance(10_000); await advance(1_600);
    await advance(10_000); // 第 3 次守卫 → 探测发起并悬置
    await advance(3_200); // connect#4
    const recovered = FakeWebSocket.instances.at(-1)!;
    recovered.emitOpen(); // 连接恢复(周期推进)

    // 恢复后再次断线:新一轮失败开始(悬挂计数重新累计,尚未达到自愈阈值)
    recovered.emitClose();
    await advance(500); // connect#5 开始尝试(新周期,悬挂计数 0)

    // 旧周期的探测此刻才返回 200:不得刷新——新一轮恢复刚开始,提前刷新会中断它
    const lateResolve = resolveFetch as null | ((v: { ok: boolean }) => void);
    lateResolve?.({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();
    // 新周期自身尚未达到重试阈值,也不应有其他刷新来源
    expect(reload).not.toHaveBeenCalled();
  });

  it('探测 503 时不重载,原页保留重连能力继续重试', async () => {
    fetchMock.mockResolvedValue({ ok: false }); // 持续 503
    create();

    await hangCycle(); await hangCycle(); // 悬挂 ×2
    await advance(10_000); // 第 3 次守卫 → 探测 503 → 不重载
    expect(reload).not.toHaveBeenCalled();

    await hangCycle(); await hangCycle(); // 继续悬挂重试
    await advance(10_000); // 第 6 次守卫 → 再次探测 503 → 仍不重载
    expect(reload).not.toHaveBeenCalled();
    const probe = (globalThis.window as unknown as { __wtWs?: { reconnects: number } }).__wtWs;
    expect(probe?.reconnects ?? 0).toBeGreaterThanOrEqual(5); // 重连链未死
  });

  it('未恢复且文档可用时执行自愈重载', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    create();

    await advance(10_000); await advance(800);
    await advance(10_000); await advance(1_600);
    await advance(10_000); // 第 3 次守卫 → 探测 200(未恢复) → 重载
    await Promise.resolve();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
