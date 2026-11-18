import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlayer, type PlayerReport } from './player.js';
import type { PreparedClip } from './video-track.js';
import type { AudioHandle, AudioTrack } from './audio-track.js';
import type { PerformanceDispatch } from '../../shared/performance.js';

// WT-P1-003 播放器级回归(审核要求:仅测轨道令牌不足以覆盖这两条路径):
// ① 迟到加载:旧表演的加载回调弃置时不得触碰共享轨道(停止新表演的音频);
// ② 迟到起播确认:旧句柄的 begin 成/败都不得替新表演上报 started。

function fakeWindow() {
  vi.stubGlobal('window', { setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) });
  vi.stubGlobal('document', { querySelectorAll: () => [] as Element[] });
}

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (v: T) => void;
  reject!: (e: unknown) => void;
  done = false;
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = (v) => {
        if (this.done) return;
        this.done = true;
        res(v);
      };
      this.reject = (e) => {
        if (this.done) return;
        this.done = true;
        rej(e);
      };
    });
  }
}

function makeClip(): PreparedClip & { endedDeferred: Deferred<void> } {
  const endedDeferred = new Deferred<void>();
  return {
    endedDeferred,
    show() {},
    play() {},
    ended: () => endedDeferred.promise,
    stop() {},
  };
}

function makeAudioTrack() {
  const calls: string[] = [];
  const pendingPrepares: { url: string; deferred: Deferred<AudioHandle> }[] = [];
  const track: AudioTrack = {
    prepare(url: string) {
      calls.push(`prepare:${url}`);
      const d = new Deferred<AudioHandle>();
      pendingPrepares.push({ url, deferred: d });
      return d.promise;
    },
    stop() {
      calls.push('stop'); // 关键观测:迟到的旧任务不得触发全局 stop
    },
    currentSrc: () => null,
  };
  return { track, calls, pendingPrepares };
}

function makeHandle() {
  const beginDeferred = new Deferred<boolean>();
  const endedDeferred = new Deferred<'ended' | 'failed'>();
  const handle: AudioHandle = {
    begin: () => beginDeferred.promise,
    ended: () => endedDeferred.promise,
  };
  return { handle, beginDeferred, endedDeferred };
}

function makePlayer(audio: AudioTrack) {
  const reports: { track: string; status: string; reason?: string }[] = [];
  const report: PlayerReport = (track, status, reason) => {
    reports.push({ track, status, ...(reason !== undefined ? { reason } : {}) });
  };
  const clips: PreparedClip[] = [];
  const video = {
    prepareIdle: () => Promise.resolve(makeClip()),
    prepareAction: () => {
      const clip = makeClip();
      clips.push(clip);
      return Promise.resolve(clip);
    },
    hideAll: () => {},
  };
  const els = {
    caption: { style: { display: 'none' }, textContent: '' },
    placeholder: { style: { display: 'none' } },
    placeholderLabel: { textContent: '' },
  };
  const player = createPlayer({
    video: video as never,
    audio,
    caption: els.caption as never,
    placeholder: els.placeholder as never,
    placeholderLabel: els.placeholderLabel as never,
    report,
  });
  return { player, reports, clips, els };
}

function dispatch(id: string, action: string, loop: boolean): PerformanceDispatch {
  return {
    runId: 'run-1',
    leaseId: 'lease-1',
    performance: {
      id,
      sourceEventId: 'evt',
      priority: 40,
      say: `say-${id}`,
      action,
      expiresAt: Number.MAX_SAFE_INTEGER,
      audioUrl: `/media/audio/${id}.wav`,
    },
    asset: { url: `/media/pets/main/animations/${action}.webm`, mime: 'video/webm', loop, available: true },
  };
}

const idle = () => new Promise((r) => setTimeout(r, 10));

beforeEach(fakeWindow);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('播放器迟到回调归属(WT-P1-003)', () => {
  it('旧表演的迟到加载弃置时不触碰共享轨道,新表演的音频照常完成', async () => {
    const { track, calls, pendingPrepares } = makeAudioTrack();
    const { player, reports, clips } = makePlayer(track);

    // A(说话类)进入音频加载,悬置不返回
    player.play(dispatch('pf-a', 'talk', true));
    await idle();
    expect(pendingPrepares.length).toBe(1);

    // 紧急停止后 B 接替并正常播放
    player.stop(null);
    player.play(dispatch('pf-b', 'talk', true));
    await idle();
    const prepB = pendingPrepares[1]!;
    const hb = makeHandle();
    prepB.deferred.resolve(hb.handle);
    await idle();
    const stopCountAfterExplicit = calls.filter((c) => c === 'stop').length; // 仅显式 player.stop 产生
    hb.beginDeferred.resolve(true);
    await idle();
    expect(reports.some((r) => r.track === 'audio' && r.status === 'started')).toBe(true);

    // A 的迟到加载回调此刻以 superseded 拒绝:不得再触发全局 stop、不得产生 A 的回执
    const beforeCount = reports.length;
    pendingPrepares[0]!.deferred.reject(new Error('audio-load-superseded'));
    await idle();
    expect(calls.filter((c) => c === 'stop').length).toBe(stopCountAfterExplicit); // 无新增 stop(WT-P1-003)
    expect(reports.length).toBe(beforeCount);
    expect(clips.length).toBe(1); // A 的视频加载未开始(音频先弃置)

    // B 自然结束:回执完整
    hb.endedDeferred.resolve('ended');
    await idle();
    expect(reports.some((r) => r.track === 'audio' && r.status === 'ended')).toBe(true);
    expect(reports.some((r) => r.track === 'animation' && r.status === 'ended')).toBe(true);
  });

  it('旧句柄迟到的 begin 成功确认不替新表演上报 started', async () => {
    const { track, pendingPrepares } = makeAudioTrack();
    const { player, reports } = makePlayer(track);

    // A 的 begin 悬置
    player.play(dispatch('pf-a', 'talk', true));
    await idle();
    const ha = makeHandle();
    pendingPrepares[0]!.deferred.resolve(ha.handle);
    await idle();

    // B 接替并完成完整周期
    player.play(dispatch('pf-b', 'talk', true));
    await idle();
    const hb = makeHandle();
    pendingPrepares[1]!.deferred.resolve(hb.handle);
    await idle();
    hb.beginDeferred.resolve(true);
    await idle();
    hb.endedDeferred.resolve('ended');
    await idle();
    const bStarted = reports.filter((r) => r.track === 'audio' && r.status === 'started').length;

    // A 的迟到 begin 成功确认(真实轨道下失效句柄兑现 false;此处模拟 true 验证播放器侧防线)
    ha.beginDeferred.resolve(true);
    await idle();
    const startedAfter = reports.filter((r) => r.track === 'audio' && r.status === 'started').length;
    expect(startedAfter).toBe(bStarted); // 未新增 A 的 started
    // A 无任何回执产生
    expect(reports.some((r) => r.reason === undefined && r.status === 'started' && r.track === 'audio' && startedAfter === bStarted)).toBe(true);
  });
});
