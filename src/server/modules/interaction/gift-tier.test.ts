import { describe, expect, it } from 'vitest';
import type { LiveEvent } from '../../../shared/live-event.js';
import type { EffectiveSettings } from '../../../shared/settings.js';
import type { Performance } from '../../../shared/performance.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { CharactersModule } from '../characters/index.js';
import type { PlaybackModule } from '../playback/index.js';
import type { ReplyProvider, SpeechProvider } from './providers.js';
import { createInteraction } from './index.js';
import { resolveGiftRules } from './rules.js';

// P2 互动第二批:礼物三档分层答谢、SC/大航海归大额档、调度层高峰降级合并。
// 金额语义:仅金瓜子(gold)计价;免费/银瓜子/未知价格一律小额(v1.1 修正 2)。

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
  const loopActions = ['talk', 'talk-nod'];
  return {
    reload: () => {},
    petId: () => 'main',
    view: () => ({ petId: 'main', name: 'x', licenseName: 'x', actions: [] }),
    resolveAction: (id: string) => (['idle', 'talk', 'talk-nod', 'laugh', 'stamp-letter'].includes(id) ? { actionId: id, file: `animations/${id}.webm`, loop: loopActions.includes(id), available: true } : null),
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

function giftEvent(opts: { user: string; giftId?: string; giftName?: string; quantity?: number; coinType?: string; unitPrice?: number }): LiveEvent {
  return {
    id: `evt-${opts.user}-${opts.giftId ?? 'g'}`,
    sourceKey: `sk-${opts.user}-${opts.giftId ?? 'g'}-${t}`,
    source: 'mock',
    roomId: 'r',
    type: 'gift',
    user: { id: opts.user, name: opts.user },
    gift: {
      id: opts.giftId ?? 'g',
      name: opts.giftName ?? '礼物',
      quantity: opts.quantity ?? 1,
      ...(opts.coinType !== undefined ? { coinType: opts.coinType } : {}),
      ...(opts.unitPrice !== undefined ? { unitPrice: opts.unitPrice } : {}),
    },
    receivedAt: Date.now(),
  };
}

function guardEvent(user: string): LiveEvent {
  return { id: `evt-guard-${user}`, sourceKey: `sk-guard-${user}`, source: 'mock', roomId: 'r', type: 'guard', user: { id: user, name: user }, receivedAt: Date.now() };
}

function superchatEvent(user: string): LiveEvent {
  return { id: `evt-sc-${user}`, sourceKey: `sk-sc-${user}`, source: 'mock', roomId: 'r', type: 'superchat', user: { id: user, name: user }, text: '上榜留言', receivedAt: Date.now() };
}

const persona = { name: '大肥鱼', fallbackReplies: ['保底回复'], commandReplies: {} };
const giftRules = resolveGiftRules({});

function build() {
  const playback = fakePlayback();
  const reply: ReplyProvider = { generate: async () => ({ say: '生成的话', action: null }) };
  const speech: SpeechProvider = { synthesize: async () => ({ audioUrl: '/media/audio/t.wav', audioId: 't.wav' }) };
  const interaction = createInteraction({
    settings,
    characters: fakeCharacters(),
    playback: playback.module,
    replyProvider: reply,
    speechProvider: speech,
    persona,
    giftRules,
    logger: silentLogger,
    now: () => t,
  });
  return { interaction, playback };
}

const settle = () => new Promise((r) => setTimeout(r, 25));

describe('礼物分层答谢入队(P2 第二批)', () => {
  it('金瓜子 15 元礼物走大额档:stamp-letter、优先级 80、文案含礼物与仪式感(金额占位符见 rules-tier.test)', async () => {
    t = 0;
    const { interaction, playback } = build();
    interaction.enqueue(giftEvent({ user: '土豪', giftId: 'rocket', giftName: '火箭', quantity: 1, coinType: 'gold', unitPrice: 15 }));
    t += 2000;
    interaction.tick();
    await settle();
    const p = playback.plays[0]?.performance;
    expect(p?.action).toBe('stamp-letter');
    expect(p?.priority).toBe(80);
    expect(p?.say).toContain('土豪');
    expect(p?.say).toContain('火箭');
    expect(p?.say).not.toContain('{');
  });

  it('5 元礼物走中额档:laugh、优先级 66', async () => {
    t = 0;
    const { interaction, playback } = build();
    interaction.enqueue(giftEvent({ user: '常客', giftId: 'lida', giftName: '礼花', quantity: 1, coinType: 'gold', unitPrice: 5 }));
    t += 2000;
    interaction.tick();
    await settle();
    const p = playback.plays[0]?.performance;
    expect(p?.action).toBe('laugh');
    expect(p?.priority).toBe(66);
    expect(p?.say).toContain('礼花');
  });

  it('无价格与银瓜子礼物走小额档:talk-nod、优先级 60', async () => {
    t = 0;
    const { interaction, playback } = build();
    interaction.enqueue(giftEvent({ user: '路人甲', giftId: 'free1', giftName: '小心心' }));
    interaction.enqueue(giftEvent({ user: '路人乙', giftId: 'free2', giftName: '辣条', coinType: 'silver', unitPrice: 0.1 }));
    t += 2000;
    interaction.tick();
    await settle();
    interaction.tick();
    await settle();
    expect(playback.plays.length).toBe(2);
    for (const play of playback.plays) {
      expect(play.performance.action).toBe('talk-nod');
      expect(play.performance.priority).toBe(60);
    }
  });

  it('SC 与大航海归大额档:stamp-letter,文案复用大额模板', async () => {
    t = 0;
    const { interaction, playback } = build();
    interaction.enqueue(guardEvent('舰长甲'));
    interaction.enqueue(superchatEvent('SC乙'));
    interaction.tick();
    await settle();
    interaction.tick();
    await settle();
    expect(playback.plays.length).toBe(2);
    for (const play of playback.plays) expect(play.performance.action).toBe('stamp-letter');
    const kinds = playback.plays.map((p) => p.performance.say).join('|');
    expect(kinds).toContain('大航海');
    expect(kinds).toContain('醒目留言');
  });
});

describe('高峰降级合并(P2 第二批)', () => {
  it('待播小额达 6 条合并为一句,人名截断 5 个并加"等朋友"', async () => {
    t = 0;
    const { interaction, playback } = build();
    for (const u of ['甲', '乙', '丙', '丁', '戊', '己']) {
      interaction.enqueue(giftEvent({ user: u, giftId: `xinxin-${u}`, giftName: '小心心' }));
    }
    t += 2000;
    interaction.tick();
    await settle();
    const p = playback.plays[0]?.performance;
    expect(p?.action).toBe('talk-nod');
    expect(p?.say).toContain('甲、乙、丙、丁、戊 等朋友');
    expect(p?.say).not.toContain('己');
    expect(interaction.state().queue.length).toBe(0);
  });

  it('合并保留大额独立答谢:大额先播,合并句后播', async () => {
    t = 0;
    const { interaction, playback } = build();
    for (const u of ['甲', '乙', '丙', '丁', '戊', '己']) {
      interaction.enqueue(giftEvent({ user: u, giftId: `xinxin-${u}`, giftName: '小心心' }));
    }
    interaction.enqueue(giftEvent({ user: '土豪', giftId: 'rocket', giftName: '火箭', quantity: 1, coinType: 'gold', unitPrice: 15 }));
    t += 2000;
    interaction.tick();
    await settle();
    expect(playback.plays[0]?.performance.action).toBe('stamp-letter');
    interaction.tick();
    await settle();
    expect(playback.plays[1]?.performance.action).toBe('talk-nod');
    expect(playback.plays[1]?.performance.say).toContain('等朋友');
    expect(interaction.state().queue.length).toBe(0);
  });

  it('中额礼物不参与合并:逐条独立答谢', async () => {
    t = 0;
    const { interaction, playback } = build();
    for (const u of ['甲', '乙', '丙', '丁', '戊', '己']) {
      interaction.enqueue(giftEvent({ user: u, giftId: `lida-${u}`, giftName: '礼花', quantity: 1, coinType: 'gold', unitPrice: 5 }));
    }
    t += 2000;
    interaction.tick();
    await settle();
    // 派发链会连续消费多条;断言所有已播的都是独立中额答谢(无合并句),且无 peak-merged 丢弃。
    expect(playback.plays.length).toBeGreaterThanOrEqual(1);
    for (const play of playback.plays) {
      expect(play.performance.action).toBe('laugh');
      expect(play.performance.say).toContain('礼花');
    }
    expect(interaction.state().queue.drops.some((d) => d.reason === 'peak-merged')).toBe(false);
  });
});
