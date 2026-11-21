import { createHash, createHmac, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
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
const OP_HEARTBEAT_REPLY = 3;
const OP_SERVER_NOTIFY = 5;
const OP_AUTHORITY = 7;
const OP_AUTHORITY_REPLY = 8;
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
  const signingString = pairs.map(([k, v]) => `${k}:${v}`).join('\n');
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
  // 开放平台隐私口径:uid 恒为 0,用户标识用 open_id;旧字段 uid 仅作回退
  const uidOf = (): { id: string; ok: boolean } => {
    const openId = str(data.open_id);
    const uid = num(data.uid);
    if (openId !== '') return { id: openId, ok: true };
    return { id: String(uid), ok: uid !== 0 };
  };
  // 官方 SC/GUARD 推送的用户信息在 user_info 对象内(WT-P2-005);旧格式为顶层字段,两者兼容。
  const userOf = (d: Record<string, unknown>): { id: string; name: string; ok: boolean } => {
    const ui = (typeof d.user_info === 'object' && d.user_info !== null ? d.user_info : {}) as Record<string, unknown>;
    const name = str(ui.uname) || str(d.uname);
    const openId = str(ui.open_id) || str(d.open_id);
    const uid = num(ui.uid) || num(d.uid);
    if (openId !== '') return { id: openId, name, ok: name !== '' };
    return { id: String(uid), name, ok: name !== '' && uid !== 0 };
  };
  switch (cmd) {
    case 'LIVE_OPEN_PLATFORM_DM': {
      const { id: userId, ok } = uidOf();
      const uname = str(data.uname);
      const msg = str(data.msg);
      const msgId = str(data.msg_id);
      if (!ok || uname === '' || msg === '' || msgId === '') return null;
      return {
        id: `evt-${msgId}`,
        sourceKey: `dm-${userId}-${msgId}`,
        source: 'bilibili-open',
        roomId: roomId || 'open-live',
        type: 'chat',
        user: { id: userId, name: uname },
        text: msg,
        receivedAt: nowMs,
      };
    }
    case 'LIVE_OPEN_PLATFORM_SEND_GIFT': {
      // 官方口径(WT-P2-004):gift_id 为数字;paid 表示是否付费;r_price 为实际价值,
      // price 为标价或盲盒爆出价值,金额单位 1000 = 1 元;msg_id 标识每条消息;连击在 combo_info 对象内。
      const { id: userId, ok } = uidOf();
      const uname = str(data.uname);
      const giftIdRaw = data.gift_id;
      const giftId = typeof giftIdRaw === 'number' && Number.isFinite(giftIdRaw) ? String(giftIdRaw) : str(giftIdRaw);
      const giftName = str(data.gift_name);
      const quantity = num(data.gift_num); // 本次新增数量;连击累计在 combo_info.combo_num,由 events 去重链路处理
      if (!ok || uname === '' || giftId === '' || giftName === '' || quantity < 1) return null;
      const combo = (typeof data.combo_info === 'object' && data.combo_info !== null ? data.combo_info : {}) as Record<string, unknown>;
      const comboId = str(combo.combo_id) || str(data.combo_id);
      // 实付口径:paid=true 且有实际价值(r_price)才计价;仅有标价/爆出价值(price)属于现金实付未确认,
      // 保留普通感谢不计金额(盲盒的两种价格官方均解释为爆出物价值)。
      const paid = data.paid === true;
      const rPrice = num(data.r_price);
      const paidMilliYuan = paid && rPrice > 0 ? rPrice : undefined;
      const msgId = str(data.msg_id);
      return {
        id: `evt-${msgId !== '' ? msgId : randomUUID().slice(0, 8)}`,
        // 去重键带 msg_id:同用户同礼物同秒的不同消息不互斥;同 msg_id 重推保持幂等。
        sourceKey: msgId !== ''
          ? `gift-${userId}-${giftId}-${msgId}`
          : `gift-${userId}-${giftId}-${num(data.combo_num)}-${num(data.timestamp) || nowMs}`,
        source: 'bilibili-open',
        roomId: roomId || 'open-live',
        type: 'gift',
        user: { id: userId, name: uname },
        gift: {
          id: giftId,
          name: giftName,
          quantity,
          ...(comboId !== '' ? { comboId } : {}),
          ...(paidMilliYuan !== undefined ? { paidMilliYuan } : {}),
        },
        receivedAt: nowMs,
      };
    }
    // 大航海:官方命令为 LIVE_OPEN_PLATFORM_GUARD,用户信息在 user_info 对象内(WT-P2-005);
    // 旧命令 LIVE_OPEN_PLATFORM_GUARD_BUY 与顶层用户字段作为已存在格式保留。
    case 'LIVE_OPEN_PLATFORM_GUARD':
    case 'LIVE_OPEN_PLATFORM_GUARD_BUY': {
      const user = userOf(data);
      if (!user.ok) return null;
      const msgId = str(data.msg_id);
      return {
        id: `evt-${msgId !== '' ? msgId : randomUUID().slice(0, 8)}`,
        sourceKey: `guard-${user.id}-${msgId !== '' ? msgId : `${num(data.start_time) || nowMs}`}`,
        source: 'bilibili-open',
        roomId: roomId || 'open-live',
        type: 'guard',
        user: { id: user.id, name: user.name },
        receivedAt: nowMs,
      };
    }
    // 醒目留言:官方命令为 LIVE_OPEN_PLATFORM_SUPER_CHAT(message_id/msg_id 标识,WT-P2-005);
    // 旧命令 LIVE_OPEN_PLATFORM_SUPER_CHAT_MESSAGE 作为已存在格式保留。
    case 'LIVE_OPEN_PLATFORM_SUPER_CHAT':
    case 'LIVE_OPEN_PLATFORM_SUPER_CHAT_MESSAGE': {
      const user = userOf(data);
      const msg = str(data.message);
      if (!user.ok || msg === '') return null;
      const msgId = str(data.msg_id) || str(data.message_id);
      return {
        id: `evt-${msgId !== '' ? msgId : randomUUID().slice(0, 8)}`,
        sourceKey: `sc-${user.id}-${msgId !== '' ? msgId : `${num(data.sc_id) || num(data.start_time) || nowMs}`}`,
        source: 'bilibili-open',
        roomId: roomId || 'open-live',
        type: 'superchat',
        user: { id: user.id, name: user.name },
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
          // 诊断:记录每个入站封包(op/pv/body 摘要),鉴权回包(op=8)与压缩推送(pv!=0)靠它可见
          if (packet.operation === OP_SERVER_NOTIFY && packet.protocolVersion === PV_UNCOMPRESSED) {
            deps.logger.info('bilibili.open-push', { bodyLen: packet.body.length, body: packet.body.toString('utf8').slice(0, 700) });
          } else if (packet.operation === OP_HEARTBEAT_REPLY) {
            deps.logger.info('bilibili.open-packet', { op: packet.operation, pv: packet.protocolVersion });
          } else {
            deps.logger.info('bilibili.open-packet', { op: packet.operation, pv: packet.protocolVersion, head: packet.body.toString('utf8').slice(0, 120) });
          }
          if (packet.operation === OP_SERVER_NOTIFY && packet.protocolVersion === PV_UNCOMPRESSED) {
            const msg = JSON.parse(packet.body.toString('utf8')) as PushMessage;
            const cmd = typeof msg.cmd === 'string' ? msg.cmd : '';
            const event = mapPushMessage(cmd, msg.data ?? {}, deps.now());
            if (event !== null) {
              setStatus({ lastEventAt: deps.now() });
              deps.onEvent(event);
            } else if (cmd !== '' && cmd !== 'LIVE_OPEN_PLATFORM_LIKE' && cmd !== 'LIVE_OPEN_PLATFORM_USER_ENTER') {
              deps.logger.warn('bilibili.open-unmapped', { cmd });
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
      // 正常结束游戏会话(7002 房间重复游戏的预防:会话绑定房间+app,不 end 则需等 60s 过期)
      const gameId = String(status.gameId ?? '');
      if (gameId !== '') {
        signedPost('/v2/app/end', { game_id: gameId }).catch((err) => {
          deps.logger.warn('bilibili.open-end-failed', { error: String(err) });
        });
      }
    },
    status() {
      return { ...status };
    },
  };
}
