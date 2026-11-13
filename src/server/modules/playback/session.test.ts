import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Performance, PlaybackReport } from '../../../shared/performance.js';
import { createSessionManager, type SessionDeps } from './session.js';

// 回归重点(ROADMAP P0 验收):
// - 同一表演被重复或乱序回执更新时,终态结果只完成一次;
// - 取消信号、无播放端与看门狗超时都能结束本地等待;
// - 迟到回执与旧会话(runId)回执保持失效。

function makePerformance(id = 'pf-test'): Performance {
  return { id, sourceEventId: 'evt-1', priority: 40, say: '你好', action: 'wave', expiresAt: Date.now() + 60_000 };
}

function makeReport(overrides: Partial<PlaybackReport>): PlaybackReport {
  return {
    runId: 'run-1',
    leaseId: null,
    performanceId: 'pf-test',
    rendererId: 'rnd-1',
    track: 'animation',
    status: 'started',
    at: Date.now(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SessionDeps> = {}): SessionDeps {
  return {
    runId: 'run-1',
    now: () => Date.now(),
    preloadTimeoutMs: () => 8_000,
    overallTimeoutMs: () => 120_000,
    noRendererGraceMs: () => 3_000,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => ({}) as never }) }),
    },
    tryDispatch: vi.fn((entry: { dispatchedRendererId: string | null; leaseId: string | null }) => {
      // 履行 tryDispatch 契约:成功派发时回填派发目标与租约快照
      entry.dispatchedRendererId = 'rnd-1';
      entry.leaseId = null;
      return true;
    }),
    sendStop: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('playback 会话单次完成', () => {
  it('ready → started → ended 正常完成,重复终态回执被忽略', async () => {
    const deps = makeDeps();
    const sessions = createSessionManager(deps);
    const controller = new AbortController();
    const pending = sessions.start({ performance: makePerformance(), asset: null, signal: controller.signal });
    expect(sessions.report(makeReport({ status: 'ready' }))).toBe('accepted');
    expect(sessions.report(makeReport({ status: 'started' }))).toBe('accepted');
    expect(sessions.report(makeReport({ status: 'started' }))).toBe('stale-track'); // 重复 started
    expect(sessions.report(makeReport({ status: 'ended' }))).toBe('accepted');
    const result = await pending;
    expect(result).toEqual({ performanceId: 'pf-test', status: 'ended' });
    // 结束后的迟到回执:会话已清空 → stale-performance
    expect(sessions.report(makeReport({ status: 'ended' }))).toBe('stale-performance');
  });

  it('乱序回执:ended 先到即终态,迟到的 ready 被忽略,结果只完成一次', async () => {
    const deps = makeDeps();
    const sessions = createSessionManager(deps);
    const pending = sessions.start({ performance: makePerformance(), asset: null, signal: new AbortController().signal });
    expect(sessions.report(makeReport({ status: 'ended' }))).toBe('accepted');
    expect(sessions.report(makeReport({ status: 'ready' }))).toBe('stale-performance'); // 会话已清空
    expect(await pending).toEqual({ performanceId: 'pf-test', status: 'ended' });
  });

  it('取消信号:立即兑现 cancelled 并向播放端补发停止', async () => {
    const sendStop = vi.fn();
    const deps = makeDeps({ sendStop });
    const sessions = createSessionManager(deps);
    const controller = new AbortController();
    const pending = sessions.start({ performance: makePerformance(), asset: null, signal: controller.signal });
    sessions.report(makeReport({ status: 'started' }));
    controller.abort();
    const result = await pending;
    expect(result).toEqual({ performanceId: 'pf-test', status: 'cancelled' });
    expect(sendStop).toHaveBeenCalledWith('pf-test');
  });

  it('外部 stop():当前表演兑现 cancelled', async () => {
    const deps = makeDeps();
    const sessions = createSessionManager(deps);
    const pending = sessions.start({ performance: makePerformance(), asset: null, signal: new AbortController().signal });
    sessions.stop();
    expect(await pending).toEqual({ performanceId: 'pf-test', status: 'cancelled' });
  });

  it('旧会话(runId 不匹配)的回执被拒绝', async () => {
    const deps = makeDeps();
    const sessions = createSessionManager(deps);
    const pending = sessions.start({ performance: makePerformance(), asset: null, signal: new AbortController().signal });
    expect(sessions.report(makeReport({ runId: 'run-old', status: 'ended' }))).toBe('stale-run');
    expect(sessions.report(makeReport({ status: 'ended' }))).toBe('accepted');
    expect(await pending).toEqual({ performanceId: 'pf-test', status: 'ended' });
  });

  it('非派发渲染端的回执被拒绝(播放端归属)', async () => {
    const deps = makeDeps();
    const sessions = createSessionManager(deps);
    const pending = sessions.start({ performance: makePerformance(), asset: null, signal: new AbortController().signal });
    expect(sessions.report(makeReport({ rendererId: 'rnd-other', status: 'ended' }))).toBe('stale-owner');
    expect(sessions.report(makeReport({ status: 'ended' }))).toBe('accepted');
    expect(await pending).toEqual({ performanceId: 'pf-test', status: 'ended' });
  });

  it('素材缺失:动画 failed(ASSET_MISSING)兑现失败终态', async () => {
    const deps = makeDeps();
    const sessions = createSessionManager(deps);
    const pending = sessions.start({ performance: makePerformance(), asset: null, signal: new AbortController().signal });
    expect(sessions.report(makeReport({ status: 'started' }))).toBe('accepted');
    expect(sessions.report(makeReport({ status: 'failed', reason: 'ASSET_MISSING' }))).toBe('accepted');
    expect(await pending).toEqual({ performanceId: 'pf-test', status: 'failed', code: 'ASSET_MISSING' });
  });

  it('无播放端:宽限期后兑现 NO_RENDERER', async () => {
    vi.useFakeTimers();
    const deps = makeDeps({ tryDispatch: () => false, noRendererGraceMs: () => 3_000 });
    const sessions = createSessionManager(deps);
    const pending = sessions.start({ performance: makePerformance(), asset: null, signal: new AbortController().signal });
    const assertion = expect(pending).resolves.toEqual({ performanceId: 'pf-test', status: 'failed', code: 'NO_RENDERER' });
    await vi.advanceTimersByTimeAsync(3_500);
    await assertion;
  });

  it('看门狗:预加载超时兑现 PLAYBACK_TIMEOUT', async () => {
    vi.useFakeTimers();
    const sendStop = vi.fn();
    const deps = makeDeps({ sendStop, preloadTimeoutMs: () => 2_000 });
    const sessions = createSessionManager(deps);
    const pending = sessions.start({ performance: makePerformance(), asset: null, signal: new AbortController().signal });
    const assertion = expect(pending).resolves.toEqual({ performanceId: 'pf-test', status: 'failed', code: 'PLAYBACK_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(2_500);
    await assertion;
    expect(sendStop).toHaveBeenCalledWith('pf-test');
  });

  it('并发 start 被拒绝为失败,不悬挂调度', async () => {
    const deps = makeDeps();
    const sessions = createSessionManager(deps);
    const first = sessions.start({ performance: makePerformance('pf-1'), asset: null, signal: new AbortController().signal });
    const second = await sessions.start({ performance: makePerformance('pf-2'), asset: null, signal: new AbortController().signal });
    expect(second).toEqual({ performanceId: 'pf-2', status: 'failed', code: 'UNKNOWN' });
    sessions.report(makeReport({ performanceId: 'pf-1', status: 'ended' }));
    expect(await first).toEqual({ performanceId: 'pf-1', status: 'ended' });
  });
});
