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
    gift: { mergeWindowMs: 2_000, tiering: { smallMaxYuan: 1, largeMinYuan: 10, peakMergeCount: 6 } },
    greetings: { enabled: true, enterWindowMs: 10_000, maxNamedCount: 3, allRoomIntervalMs: 60_000, coldIdleMs: 180_000, coldIntervalMs: 300_000 },
    playback: { preloadTimeoutMs: 8_000, overallTimeoutMs: 120_000, noRendererGraceMs: 3_000 },
    lease: { ttlMs: 3_000, renewIntervalMs: 1_000, takeoverSafetyMs: 0 },
      tts: { provider: 'fixed-local', voice: 'zh-CN-XiaoxiaoNeural' },
    singing: { enabled: true, clipStartRatio: 0.4, clipSeconds: 40, targetHz: 310, keyMin: -6, keyMax: 24, indexRate: 0.3, protect: 0.33, rmsMixRate: 0.25, actionId: 'talk' },
    llm: { provider: 'fixed-local' },
    server: { host: '127.0.0.1', port: 3210 },
    platform: 'mock',
    auth: { timeoutMs: 5_000 },
    generation: { llmTimeoutMs: 8_000, ttsTimeoutMs: 10_000 },
  };
}

function makePerformance(id: string, action: string): Performance {
  return { id, sourceEventId: 'evt-x', priority: 40, say: '', action, expiresAt: Number.MAX_SAFE_INTEGER };
}

function makeAudioPerformance(id: string): Performance {
  return { ...makePerformance(id, 'talk'), audioUrl: '/media/audio/x.wav' };
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

  it('定时回收后安全窗仍生效,到期才允许接管;显式释放立即接管(WT-P1-004)', async () => {
    const sent: WsServerMessage[] = [];
    let t = 0;
    const cfg = () => ({ ...settings(), lease: { ttlMs: 3_000, renewIntervalMs: 1_000, takeoverSafetyMs: 800 } });
    const playback = createPlayback({ runId: 'run-1', settings: cfg, logger: silentLogger, now: () => t, urlForAsset: () => null });
    playback.registerRenderer('A', (m) => { sent.push(m); return true; });
    playback.registerRenderer('B', (m) => { sent.push(m); return true; });
    expect(playback.requestLease('A').ok).toBe(true);

    // 回收前申请:被拒,剩余等待 ≈ 780ms(时钟 3020)
    t = 3_020;
    const beforeTick = playback.requestLease('B');
    expect(beforeTick.ok).toBe(false);
    if (!beforeTick.ok) expect(beforeTick.retryAfterMs).toBeGreaterThanOrEqual(700);

    // 定时回收清除持有者后,安全等待依然存在(WT-P1-004 核心)
    playback.tick();
    const afterTick = playback.requestLease('B');
    expect(afterTick.ok).toBe(false);
    if (!afterTick.ok) expect(afterTick.retryAfterMs).toBeGreaterThan(0);

    // 安全时刻(3800)之后:接管成功
    t = 3_801;
    const granted = playback.requestLease('B');
    expect(granted.ok).toBe(true);

    // 显式释放路径:停止确认后新端立即接管,无等待
    t = 10_000;
    playback.tick(); // B 租约过期回收
    const holderLease = playback.requestLease('A'); // A 重新持有
    expect(holderLease.ok).toBe(true);
    if (holderLease.ok) {
      t = 20_000;
      expect(playback.releaseLease('A', holderLease.leaseId)).toBe(true); // A 显式释放
      const immediate = playback.requestLease('B'); // B 无需等安全窗
      expect(immediate.ok).toBe(true);
    }
  });

  it('持有端断线注销保留旧租约剩余生命的接管等待,不早于旧租约截止接管(WT-P1-004)', async () => {
    const sent: WsServerMessage[] = [];
    let t = 1_000;
    const cfg = () => ({ ...settings(), lease: { ttlMs: 15_000, renewIntervalMs: 5_000, takeoverSafetyMs: 800 } });
    const playback = createPlayback({ runId: 'run-1', settings: cfg, logger: silentLogger, now: () => t, urlForAsset: () => null });
    playback.registerRenderer('A', (m) => { sent.push(m); return true; });
    playback.registerRenderer('B', (m) => { sent.push(m); return true; });
    const leaseA = playback.requestLease('A');
    expect(leaseA.ok).toBe(true); // expiresAt = 16_000,剩余 15s

    // A 断线(未确认停声):关闭事件处理延迟可超过固定安全窗,安全期限必须
    // 保留旧租约剩余生命(expiresAt + safety = 16_800),而不是断线时刻 + 800。
    playback.unregisterRenderer('A');
    t = 1_801; // 旧实现的授予时刻:仍处于旧租约生命期内,必须被拒
    const early = playback.requestLease('B');
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.retryAfterMs).toBeGreaterThan(14_000);

    t = 16_700; // 旧租约截止 + 700ms(安全窗 800 内):仍被拒
    const stillEarly = playback.requestLease('B');
    expect(stillEarly.ok).toBe(false);

    t = 16_801; // 旧租约截止 + 安全窗之后:接管成功
    const granted = playback.requestLease('B');
    expect(granted.ok).toBe(true);
  });

  it('断线端重连补发释放(停止确认)提前解除接管等待(WT-P1-004)', async () => {
    const sent: WsServerMessage[] = [];
    let t = 1_000;
    const cfg = () => ({ ...settings(), lease: { ttlMs: 15_000, renewIntervalMs: 5_000, takeoverSafetyMs: 800 } });
    const playback = createPlayback({ runId: 'run-1', settings: cfg, logger: silentLogger, now: () => t, urlForAsset: () => null });
    playback.registerRenderer('A', (m) => { sent.push(m); return true; });
    playback.registerRenderer('B', (m) => { sent.push(m); return true; });
    const leaseA = playback.requestLease('A');
    expect(leaseA.ok).toBe(true);
    const oldLeaseId = leaseA.ok ? leaseA.leaseId : '';

    playback.unregisterRenderer('A'); // A 断线,安全期限 = 16_800
    const early = playback.requestLease('B');
    expect(early.ok).toBe(false);

    // A 重连(新连接分配新 rendererId),登记后补发断线前租约的释放:真实停止确认
    playback.registerRenderer('A2', (m) => { sent.push(m); return true; });
    expect(playback.releaseLease('A2', oldLeaseId)).toBe(true);
    const immediate = playback.requestLease('B'); // 无需等安全时刻
    expect(immediate.ok).toBe(true);

    // 补发释放只匹配最近一次断线租约:无关 leaseId 不产生效果
    expect(playback.releaseLease('A2', 'lease-not-exist')).toBe(false);
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

  it('拒绝且租约视图未变化时不广播状态,避免多候补申请风暴(WT-P1-012)', async () => {
    const sent: WsServerMessage[] = [];
    let t = 1_000;
    let broadcasts = 0;
    const cfg = () => ({ ...settings(), lease: { ttlMs: 15_000, renewIntervalMs: 5_000, takeoverSafetyMs: 800 } });
    const playback = createPlayback({ runId: 'run-1', settings: cfg, logger: silentLogger, now: () => t, urlForAsset: () => null });
    playback.onChange(() => { broadcasts += 1; });
    playback.registerRenderer('A', (m) => { sent.push(m); return true; });
    playback.registerRenderer('B', (m) => { sent.push(m); return true; });
    playback.registerRenderer('C', (m) => { sent.push(m); return true; });
    const lease = playback.requestLease('A');
    expect(lease.ok).toBe(true);
    const broadcastsAfterGrant = broadcasts;

    // A 断线:安全期限内 B/C 的申请全部被拒,且拒绝不得引发状态广播
    playback.unregisterRenderer('A');
    const broadcastsAfterDisconnect = broadcasts;
    for (let i = 0; i < 20; i += 1) {
      expect(playback.requestLease('B').ok).toBe(false);
      expect(playback.requestLease('C').ok).toBe(false);
    }
    expect(broadcasts).toBe(broadcastsAfterDisconnect); // 拒绝不广播:风暴无放大器

    // 授予(安全时刻后)照常广播
    t = 17_000;
    expect(playback.requestLease('B').ok).toBe(true);
    expect(broadcasts).toBeGreaterThan(broadcastsAfterGrant + 0);
    expect(broadcasts).toBeGreaterThan(broadcastsAfterDisconnect);
  });
});

describe('opened 已开口查询(WT-P2-013 复审)', () => {
  it('音频 started→ended 保留开过口的事实:动画仍在播时查询仍为 true(反例 1)', async () => {
    let t = 0;
    const sent: WsServerMessage[] = [];
    const playback = createPlayback({ runId: 'run-open', settings, logger: silentLogger, now: () => t, urlForAsset: () => '/media/audio/x.wav' });
    playback.registerRenderer('r1', (m) => { sent.push(m); return true; });
    expect(playback.requestLease('r1').ok).toBe(true);
    void playback.play({ performance: makeAudioPerformance('pf-a'), asset: { assetId: 'a', loop: false, available: true }, signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 20));
    const dispatch = dispatchedActions(sent).at(-1)!;
    expect(dispatch.performanceId).toBe('pf-a');
    expect(playback.report({ runId: 'run-open', at: t, performanceId: 'pf-a', rendererId: 'r1', leaseId: dispatch.leaseId, track: 'animation', status: 'started' }, 'r1')).toBe('accepted');
    expect(playback.report({ runId: 'run-open', at: t, performanceId: 'pf-a', rendererId: 'r1', leaseId: dispatch.leaseId, track: 'audio', status: 'started' }, 'r1')).toBe('accepted');
    expect(playback.opened('pf-a')).toBe(true);
    // 音频自然结束、动画仍在播:开过口的事实保留
    expect(playback.report({ runId: 'run-open', at: t, performanceId: 'pf-a', rendererId: 'r1', leaseId: dispatch.leaseId, track: 'audio', status: 'ended' }, 'r1')).toBe('accepted');
    expect(playback.opened('pf-a')).toBe(true);
    // 表演结算后查询回 false
    expect(playback.report({ runId: 'run-open', at: t, performanceId: 'pf-a', rendererId: 'r1', leaseId: dispatch.leaseId, track: 'animation', status: 'ended' }, 'r1')).toBe('accepted');
    await new Promise((r) => setTimeout(r, 20));
    expect(playback.opened('pf-a')).toBe(false);
  });

  it('无租约降级为无声后按动画回执判断;动画未 started 时可让位(反例 2)', async () => {
    let t = 0;
    const sent: WsServerMessage[] = [];
    const playback = createPlayback({ runId: 'run-open2', settings, logger: silentLogger, now: () => t, urlForAsset: () => '/media/audio/x.wav' });
    // 登记播放端但不领取租约:音频降级为无声
    playback.registerRenderer('r1', (m) => { sent.push(m); return true; });
    void playback.play({ performance: makeAudioPerformance('pf-b'), asset: { assetId: 'a', loop: false, available: true }, signal: new AbortController().signal });
    t += 3_100; // 越过无租约宽限期
    await new Promise((r) => setTimeout(r, 700)); // 等待降级派发轮询
    const views = dispatchedActions(sent).filter((v) => v.performanceId === 'pf-b');
    expect(views.length).toBe(1);
    expect(views[0]!.audioUrl).toBeUndefined(); // 实际派发为无声
    expect(playback.opened('pf-b')).toBe(false); // 动画未 started:可让位
    expect(playback.report({ runId: 'run-open2', at: t, performanceId: 'pf-b', rendererId: 'r1', leaseId: views[0]!.leaseId, track: 'animation', status: 'started' }, 'r1')).toBe('accepted');
    expect(playback.opened('pf-b')).toBe(true); // 动画已开始:已开口
  });
});

describe('opened 音频故障路径(WT-P2-013 复审)', () => {
  it('音频起播前 failed 转无声:按动画是否已开始判定已开口', async () => {
    let t = 0;
    const sent: WsServerMessage[] = [];
    const playback = createPlayback({ runId: 'run-f1', settings, logger: silentLogger, now: () => t, urlForAsset: () => '/media/audio/x.wav' });
    playback.registerRenderer('r1', (m) => { sent.push(m); return true; });
    expect(playback.requestLease('r1').ok).toBe(true);
    void playback.play({ performance: makeAudioPerformance('pf-f1'), asset: { assetId: 'a', loop: false, available: true }, signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 20));
    const dispatch = dispatchedActions(sent).at(-1)!;
    expect(playback.opened('pf-f1')).toBe(false); // 音频与动画均未开始:可让位
    // 加载失败(未 started)+ 动画已开始:转无声播放,按动画边界判定
    expect(playback.report({ runId: 'run-f1', at: t, performanceId: 'pf-f1', rendererId: 'r1', leaseId: dispatch.leaseId, track: 'audio', status: 'failed' }, 'r1')).toBe('accepted');
    expect(playback.report({ runId: 'run-f1', at: t, performanceId: 'pf-f1', rendererId: 'r1', leaseId: dispatch.leaseId, track: 'animation', status: 'started' }, 'r1')).toBe('accepted');
    expect(playback.opened('pf-f1')).toBe(true);
  });

  it('音频 started 后播放出错:开过口的事实不因 failed 丢失', async () => {
    let t = 0;
    const sent: WsServerMessage[] = [];
    const playback = createPlayback({ runId: 'run-f2', settings, logger: silentLogger, now: () => t, urlForAsset: () => '/media/audio/x.wav' });
    playback.registerRenderer('r1', (m) => { sent.push(m); return true; });
    expect(playback.requestLease('r1').ok).toBe(true);
    void playback.play({ performance: makeAudioPerformance('pf-f2'), asset: { assetId: 'a', loop: false, available: true }, signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 20));
    const dispatch = dispatchedActions(sent).at(-1)!;
    expect(playback.report({ runId: 'run-f2', at: t, performanceId: 'pf-f2', rendererId: 'r1', leaseId: dispatch.leaseId, track: 'audio', status: 'started' }, 'r1')).toBe('accepted');
    expect(playback.opened('pf-f2')).toBe(true);
    // 起播后播放出错(audio failed):开过口的事实保留
    expect(playback.report({ runId: 'run-f2', at: t, performanceId: 'pf-f2', rendererId: 'r1', leaseId: dispatch.leaseId, track: 'audio', status: 'failed' }, 'r1')).toBe('accepted');
    expect(playback.opened('pf-f2')).toBe(true);
    expect(playback.report({ runId: 'run-f2', at: t, performanceId: 'pf-f2', rendererId: 'r1', leaseId: dispatch.leaseId, track: 'animation', status: 'started' }, 'r1')).toBe('accepted');
    expect(playback.opened('pf-f2')).toBe(true);
  });

  it('音频仍在准备且动画已开始:保留让位行为(opened false)', async () => {
    let t = 0;
    const sent: WsServerMessage[] = [];
    const playback = createPlayback({ runId: 'run-f3', settings, logger: silentLogger, now: () => t, urlForAsset: () => '/media/audio/x.wav' });
    playback.registerRenderer('r1', (m) => { sent.push(m); return true; });
    expect(playback.requestLease('r1').ok).toBe(true);
    void playback.play({ performance: makeAudioPerformance('pf-f3'), asset: { assetId: 'a', loop: false, available: true }, signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 20));
    const dispatch = dispatchedActions(sent).at(-1)!;
    expect(playback.report({ runId: 'run-f3', at: t, performanceId: 'pf-f3', rendererId: 'r1', leaseId: dispatch.leaseId, track: 'animation', status: 'started' }, 'r1')).toBe('accepted');
    expect(playback.opened('pf-f3')).toBe(false); // 音频 pending 仍可起播:保留让位
  });
});
