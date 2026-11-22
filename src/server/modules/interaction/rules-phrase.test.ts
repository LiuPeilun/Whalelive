import { describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '../../../shared/live-event.js';
import type { EffectiveSettings } from '../../../shared/settings.js';
import type { Performance } from '../../../shared/performance.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { CharactersModule } from '../characters/index.js';
import type { PlaybackModule } from '../playback/index.js';
import type { ReplyProvider, SpeechProvider } from './providers.js';
import { createInteraction, resolveAdoptableAction } from './index.js';
import { resolveGiftRules, resolveGreetings } from './rules.js';

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
    gift: { mergeWindowMs: 2_000, tiering: { smallMaxYuan: 1, largeMinYuan: 10, peakMergeCount: 6 } },
    greetings: { enabled: true, enterWindowMs: 10_000, maxNamedCount: 3, allRoomIntervalMs: 60_000, coldIdleMs: 180_000, coldIntervalMs: 300_000 },
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
    // known:清单登记集合;missing:登记但素材缺失(模拟迁移/分批复制场景,WT-P2-002)
    resolveAction: (id: string) => {
      const known = ['idle', 'talk', 'wave', 'dance', 'eat', 'salute', 'sip-tea', 'talk-nod', 'stamp-letter', 'spin'];
      if (!known.includes(id)) return null;
      const missing = ['spin'];
      return { actionId: id, file: `animations/${id}.webm`, loop: id === 'talk' || id === 'talk-nod', available: !missing.includes(id) };
    },
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
    trackStarted: () => false,
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
const giftRules = resolveGiftRules({ thanksTemplate: '谢谢 {user}!', celebrateText: '{kind}!' });

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
    greetings: resolveGreetings({}),
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

describe('带口令词的提问与旧指令边界(WT-P2-003 复验)', () => {
  it('「为什么要喝口茶?」不被旧 think 指令截获,进入问答流程', async () => {
    const { interaction, playback, generate } = build();
    interaction.enqueue(chatEvent('为什么要喝口茶?'));
    await settle();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0].text).toBe('为什么要喝口茶?');
    expect(playback.plays[0]!.performance.say).toBe('生成的话');
  });

  it('明确的旧动作指令仍正常触发(跳舞)', async () => {
    const { interaction, playback, generate } = build();
    interaction.enqueue(chatEvent('来跳个舞'));
    await settle();
    expect(generate).not.toHaveBeenCalled();
    expect(playback.plays[0]!.performance.action).toBe('dance');
  });
});

describe('模型建议动作的来源与素材约束(WT-P2-001/002)', () => {
  it('模型建议答谢专属动作 stamp-letter 被拒:保留回复文本,动作回落通用口型', async () => {
    const { interaction, playback } = build({
      reply: { generate: (async () => ({ say: '这封信我盖个章寄给你!', action: 'stamp-letter', provider: 'rule' })) as unknown as ReplyProvider['generate'] },
    });
    interaction.enqueue(chatEvent('普通弹幕内容'));
    await settle();
    expect(playback.plays).toHaveLength(1);
    expect(playback.plays[0]!.performance.action).toBe('talk');
    expect(playback.plays[0]!.performance.say).toBe('这封信我盖个章寄给你!');
  });

  it('模型建议缺素材动作(spin)被拒:保留回复文本,动作回落通用口型', async () => {
    const { interaction, playback } = build({
      reply: { generate: (async () => ({ say: '给你转个圈!', action: 'spin', provider: 'rule' })) as unknown as ReplyProvider['generate'] },
    });
    interaction.enqueue(chatEvent('普通弹幕内容'));
    await settle();
    expect(playback.plays).toHaveLength(1);
    expect(playback.plays[0]!.performance.action).toBe('talk');
    expect(playback.plays[0]!.performance.say).toBe('给你转个圈!');
  });

  it('模型建议 idle 被拒:保留回复文本,动作回落通用口型', async () => {
    const { interaction, playback } = build({
      reply: { generate: (async () => ({ say: '嗯哼', action: 'idle', provider: 'rule' })) as unknown as ReplyProvider['generate'] },
    });
    interaction.enqueue(chatEvent('普通弹幕内容'));
    await settle();
    expect(playback.plays[0]!.performance.action).toBe('talk');
    expect(playback.plays[0]!.performance.say).toBe('嗯哼');
  });

  it('manualAction 素材缺失时明确拒绝(asset-missing)', async () => {
    const { interaction, playback } = build();
    const result = interaction.manualAction('spin');
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe('asset-missing');
    await settle();
    expect(playback.plays).toHaveLength(0);
  });

  it('manualAction 素材就位的动作仍正常入队(回归)', async () => {
    const { interaction, playback } = build();
    const result = interaction.manualAction('salute');
    expect(result.accepted).toBe(true);
    await settle();
    expect(playback.plays).toHaveLength(1);
    expect(playback.plays[0]!.performance.action).toBe('salute');
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

describe('候选校验统一口径(WT-P2-002 复验)', () => {
  const resolve = (id: string) => {
    const known = ['talk', 'salute', 'stamp-letter', 'spin'];
    if (!known.includes(id)) return null;
    return { available: id !== 'spin' };
  };

  it('正常可用的动作采纳', () => {
    expect(resolveAdoptableAction('salute', resolve)).toBe('salute');
    expect(resolveAdoptableAction('talk', resolve)).toBe('talk');
  });

  it('空/idle/清单外/缺素材/答谢专属一律返回 null', () => {
    expect(resolveAdoptableAction(null, resolve)).toBeNull();
    expect(resolveAdoptableAction('', resolve)).toBeNull();
    expect(resolveAdoptableAction('idle', resolve)).toBeNull();
    expect(resolveAdoptableAction('dance', resolve)).toBeNull();
    expect(resolveAdoptableAction('spin', resolve)).toBeNull();
    expect(resolveAdoptableAction('stamp-letter', resolve)).toBeNull();
  });
});

describe('含彩蛋词的普通提问不被任何旧指令截获(WT-P2-003 复验)', () => {
  it('「吃饭前喝口茶对肠胃有影响吗?」走问答(审核复验样本)', async () => {
    const { interaction, playback, generate } = build();
    interaction.enqueue(chatEvent('吃饭前喝口茶对肠胃有影响吗?'));
    await settle();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0].text).toBe('吃饭前喝口茶对肠胃有影响吗?');
    expect(playback.plays[0]!.performance.say).toBe('生成的话');
  });

  it('「为什么要喝口茶?」走问答(上一轮复验样本保留)', async () => {
    const { interaction, playback, generate } = build();
    interaction.enqueue(chatEvent('为什么要喝口茶?'));
    await settle();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(playback.plays[0]!.performance.say).toBe('生成的话');
  });

  it('eat 点播意图回归:「今天吃什么」仍触发 eat', async () => {
    const { interaction, playback, generate } = build();
    interaction.enqueue(chatEvent('今天吃什么'));
    await settle();
    expect(generate).not.toHaveBeenCalled();
    expect(playback.plays[0]!.performance.action).toBe('eat');
  });

  it('明确旧指令回归:「来跳个舞」仍触发 dance', async () => {
    const { interaction, playback, generate } = build();
    interaction.enqueue(chatEvent('来跳个舞'));
    await settle();
    expect(generate).not.toHaveBeenCalled();
    expect(playback.plays[0]!.performance.action).toBe('dance');
  });
});
