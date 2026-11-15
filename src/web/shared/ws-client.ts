import type { ClientRole, WsClientMessage, WsServerMessage } from '../../shared/protocol.js';
import { PROTOCOL_VERSION } from '../../shared/protocol.js';

// 两个页面共用的 WS 客户端:认证握手、断线自动重连与状态回调。
// 凭据来自 URL fragment(不随 HTTP 请求发送),页面关闭时自动释放。
// 重连链必须永不中断:状态回调与构造异常都被捕获并计入探针(window.__wtWs),
// 供断线重连类问题(WT-P0-010)实测观察。

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

export type WsClientHandle = {
  send(message: WsClientMessage): boolean;
  close(): void;
};

export function readCredentialFromHash(): string | null {
  const raw = window.location.hash.replace(/^#/, '').trim();
  return raw.length > 0 ? raw : null;
}

export function createWsClient(opts: {
  role: ClientRole;
  credential: string;
  onMessage(message: WsServerMessage): void;
  onStatus(status: WsStatus): void;
}): WsClientHandle {
  let ws: WebSocket | null = null;
  let closedByUser = false;
  let retryMs = 800;
  let reconnects = 0;

  // 页面可观测探针(诊断用,不含敏感信息)
  const probe = { status: 'connecting' as WsStatus, reconnects: 0, lastError: null as string | null };
  (window as unknown as { __wtWs?: typeof probe }).__wtWs = probe;

  function send(message: WsClientMessage): boolean {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  let connectSeq = 0; // 连接会话编号:守卫超时与事件的归属判定,防双重重连循环

  function scheduleReconnect(): void {
    if (closedByUser) return;
    probe.status = 'disconnected';
    probe.reconnects = reconnects;
    try {
      opts.onStatus('disconnected');
    } catch (err) {
      // 回调异常不得中断重连链
      probe.lastError = `onStatus: ${String(err)}`;
    }
    const wait = retryMs;
    retryMs = Math.min(retryMs * 2, 5000);
    setTimeout(connect, wait);
  }

  function connect(): void {
    if (closedByUser) return;
    const myId = ++connectSeq;
    let socket: WebSocket;
    try {
      probe.status = 'connecting';
      opts.onStatus('connecting');
      socket = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`);
    } catch (err) {
      probe.lastError = `construct: ${String(err)}`;
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.onopen = () => {
      clearTimeout(guard);
      if (connectSeq !== myId) return;
      retryMs = 800;
      probe.status = 'connected';
      opts.onStatus('connected');
      send({ kind: 'auth', protocolVersion: PROTOCOL_VERSION, role: opts.role, credential: opts.credential });
    };
    socket.onmessage = (event) => {
      try {
        opts.onMessage(JSON.parse(String(event.data)) as WsServerMessage);
      } catch (err) {
        // 消息处理异常不得影响连接与后续消息
        probe.lastError = `onMessage: ${String(err)}`;
      }
    };
    socket.onclose = () => {
      clearTimeout(guard);
      if (connectSeq !== myId) return;
      reconnects += 1;
      scheduleReconnect();
    };
    socket.onerror = () => {
      // 仅记录;CONNECTING 状态主动 close() 会吞掉后续 close 事件,
      // 连接失败时浏览器会自行派发 error + close(WT-P0-010 重连链死亡根因)
      probe.lastError = 'socket-error';
    };
    // 悬挂守卫:CONNECTING 超过 10 秒(半开网络等)按失败处理并重排
    const guard = setTimeout(() => {
      if (connectSeq !== myId) return;
      if (socket.readyState === WebSocket.CONNECTING) {
        try {
          socket.close();
        } catch {
          /* 忽略 */
        }
        probe.lastError = 'connecting-timeout';
        reconnects += 1;
        scheduleReconnect();
      }
    }, 10_000);
  }

  connect();

  return {
    send,
    close() {
      closedByUser = true;
      try {
        ws?.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}

export async function apiFetch(path: string, credential: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  // 仅在确有请求体时声明 JSON Content-Type:空 POST 带 JSON 头会被 Fastify 按
  // 空请求体拒绝(FST_ERR_CTP_EMPTY_JSON_BODY),暂停/恢复/停止均为无体 POST。
  const headers: Record<string, string> = { authorization: `Bearer ${credential}` };
  if (init?.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers ?? {}),
    },
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}
