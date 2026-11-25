import { afterAll, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '../../../shared/live-event.js';
import type { EffectiveSettings } from '../../../shared/settings.js';
import type { Performance } from '../../../shared/performance.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { CharactersModule } from '../characters/index.js';
import type { PlaybackModule } from '../playback/index.js';
import type { ReplyProvider, SpeechProvider } from './providers.js';
import { createInteraction } from './index.js';
import type { SingingModule, SongReadyPayload } from '../singing/index.js';
import { resolveGiftRules, resolveGreetings } from './rules.js';

// P1 第一批:生成移到出队后 —— 指令短路、语义弹幕经回复提供方、
// 提供方超时/空回复走保底、语音合成挂到表演、人工停止丢弃迟到结果。

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => ({ ...silentLogger, child: () => silentLogger }),
};

const CAPACITY_OVERRIDE: { value: number | null } = { value: null };

function settings(): EffectiveSettings {
  return {
    petId: 'main',
    queue: { capacity: CAPACITY_OVERRIDE.value ?? 20, chatTtlMs: 30_000, userCooldownMs: 0 },
    gift: { mergeWindowMs: 2_000, tiering: { smallMaxYuan: 1, largeMinYuan: 10, peakMergeCount: 6 } },
    greetings: { enabled: true, enterWindowMs: 10_000, maxNamedCount: 3, allRoomIntervalMs: 60_000, coldIdleMs: 180_000, coldIntervalMs: 300_000 },
    playback: { preloadTimeoutMs: 8_000, overallTimeoutMs: 120_000, noRendererGraceMs: 3_000 },
    lease: { ttlMs: 15_000, renewIntervalMs: 5_000, takeoverSafetyMs: 0 },
      tts: { provider: 'fixed-local', voice: 'zh-CN-XiaoxiaoNeural' },
    singing: { enabled: true, clipStartRatio: 0.4, clipSeconds: 40, targetHz: 310, keyMin: -6, keyMax: 24, indexRate: 0.3, protect: 0.33, rmsMixRate: 0.25, actionId: 'talk' },
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
    opened: () => false,
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

function build(opts: { reply?: Partial<ReplyProvider>; speech?: Partial<SpeechProvider>; now?: () => number; singing?: SingingModule | null; capacity?: number } = {}) {
  const playback = fakePlayback();
  if (opts.capacity !== undefined) CAPACITY_OVERRIDE.value = opts.capacity;
  const singingRef: SingingModule | null = opts.singing ?? null;
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
    greetings: resolveGreetings({}),
    singing: () => singingRef,
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

// WT-P3-007:点歌确认条目必须先于成片条目(缓存命中时任务同步触发派发)
describe('唱歌点歌接入(P3)', () => {
  function fakeSinging(over: Partial<SingingModule> = {}): SingingModule {
    const events: { title: string; eventId: string }[] = [];
    return {
      peekCached: over.peekCached ?? (() => false),
      probe: over.probe ?? (() => ({ cached: false, reusable: false, acceptable: true })),
      assess: over.assess ?? (() => ({ cached: false, reusable: false, acceptable: true })),
      requestSong: over.requestSong ?? ((title, source) => {
        events.push({ title, eventId: source.eventId });
        return { ok: true, jobId: 'song-x', cached: false };
      }),
      job: over.job ?? (() => null),
      jobs: over.jobs ?? (() => []),
      cancelAll: over.cancelAll ?? (() => {}),
      stop: over.stop ?? (() => {}),
    };
  }

  it('缓存命中:确认表演(40)先派发,成片表演(35)后派发——不允许先唱后确认', async () => {
    const { interaction, playback } = build({
      singing: fakeSinging({
        peekCached: () => true,
        probe: () => ({ cached: true, acceptable: true }),
        requestSong: (title, source) => {
          // 模拟缓存命中:requestSong 内同步触发成片回调
          interaction.enqueueSongReady({ jobId: 'song-x', eventId: source.eventId, title, key: null, audioUrl: '/media/audio/song-a.mp3' });
          return { ok: true, jobId: 'song-x', cached: true };
        },
      }),
    });
    const result = interaction.enqueue(chatEvent('点歌 篇章'));
    expect(result.accepted).toBe(true);
    await settle();
    expect(playback.plays.length).toBe(2);
    const p0 = playback.plays[0]!;
    const p1 = playback.plays[1]!;
    expect(p0.performance.priority).toBe(40);
    expect(p0.performance.say).toContain('这就来');
    expect(p1.performance.priority).toBe(35);
    expect(p1.performance.audioUrl).toBe('/media/audio/song-a.mp3');
  });

  it('非缓存点歌:确认派发,任务后台启动,成片暂不派发', async () => {
    const { interaction, playback } = build({ singing: fakeSinging() });
    const result = interaction.enqueue(chatEvent('点歌 好歌'));
    expect(result.accepted).toBe(true);
    await settle();
    expect(playback.plays.length).toBe(1);
    expect(playback.plays[0]!.performance.say).toContain('正在准备');
  });

  it('未注入 singing 模块时:点歌给提示回复,不崩溃', async () => {
    const { interaction, playback } = build();
    const result = interaction.enqueue(chatEvent('点歌 篇章'));
    expect(result.accepted).toBe(true);
    await settle();
    expect(playback.plays.length).toBe(1);
    expect(playback.plays[0]!.performance.say).toContain('还没准备好');
  });

  it('WT-P3-007 复审:队列剩一格时,缓存命中点歌只给拒绝提示且无 song 条目', async () => {
    const singing = fakeSinging({
      peekCached: () => true,
      probe: () => ({ cached: true, acceptable: true }),
      requestSong: () => ({ ok: true, jobId: 'song-x', cached: true }),
    });
    const { interaction, playback } = build({ singing });
    interaction.pause(); // 暂停派发,精确控制队列内容
    // 19 条普通弹幕占位(capacity 20,剩一格)
    for (let i = 0; i < 19; i++) {
      interaction.enqueue(chatEvent(`普通弹幕 ${i}`, `user-${i}`));
    }
    const result = interaction.enqueue(chatEvent('点歌 篇章', '点歌员-a'));
    await settle();
    // 预判:确认(40)占最后一格后,歌曲(35)无法挤过普通弹幕(40)→ 确认语即拒绝,不接单
    if (result.accepted) throw new Error('expected rejection');
    expect(result.reason).toBe('song-busy-limit');
    const songs = interaction.state().queue.items.filter((q) => q.type === 'song');
    expect(songs.length).toBe(0);
    // WT-P3-007 复审:拒绝场景零副作用——无确认/提示条目入队
    expect(interaction.state().queue.items.some((q) => q.type === 'chat' && q.say.includes('这就来'))).toBe(false);
    void playback;
  });

  it('WT-P3-007 复审:队列有两格时,缓存命中确认与歌曲均正常入队', async () => {
    const singing = fakeSinging({
      peekCached: () => true,
      probe: () => ({ cached: true, acceptable: true }),
      requestSong: () => {
        interaction.enqueueSongReady({ jobId: 'song-x', eventId: 'evt-song', title: '篇章', key: null, audioUrl: '/media/audio/song-a.mp3' });
        return { ok: true, jobId: 'song-x', cached: true };
      },
    });
    const { interaction, playback } = build({ singing });
    interaction.pause();
    for (let i = 0; i < 18; i++) {
      interaction.enqueue(chatEvent(`普通弹幕 ${i}`, `user-${i}`));
    }
    const result = interaction.enqueue(chatEvent('点歌 篇章', '点歌员-a'));
    expect(result.accepted).toBe(true);
    await settle();
    const types = interaction.state().queue.items.filter((q) => q.type === 'chat' || q.type === 'song').map((q) => q.type);
    expect(types[0]).toBe('chat'); // 确认(40)先
    expect(types).toContain('song'); // 歌曲(35)后
    void playback;
  });

  it('WT-P3-007 复审:全 song 队列滚动腾位——确认与成片均入队,无矛盾提示', async () => {
    const singing = fakeSinging({
      peekCached: () => true,
      probe: () => ({ cached: true, acceptable: true }),
      requestSong: (title, source) => {
        // 模拟缓存命中:requestSong 内同步触发成片回调
        interaction.enqueueSongReady({ jobId: `job-${title}`, eventId: source.eventId, title, key: null, audioUrl: `/media/audio/${title}.mp3` });
        return { ok: true, jobId: `job-${title}`, cached: true };
      },
    });
    const { interaction } = build({ singing });
    interaction.pause(); // 暂停派发,精确控制队列内容
    // 10 首缓存歌 × (确认 40 + 成片 35) = 20 条填满;第 11 首起滚动腾位最旧
    for (let i = 0; i < 11; i++) {
      const result = interaction.enqueue(chatEvent(`点歌 歌${i}`, `点歌员`));
      expect(result.accepted).toBe(true);
    }
    await settle();
    const items = interaction.state().queue.items;
    const songs = items.filter((q) => q.type === 'song');
    const busyAcks = items.filter((q) => q.eventId.includes('-busy'));
    // 滚动腾位:容量 20,11 首各占确认+成片两格,最旧两首被挤出(第 2~11 首保留)
    expect(songs.length).toBe(9);
    expect(busyAcks.length).toBe(0); // 全程无矛盾提示
  });
});


describe('WT-P3-007 第七轮复审回归:唯一可腾位候选被确认抢占', () => {
  function fakeSinging(over: Partial<SingingModule> = {}): SingingModule {
    const events: { title: string; eventId: string }[] = [];
    return {
      peekCached: over.peekCached ?? (() => false),
      probe: over.probe ?? (() => ({ cached: false, reusable: false, acceptable: true })),
      assess: over.assess ?? (() => ({ cached: false, reusable: false, acceptable: true })),
      requestSong: over.requestSong ?? ((title, source) => {
        events.push({ title, eventId: source.eventId });
        return { ok: true, jobId: 'song-x', cached: false };
      }),
      job: over.job ?? (() => null),
      jobs: over.jobs ?? (() => []),
      cancelAll: over.cancelAll ?? (() => {}),
      stop: over.stop ?? (() => {}),
    };
  }
  it('满队(4弹幕+1旧歌)点不同缓存歌:拒绝接单,确认语不含"这就来",旧歌不被挤出', async () => {
    const singing = fakeSinging({
      peekCached: () => true,
      probe: () => ({ cached: true, acceptable: true }),
      requestSong: () => ({ ok: true, jobId: 'song-new', cached: true }),
    });
    const { interaction, playback } = build({ singing, capacity: 5 });
    interaction.pause(); // 暂停派发,冻结队列使断言稳定
    // 预置:先入 4 条普通弹幕,再入旧 song(若腾位挤出则测试前置失败,定位问题)
    for (let i = 0; i < 4; i++) {
      interaction.enqueue(chatEvent(`普通弹幕 ${i}`, `user-${i}`));
    }
    interaction.enqueueSongReady({ jobId: 'job-old', eventId: 'evt-old', title: '旧歌', key: 0, audioUrl: '/media/audio/song-old.mp3' });
    expect(interaction.state().queue.items.length).toBe(5);
    const result = interaction.enqueue(chatEvent('点歌 新歌', '点歌员-a'));
    await settle();
    // 接单结果:未受理
    if (result.accepted) throw new Error('expected rejection');
    expect(result.reason).toBe('song-busy-limit');
    // 确认语不含"这就来"(审核断言:不能留下成功确认)
    const acks = interaction.state().queue.items.filter((q) => q.type === 'chat');
    for (const ack of acks) {
      expect(ack.say).not.toContain('这就来');
    }
    // 旧 song 未被挤出(点歌请求零副作用);view 层无 songAudioUrl,用 eventId 匹配
    const oldStill = interaction.state().queue.items.some((q) => q.eventId === 'evt-old-song');
    const newQueued = interaction.state().queue.items.some((q) => q.eventId === 'evt-new-song');
    expect(oldStill).toBe(true);
    expect(newQueued).toBe(false);
    void playback;
  });

  afterAll(() => {
    CAPACITY_OVERRIDE.value = null;
  });
});

describe('WT-P3-007/025 第九轮复审回归', () => {
  function fakeSingingLocal(over: Partial<SingingModule> = {}): SingingModule {
    return {
      peekCached: over.peekCached ?? (() => false),
      probe: over.probe ?? (() => ({ cached: false, reusable: false, acceptable: true })),
      assess: over.assess ?? (() => ({ cached: false, reusable: false, acceptable: true })),
      requestSong: over.requestSong ?? (() => ({ ok: true, jobId: 'song-x', cached: true })),
      job: over.job ?? (() => null),
      jobs: over.jobs ?? (() => []),
      cancelAll: over.cancelAll ?? (() => {}),
      stop: over.stop ?? (() => {}),
    };
  }

  it('满队只有旧歌可腾位:busy 提示(低优先级)放弃,旧歌保留,接单未受理', async () => {
    const singing = fakeSingingLocal({
      peekCached: () => true,
      probe: () => ({ cached: true, acceptable: true }),
      requestSong: () => ({ ok: true, jobId: 'song-new', cached: true }),
    });
    const { interaction, playback } = build({ singing, capacity: 5 });
    interaction.pause();
    // 预置:1 条旧 song + 4 条普通弹幕 = 满(5)
    interaction.enqueueSongReady({ jobId: 'job-old', eventId: 'evt-old', title: '旧歌', key: 0, audioUrl: '/media/audio/song-old.mp3' });
    for (let i = 0; i < 4; i++) {
      interaction.enqueue(chatEvent(`普通弹幕 ${i}`, `user-${i}`));
    }
    expect(interaction.state().queue.items.length).toBe(5);
    const result = interaction.enqueue(chatEvent('点歌 新歌', '点歌员-a'));
    await settle();
    // 旧歌不被 busy 提示(25)挤出
    expect(interaction.state().queue.items.some((q) => q.eventId === 'evt-old-song')).toBe(true);
    // 接单未受理
    if (result.accepted) throw new Error('expected rejection');
    void playback;
  });

  it('队列满:busy 提示正常排入(有可腾位条目,歌曲不入队)', async () => {
    const singing = fakeSingingLocal({
      peekCached: () => true,
      probe: () => ({ cached: true, acceptable: true }),
      requestSong: () => ({ ok: true, jobId: 'song-new', cached: true }),
    });
    const { interaction, playback } = build({ singing, capacity: 5 });
    interaction.pause();
    for (let i = 0; i < 5; i++) {
      interaction.enqueue(chatEvent(`普通弹幕 ${i}`, `user-${i}`));
    }
    const result = interaction.enqueue(chatEvent('点歌 篇章', '点歌员-a'));
    // WT-P3-007 复审:满队弹幕时拒绝点歌;低优先级繁忙提示(25)挤不动弹幕(40)则放弃——零副作用
    expect(result.accepted).toBe(false);
    const busyAcks = interaction.state().queue.items.filter((q) => q.type === 'chat' && q.say.includes('排满了'));
    expect(busyAcks.length).toBe(0);
    const songs = interaction.state().queue.items.filter((q) => q.type === 'song');
    expect(songs.length).toBe(0);
    void playback;
  });
});