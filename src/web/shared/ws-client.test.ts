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
