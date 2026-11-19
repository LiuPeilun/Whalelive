import { describe, expect, it, vi } from 'vitest';
import { createBilibiliOpenClient, decodePackets, encodePacket, mapPushMessage, signHeaders, type BilibiliOpenHandle } from './bilibili-open.js';
import type { Logger } from '../../infrastructure/logger.js';

// P2 平台适配器:签名、事件映射(弹幕/礼物/大航海/SC)、ws 鉴权与 HTTP 心跳、
// 重连与停止语义。fetch 与 WebSocket 全部注入替身,不触网;生命周期测试用
// 真实短定时器轮询状态,不依赖 fake timers 与原生 AbortSignal 的交互。

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => silentLogger } as unknown as Logger;
const cfg = { appId: 1796120001, accessKeyId: 'id-x', accessKeySecret: 'secret-x', code: 'CODE-XYZ' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs = 3_000, step = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(step);
  }
}

type Handler = (a?: unknown) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: Buffer[] = [];
  closed = false;
  private handlers = new Map<string, Handler[]>();

  constructor(_url: string) {
    console.log('[debug] WS 构造器调用:', String(_url).slice(0, 40));
    FakeWebSocket.instances.push(this);
    console.log('[debug] WS 构造, instances.length =', FakeWebSocket.instances.length);
  }

  send(data: string): void {
    this.sent.push(typeof data === "string" ? Buffer.from(data) : data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  on(event: string, cb: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }

  /** 测试驱动:模拟握手完成(真实 WS 在握手成功后自动派发 open) */
  simulateOpen(): void {
    this.emit('open');
  }

  emit(event: string, a?: unknown): void {
    for (const cb of this.handlers.get(event) ?? []) cb(a);
  }
}

function makeClient(opts: {
  heartbeatIntervalMs?: number;
  reconnectDelayMs?: number;
  /** 动态开关:每次请求时读取,测试中可翻转以模拟"故障期间恢复" */
  failStart?: { value: boolean };
  onEvent?: (e: unknown) => void;
} = {}): { handle: BilibiliOpenHandle; clients: FakeWebSocket[]; calls: Array<{ url: string }>; opts: { failStart: { value: boolean } } } {
  const calls: Array<{ url: string }> = [];
  FakeWebSocket.instances = []; // 本场景实例从零开始
  const clients = FakeWebSocket.instances; // 构造器自动登记,直接引用同一数组
  const deps = {
    config: cfg,
    onEvent: opts.onEvent ?? vi.fn(),
    logger: silentLogger,
    now: () => 1_000,
    WebSocketImpl: FakeWebSocket as unknown as new (url: string) => FakeWebSocket,
    fetch: (async (url: string) => {
      console.log('[debug] fetch:', String(url).slice(-30));
      calls.push({ url: String(url) });
      if (String(url).includes('/app/start')) {
        if (opts.failStart?.value === true) return new Response('boom', { status: 500 });
        return new Response(JSON.stringify({ code: 0, data: { game_info: { game_id: 'game-1' }, websocket_info: { auth_body: '{"room_id":1796120001,"key":"k1"}', wss_link: ['wss://fake/open-live'] }, anchor_info: { room_id: 1796120001, uname: '主播' } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }) as unknown as typeof fetch,
  };
  if (opts.heartbeatIntervalMs !== undefined) {
    (deps as { wsHeartbeatMs?: number }).wsHeartbeatMs = opts.heartbeatIntervalMs;
    (deps as { projectHeartbeatMs?: number }).projectHeartbeatMs = opts.heartbeatIntervalMs;
  }
  if (opts.reconnectDelayMs !== undefined) (deps as { reconnectDelayMs?: number }).reconnectDelayMs = opts.reconnectDelayMs;
  const handle = createBilibiliOpenClient(deps);
  return { handle, clients, calls, opts: { failStart: opts.failStart ?? { value: false } } };
}

describe('签名(WT:开放平台)', () => {
  it('headers 含规范要求的字段,签名对 body 内容敏感', () => {
    const nonce = '3f2a9b8c-1111-4222-8333-9444aaaa5555';
    const h1 = signHeaders(cfg, '{"a":1}', 1_700_000_000_000, nonce);
    expect(h1['x-bili-content-md5']).toBeTruthy();
    expect(h1['x-bili-signature-method']).toBe('HMAC-SHA256');
    expect(h1['x-bili-signature-version']).toBe('1.0');
    expect(h1['x-bili-timestamp']).toBe('1700000000');
    expect(h1.authorization).toMatch(/^[0-9a-f]{64}$/);
    const h2 = signHeaders(cfg, '{"a":2}', 1_700_000_000_000, nonce);
    expect(h2['x-bili-content-md5']).not.toBe(h1['x-bili-content-md5']);
    expect(h2.authorization).not.toBe(h1.authorization); // body 变 → 签名变
  });
});

describe('推送消息映射(WT:事件契约)', () => {
  it('弹幕 → chat,sourceKey 含 msg_id(重连幂等)', () => {
    const e = mapPushMessage('LIVE_OPEN_PLATFORM_DM', { uid: 42, uname: '观众', msg: '你好', msg_id: 'm-1' }, 1_000);
    expect(e).toMatchObject({ source: 'bilibili-open', type: 'chat', text: '你好', sourceKey: 'dm-42-m-1' });
    expect(e?.user.name).toBe('观众');
  });

  it('礼物 → gift:quantity 取本次新增(gift_num),连击与瓜子单价随行', () => {
    const e = mapPushMessage('LIVE_OPEN_PLATFORM_SEND_GIFT', {
      uid: 7, uname: '投喂人', gift_id: '31036', gift_name: '小心心', gift_num: 3,
      combo_id: 'c-9', combo_num: 9, coin_type: 'gold', price: 100,
    }, 2_000);
    expect(e?.type).toBe('gift');
    expect(e?.gift).toMatchObject({ id: '31036', name: '小心心', quantity: 3, comboId: 'c-9', unitPrice: 1, priceUnit: '金瓜子' });
  });

  it('大航海与 SC 映射', () => {
    const g = mapPushMessage('LIVE_OPEN_PLATFORM_GUARD_BUY', { uid: 9, uname: '舰长甲', room_id: 1796120001 }, 3_000);
    expect(g?.type).toBe('guard');
    const sc = mapPushMessage('LIVE_OPEN_PLATFORM_SUPER_CHAT_MESSAGE', { uid: 9, uname: 'SC 甲', message: '你好', sc_id: 55 }, 3_000);
    expect(sc?.type).toBe('superchat');
    expect(sc?.text).toBe('你好');
  });

  it('enter/like/未知 cmd 返回 null(不投递,记日志)', () => {
    expect(mapPushMessage('LIVE_OPEN_PLATFORM_LIKE', { like_count: 3 }, 1_000)).toBeNull();
    expect(mapPushMessage('LIVE_OPEN_PLATFORM_USER_ENTER', { uid: 1, uname: 'x' }, 1_000)).toBeNull();
    expect(mapPushMessage('SOMETHING_NEW', { data: 1 }, 1_000)).toBeNull();
  });
});

describe('生命周期(WT:鉴权/心跳/停止/重连)', () => {
  it('start → app/start 签名请求 → ws 鉴权 → 心跳维持 → stop 停止心跳', async () => {
    const { handle, clients, calls } = makeClient({ heartbeatIntervalMs: 300 });
    handle.start();
    expect(await waitFor(() => clients.length === 1)).toBe(true);
    const ws = clients[0]!;
    // ws 不会自动 open(替身),显式模拟握手完成
    ws.simulateOpen();
    // 鉴权封包断言(二进制协议):operation=7,body=auth_body
    expect(await waitFor(() => ws.sent.length > 0)).toBe(true);
    const authPacket = decodePackets(ws.sent[0]!)[0]!;
    expect(authPacket.operation).toBe(7);
    expect(authPacket.body.toString()).toContain('room_id');
    expect(calls.some((c) => c.url.includes('/app/start'))).toBe(true);
    expect(handle.status().state).toBe('connected');
    // 心跳:等待 700ms 至少一次 HTTP 心跳
    expect(await waitFor(() => calls.some((c) => c.url.includes('/app/heartbeat')), 1_500)).toBe(true);
    const hbAtStop = calls.filter((c) => c.url.includes('/app/heartbeat')).length;
    handle.stop();
    expect(ws.closed).toBe(true);
    await sleep(700);
    expect(calls.filter((c) => c.url.includes('/app/heartbeat')).length).toBe(hbAtStop); // 停止后不再心跳
    expect(handle.status().state).toBe('disabled');
  });

  it('ws 关闭 → 重连(重新 app/start);stop 可打断', async () => {
    const { handle, clients } = makeClient({ reconnectDelayMs: 80 });
    handle.start();
    expect(await waitFor(() => clients.length === 1, 2_000)).toBe(true);
    clients[0]!.simulateOpen();
    clients[0]!.close(); // 模拟断线
    expect(await waitFor(() => clients.length === 2, 2_000)).toBe(true); // 退避 80ms 后重连
    handle.stop();
    expect(clients[1]?.closed).toBe(true);
  });

  it('app/start 失败 → 退避重试成功(断网场景,WT:断线恢复)', async () => {
    const failFlag = { value: true };
    const { handle, clients } = makeClient({ reconnectDelayMs: 60, failStart: failFlag });
    handle.start();
    expect(await waitFor(() => handle.status().state === 'reconnecting', 1_000)).toBe(true); // 首次失败进入退避
    failFlag.value = false; // 期间恢复
    expect(await waitFor(() => clients.length === 1, 3_000)).toBe(true); // 重试成功,ws 建立
    clients[0]!.simulateOpen(); // 握手完成
    expect(await waitFor(() => handle.status().state === 'connected', 1_000)).toBe(true);
    handle.stop();
  });
});

describe('推送进入事件管道(onEvent)', () => {
  it('收到弹幕推送时以标准 LiveEvent 通知', async () => {
    const onEvent = vi.fn();
    const { handle, clients } = makeClient({ onEvent });
    handle.start();
    expect(await waitFor(() => clients.length === 1, 2_000)).toBe(true);
    const ws = clients[0]!;
    ws.simulateOpen();
    // 推送封包:operation=5, 未压缩 JSON body
    ws.emit('message', encodePacket(5, 0, Buffer.from(JSON.stringify({
      cmd: 'LIVE_OPEN_PLATFORM_DM',
      data: { uid: 42, uname: '观众', msg: '你好', msg_id: 'm-9', room_id: 1796120001 },
    }))));
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({ type: 'chat', text: '你好', source: 'bilibili-open' });
    handle.stop();
  });
});
