import type { Performance, PerformanceDispatch, PlaybackReport, PlaybackResult } from '../../../shared/performance.js';
import { ErrorCodes } from '../../../shared/errors.js';
import type { Logger } from '../../infrastructure/logger.js';

// 当前表演与音画轨道状态(PROJECT_STRUCTURE《模块职责》)。
// 单次完成:同一表演的终态结果只 resolve 一次;重复、乱序与迟到回执按轨道幂等处理。
// 看门狗:预加载超时与整体超时兜底缺失回执,超时后向播放端补发停止。

type TrackState = 'pending' | 'ready' | 'started' | 'ended' | 'cancelled' | 'failed';

type SessionEntry = {
  performance: Performance;
  asset: SessionRawAsset;
  leaseId: string | null;
  dispatchedRendererId: string | null;
  animation: TrackState;
  audio: TrackState | null;
  /** 音频是否曾经到达 started(WT-P2-013 复审:开过口的事实保留到表演结算,后续 failed/ended 不丢)。 */
  audioEverStarted: boolean;
  failedReason: string | null;
  settled: boolean;
  resolve: (result: PlaybackResult) => void;
  timers: { poll?: ReturnType<typeof setInterval>; preload?: ReturnType<typeof setTimeout>; overall?: ReturnType<typeof setTimeout> };
};

export type ReportAcceptance = 'accepted' | 'stale-run' | 'stale-performance' | 'stale-owner' | 'stale-lease' | 'stale-track';

export type SessionRawAsset = { assetId: string; loop: boolean; available: boolean } | null;

export type SessionDeps = {
  runId: string;
  now(): number;
  preloadTimeoutMs(): number;
  overallTimeoutMs(): number;
  noRendererGraceMs(): number;
  logger: Logger;
  tryDispatch(entry: SessionEntry, performance: Performance, asset: SessionRawAsset): boolean;
  /** 停止指令绑定实际派发端;rendererId 为空时由实现回退到当前主目标。 */
  sendStop(performanceId: string, rendererId: string | null): void;
};

export function createSessionManager(deps: SessionDeps) {
  let current: SessionEntry | null = null;

  function clearTimers(entry: SessionEntry): void {
    if (entry.timers.poll) clearInterval(entry.timers.poll);
    if (entry.timers.preload) clearTimeout(entry.timers.preload);
    if (entry.timers.overall) clearTimeout(entry.timers.overall);
    entry.timers = {};
  }

  function settle(entry: SessionEntry, result: PlaybackResult): void {
    if (entry.settled) return;
    entry.settled = true;
    clearTimers(entry);
    if (current === entry) current = null;
    deps.logger.info('playback.session-settled', { performanceId: entry.performance.id, result: result.status, code: result.status === 'failed' ? result.code : undefined });
    entry.resolve(result);
  }

  function trackTerminal(state: TrackState): boolean {
    return state === 'ended' || state === 'cancelled' || state === 'failed';
  }

  function maybeResolveByTracks(entry: SessionEntry): void {
    if (entry.settled) return;
    const audioState = entry.audio ?? 'ended';
    if (!trackTerminal(entry.animation) || !trackTerminal(audioState)) return;
    if (entry.animation === 'cancelled' || audioState === 'cancelled') {
      settle(entry, { performanceId: entry.performance.id, status: 'cancelled' });
      return;
    }
    const failed = entry.animation === 'failed' || audioState === 'failed';
    if (failed) {
      const code = entry.failedReason && isValidCode(entry.failedReason) ? entry.failedReason : ErrorCodes.UNKNOWN;
      settle(entry, { performanceId: entry.performance.id, status: 'failed', code });
      return;
    }
    settle(entry, { performanceId: entry.performance.id, status: 'ended' });
  }

  function isValidCode(reason: string): boolean {
    return Object.values(ErrorCodes).includes(reason as never);
  }

  /** 开始一次表演:等待播放端出现并派发,设置双看门狗,返回终态 Promise。 */
  function start(input: { performance: Performance; asset: SessionRawAsset; signal: AbortSignal }): Promise<PlaybackResult> {
    // 已中止的任务不得进入会话:已触发过的 abort 事件不会重放给后续监听(WT-P1-002)
    if (input.signal.aborted) {
      return Promise.resolve({ performanceId: input.performance.id, status: 'cancelled' });
    }
    if (current !== null) {
      // interaction 保证串行;走到这里说明调度状态被破坏,立即暴露为失败而不是排队。
      deps.logger.error('playback.session-busy', { existing: current.performance.id, incoming: input.performance.id });
      return Promise.resolve({ performanceId: input.performance.id, status: 'failed', code: ErrorCodes.UNKNOWN });
    }
    return new Promise<PlaybackResult>((resolve) => {
      const entry: SessionEntry = {
        performance: input.performance,
        asset: input.asset,
        leaseId: null,
        dispatchedRendererId: null,
        animation: 'pending',
        audio: input.performance.audioUrl ? 'pending' : null,
        audioEverStarted: false,
        failedReason: null,
        settled: false,
        resolve,
        timers: {},
      };
      current = entry;

      const abort = () => {
        if (entry.settled) return;
        deps.sendStop(entry.performance.id, entry.dispatchedRendererId);
        settle(entry, { performanceId: entry.performance.id, status: 'cancelled' });
      };
      input.signal.addEventListener('abort', abort, { once: true });

      const dispatchDeadline = deps.now() + deps.noRendererGraceMs();
      const attemptDispatch = () => {
        if (entry.settled) return true;
        if (deps.tryDispatch(entry, entry.performance, entry.asset)) {
          clearInterval(entry.timers.poll);
          entry.timers.preload = setTimeout(() => {
            if (entry.settled) return;
            if (entry.animation === 'pending' || entry.animation === 'ready') {
              deps.logger.warn('playback.preload-timeout', { performanceId: entry.performance.id, animation: entry.animation });
              deps.sendStop(entry.performance.id, entry.dispatchedRendererId);
              settle(entry, { performanceId: entry.performance.id, status: 'failed', code: ErrorCodes.PLAYBACK_TIMEOUT });
            }
          }, deps.preloadTimeoutMs());
          entry.timers.overall = setTimeout(() => {
            if (entry.settled) return;
            deps.logger.warn('playback.overall-timeout', { performanceId: entry.performance.id });
            deps.sendStop(entry.performance.id, entry.dispatchedRendererId);
            settle(entry, { performanceId: entry.performance.id, status: 'failed', code: ErrorCodes.PLAYBACK_TIMEOUT });
          }, deps.overallTimeoutMs());
          return true;
        }
        if (deps.now() >= dispatchDeadline) {
          clearInterval(entry.timers.poll);
          settle(entry, { performanceId: entry.performance.id, status: 'failed', code: ErrorCodes.NO_RENDERER });
          return true;
        }
        return false;
      };
      if (!attemptDispatch()) {
        entry.timers.poll = setInterval(attemptDispatch, 200);
      }
    });
  }

  /** 处理播放回执;返回接受结果供传输层记录与状态推送。 */
  function report(report: PlaybackReport): ReportAcceptance {
    if (report.runId !== deps.runId) return 'stale-run';
    const entry = current;
    if (!entry || entry.performance.id !== report.performanceId) return 'stale-performance';
    if (report.rendererId !== entry.dispatchedRendererId) return 'stale-owner';
    if ((report.leaseId ?? null) !== entry.leaseId) return 'stale-lease';
    const track = report.track === 'audio' ? 'audio' : 'animation';
    const stateRef = track === 'audio' ? entry.audio : entry.animation;
    if (stateRef === null) return 'stale-track';
    if (trackTerminal(stateRef)) return 'stale-track'; // 该轨道已终态,重复回执幂等忽略
    if (report.status === 'ready' || report.status === 'started') {
      // 非终态回执只允许前进:pending → ready → started,重复或回退幂等忽略
      const rankOf = (s: TrackState): number => (s === 'pending' ? 0 : s === 'ready' ? 1 : 2);
      const incomingRank = report.status === 'ready' ? 1 : 2;
      if (incomingRank <= rankOf(stateRef)) return 'stale-track';
      if (track === 'audio') {
        entry.audio = report.status;
        // 开过口的事实保留到表演结算:后续 failed/ended 不丢(WT-P2-013 复审)
        if (report.status === 'started') entry.audioEverStarted = true;
      } else {
        entry.animation = report.status;
      }
      return 'accepted';
    }
    if (report.status === 'ended' || report.status === 'cancelled' || report.status === 'failed') {
      if (track === 'audio') entry.audio = report.status;
      else entry.animation = report.status;
      if (report.status === 'failed' && entry.failedReason === null && typeof report.reason === 'string') {
        entry.failedReason = report.reason;
      }
      maybeResolveByTracks(entry);
      return 'accepted';
    }
    return 'stale-track';
  }

  /** 外部停止(紧急停止/人工):取消当前表演并通知播放端。 */
  function stop(): void {
    if (!current) return;
    deps.sendStop(current.performance.id, current.dispatchedRendererId);
    settle(current, { performanceId: current.performance.id, status: 'cancelled' });
  }

  /** 派发目标断线:立即以 RENDERER_LOST 结算,避免等待整体超时阻塞调度。 */
  function rendererLost(rendererId: string): void {
    if (!current || current.dispatchedRendererId !== rendererId) return;
    settle(current, { performanceId: current.performance.id, status: 'failed', code: ErrorCodes.RENDERER_LOST });
  }

  /**
   * 派发时依赖的租约失效(到期被回收、被释放或被新端接管):
   * 立即结束该表演的服务端等待并通知播放端本地停止,interaction 随之继续调度。
   * 终态校验仍基于本会话记录的 runId / leaseId / performanceId / 派发归属。
   */
  function leaseLost(leaseId: string): void {
    if (!current || current.leaseId !== leaseId || current.settled) return;
    deps.logger.warn('playback.lease-lost', { performanceId: current.performance.id, leaseId });
    deps.sendStop(current.performance.id, current.dispatchedRendererId);
    settle(current, { performanceId: current.performance.id, status: 'failed', code: ErrorCodes.LEASE_LOST });
  }

  function status(): 'idle' | 'dispatching' | 'playing' | 'stopping' {
    if (!current) return 'idle';
    if (current.dispatchedRendererId === null) return 'dispatching';
    if (current.animation === 'pending' || current.animation === 'ready') return 'dispatching';
    return 'playing';
  }

  function currentPerformanceId(): string | null {
    return current?.performance.id ?? null;
  }

  /** 该表演是否已开口(WT-P2-013 复审):依据**实际派发的轨道**与回执历史——
   *  音频曾经 started(含 started 后又 failed/ended)即已开口,事实保留到表演结算;
   *  音频未开始:起播前失败/无声降级转为按动画边界(动画 started/ended 即已开口),
   *  音频仍可起播(pending/ready)时不视为已开口,保留让位行为。非当前表演一律 false。 */
  function opened(performanceId: string): boolean {
    if (!current || current.performance.id !== performanceId) return false;
    if (current.audioEverStarted) return true;
    const animationOpened = current.animation === 'started' || current.animation === 'ended';
    if (current.audio === null || current.audio === 'failed') return animationOpened;
    return false; // 音频 pending/ready:仍可起播,保留让位行为
  }

  return { start, report, stop, rendererLost, leaseLost, status, currentPerformanceId, opened };
}
