import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { LiveEvent } from '../../../shared/live-event.js';
import type { Logger } from '../../infrastructure/logger.js';

// P2 平台适配器:B 站创作开放平台(open-live)「互动玩法」官方二进制协议。
// 流程(参考官方 .NET SDK 与开源实现,协议细节经源码核对):
//   1. POST /v2/app/start (签名头,body {code: 主播身份码, app_id})
//      → data.game_info.game_id / data.websocket_info.{auth_body, wss_link[]}
//      / data.anchor_info.room_id
//   2. WebSocket 连接 wss_link[0],发送鉴权封包(operation=7, body=auth_body)
//   3. ws 心跳封包(operation=2, 无 body) 每 30s;HTTP /v2/app/heartbeat
//      (body {game_id}) 每 20s 维持项目会话
//   4. 推送封包(operation=5, 未压缩 JSON):按 cmd 映射为标准 LiveEvent
// 封包格式:16 字节头(长度4/头长4/协议版本2/操作码4/序列号4,大端) + body。
// 断线自动重连(指数退避);密钥与身份码只在本模块与 env 中流转,不入日志。

const OPEN_LIVE_HOST = 'https://live-open.biliapi.com';
const WS_HEARTBEAT_MS = 30_000;
const PROJECT_HEARTBEAT_MS = 20_000;
const RECONNECT_MAX_MS = 60_000;
const HEADER_LENGTH = 16;

const OP_HEARTBEAT = 2;
const OP_SERVER_NOTIFY = 5;
const OP_AUTHORITY = 7;
const PV_HEARTBEAT = 1;
const PV_UNCOMPRESSED = 0;

export type BilibiliOpenConfig = {
  appId: number;
  accessKeyId: string;
  accessKeySecret: string;
  /** 主播身份码:主播在开放平台生成的互动玩法身份码(本人直播间测试亦需要)。 */
  code: string;
};

export type PlatformStatus = {
  state: 'disabled' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  appId: number | null;
  roomId: number | null;
  gameId: string | null;
  lastError: string | null;
  lastEventAt: number | null;
};

export type BilibiliOpenHandle = {
  start(): void;
  stop(): void;
  status(): PlatformStatus;
};

type WsLike = {
  send(data: Buffer | string): void;
  close(): void;
  on(event: 'open' | 'close' | 'error', cb: (err?: Error) => void): void;
  on(event: 'message', cb: (data: Buffer) => void): void;
};

type PushMessage = { cmd?: string; data?: Record<string, unknown> } & Record<string, unknown>;

/** 官方签名:x-bili-* 头按字典序 "key:value\n" 拼接,HMAC-SHA256(secret) hex 放 authorization。 */
export function signHeaders(cfg: BilibiliOpenConfig, rawBody: string, nowMs: number, nonce = randomUUID()): Record<string, string> {
  const contentMd5 = createHash('md5').update(rawBody).digest('hex');
  const timestamp = Math.floor(nowMs / 1000).toString();
  const pairs: Array<[string, string]> = [
    ['x-bili-accesskeyid', cfg.accessKeyId],
    ['x-bili-content-md5', contentMd5],
    ['x-bili-signature-method', 'HMAC-SHA256'],
    ['x-bili-signature-nonce', nonce],
    ['x-bili-signature-version', '1.0'],
    ['x-bili-timestamp', timestamp],
  ].map((p) => [p[0], p[1]] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signingString = pairs.map(([k, v]) => `${k}:${v}\n`).join('');
  const signature = createHmac('sha256', cfg.accessKeySecret).update(signingString).digest('hex');
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: signature,
  };
  for (const [k, v] of pairs) headers[k] = v;
  return headers;
}

/** 封包编码:16 字节大端头 + body */
export function encodePacket(operation: number, protocolVersion: number, body?: Buffer): Buffer {
  const bodyLen = body?.length ?? 0;
  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt32BE(HEADER_LENGTH + bodyLen, 0);
  header.writeUInt16BE(HEADER_LENGTH, 4);
  header.writeUInt16BE(protocolVersion, 6);
  header.writeUInt32BE(operation, 8);
  header.writeUInt32BE(1, 12); // sequenceId
  return body ? Buffer.concat([header, body]) : header;
}

/** 从一帧数据解析出封包列表(一帧可能含多个子包) */
export function decodePackets(frame: Buffer): Array<{ operation: number; protocolVersion: number; body: Buffer }> {
  const out: Array<{ operation: number; protocolVersion: number; body: Buffer }> = [];
  let offset = 0;
  while (offset + HEADER_LENGTH <= frame.length) {
    const packetLength = frame.readUInt32BE(offset);
    const headerLength = frame.readUInt16BE(offset + 4);
    const protocolVersion = frame.readUInt16BE(offset + 6);
    const operation = frame.readUInt32BE(offset + 8);
    const bodyEnd = Math.min(packetLength, frame.length - offset);
    const body = frame.subarray(offset + headerLength, offset + bodyEnd);
    out.push({ operation, protocolVersion, body });
    offset += packetLength;
  }
  return out;
}

/** 普通弹幕/礼物/大航海/SC 推送 → 标准 LiveEvent;不支持的消息返回 null */
export function mapPushMessage(cmd: string, data: Record<string, unknown>, nowMs: number): LiveEvent | null {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const roomId = num(data.room_id).toString();
  switch (cmd) {
    case 'LIVE_OPEN_PLATFORM_DM': {
      const uid = num(data.uid);
      const uname = str(data.uname);
      const msg = str(data.msg);
      const msgId = str(data.msg_id);
      if (uid === 0 || uname === '' || msg === '' || msgId === '') return null;
      return {
        id: `evt-${msgId}`,
        sourceKey: `dm-${uid}-${msgId}`,
        source: 'bilibili-open',
        roomId: roomId || 'open-live',
        type: 'chat',
        user: { id: String(uid), name: uname },
        text: msg,
        receivedAt: nowMs,
      };
    }
    case 'LIVE_OPEN_PLATFORM_SEND_GIFT': {
      const uid = num(data.uid);
      const uname = str(data.uname);
      const giftId = str(data.gift_id);
      const giftName = str(data.gift_name);
      const quantity = num(data.gift_num); // 本次新增数量;连击累计为 combo_num,由 events 去重链路处理
      if (uid === 0 || uname === '' || giftId === '' || giftName === '' || quantity < 1) return null;
      const coinType = str(data.coin_type);
      const price = num(data.price); // 单价(以 0.01 元/瓜子为单位)
      const comboId = str(data.combo_id);
      return {
        id: `evt-${randomUUID().slice(0, 8)}`,
        sourceKey: `gift-${uid}-${giftId}-${num(data.combo_num)}-${num(data.timestamp) || nowMs}`,
        source: 'bilibili-open',
        roomId: roomId || 'open-live',
        type: 'gift',
        user: { id: String(uid), name: uname },
        gift: {
          id: giftId,
          name: giftName,
          quantity,
          ...(comboId !== '' ? { comboId } : {}),
          ...(coinType !== '' ? { coinType } : {}),
          ...(price > 0 ? { unitPrice: price / 100, priceUnit: coinType === 'gold' ? '金瓜子' : '银瓜子' } : {}),
        },
        receivedAt: nowMs,
      };
    }
    case 'LIVE_OPEN_PLATFORM_GUARD_BUY': {
      const uid = num(data.uid);
      const uname = str(data.uname);
      if (uid === 0 || uname === '') return null;
      return {
        id: `evt-${randomUUID().slice(0, 8)}`,
        sourceKey: `guard-${uid}-${num(data.start_time) || nowMs}`,
        source: 'bilibili-open',
        roomId: roomId || 'open-live',
        type: 'guard',
        user: { id: String(uid), name: uname },
        receivedAt: nowMs,
      };
    }
    case 'LIVE_OPEN_PLATFORM_SUPER_CHAT_MESSAGE': {
      const uid = num(data.uid);
      const uname = str(data.uname);
      const msg = str(data.message);
      if (uid === 0 || uname === '' || msg === '') return null;
      return {
        id: `evt-${randomUUID().slice(0, 8)}`,
        sourceKey: `sc-${uid}-${num(data.sc_id) || nowMs}`,
        source: 'bilibili-open',
        roomId: roomId || 'open-live',
        type: 'superchat',
        user: { id: String(uid), name: uname },
        text: msg,
        receivedAt: nowMs,
      };
    }
    default:
      return null;
  }
}

export function createBilibiliOpenClient(deps: {
  config: BilibiliOpenConfig;
  onEvent(event: LiveEvent): void;
  logger: Logger;
  now(): number;
  /** 注入 WebSocket 构造器(测试用);默认全局 WebSocket */
  WebSocketImpl?: unknown;
  fetch?: typeof fetch;
  /** ws 心跳间隔(默认 30s;测试可注入短值) */
  wsHeartbeatMs?: number;
  /** 项目心跳间隔(默认 20s;测试可注入短值) */
  projectHeartbeatMs?: number;
  /** 重连退避起始延迟(默认 1s;测试可注入短值) */
  reconnectDelayMs?: number;
}): BilibiliOpenHandle {
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const WS = (deps.WebSocketImpl ?? WebSocket) as unknown as new (url: string) => WsLike;
  const wsHeartbeatMs = deps.wsHeartbeatMs ?? WS_HEARTBEAT_MS;
  const projectHeartbeatMs = deps.projectHeartbeatMs ?? PROJECT_HEARTBEAT_MS;
  const reconnectBase = deps.reconnectDelayMs ?? 1_000;

  let status: PlatformStatus = { state: 'disabled', appId: null, roomId: null, gameId: null, lastError: null, lastEventAt: null };
  let stopped = false;
  let ws: WsLike | null = null;
  let wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let projectHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = reconnectBase;
  const buvid = randomUUID();

  function setStatus(patch: Partial<PlatformStatus>): void {
    status = { ...status, ...patch };
  }

  function abortPromise(signal: AbortSignal): Promise<never> {
    return new Promise((_, reject) => {
      const rejectWith = () => reject(signal.reason instanceof Error ? signal.reason : new Error('等待被取消'));
      if (signal.aborted) {
        rejectWith();
        return;
      }
      signal.addEventListener('abort', rejectWith, { once: true });
    });
  }

  async function signedPost(pathname: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const raw = JSON.stringify(body);
    const headers = signHeaders(deps.config, raw, deps.now());
    const response = await doFetch(`${OPEN_LIVE_HOST}${pathname}`, {
      method: 'POST',
      headers,
      body: raw,
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await response.json()) as { code?: number; message?: string; data?: Record<string, unknown> };
    if (!response.ok || json.code !== 0) {
      throw new Error(`${pathname} 失败: code=${json.code ?? response.status} ${json.message ?? ''}`.trim());
    }
    return json.data ?? {};
  }

  function clearTimers(): void {
    if (wsHeartbeatTimer !== null) { clearInterval(wsHeartbeatTimer); wsHeartbeatTimer = null; }
    if (projectHeartbeatTimer !== null) { clearInterval(projectHeartbeatTimer); projectHeartbeatTimer = null; }
  }

  async function connectOnce(): Promise<void> {
    setStatus({ state: 'connecting' });
    const signal = AbortSignal.timeout(10_000);
    const data = (await Promise.race([signedPost('/v2/app/start', { code: deps.config.code, app_id: deps.config.appId }), abortPromise(signal)])) as {
      websocket_info?: { wss_link?: unknown[]; auth_body?: unknown };
      game_info?: { game_id?: unknown };
      anchor_info?: { room_id?: unknown };
    };
    const wssLinks = (data.websocket_info?.wss_link ?? []) as unknown[];
    const authBody = String(data.websocket_info?.auth_body ?? '');
    const gameId = String(data.game_info?.game_id ?? '');
    const roomId = numOrNull(data.anchor_info?.room_id);
    if (wssLinks.length === 0 || authBody === '' || gameId === '') {
      throw new Error('app/start 返回缺少 wss_link/auth_body/game_id');
    }
    setStatus({ appId: deps.config.appId, roomId, gameId });

    const socket = new WS(String(wssLinks[0]));
    ws = socket;
    socket.on('open', () => {
      // 鉴权封包:operation=7, protocolVersion=1, body=auth_body
      socket.send(encodePacket(OP_AUTHORITY, PV_HEARTBEAT, Buffer.from(authBody)));
      setStatus({ state: 'connected', lastError: null });
      reconnectDelay = reconnectBase;
      // ws 心跳:30s 一次空 body 封包(operation=2)
      if (wsHeartbeatTimer === null) {
        wsHeartbeatTimer = setInterval(() => {
          try { socket.send(encodePacket(OP_HEARTBEAT, PV_HEARTBEAT)); } catch { /* 关闭中 */ }
        }, wsHeartbeatMs);
      }
      // 项目心跳:HTTP,20s 一次
      if (projectHeartbeatTimer === null) {
        projectHeartbeatTimer = setInterval(() => {
          signedPost('/v2/app/heartbeat', { game_id: gameId }).catch((err) => {
            deps.logger.warn('bilibili.open-heartbeat-failed', { error: String(err) });
          });
        }, projectHeartbeatMs);
      }
    });
    socket.on('message', (frame: Buffer) => {
      try {
        for (const packet of decodePackets(frame)) {
          if (packet.operation === OP_SERVER_NOTIFY && packet.protocolVersion === PV_UNCOMPRESSED) {
            const msg = JSON.parse(packet.body.toString('utf8')) as PushMessage;
            const cmd = typeof msg.cmd === 'string' ? msg.cmd : '';
            const event = mapPushMessage(cmd, msg.data ?? {}, deps.now());
            if (event !== null) {
              setStatus({ lastEventAt: deps.now() });
              deps.onEvent(event);
            } else if (cmd !== '' && cmd !== 'LIVE_OPEN_PLATFORM_LIKE' && cmd !== 'LIVE_OPEN_PLATFORM_USER_ENTER') {
              deps.logger.debug('bilibili.open-unmapped', { cmd });
            }
          }
        }
      } catch (err) {
        deps.logger.warn('bilibili.open-parse-error', { error: String(err) });
      }
    });
    socket.on('error', (err) => {
      setStatus({ lastError: err?.message ?? 'socket error' });
      deps.logger.warn('bilibili.open-socket-error', { error: String(err) });
    });
    socket.on('close', () => {
      clearTimers();
      ws = null;
      if (stopped) return;
      scheduleReconnect();
    });
  }

  function numOrNull(v: unknown): number | null {
    const n = typeof v === 'number' ? Math.trunc(v) : Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    setStatus({ state: 'reconnecting' });
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectOnce().catch((err) => {
        deps.logger.warn('bilibili.open-reconnect-failed', { error: String(err), nextRetryMs: reconnectDelay });
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
        scheduleReconnect();
      });
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  return {
    start() {
      stopped = false;
      setStatus({ state: 'connecting' });
      connectOnce().catch((err) => {
        setStatus({ state: 'error', lastError: String(err) });
        deps.logger.warn('bilibili.open-start-failed', { error: String(err) });
        scheduleReconnect();
      });
    },
    stop() {
      stopped = true;
      clearTimers();
      if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { ws?.close(); } catch { /* 已关闭 */ }
      ws = null;
      setStatus({ state: 'disabled' });
    },
    status() {
      return { ...status };
    },
  };
}
