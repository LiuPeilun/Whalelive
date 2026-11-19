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
    takeoverSafetyMs: () => deps.settings().lease.takeoverSafetyMs,
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
      // 带音频的表演只派发给租约持有者(单一可听语音);等待期间由 play 包装层处理宽限与降级
      const target = performance.audioUrl ? registry.leaseHolderHandle() : registry.primaryTarget();
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
    sendStop(performanceId, rendererId) {
      // 停止指令发给实际派发端(WT-P1-004):租约转交后主目标可能已是新端,
      // 旧端才是仍在发声的一方;定向失败再回退主目标。
      const message: WsServerMessage = { kind: 'stop', runId: deps.runId, performanceId };
      if (rendererId !== null && registry.send(rendererId, message)) return;
      const fallback = registry.primaryTarget();
      if (fallback) registry.send(fallback.rendererId, message);
    },
  });

  /** 带音频的表演:宽限期内等待租约持有者出现;超时降级为无声动画(不整单失败)。 */
  async function playWithAudioOwnership(input: PlayInput): Promise<PlaybackResult> {
    const deadline = deps.now() + deps.settings().playback.noRendererGraceMs;
    while (deps.now() < deadline) {
      if (input.signal.aborted) {
        return { performanceId: input.performance.id, status: 'cancelled' };
      }
      if (registry.leaseHolderHandle() !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    // 等待结束后再次拒绝已中止任务:边界交错(等待中停止、随后持有者出现)不得派发(WT-P1-002)
    if (input.signal.aborted) {
      return { performanceId: input.performance.id, status: 'cancelled' };
    }
    if (registry.leaseHolderHandle() !== null) {
      return sessions.start(input);
    }
    if (input.signal.aborted) {
      return { performanceId: input.performance.id, status: 'cancelled' };
    }
    // 降级:剥离 audioUrl,以纯动画派发给任意在线播放端
    deps.logger.warn('playback.audio-degraded-no-lease', { performanceId: input.performance.id });
    const { audioUrl: _dropped, ...silent } = input.performance;
    void _dropped;
    return sessions.start({ ...input, performance: silent });
  }

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
      const prev = registry.leaseView();
      const result = registry.requestLease(rendererId);
      // 拒绝且租约视图未变化时不广播(WT-P1-012):断线安全等待内多候补的
      // 申请-拒绝循环若每次都广播,候补端会相互触发立即重申请,形成高频风暴;
      // 授予或视图变化(接管/释放)照常广播,候补端据状态变化重评。
      const next = registry.leaseView();
      const viewChanged = result.ok
        || prev.leaseId !== next.leaseId
        || prev.holderRendererId !== next.holderRendererId
        || prev.expiresAt !== next.expiresAt;
      if (viewChanged) notify();
      if (result.ok) {
        // 新端接管了已过期的旧租约:旧租约归属的表演立即结算(WT-P0-007)
        if (prev.leaseId !== null && prev.leaseId !== result.leaseId) {
          sessions.leaseLost(prev.leaseId);
        }
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
      if (ok) {
        sessions.leaseLost(leaseId); // 持有者主动释放:归属表演立即结算
        notify();
      }
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
      if (input.performance.audioUrl === undefined) {
        return sessions.start(input).finally(notify);
      }
      return playWithAudioOwnership(input);
    },
    stop() {
      sessions.stop();
      notify();
    },
    tick() {
      const lostLeaseId = registry.sweep();
      if (lostLeaseId !== null) {
        sessions.leaseLost(lostLeaseId); // 到期回收:归属表演立即结算,解除队列阻塞
        notify();
      }
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
