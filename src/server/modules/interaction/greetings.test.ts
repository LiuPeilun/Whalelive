import { describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '../../../shared/live-event.js';
import type { EffectiveSettings } from '../../../shared/settings.js';
import type { Performance } from '../../../shared/performance.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { CharactersModule } from '../characters/index.js';
import type { PlaybackModule } from '../playback/index.js';
import type { ReplyProvider, SpeechProvider } from './providers.js';
import { createInteraction } from './index.js';
import { resolveGiftRules, resolveGreetings } from './rules.js';

// P2 互动第三批:进场/关注/分享播报、冷场自救话题(触发/间隔门/真实互动取消)。
// 优先级栈(v1.1):彩蛋(聊天 40)> 关注/分享 30 > 进场 25 > 闲聊 10。

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => ({ ...silentLogger, child: () => silentLogger }),
};

let t = 0;

function settings(): EffectiveSettings {
  return {
    petId: 'main',
    queue: { capacity: 20, chatTtlMs: 30_000, userCooldownMs: 0 },
    gift: { mergeWindowMs: 2_000, tiering: { smallMaxYuan: 1, largeMinYuan: 10, peakMergeCount: 6 } },
    greetings: { enabled: true, enterWindowMs: 10_000, maxNamedCount: 3, allRoomIntervalMs: 60_000, coldIdleMs: 2_000, coldIntervalMs: 5_000 },
    playback: { preloadTimeoutMs: 8_000, overallTimeoutMs: 120_000, noRendererGraceMs: 3_000 },
    lease: { ttlMs: 15_000, renewIntervalMs: 5_000, takeoverSafetyMs: 0 },
    tts: { provider: 'fixed-local', voice: 'zh-CN-XiaoxiaoNeural' },
    llm: { provider: 'fixed-local' },
    server: { host: '127.0.0.1', port: 3210 },
    platform: 'mock',
    auth: { timeoutMs: 5_000 },
    generation: { llmTimeoutMs: 60, ttsTimeoutMs: 60 },
  };
}

function fakeCharacters(): CharactersModule {
  const loopActions = ['talk', 'talk-nod', 'talk-serious'];
  return {
    reload: () => {},
    petId: () => 'main',
    view: () => ({ petId: 'main', name: 'x', licenseName: 'x', actions: [] }),
    resolveAction: (id: string) => (['idle', 'talk', 'wave', 'laugh', 'talk-serious'].includes(id) ? { actionId: id, file: `animations/${id}.webm`, loop: loopActions.includes(id), available: true } : null),
    resolveAsset: () => null,
    missingActions: () => [],
  };
}

type PlayCapture = { performance: Performance; signal: AbortSignal };

function fakePlayback(): { module: PlaybackModule; plays: PlayCapture[] } {
  const plays: PlayCapture[] = [];
  const module: PlaybackModule = {
    registerRenderer: () => {},
    unregisterRenderer: () => {},
    requestLease: () => ({ ok: true, leaseId: 'l', ttlMs: 1, renewIntervalMs: 1 }),
    renewLease: () => true,
    releaseLease: () => true,
    report: () => 'stale',
    play: (input) => {
      plays.push({ performance: input.performance, signal: input.signal });
      return new Promise<{ performanceId: string; status: 'ended' | 'cancelled' }>((resolve) => {
        const timer = setTimeout(() => resolve({ performanceId: input.performance.id, status: 'ended' }), 5);
        input.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve({ performanceId: input.performance.id, status: 'cancelled' });
          },
          { once: true },
        );
      });
    },
    stop: () => {},
    tick: () => {},
    view: () => ({ status: 'idle', performanceId: null, action: null }),
    renderersView: () => ({ count: 0, primaryRendererId: null, leaseHolderRendererId: null, leaseExpiresAt: null }),
    onChange: () => () => {},
  };
  return { module, plays };
}

function event(type: LiveEvent['type'], user: string): LiveEvent {
  return { id: `evt-${type}-${user}`, sourceKey: `sk-${type}-${user}-${t}`, source: 'mock', roomId: 'r', type, user: { id: user, name: user }, receivedAt: Date.now() };
}

const persona = { name: '大肥鱼', fallbackReplies: ['保底回复'], commandReplies: {} };
const giftRules = resolveGiftRules({});
const greetings = resolveGreetings({});

function build() {
  const playback = fakePlayback();
  const generate = vi.fn(async (input: { text: string }) => ({ say: `话题:${input.text}`, action: null }));
  const reply: ReplyProvider = { generate } as unknown as ReplyProvider;
  const speech: SpeechProvider = { synthesize: async () => ({ audioUrl: '/media/audio/t.wav', audioId: 't.wav' }) };
  const interaction = createInteraction({
    settings,
    characters: fakeCharacters(),
    playback: playback.module,
    replyProvider: reply,
    speechProvider: speech,
    persona,
    giftRules,
    greetings,
    logger: silentLogger,
    now: () => t,
  });
  return { interaction, playback, generate };
}

const settle = () => new Promise((r) => setTimeout(r, 25));

describe('进场/关注/分享播报(互动第三批)', () => {
  it('进场窗口关闭产出念名欢迎:enter 类型、优先级 25、wave 动作', async () => {
    t = 0;
    const { interaction, playback } = build();
    interaction.enqueue(event('enter', '甲'));
    t += 10_000;
    interaction.tick();
    await settle();
    const p = playback.plays[0]?.performance;
    expect(p?.action).toBe('wave');
    expect(p?.priority).toBe(25);
    expect(p?.say).toContain('甲');
  });

  it('关注与分享:优先级 30,文案按事件种类区分', async () => {
    t = 0;
    const { interaction, playback } = build();
    interaction.enqueue(event('follow', '粉丝甲'));
    interaction.enqueue(event('share', '粉丝乙'));
    t += 100;
    interaction.tick();
    await settle();
    interaction.tick();
    await settle();
    expect(playback.plays.length).toBe(2);
    const says = playback.plays.map((p) => p.performance.say).join('|');
    expect(says).toContain('关注');
    expect(says).toContain('分享');
    for (const play of playback.plays) expect(play.performance.priority).toBe(30);
  });

  it('问候开关关闭:进场只记活跃不产生播报', async () => {
    const disabled = settings();
    disabled.greetings.enabled = false;
    t = 0;
    const playback = fakePlayback();
    const interaction = createInteraction({
      settings: () => disabled,
      characters: fakeCharacters(),
      playback: playback.module,
      replyProvider: { generate: async () => ({ say: 'x', action: null }) },
      speechProvider: { synthesize: async () => ({ audioUrl: '/media/audio/t.wav', audioId: 't.wav' }) },
      persona,
      giftRules,
      greetings,
      logger: silentLogger,
      now: () => t,
    });
    const accepted = interaction.enqueue(event('enter', '甲'));
    expect(accepted.accepted).toBe(true);
    t += 10_000;
    interaction.tick();
    await settle();
    expect(playback.plays.length).toBe(0);
    expect(interaction.state().queue.length).toBe(0);
  });
});

describe('冷场自救(互动第三批)', () => {
  it('空闲满阈值且服务空闲时,冷场话题入队并经回复提供方生成', async () => {
    t = 0;
    const { interaction, playback, generate } = build();
    t += 5_100; // coldIdleMs=2000 静默满阈值;初始 lastColdAt=0,间隔 5000 也已过
    interaction.tick();
    await settle();
    const p = playback.plays[0]?.performance;
    expect(p?.action).toBe('talk-serious');
    expect(p?.priority).toBe(10);
    expect(generate).toHaveBeenCalledTimes(1);
    const callText = (generate.mock.calls[0]?.[0] as { text: string }).text;
    expect(typeof callText).toBe('string');
    expect(callText.length).toBeGreaterThan(0);
    expect(p?.say).toContain('话题:');
  });

  it('间隔门:两次话题的最小间隔(coldIntervalMs=5000)约束生效', async () => {
    t = 0;
    const { interaction, playback } = build();
    t += 5_100;
    interaction.tick(); // 冷场话题 #1(此刻间隔已过)
    await settle();
    expect(playback.plays.length).toBe(1);
    t += 2_000; // 静默满阈值,但距上次话题 2000 < 5000
    interaction.tick();
    await settle();
    expect(playback.plays.length).toBe(1); // 间隔门拦截
    expect(interaction.state().queue.length).toBe(0);
    t += 3_100; // 距上次话题 5100 ≥ 5000,静默也满阈值
    interaction.tick();
    await settle();
    expect(playback.plays.length).toBe(2); // 间隔已过:第二条话题
  });

  it('真实互动(聊天)取消尚未开口的冷场话题,并以 cold-superseded 记录', async () => {
    t = 0;
    const { interaction, playback } = build();
    interaction.pause();
    t += 5_100;
    interaction.tick(); // 冷场话题入队(暂停未派发)
    expect(interaction.state().queue.items.some((i) => i.type === 'idle')).toBe(true);
    interaction.enqueue(event('chat', '观众'));
    const snapshot = interaction.state().queue;
    expect(snapshot.items.some((i) => i.type === 'idle')).toBe(false);
    expect(snapshot.drops.some((d) => d.reason === 'cold-superseded')).toBe(true);
    interaction.resume();
    await settle();
    void playback;
  });

  it('取消冷场同时刷新活跃锚点:取消后短时间内不再触发新话题', async () => {
    t = 0;
    const { interaction, playback } = build();
    interaction.pause();
    t += 5_100;
    interaction.tick(); // 冷场话题入队
    t += 50;
    interaction.enqueue(event('chat', '观众')); // 取消 + 活跃锚点刷新到 t=5150
    interaction.resume();
    await settle();
    t += 1_000; // 距活跃刷新仅 1000 < coldIdleMs 2000
    interaction.tick();
    await settle();
    expect(playback.plays.some((p) => p.performance.action === 'talk-serious')).toBe(false);
  });

  it('人工试播不算观众互动:不取消冷场话题', async () => {
    t = 0;
    const { interaction } = build();
    interaction.pause();
    t += 5_100;
    interaction.tick(); // 冷场话题入队
    interaction.manualAction('wave');
    expect(interaction.state().queue.items.some((i) => i.type === 'idle')).toBe(true);
    interaction.resume();
  });

  it('待播队列非空时不触发冷场(无待播条件)', async () => {
    t = 0;
    const { interaction, playback } = build();
    interaction.pause();
    interaction.enqueue(event('follow', '粉丝甲')); // 队列有待播关注答谢
    t += 5_100;
    interaction.tick(); // 暂停态:冷场被"无待播"条件拦截,不产生话题
    await settle();
    expect(playback.plays.some((p) => p.performance.action === 'talk-serious')).toBe(false);
    expect(interaction.state().queue.items.some((i) => i.type === 'idle')).toBe(false);
    interaction.resume();
  });
});
