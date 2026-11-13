import type { Performance, PerformanceDispatch, PlaybackReport, PlaybackResult } from '../../../shared/performance.js';
import type { PlaybackView, RenderersView, WsServerMessage } from '../../../shared/protocol.js';
import type { EffectiveSettings } from '../../../shared/settings.js';
import type { Logger } from '../../infrastructure/logger.js';
import { createRendererRegistry } from './renderer-lease.js';
import { createSessionManager } from './session.js';

// playback 模块公开入口:播放会话 + 播放端租约。
// 通过注入的发送函数调用已登记播放端;WebSocket 连接对象归 transport/ws 管理。

export type PlayInput = {
  performance: Performance;
  asset: { assetId: string; loop: boolean; available: boolean } | null;
  signal: AbortSignal;
};

export type PlaybackModule = {
  registerRenderer(rendererId: string, send: (message: WsServerMessage) => boolean): void;
  unregisterRenderer(rendererId: string): void;
  requestLease(rendererId: string): { ok: true; leaseId: string; ttlMs: number; renewIntervalMs: number } | { ok: false; code: string; retryAfterMs: number };
  renewLease(rendererId: string, leaseId: string): boolean;
  releaseLease(rendererId: string, leaseId: string): boolean;
  report(report: PlaybackReport, connectionRendererId: string): 'accepted' | 'stale';
  play(input: PlayInput): Promise<PlaybackResult>;
  stop(): void;
  tick(): void;
  view(): PlaybackView;
  renderersView(): RenderersView;
  onChange(cb: () => void): () => void;
};

export function createPlayback(deps: {
  runId: string;
  settings(): EffectiveSettings;
  logger: Logger;
  now(): number;
  /** 由 app.ts 注入:把清单内 assetId 变成受控媒体地址。 */
  urlForAsset(assetId: string): string | null;
}): PlaybackModule {
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const cb of listeners) cb();
  }

  const registry = createRendererRegistry({
    leaseTtlMs: () => deps.settings().lease.ttlMs,
    renewIntervalMs: () => deps.settings().lease.renewIntervalMs,
    now: deps.now,
    logger: deps.logger,
  });

  const sessions = createSessionManager({
    runId: deps.runId,
    now: deps.now,
    preloadTimeoutMs: () => deps.settings().playback.preloadTimeoutMs,
    overallTimeoutMs: () => deps.settings().playback.overallTimeoutMs,
    noRendererGraceMs: () => deps.settings().playback.noRendererGraceMs,
    logger: deps.logger,
    tryDispatch(entry, performance, asset) {
      const target = registry.primaryTarget();
      if (!target) return false;
      const lease = registry.leaseView();
      const leaseId = lease.holderRendererId === target.rendererId ? lease.leaseId : null;
      entry.dispatchedRendererId = target.rendererId;
      entry.leaseId = leaseId;
      const dispatch: PerformanceDispatch = {
        runId: deps.runId,
        leaseId,
        performance,
        asset:
          asset && asset.available
            ? { url: deps.urlForAsset(asset.assetId) ?? '', mime: 'video/webm', loop: asset.loop, available: true }
            : asset
              ? { url: '', mime: 'video/webm', loop: asset.loop, available: false }
              : null,
      };
      const sent = registry.send(target.rendererId, { kind: 'performance', dispatch });
      if (!sent) {
        entry.dispatchedRendererId = null;
        entry.leaseId = null;
        return false;
      }
      deps.logger.info('playback.dispatched', {
        performanceId: performance.id,
        rendererId: target.rendererId,
        leaseId,
        action: performance.action,
        assetAvailable: dispatch.asset?.available ?? false,
      });
      return true;
    },
    sendStop(performanceId) {
      const target = registry.primaryTarget();
      if (target) registry.send(target.rendererId, { kind: 'stop', runId: deps.runId, performanceId });
    },
  });

  return {
    registerRenderer(rendererId, send) {
      registry.register(rendererId, send);
      deps.logger.info('playback.renderer-registered', { rendererId, count: registry.count() });
      notify();
    },
    unregisterRenderer(rendererId) {
      registry.unregister(rendererId);
      sessions.rendererLost(rendererId);
      deps.logger.info('playback.renderer-unregistered', { rendererId, count: registry.count() });
      notify();
    },
    requestLease(rendererId) {
      const result = registry.requestLease(rendererId);
      notify();
      if (result.ok) {
        return { ok: true, leaseId: result.leaseId, ttlMs: result.ttlMs, renewIntervalMs: deps.settings().lease.renewIntervalMs };
      }
      return { ok: false, code: result.code, retryAfterMs: result.retryAfterMs };
    },
    renewLease(rendererId, leaseId) {
      const ok = registry.renewLease(rendererId, leaseId);
      if (ok) notify();
      return ok;
    },
    releaseLease(rendererId, leaseId) {
      const ok = registry.releaseLease(rendererId, leaseId);
      if (ok) notify();
      return ok;
    },
    report(report, connectionRendererId) {
      if (report.rendererId !== connectionRendererId) return 'stale';
      const accepted = sessions.report(report);
      if (accepted === 'accepted') {
        notify();
        return 'accepted';
      }
      deps.logger.info('playback.report-stale', { performanceId: report.performanceId, track: report.track, status: report.status, why: accepted });
      return 'stale';
    },
    play(input) {
      notify();
      return sessions.start(input).finally(notify);
    },
    stop() {
      sessions.stop();
      notify();
    },
    tick() {
      const before = registry.leaseView();
      registry.sweep();
      if (before.expiresAt !== registry.leaseView().expiresAt) notify();
    },
    view() {
      return {
        status: sessions.status(),
        performanceId: sessions.currentPerformanceId(),
        action: null, // 由状态组装层结合 interaction 填充
      };
    },
    renderersView() {
      const lease = registry.leaseView();
      const primary = registry.primaryTarget();
      return {
        count: registry.count(),
        primaryRendererId: primary?.rendererId ?? null,
        leaseHolderRendererId: lease.holderRendererId,
        leaseExpiresAt: lease.expiresAt,
      };
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
