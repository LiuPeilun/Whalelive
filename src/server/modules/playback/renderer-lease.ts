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

export function createRendererRegistry(deps: { leaseTtlMs(): number; renewIntervalMs(): number; takeoverSafetyMs(): number; now(): number; logger: Logger }) {
  const renderers = new Map<string, RendererHandle>();
  let lease: Lease | null = null;
  // 定时回收清除 lease 后仍保留的接管期限(WT-P1-004):sweep 与申请触发回收
  // 必须走同一安全条件;旧端显式释放(停止确认)即刻清零。
  let lastExpiredSafeUntil = 0;

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
    }
    // 接管安全窗(WT-P1-004):不论租约是被申请路径还是定时 sweep 回收,
    // 旧端本地截止(ttl+500)与 stop 处理延迟都需要这一窗口;显式释放(停止确认)已清零。
    const safeUntil = lease !== null ? lease.expiresAt + deps.takeoverSafetyMs() : lastExpiredSafeUntil;
    if (now < safeUntil) {
      return { ok: false, code: 'LEASE_HELD', retryAfterMs: Math.max(200, safeUntil - now) };
    }
    if (lease !== null) {
      deps.logger.info('playback.lease-expired-takeover', { old: lease.rendererId, leaseId: lease.leaseId });
    }
    leaseSeq += 1;
    lastExpiredSafeUntil = 0; // 新租约成立,旧期限作废
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
    lastExpiredSafeUntil = 0; // 旧端显式释放即停止确认,新端可立即接管
    lease = null;
    deps.logger.info('playback.lease-released', { rendererId, leaseId });
    return true;
  }

  /** 租约过期回收;返回本次回收的租约 ID(无回收时为 null),供会话终态联动。 */
  function sweep(): string | null {
    if (lease && lease.expiresAt <= deps.now()) {
      const lostId = lease.leaseId;
      lastExpiredSafeUntil = lease.expiresAt + deps.takeoverSafetyMs(); // 回收不清除安全等待(WT-P1-004)
      deps.logger.info('playback.lease-expired', { rendererId: lease.rendererId, leaseId: lostId, safeUntil: lastExpiredSafeUntil });
      lease = null;
      return lostId;
    }
    return null;
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

  /** 租约持有者句柄(持有者已登记时);带音频的表演只派发给该目标。 */
  function leaseHolderHandle(): RendererHandle | null {
    if (!lease) return null;
    return renderers.get(lease.rendererId) ?? null;
  }

  function count(): number {
    return renderers.size;
  }

  return { register, unregister, primaryTarget, leaseHolderHandle, requestLease, renewLease, releaseLease, sweep, send, leaseView, count };
}
