import type { WsServerMessage } from '../../../shared/protocol.js';
import type { Logger } from '../../infrastructure/logger.js';

// 主播放端租约与失效处理(PROJECT_STRUCTURE《模块职责》)。
// 同一时刻至多一个有效租约;过期或释放后新端才可接管,防止多端重复发声。

export type RendererHandle = {
  rendererId: string;
  send(message: WsServerMessage): boolean;
  connectedAt: number;
};

type Lease = {
  leaseId: string;
  rendererId: string;
  grantedAt: number;
  expiresAt: number;
};

export type LeaseRequestResult =
  | { ok: true; leaseId: string; ttlMs: number }
  | { ok: false; code: 'LEASE_HELD' | 'RENDERER_UNKNOWN'; retryAfterMs: number };

let leaseSeq = 0;

export function createRendererRegistry(deps: { leaseTtlMs(): number; renewIntervalMs(): number; now(): number; logger: Logger }) {
  const renderers = new Map<string, RendererHandle>();
  let lease: Lease | null = null;

  function register(rendererId: string, send: RendererHandle['send']): void {
    renderers.set(rendererId, { rendererId, send, connectedAt: deps.now() });
  }

  function unregister(rendererId: string): void {
    renderers.delete(rendererId);
    if (lease?.rendererId === rendererId) {
      deps.logger.info('playback.lease-released-by-disconnect', { rendererId, leaseId: lease.leaseId });
      lease = null;
    }
  }

  /** 派发目标:优先租约持有者,否则取最近注册的在线播放端。 */
  function primaryTarget(): RendererHandle | null {
    if (lease && renderers.has(lease.rendererId)) {
      return renderers.get(lease.rendererId) ?? null;
    }
    let latest: RendererHandle | null = null;
    for (const r of renderers.values()) {
      if (latest === null || r.connectedAt >= latest.connectedAt) latest = r;
    }
    return latest;
  }

  function requestLease(rendererId: string): LeaseRequestResult {
    const ttlMs = deps.leaseTtlMs();
    const now = deps.now();
    if (!renderers.has(rendererId)) {
      return { ok: false, code: 'RENDERER_UNKNOWN', retryAfterMs: 1_000 };
    }
    if (lease) {
      if (lease.rendererId === rendererId) {
        lease.expiresAt = now + ttlMs; // 幂等续期
        return { ok: true, leaseId: lease.leaseId, ttlMs };
      }
      if (lease.expiresAt > now) {
        const retryAfterMs = Math.max(200, lease.expiresAt - now);
        return { ok: false, code: 'LEASE_HELD', retryAfterMs };
      }
      deps.logger.info('playback.lease-expired-takeover', { old: lease.rendererId, leaseId: lease.leaseId });
    }
    leaseSeq += 1;
    lease = { leaseId: `lease-${leaseSeq}-${Math.random().toString(36).slice(2, 8)}`, rendererId, grantedAt: now, expiresAt: now + ttlMs };
    deps.logger.info('playback.lease-granted', { rendererId, leaseId: lease.leaseId, ttlMs });
    return { ok: true, leaseId: lease.leaseId, ttlMs };
  }

  function renewLease(rendererId: string, leaseId: string): boolean {
    if (!lease || lease.leaseId !== leaseId || lease.rendererId !== rendererId) return false;
    lease.expiresAt = deps.now() + deps.leaseTtlMs();
    return true;
  }

  function releaseLease(rendererId: string, leaseId: string): boolean {
    if (!lease || lease.leaseId !== leaseId || lease.rendererId !== rendererId) return false;
    lease = null;
    deps.logger.info('playback.lease-released', { rendererId, leaseId });
    return true;
  }

  /** 租约过期回收;由调度循环周期调用。 */
  function sweep(): void {
    if (lease && lease.expiresAt <= deps.now()) {
      deps.logger.info('playback.lease-expired', { rendererId: lease.rendererId, leaseId: lease.leaseId });
      lease = null;
    }
  }

  function send(rendererId: string, message: WsServerMessage): boolean {
    const handle = renderers.get(rendererId);
    if (!handle) return false;
    try {
      return handle.send(message);
    } catch (err) {
      deps.logger.warn('playback.renderer-send-failed', { rendererId, error: String(err) });
      return false;
    }
  }

  function leaseView(): { holderRendererId: string | null; leaseId: string | null; expiresAt: number | null } {
    if (!lease) return { holderRendererId: null, leaseId: null, expiresAt: null };
    return { holderRendererId: lease.rendererId, leaseId: lease.leaseId, expiresAt: lease.expiresAt };
  }

  function count(): number {
    return renderers.size;
  }

  return { register, unregister, primaryTarget, requestLease, renewLease, releaseLease, sweep, send, leaseView, count };
}
