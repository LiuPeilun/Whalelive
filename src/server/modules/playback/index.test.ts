import { describe, expect, it, vi } from 'vitest';
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
    lease: { ttlMs: 3_000, renewIntervalMs: 1_000, takeoverSafetyMs: 0 },
    server: { host: '127.0.0.1', port: 3210 },
    platform: 'mock',
    auth: { timeoutMs: 5_000 },
    generation: { llmTimeoutMs: 8_000, ttsTimeoutMs: 10_000 },
  };
}

function makePerformance(id: string, action: string): Performance {
  return { id, sourceEventId: 'evt-x', priority: 40, say: '', action, expiresAt: Number.MAX_SAFE_INTEGER };
}

type DispatchView = { performanceId: string; leaseId: string | null; action: string; audioUrl: string | undefined };

function dispatchedActions(sent: WsServerMessage[]): DispatchView[] {
  const views: DispatchView[] = [];
  for (const m of sent) {
    if (m.kind === 'performance') {
      views.push({ performanceId: m.dispatch.performance.id, leaseId: m.dispatch.leaseId, action: m.dispatch.performance.action, audioUrl: m.dispatch.performance.audioUrl });
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

  it('租约失效后自动推进的下一项以空租约派发,回执按派发身份被接受(WT-P0-007)', async () => {
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
    if (!lease1.ok) throw new Error('unreachable');

    // dance 播放中(wave 在租约失效前已由 interaction 排队,此处直接模拟其自动推进)
    const pendingA = playback.play({ performance: makePerformance('pf-a', 'dance'), asset: null, signal: new AbortController().signal });
    expect(
      playback.report({ runId: 'run-1', leaseId: lease1.leaseId, performanceId: 'pf-a', rendererId: 'r1', track: 'animation', status: 'started', at: 0 }, 'r1'),
    ).toBe('accepted');

    // 租约过期回收:dance 立即结算,不重新取租约(interaction 自动推进的真实空窗)
    t += 4_000;
    playback.tick();
    expect(await pendingA).toEqual({ performanceId: 'pf-a', status: 'failed', code: 'LEASE_LOST' });

    const pendingB = playback.play({ performance: makePerformance('pf-b', 'wave'), asset: null, signal: new AbortController().signal });
    const dispatchB = dispatchedActions(sent).at(-1);
    expect(dispatchB).toMatchObject({ performanceId: 'pf-b', leaseId: null, action: 'wave' });

    // 页面按派发身份(空租约)回执 → 被接受并正常完成,不再依赖旧租约或预加载看门狗
    expect(
      playback.report({ runId: 'run-1', leaseId: null, performanceId: 'pf-b', rendererId: 'r1', track: 'animation', status: 'ended', at: 0 }, 'r1'),
    ).toBe('accepted');
    expect(await pendingB).toEqual({ performanceId: 'pf-b', status: 'ended' });

    // 旧租约下的回执保持失效
    expect(
      playback.report({ runId: 'run-1', leaseId: lease1.leaseId, performanceId: 'pf-b', rendererId: 'r1', track: 'animation', status: 'started', at: 0 }, 'r1'),
    ).toBe('stale');
  });

  it('带音频的表演只派发给租约持有者并携带租约(P1)', async () => {
    const sent: WsServerMessage[] = [];
    const fast = () => ({ ...settings(), playback: { ...settings().playback, noRendererGraceMs: 150 } });
    const playback = createPlayback({
      runId: 'run-1',
      settings: fast,
      logger: silentLogger,
      now: () => Date.now(),
      urlForAsset: () => null,
    });
    playback.registerRenderer('r-holder', (m) => {
      sent.push(m);
      return true;
    });
    playback.registerRenderer('r-preview', (m) => {
      sent.push(m);
      return true;
    });
    const lease = playback.requestLease('r-holder');
    expect(lease.ok).toBe(true);
    const leaseId = lease.ok ? lease.leaseId : null;

    const pending = playback.play({
      performance: { ...makePerformance('pf-a', 'talk'), audioUrl: '/media/audio/a.wav' },
      asset: null,
      signal: new AbortController().signal,
    });
    const dispatch = dispatchedActions(sent).at(-1);
    expect(dispatch).toMatchObject({ performanceId: 'pf-a', leaseId, action: 'talk' });
    expect(
      playback.report({ runId: 'run-1', leaseId, performanceId: 'pf-a', rendererId: 'r-holder', track: 'animation', status: 'ended', at: 0 }, 'r-holder'),
    ).toBe('accepted');
    expect(
      playback.report({ runId: 'run-1', leaseId, performanceId: 'pf-a', rendererId: 'r-holder', track: 'audio', status: 'ended', at: 0 }, 'r-holder'),
    ).toBe('accepted');
    expect(await pending).toEqual({ performanceId: 'pf-a', status: 'ended' });
  });

  it('无租约持有者时带音频表演宽限后降级无声,不整单失败(P1)', async () => {
    const sent: WsServerMessage[] = [];
    const fast = () => ({ ...settings(), playback: { ...settings().playback, noRendererGraceMs: 150 } });
    const playback = createPlayback({
      runId: 'run-1',
      settings: fast,
      logger: silentLogger,
      now: () => Date.now(),
      urlForAsset: () => null,
    });
    playback.registerRenderer('r1', (m) => {
      sent.push(m);
      return true;
    });
    // 不申请租约 → 无持有者
    const pending = playback.play({
      performance: { ...makePerformance('pf-b', 'talk'), audioUrl: '/media/audio/b.wav' },
      asset: null,
      signal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 450)); // 超过宽限(150ms)
    const dispatch = dispatchedActions(sent).at(-1);
    expect(dispatch).toMatchObject({ performanceId: 'pf-b', action: 'talk', leaseId: null });
    // 降级:派发到任意在线播放端,且剥离 audioUrl
    expect(dispatch?.audioUrl).toBeUndefined();
    expect(playback.report({ runId: 'run-1', leaseId: null, performanceId: 'pf-b', rendererId: 'r1', track: 'animation', status: 'ended', at: 0 }, 'r1')).toBe('accepted');
    expect(await pending).toEqual({ performanceId: 'pf-b', status: 'ended' });
  });

  it('等待租约期间中止的任务不再派发,即使随后持有者出现(WT-P1-002)', async () => {
    const sent: WsServerMessage[] = [];
    const fast = () => ({ ...settings(), playback: { ...settings().playback, noRendererGraceMs: 400 } });
    const playback = createPlayback({
      runId: 'run-1',
      settings: fast,
      logger: silentLogger,
      now: () => Date.now(),
      urlForAsset: () => null,
    });
    playback.registerRenderer('r1', (m) => {
      sent.push(m);
      return true;
    });
    const controller = new AbortController();
    const pending = playback.play({
      performance: { ...makePerformance('pf-x', 'talk'), audioUrl: '/media/audio/x.wav' },
      asset: null,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 100)); // 处于等待租约中
    controller.abort(); // 宽限边界内紧急停止
    await new Promise((r) => setTimeout(r, 100));
    playback.requestLease('r1'); // 停止之后持有者才出现
    await new Promise((r) => setTimeout(r, 400)); // 超过剩余宽限
    expect(await pending).toEqual({ performanceId: 'pf-x', status: 'cancelled' });
    expect(dispatchedActions(sent).length).toBe(0); // 已取消任务从未派发
  });

  it('租约转交后停止指令发给实际派发端,而非新持有者(WT-P1-004)', async () => {
    const sentA: WsServerMessage[] = [];
    const sentB: WsServerMessage[] = [];
    let t = 0;
    const playback = createPlayback({
      runId: 'run-1',
      settings,
      logger: silentLogger,
      now: () => t,
      urlForAsset: () => null,
    });
    playback.registerRenderer('A', (m) => {
      sentA.push(m);
      return true;
    });
    playback.registerRenderer('B', (m) => {
      sentB.push(m);
      return true;
    });
    const lease = playback.requestLease('A');
    expect(lease.ok).toBe(true);
    const pending = playback.play({ performance: makePerformance('pf-a', 'dance'), asset: null, signal: new AbortController().signal });
    expect(dispatchedActions(sentA).at(-1)).toMatchObject({ performanceId: 'pf-a', action: 'dance' });

    t += 4_000; // A 未续租,租约过期
    playback.tick(); // 回收 → leaseLost → 结算(LEASE_LOST);停止发给 A
    expect(await pending).toEqual({ performanceId: 'pf-a', status: 'failed', code: 'LEASE_LOST' });
    const leaseB = playback.requestLease('B'); // B 接管
    expect(leaseB.ok).toBe(true);

    // 旧端收到停止;新端不收到旧表演的 stop(WT-P1-004)
    expect(sentA.some((m) => m.kind === 'stop' && m.performanceId === 'pf-a')).toBe(true);
    expect(sentB.some((m) => m.kind === 'stop' && m.performanceId === 'pf-a')).toBe(false);
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
