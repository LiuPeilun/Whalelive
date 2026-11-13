import type { WebSocket, WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { ErrorCodes } from '../../../shared/errors.js';
import { isPlaybackReport } from '../../../shared/performance.js';
import { PROTOCOL_VERSION, type ClientRole, type StateSnapshot, type WsClientMessage, type WsServerMessage } from '../../../shared/protocol.js';
import type { EffectiveSettings } from '../../../shared/settings.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { PlaybackModule } from '../../modules/playback/index.js';
import type { createAccessControl } from '../auth.js';

// 浏览器连接、状态推送、播放回执(PROJECT_STRUCTURE《接口与页面路径》)。
// 升级前的 Host/Origin/回环检查在 app.ts 的升级路由完成;连接后必须在期限内完成 auth 握手。

type Conn = {
  ws: WebSocket;
  role: ClientRole | null;
  connectionId: string | null;
  rendererId: string | null;
  authTimer: ReturnType<typeof setTimeout> | null;
};

export type WsTransport = {
  attach(wss: WebSocketServer): void;
  broadcastState(): void;
  closeAll(): void;
};

export function createWsTransport(deps: {
  runId: string;
  access: ReturnType<typeof createAccessControl>;
  playback: PlaybackModule;
  stateSnapshot(): StateSnapshot;
  settings(): EffectiveSettings;
  /** 播放端登记时下发的待机素材描述(由 app.ts 结合角色清单生成)。 */
  idleInfo(): { url: string; loop: boolean; available: boolean } | null;
  logger: Logger;
  now(): number;
}): WsTransport {
  const conns = new Set<Conn>();

  function send(ws: WebSocket, message: WsServerMessage): boolean {
    if (ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function broadcastState(): void {
    const state = deps.stateSnapshot();
    for (const conn of conns) {
      if (conn.role !== null) send(conn.ws, { kind: 'state', state });
    }
  }

  function closeConn(conn: Conn, code: number, why: string): void {
    try {
      conn.ws.close(code, why);
    } catch {
      /* 已关闭 */
    }
  }

  function cleanup(conn: Conn): void {
    if (conn.authTimer) clearTimeout(conn.authTimer);
    conns.delete(conn);
    if (conn.rendererId) deps.playback.unregisterRenderer(conn.rendererId);
  }

  function handleAuth(conn: Conn, protocolVersion: number, role: ClientRole, credential: string): void {
    if (conn.role !== null) return; // 重复 auth 忽略
    if (protocolVersion !== PROTOCOL_VERSION) {
      send(conn.ws, { kind: 'auth-result', ok: false, code: ErrorCodes.PROTOCOL_VERSION_UNSUPPORTED });
      closeConn(conn, 4002, 'protocol-unsupported');
      return;
    }
    if (!deps.access.verify(credential, role)) {
      deps.logger.warn('ws.auth-rejected', { remote: 'credential-mismatch' });
      send(conn.ws, { kind: 'auth-result', ok: false, code: ErrorCodes.AUTH_REJECTED });
      closeConn(conn, 4001, 'auth-rejected');
      return;
    }
    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = null;
    }
    conn.role = role;
    conn.connectionId = `conn-${randomUUID().slice(0, 8)}`;
    deps.logger.info('ws.authenticated', { role, connectionId: conn.connectionId });
    send(conn.ws, { kind: 'auth-result', ok: true, connectionId: conn.connectionId, role, runId: deps.runId });
    send(conn.ws, { kind: 'state', state: deps.stateSnapshot() });
  }

  function handleMessage(conn: Conn, raw: unknown): void {
    let message: WsClientMessage;
    try {
      message = JSON.parse(String(raw)) as WsClientMessage;
    } catch {
      deps.logger.warn('ws.message-parse-failed', {});
      return;
    }
    if (conn.role === null) {
      // 待认证阶段只接受 auth
      if (typeof message === 'object' && message !== null && message.kind === 'auth') {
        handleAuth(conn, message.protocolVersion, message.role, message.credential);
      } else {
        closeConn(conn, 4001, 'auth-required');
      }
      return;
    }
    switch (message.kind) {
      case 'auth':
        return; // 已认证,重复 auth 忽略
      case 'ping':
        send(conn.ws, { kind: 'pong' });
        return;
      case 'renderer-register': {
        if (conn.role !== 'playback') return;
        conn.rendererId = `rnd-${randomUUID().slice(0, 8)}`;
        deps.playback.registerRenderer(conn.rendererId, (msg) => send(conn.ws, msg));
        send(conn.ws, { kind: 'renderer-registered', rendererId: conn.rendererId, idle: deps.idleInfo() });
        return;
      }
      case 'renderer-unregister': {
        if (conn.role !== 'playback' || !conn.rendererId) return;
        deps.playback.unregisterRenderer(conn.rendererId);
        conn.rendererId = null;
        return;
      }
      case 'lease-request': {
        if (conn.role !== 'playback' || !conn.rendererId) return;
        const result = deps.playback.requestLease(conn.rendererId);
        if (result.ok) {
          send(conn.ws, { kind: 'lease-result', ok: true, leaseId: result.leaseId, ttlMs: result.ttlMs, renewIntervalMs: result.renewIntervalMs });
        } else {
          const msg: WsServerMessage = { kind: 'lease-result', ok: false, code: result.code };
          send(conn.ws, msg);
        }
        return;
      }
      case 'lease-renew': {
        if (conn.role !== 'playback' || !conn.rendererId) return;
        if (deps.playback.renewLease(conn.rendererId, message.leaseId)) {
          send(conn.ws, { kind: 'lease-result', ok: true, leaseId: message.leaseId, ttlMs: deps.settings().lease.ttlMs, renewIntervalMs: deps.settings().lease.renewIntervalMs });
        } else {
          send(conn.ws, { kind: 'lease-result', ok: false, code: 'LEASE_EXPIRED' });
        }
        return;
      }
      case 'lease-release': {
        if (conn.role !== 'playback' || !conn.rendererId) return;
        deps.playback.releaseLease(conn.rendererId, message.leaseId);
        return;
      }
      case 'playback-report': {
        if (conn.role !== 'playback' || !conn.rendererId) return;
        if (!isPlaybackReport(message.report)) {
          deps.logger.warn('ws.report-invalid', {});
          return;
        }
        const report = message.report;
        if (report.runId !== deps.runId) {
          deps.logger.info('ws.report-stale-run', { performanceId: report.performanceId });
          return;
        }
        deps.playback.report(report, conn.rendererId);
        return;
      }
      default:
        return;
    }
  }

  function attach(wss: WebSocketServer): void {
    wss.on('connection', (ws: WebSocket) => {
      const conn: Conn = { ws, role: null, connectionId: null, rendererId: null, authTimer: null };
      conns.add(conn);
      conn.authTimer = setTimeout(() => {
        deps.logger.info('ws.auth-timeout', {});
        closeConn(conn, 4001, 'auth-timeout');
      }, deps.settings().auth.timeoutMs);
      ws.on('message', (data) => handleMessage(conn, data));
      ws.on('close', () => cleanup(conn));
      ws.on('error', () => cleanup(conn));
    });
  }

  function closeAll(): void {
    for (const conn of conns) {
      if (conn.authTimer) clearTimeout(conn.authTimer);
      try {
        conn.ws.close(1001, 'server-shutdown');
      } catch {
        /* 忽略 */
      }
    }
    conns.clear();
  }

  return { attach, broadcastState, closeAll };
}
