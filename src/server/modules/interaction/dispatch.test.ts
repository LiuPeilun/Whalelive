import { describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '../../../shared/live-event.js';
import type { EffectiveSettings } from '../../../shared/settings.js';
import type { Performance } from '../../../shared/performance.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { CharactersModule } from '../characters/index.js';
import type { PlaybackModule } from '../playback/index.js';
import type { ReplyProvider, SpeechProvider } from './providers.js';
import { createInteraction } from './index.js';
import { resolveGiftRules } from './rules.js';

// P1 第一批:生成移到出队后 —— 指令短路、语义弹幕经回复提供方、
// 提供方超时/空回复走保底、语音合成挂到表演、人工停止丢弃迟到结果。

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
  return {
    reload: () => {},
    petId: () => 'main',
    view: () => ({ petId: 'main', name: 'x', licenseName: 'x', actions: [] }),
    resolveAction: (id: string) => (['idle', 'talk', 'wave', 'dance'].includes(id) ? { actionId: id, file: `animations/${id}.webm`, loop: id === 'talk', available: true } : null),
    resolveAsset: () => null,
    missingActions: () => [],
  };
}

type PlayCapture = { performance: Performance; signal: AbortSignal };

function fakePlayback(): { module: PlaybackModule; plays: PlayCapture[]; results: Map<string, Promise<{ status: 'ended' | 'cancelled' | 'failed' }>> } {
  const plays: PlayCapture[] = [];
  const results = new Map<string, Promise<{ status: 'ended' | 'cancelled' | 'failed' }>>();
  const module: PlaybackModule = {
    registerRenderer: () => {},
    unregisterRenderer: () => {},
    requestLease: () => ({ ok: true, leaseId: 'l', ttlMs: 1, renewIntervalMs: 1 }),
    renewLease: () => true,
    releaseLease: () => true,
    report: () => 'stale',
    play: (input) => {
      plays.push({ performance: input.performance, signal: input.signal });
      const p = new Promise<{ performanceId: string; status: 'ended' | 'cancelled' }>((resolve) => {
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
      results.set(input.performance.id, p);
      return p;
    },
    stop: () => {},
    tick: () => {},
    view: () => ({ status: 'idle', performanceId: null, action: null }),
    renderersView: () => ({ count: 0, primaryRendererId: null, leaseHolderRendererId: null, leaseExpiresAt: null }),
    onChange: () => () => {},
  };
  return { module, plays, results };
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

const persona = { name: '大肥鱼', fallbackReplies: ['保底回复A', '保底回复B'], commandReplies: { dance: '看好啦!' } };
const giftRules = resolveGiftRules({ thanksTemplate: '谢谢 {user} 的 {gift} ×{count}!', celebrateText: '{kind}!' });

function build(opts: { reply?: Partial<ReplyProvider>; speech?: Partial<SpeechProvider>; now?: () => number } = {}) {
  const playback = fakePlayback();
  const reply: ReplyProvider = { generate: opts.reply?.generate ?? (async () => ({ say: '生成的话', action: null })) };
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
    now: opts.now ?? (() => Date.now()),
  });
  return { interaction, playback };
}

const settle = () => new Promise((r) => setTimeout(r, 25));

describe('interaction 生成链路(P1 第一批)', () => {
  it('语义弹幕:出队后经回复提供方,动作白名单校验,语音挂到表演', async () => {
    const generate = vi.fn(async () => ({ say: '今天吃火锅呀', action: 'dance' }));
    const { interaction, playback } = build({ reply: { generate } });
    interaction.enqueue(chatEvent('今晚想去哪玩'));
    await settle();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(playback.plays.length).toBe(1);
    const perf = playback.plays[0]!.performance;
    expect(perf.say).toBe('今天吃火锅呀');
    expect(perf.action).toBe('dance'); // 白名单内采纳
    expect(perf.audioUrl).toBe('/media/audio/t.wav');
  });

  it('提供方建议白名单外动作时回退 talk,不采纳', async () => {
    const { interaction, playback } = build({ reply: { generate: async () => ({ say: '嗯', action: '不存在动作' }) } });
    interaction.enqueue(chatEvent('随便聊聊'));
    await settle();
    expect(playback.plays[0]!.performance.action).toBe('talk');
  });

  it('指令弹幕短路提供方:直接使用规则文本', async () => {
    const generate = vi.fn(async () => ({ say: '不应调用', action: null }));
    const { interaction, playback } = build({ reply: { generate } });
    interaction.enqueue(chatEvent('大肥鱼跳个舞'));
    await settle();
    expect(generate).not.toHaveBeenCalled();
    expect(playback.plays[0]!.performance.say).toBe('看好啦!');
    expect(playback.plays[0]!.performance.action).toBe('dance');
  });

  it('提供方超时:回落保底文本,表演仍成立并带语音', async () => {
    const generate: ReplyProvider['generate'] = () => new Promise(() => { /* 永不返回 */ });
    const { interaction, playback } = build({ reply: { generate } });
    interaction.enqueue(chatEvent('慢慢想'));
    await new Promise((r) => setTimeout(r, 120));
    expect(playback.plays.length).toBe(1);
    expect(playback.plays[0]!.performance.say).toBe('保底回复A');
  });

  it('提供方拒绝(非超时):回落保底文本,任务照常派发(WT-P1-001)', async () => {
    const { interaction, playback } = build({ reply: { generate: async () => { throw new Error('provider down'); } } });
    interaction.enqueue(chatEvent('聊聊天气'));
    await settle();
    expect(playback.plays.length).toBe(1);
    expect(playback.plays[0]!.performance.say).toBe('保底回复A');
    expect(playback.plays[0]!.performance.audioUrl).toBeDefined();
  });

  it('合成拒绝(非超时):降级无声表演,队列继续处理下一条(WT-P1-001)', async () => {
    const { interaction, playback } = build({ speech: { synthesize: async () => { throw new Error('ENOENT'); } } });
    interaction.enqueue(chatEvent('第一条话题'));
    await settle();
    interaction.enqueue(chatEvent('第二条话题', 'u2'));
    await settle();
    expect(playback.plays.length).toBe(2); // 第一条未阻塞第二条
    expect(playback.plays[0]!.performance.audioUrl).toBeUndefined(); // 第一条无声降级
    expect(playback.plays[1]!.performance.say).toBe('生成的话'); // 第二条正常
    expect(interaction.state().current === null || interaction.state().current?.performanceId !== playback.plays[0]!.performance.id).toBe(true);
  });

  it('合成失败:降级为无声表演(audioUrl 缺省),文本与动作保留', async () => {
    const { interaction, playback } = build({ speech: { synthesize: async () => null } });
    interaction.enqueue(chatEvent('随便聊聊'));
    await settle();
    const perf = playback.plays[0]!.performance;
    expect(perf.say).toBe('生成的话');
    expect(perf.audioUrl).toBeUndefined();
  });

  it('紧急停止:生成中的任务被丢弃,不再派发', async () => {
    let release!: (v: { say: string; action: string | null }) => void;
    const generate: ReplyProvider['generate'] = () => new Promise((resolve) => { release = resolve; });
    const { interaction, playback } = build({ reply: { generate } });
    interaction.enqueue(chatEvent('慢速生成'));
    await settle();
    expect(playback.plays.length).toBe(0); // 生成中
    interaction.stop();
    release({ say: '迟到的话', action: null });
    await settle();
    expect(playback.plays.length).toBe(0); // 迟到结果被丢弃
    expect(interaction.state().paused).toBe(true);
  });
});

describe('interaction 阶段耗时与用量统计(P1 第三批)', () => {
  it('完成后记录各阶段耗时、来源与 token 用量并累计', async () => {
    const generate = async () => ({
      say: '模型回复', action: null, provider: 'deepseek',
      usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
    });
    const { interaction } = build({ reply: { generate } });
    interaction.enqueue(chatEvent('统计场景'));
    await settle();
    const m = interaction.state().metrics;
    expect(m.completed).toBe(1);
    expect(m.last?.provider).toBe('deepseek');
    expect(m.last?.usage).toEqual({ promptTokens: 12, completionTokens: 8, totalTokens: 20 });
    expect(m.last?.generationMs).not.toBeNull();
    expect(m.last?.playbackMs).not.toBeNull();
    expect(m.totals.totalTokens).toBe(20);
  });

  it('保底回复来源标记为 fallback', async () => {
    const { interaction } = build({ reply: { generate: async () => { throw new Error('down'); } } });
    interaction.enqueue(chatEvent('保底场景'));
    await settle();
    expect(interaction.state().metrics.last?.provider).toBe('fallback');
  });

  it('确定性指令来源标记为 rule,不累计 token', async () => {
    const { interaction } = build();
    interaction.enqueue(chatEvent('大肥鱼跳个舞'));
    await settle();
    const m = interaction.state().metrics;
    expect(m.last?.provider).toBe('rule');
    expect(m.totals.totalTokens).toBe(0);
  });

  it('规则语音回复也记录合成耗时(synthesisMs 非空)(WT-P1-022)', async () => {
    const { interaction } = build();
    interaction.enqueue(chatEvent('大肥鱼跳个舞')); // 确定性指令,有 say 且有音频
    await settle();
    const last = interaction.state().metrics.last;
    expect(last?.provider).toBe('rule');
    expect(last?.synthesisMs).not.toBeNull();
    expect(last?.generationMs).toBeNull(); // 规则回复无生成阶段
  });

  it('非法输出但上游有用量时仍累计 token(WT-P1-022)', async () => {
    const { interaction } = build({
      reply: {
        generate: async () => ({
          say: '   ', action: null, provider: 'deepseek',
          usage: { promptTokens: 10, completionTokens: 22, totalTokens: 32 },
        }),
      },
    });
    interaction.enqueue(chatEvent('非法输出'));
    await settle();
    const m = interaction.state().metrics;
    expect(m.last?.provider).toBe('fallback'); // 空 say 走保底
    expect(m.totals.totalTokens).toBe(32); // 用量不丢
  });

  it('模型响应后紧急停止,用量仍计入且留下统计(WT-P1-022)', async () => {
    const { interaction } = build({
      reply: {
        generate: async () => ({
          say: '回复', action: null, provider: 'deepseek',
          usage: { promptTokens: 10, completionTokens: 22, totalTokens: 32 },
        }),
      },
    });
    interaction.enqueue(chatEvent('停止场景'));
    await settle();
    interaction.stop();
    const m = interaction.state().metrics;
    expect(m.totals.totalTokens).toBe(32);
    expect(m.last?.usage?.totalTokens).toBe(32);
  });

  it('排队耗时不含生成耗时:出队即截止排队(WT-P1-022)', async () => {
    let clock = 1000;
    // 生成耗时 500ms:出队时 clock=1000,生成结束 clock=1500
    const { interaction } = build({
      now: () => clock,
      reply: {
        generate: async () => {
          clock += 500;
          return { say: '慢回复', action: null, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
        },
      },
    });
    interaction.enqueue(chatEvent('计时场景'));
    // 入队时 clock=1000;tick 出队需等一个周期,推进时钟
    await new Promise((r) => setTimeout(r, 20));
    const last = interaction.state().metrics.last;
    expect(last).not.toBeNull();
    // 排队 = 出队 - 入队,二者都在入队后很近;生成 500ms 不应计入排队
    expect(last!.queueWaitMs).toBeLessThan(100);
    expect(last!.generationMs).toBe(500);
  });
});
