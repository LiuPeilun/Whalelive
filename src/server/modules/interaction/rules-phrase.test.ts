import { describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '../../../shared/live-event.js';
import type { EffectiveSettings } from '../../../shared/settings.js';
import type { Performance } from '../../../shared/performance.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { CharactersModule } from '../characters/index.js';
import type { PlaybackModule } from '../playback/index.js';
import type { ReplyProvider, SpeechProvider } from './providers.js';
import { createInteraction } from './index.js';

// P2 第一批:明确口令彩蛋(整句全等)与控制台试播台词。
// 口令与包含类指令的边界:「敬个礼」独立触发;含口令词的正常提问走问答流程。

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
    queue: { capacity: 20, chatTtlMs: 30_000, userCooldownMs: 0 },
    gift: { mergeWindowMs: 2_000 },
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
  return {
    reload: () => {},
    petId: () => 'main',
    view: () => ({ petId: 'main', name: 'x', licenseName: 'x', actions: [] }),
    resolveAction: (id: string) =>
      (['idle', 'talk', 'wave', 'dance', 'salute', 'sip-tea', 'talk-nod'].includes(id)
        ? { actionId: id, file: `animations/${id}.webm`, loop: id === 'talk' || id === 'talk-nod', available: true }
        : null),
    resolveAsset: () => null,
    missingActions: () => [],
  };
}

function fakePlayback(): { module: PlaybackModule; plays: Array<{ performance: Performance; signal: AbortSignal }> } {
  const plays: Array<{ performance: Performance; signal: AbortSignal }> = [];
  const module: PlaybackModule = {
    registerRenderer: () => {},
    unregisterRenderer: () => {},
    requestLease: () => ({ ok: true, leaseId: 'l', ttlMs: 1, renewIntervalMs: 1 }),
    renewLease: () => true,
    releaseLease: () => true,
    report: () => 'stale',
    play: (input) => {
      plays.push({ performance: input.performance, signal: input.signal });
      return new Promise((resolve) => {
        setTimeout(() => resolve({ performanceId: input.performance.id, status: 'ended' }), 5);
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

function chatEvent(text: string, user = 'u1'): LiveEvent {
  return {
    id: `evt-${text}`,
    sourceKey: `sk-${text}-${user}`,
    source: 'mock',
    roomId: 'r',
    type: 'chat',
    user: { id: user, name: user },
    text,
    receivedAt: Date.now(),
  };
}

const persona = {
  name: '大肥鱼',
  fallbackReplies: ['保底回复A'],
  commandReplies: {
    salute: '收到!潮汐邮差向您敬礼~',
    'sip-tea': '一起喝口茶,慢慢聊~',
  },
};
const giftRules = { thanksTemplate: '谢谢 {user}!', celebrateText: '{kind}!' };

function build(opts: { reply?: Partial<ReplyProvider>; speech?: Partial<SpeechProvider> } = {}) {
  const playback = fakePlayback();
  const generate = vi.fn(opts.reply?.generate ?? (async (input: { text: string }) => ({ say: '生成的话', action: null, provider: 'rule' })));
  const reply: ReplyProvider = { generate: generate as unknown as ReplyProvider['generate'] };
  const speech: SpeechProvider = { synthesize: opts.speech?.synthesize ?? (async () => ({ audioUrl: '/media/audio/t.wav', audioId: 't.wav' })) };
  const interaction = createInteraction({
    settings,
    characters: fakeCharacters(),
    playback: playback.module,
    replyProvider: reply,
    speechProvider: speech,
    persona,
    giftRules,
    logger: silentLogger,
    now: () => Date.now(),
  });
  return { interaction, playback, generate };
}

const settle = () => new Promise((r) => setTimeout(r, 25));

describe('明确口令彩蛋(P2 第一批)', () => {
  it('「敬个礼」整句触发 salute,回复来自人设模板,不走模型', async () => {
    const { interaction, playback, generate } = build();
    interaction.enqueue(chatEvent('敬个礼'));
    await settle();
    expect(playback.plays).toHaveLength(1);
    expect(playback.plays[0]!.performance.action).toBe('salute');
    expect(playback.plays[0]!.performance.say).toBe('收到!潮汐邮差向您敬礼~');
    expect(generate).not.toHaveBeenCalled();
  });

  it('「喝口茶」整句触发 sip-tea', async () => {
    const { interaction, playback, generate } = build();
    interaction.enqueue(chatEvent('喝口茶'));
    await settle();
    expect(playback.plays).toHaveLength(1);
    expect(playback.plays[0]!.performance.action).toBe('sip-tea');
    expect(generate).not.toHaveBeenCalled();
  });

  it('带首尾空格的口令仍命中(trim 后全等)', async () => {
    const { interaction, playback } = build();
    interaction.enqueue(chatEvent('  敬个礼  '));
    await settle();
    expect(playback.plays).toHaveLength(1);
    expect(playback.plays[0]!.performance.action).toBe('salute');
  });

  it('含口令词的正常提问不命中口令,进入问答流程', async () => {
    const { interaction, playback, generate } = build();
    interaction.enqueue(chatEvent('主播可以敬个礼吗'));
    await settle();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0].text).toBe('主播可以敬个礼吗');
    // 语义回复默认通用口型 talk(问答默认动作),未被口令改写
    expect(playback.plays[0]!.performance.action).toBe('talk');
    expect(playback.plays[0]!.performance.say).toBe('生成的话');
  });

  it('其他提问不受口令影响,照常走问答', async () => {
    const { interaction, playback, generate } = build();
    interaction.enqueue(chatEvent('今天天气怎么样'));
    await settle();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(playback.plays[0]!.performance.say).toBe('生成的话');
  });
});

describe('控制台试播台词(P2 第一批)', () => {
  it('manualAction 带台词:动作与台词透传到表演(口型循环验证的数据通路)', async () => {
    const { interaction, playback } = build();
    const say = '这是一段明显长于口型动画的测试台词,用来验证循环到语音结束';
    interaction.manualAction('talk-nod', say);
    await settle();
    expect(playback.plays).toHaveLength(1);
    expect(playback.plays[0]!.performance.action).toBe('talk-nod');
    expect(playback.plays[0]!.performance.say).toBe(say);
  });

  it('manualAction 不带台词:保持原行为,只播动作', async () => {
    const { interaction, playback } = build();
    interaction.manualAction('salute');
    await settle();
    expect(playback.plays).toHaveLength(1);
    expect(playback.plays[0]!.performance.action).toBe('salute');
    expect(playback.plays[0]!.performance.say).toBe('');
  });

  it('试播台词超长截断到上限', async () => {
    const { interaction, playback } = build();
    interaction.manualAction('talk', '长'.repeat(200));
    await settle();
    expect(playback.plays[0]!.performance.say?.length ?? 0).toBeLessThanOrEqual(120);
  });
});
