// HTTP / WebSocket 消息与状态视图(浏览器可用)。连接注册、作用域与认证握手以本文为准。

export const PROTOCOL_VERSION = 1;

/** 业务 WebSocket 固定路径。 */
export const WS_PATH = '/ws';

/** Vite 热更新显式路径;服务端升级路由与 vite.config 复用同一常量。 */
export const VITE_HMR_PATH = '/__vite_hmr';

export type ClientRole = 'control' | 'playback';

// ---------- 客户端 → 服务端 ----------

export type WsClientMessage =
  | { kind: 'auth'; protocolVersion: number; role: ClientRole; credential: string }
  | { kind: 'renderer-register' }
  | { kind: 'renderer-unregister' }
  | { kind: 'lease-request' }
  | { kind: 'lease-renew'; leaseId: string }
  | { kind: 'lease-release'; leaseId: string }
  | { kind: 'playback-report'; report: unknown }
  | { kind: 'ping' };

// ---------- 服务端 → 客户端 ----------

export type WsAuthResult =
  | { kind: 'auth-result'; ok: true; connectionId: string; role: ClientRole; runId: string }
  | { kind: 'auth-result'; ok: false; code: string };

export type WsLeaseResult =
  | { kind: 'lease-result'; ok: true; leaseId: string; ttlMs: number; renewIntervalMs: number }
  | { kind: 'lease-result'; ok: false; code: string; retryAfterMs?: number };

export type WsServerMessage =
  | WsAuthResult
  | WsLeaseResult
  | { kind: 'state'; state: StateSnapshot }
  | { kind: 'renderer-registered'; rendererId: string; idle: { url: string; loop: boolean; available: boolean } | null }
  | { kind: 'performance'; dispatch: import('./performance.js').PerformanceDispatch }
  | { kind: 'stop'; runId: string; performanceId: string | null }
  | { kind: 'pong' };

// ---------- 状态快照(脱敏,页面渲染依据) ----------

export type QueueItemView = {
  eventId: string;
  type: string;
  priority: number;
  enqueuedAt: number;
  sayPreview: string;
};

export type DropRecordView = {
  eventId: string;
  reason: string;
  at: number;
};

export type TaskView = {
  eventId: string;
  performanceId: string | null;
  stage: 'waiting' | 'dispatching' | 'waiting-playback';
  say: string;
  action: string;
  since: number;
};

export type PlaybackView = {
  status: 'idle' | 'dispatching' | 'playing' | 'stopping';
  performanceId: string | null;
  action: string | null;
};

export type RenderersView = {
  count: number;
  primaryRendererId: string | null;
  leaseHolderRendererId: string | null;
  leaseExpiresAt: number | null;
};

export type StateSnapshot = {
  runId: string;
  startedAt: number;
  paused: boolean;
  platform: string;
  petId: string;
  queue: {
    capacity: number;
    length: number;
    items: QueueItemView[];
    dropped: DropRecordView[];
  };
  current: TaskView | null;
  playback: PlaybackView;
  renderers: RenderersView;
  settingsVersion: number;
  serverTime: number;
};
