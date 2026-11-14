import { describe, expect, it } from 'vitest';
import type { Performance } from '../../../shared/performance.js';
import type { EffectiveSettings } from '../../../shared/settings.js';
import type { WsServerMessage } from '../../../shared/protocol.js';
import type { Logger } from '../../infrastructure/logger.js';
import { createPlayback } from './index.js';

// WT-P0-007 联动回归:租约到期 → 会话立即结算(LEASE_LOST)并向播放端补发停止;
// 旧回执保持失效;重新取得播放权后下一表演可派发并正常完成。

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => ({ ...silentLogger, child: () => silentLogger }),
};

function settings(): EffectiveSettings {
  return {
    petId: 'main',
    queue: { capacity: 20, chatTtlMs: 30_000, userCooldownMs: 10_000 },
    gift: { mergeWindowMs: 2_000 },
    playback: { preloadTimeoutMs: 8_000, overallTimeoutMs: 120_000, noRendererGraceMs: 3_000 },
    lease: { ttlMs: 3_000, renewIntervalMs: 1_000 },
    server: { host: '127.0.0.1', port: 3210 },
    platform: 'mock',
    auth: { timeoutMs: 5_000 },
  };
}

function makePerformance(id: string, action: string): Performance {
  return { id, sourceEventId: 'evt-x', priority: 40, say: '', action, expiresAt: Number.MAX_SAFE_INTEGER };
}

type DispatchView = { performanceId: string; leaseId: string | null; action: string };

function dispatchedActions(sent: WsServerMessage[]): DispatchView[] {
  const views: DispatchView[] = [];
  for (const m of sent) {
    if (m.kind === 'performance') {
      views.push({ performanceId: m.dispatch.performance.id, leaseId: m.dispatch.leaseId, action: m.dispatch.performance.action });
    }
  }
  return views;
}

describe('playback 租约失效联动(WT-P0-007)', () => {
  it('租约到期立即结算、补发停止、旧回执失效、下一表演可派发并完成', async () => {
    let t = 0;
    const sent: WsServerMessage[] = [];
    const playback = createPlayback({
      runId: 'run-1',
      settings,
      logger: silentLogger,
      now: () => t,
      urlForAsset: () => null,
    });

    playback.registerRenderer('r1', (m) => {
      sent.push(m);
      return true;
    });
    const lease1 = playback.requestLease('r1');
    expect(lease1.ok).toBe(true);

    const pendingA = playback.play({ performance: makePerformance('pf-a', 'dance'), asset: null, signal: new AbortController().signal });
    const dispatchA = dispatchedActions(sent).at(-1);
    expect(dispatchA).toMatchObject({ performanceId: 'pf-a', leaseId: lease1.ok ? lease1.leaseId : null, action: 'dance' });
    expect(
      playback.report({ runId: 'run-1', leaseId: lease1.ok ? lease1.leaseId : null, performanceId: 'pf-a', rendererId: 'r1', track: 'animation', status: 'started', at: 0 }, 'r1'),
    ).toBe('accepted');

    // 停止续租,租约到期被回收
    t += 4_000;
    playback.tick();
    expect(await pendingA).toEqual({ performanceId: 'pf-a', status: 'failed', code: 'LEASE_LOST' });
    expect(sent.some((m) => m.kind === 'stop' && m.performanceId === 'pf-a')).toBe(true);
    expect(playback.view().status).toBe('idle');

    // 旧回执保持失效
    expect(
      playback.report({ runId: 'run-1', leaseId: lease1.ok ? lease1.leaseId : null, performanceId: 'pf-a', rendererId: 'r1', track: 'animation', status: 'ended', at: 0 }, 'r1'),
    ).toBe('stale');

    // 重新取得播放权后下一表演立即派发并正常完成
    const lease2 = playback.requestLease('r1');
    expect(lease2.ok).toBe(true);
    if (!lease2.ok || !lease1.ok) throw new Error('unreachable');
    expect(lease2.leaseId).not.toBe(lease1.leaseId);

    const pendingB = playback.play({ performance: makePerformance('pf-b', 'wave'), asset: null, signal: new AbortController().signal });
    const dispatchB = dispatchedActions(sent).at(-1);
    expect(dispatchB).toMatchObject({ performanceId: 'pf-b', leaseId: lease2.leaseId, action: 'wave' });
    expect(
      playback.report({ runId: 'run-1', leaseId: lease2.leaseId, performanceId: 'pf-b', rendererId: 'r1', track: 'animation', status: 'ended', at: 0 }, 'r1'),
    ).toBe('accepted');
    expect(await pendingB).toEqual({ performanceId: 'pf-b', status: 'ended' });
  });

  it('持有者主动释放租约同样立即结算归属表演', async () => {
    const sent: WsServerMessage[] = [];
    const playback = createPlayback({
      runId: 'run-1',
      settings,
      logger: silentLogger,
      now: () => 0,
      urlForAsset: () => null,
    });
    playback.registerRenderer('r1', (m) => {
      sent.push(m);
      return true;
    });
    const lease = playback.requestLease('r1');
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error('unreachable');
    const pending = playback.play({ performance: makePerformance('pf-c', 'dance'), asset: null, signal: new AbortController().signal });
    expect(playback.releaseLease('r1', lease.leaseId)).toBe(true);
    expect(await pending).toEqual({ performanceId: 'pf-c', status: 'failed', code: 'LEASE_LOST' });
    expect(sent.some((m) => m.kind === 'stop' && m.performanceId === 'pf-c')).toBe(true);
  });
});
