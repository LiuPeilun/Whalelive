import type { ClientRole, WsClientMessage, WsServerMessage } from '../../shared/protocol.js';
import { PROTOCOL_VERSION } from '../../shared/protocol.js';

// 两个页面共用的 WS 客户端:认证握手、断线自动重连与状态回调。
// 凭据来自 URL fragment(不随 HTTP 请求发送),页面关闭时自动释放。

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

  function send(message: WsClientMessage): boolean {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  function connect(): void {
    if (closedByUser) return;
    opts.onStatus('connecting');
    const socket = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`);
    ws = socket;
    socket.onopen = () => {
      retryMs = 800;
      opts.onStatus('connected');
      send({ kind: 'auth', protocolVersion: PROTOCOL_VERSION, role: opts.role, credential: opts.credential });
    };
    socket.onmessage = (event) => {
      try {
        opts.onMessage(JSON.parse(String(event.data)) as WsServerMessage);
      } catch {
        /* 忽略无法解析的消息 */
      }
    };
    const scheduleReconnect = () => {
      if (closedByUser) return;
      opts.onStatus('disconnected');
      const wait = retryMs;
      retryMs = Math.min(retryMs * 2, 5000);
      setTimeout(connect, wait);
    };
    socket.onclose = scheduleReconnect;
    socket.onerror = () => socket.close();
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
