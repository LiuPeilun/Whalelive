import { describe, expect, it } from 'vitest';
import type { LiveEvent } from '../../../shared/live-event.js';
import type { EffectiveSettings } from '../../../shared/settings.js';
import type { Performance } from '../../../shared/performance.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { CharactersModule } from '../characters/index.js';
import type { PlaybackModule } from '../playback/index.js';
import type { ReplyProvider, SpeechProvider } from './providers.js';
import { createInteraction } from './index.js';
import { resolveGiftRules, resolveGreetings } from './rules.js';

// P2 互动第二批修复(WT-P2-004~008):礼物三档分层、SC/大航海归大额档、
// 调度层高峰降级(满载腾位+已合并退出候选)、缺档动作回退旧礼物动作。
// 金额语义:事件带 paidMilliYuan(整数毫元,1000=1 元)才计价;免费/未确认实付/未知价格一律小额。

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

function fakeCharacters(withTierActions: boolean = true): CharactersModule {
  const available = withTierActions
    ? ['idle', 'talk', 'talk-nod', 'laugh', 'stamp-letter', 'gift', 'celebrate']
    : ['idle', 'talk', 'gift', 'celebrate']; // WT-P2-008:旧角色包/默认包(8 段,无档位动作)
  const loopActions = ['talk', 'talk-nod'];
  return {
    reload: () => {},
    petId: () => 'main',
    view: () => ({ petId: 'main', name: 'x', licenseName: 'x', actions: [] }),
    resolveAction: (id: string) => (available.includes(id) ? { actionId: id, file: `animations/${id}.webm`, loop: loopActions.includes(id), available: true } : null),
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
    opened: () => false,
    onChange: () => () => {},
  };
  return { module, plays };
}

function giftEvent(opts: { user: string; giftId?: string; giftName?: string; quantity?: number; paidMilliYuan?: number }): LiveEvent {
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
      ...(opts.paidMilliYuan !== undefined ? { paidMilliYuan: opts.paidMilliYuan } : {}),
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

function build(withTierActions = true) {
  const playback = fakePlayback();
  const reply: ReplyProvider = { generate: async () => ({ say: '生成的话', action: null }) };
  const speech: SpeechProvider = { synthesize: async () => ({ audioUrl: '/media/audio/t.wav', audioId: 't.wav' }) };
  const interaction = createInteraction({
    settings,
    characters: fakeCharacters(withTierActions),
    playback: playback.module,
    replyProvider: reply,
    speechProvider: speech,
    persona,
    giftRules,
    greetings: resolveGreetings({}),
    logger: silentLogger,
    now: () => t,
  });
  return { interaction, playback };
}

const settle = () => new Promise((r) => setTimeout(r, 25));

describe('礼物分层答谢入队(P2 第二批)', () => {
  it('paidMilliYuan 15000(15 元)礼物走大额档:stamp-letter、优先级 80', async () => {
    t = 0;
    const { interaction, playback } = build();
    interaction.enqueue(giftEvent({ user: '土豪', giftId: 'rocket', giftName: '火箭', quantity: 1, paidMilliYuan: 15000 }));
    t += 2000;
    interaction.tick();
    await settle();
    const p = playback.plays[0]?.performance;
    expect(p?.action).toBe('stamp-letter');
    expect(p?.priority).toBe(80);
    expect(p?.say).toContain('土豪');
    expect(p?.say).toContain('火箭');
  });

  it('paidMilliYuan 5000(5 元)礼物走中额档:laugh、优先级 66', async () => {
    t = 0;
    const { interaction, playback } = build();
    interaction.enqueue(giftEvent({ user: '常客', giftId: 'lida', giftName: '礼花', quantity: 1, paidMilliYuan: 5000 }));
    t += 2000;
    interaction.tick();
    await settle();
    const p = playback.plays[0]?.performance;
    expect(p?.action).toBe('laugh');
    expect(p?.priority).toBe(66);
    expect(p?.say).toContain('礼花');
  });

  it('免费礼物(paidMilliYuan 缺省)走小额档:talk-nod、优先级 60', async () => {
    t = 0;
    const { interaction, playback } = build();
    interaction.enqueue(giftEvent({ user: '路人甲', giftId: 'free1', giftName: '小心心' }));
    interaction.enqueue(giftEvent({ user: '路人乙', giftId: 'free2', giftName: '辣条' }));
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

  it('恰好 1 元(paidMilliYuan 1000)走中额,恰好 10 元(10000)走大额(WT-P2-004 边界)', async () => {
    t = 0;
    const { interaction, playback } = build();
    interaction.enqueue(giftEvent({ user: '甲', giftId: 'a', giftName: '礼物A', quantity: 1, paidMilliYuan: 1000 }));
    interaction.enqueue(giftEvent({ user: '乙', giftId: 'b', giftName: '礼物B', quantity: 1, paidMilliYuan: 10000 }));
    t += 2000;
    interaction.tick();
    await settle();
    interaction.tick();
    await settle();
    const actions = playback.plays.map((p) => p.performance.action);
    expect(actions).toContain('laugh');
    expect(actions).toContain('stamp-letter');
    const priorities = playback.plays.map((p) => p.performance.priority).sort((a, b) => a - b);
    expect(priorities).toEqual([66, 80]);
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
    interaction.enqueue(giftEvent({ user: '土豪', giftId: 'rocket', giftName: '火箭', quantity: 1, paidMilliYuan: 15000 }));
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
      interaction.enqueue(giftEvent({ user: u, giftId: `lida-${u}`, giftName: '礼花', quantity: 1, paidMilliYuan: 5000 }));
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

  it('满载小额队列不拒收大额:结算后的大额答谢由腾位合并保住(WT-P2-006)', async () => {
    t = 0;
    const { interaction } = build();
    interaction.pause();
    // 审核回放:暂停派发,同一礼物窗口先加 20 位观众小额,再加 15 元大额
    for (let i = 0; i < 20; i++) {
      interaction.enqueue(giftEvent({ user: `观众${i}`, giftId: `g-${i}`, giftName: '小心心' }));
    }
    interaction.enqueue(giftEvent({ user: '土豪', giftId: 'rocket', giftName: '火箭', quantity: 1, paidMilliYuan: 15000 }));
    t += 2000;
    interaction.tick();
    const snapshot = interaction.state().queue;
    // 大额答谢在队列中;小额合并腾位后队列只剩合并句与大额,且无 queue-full 丢弃
    const largeItem = snapshot.items.find((i) => i.priority === 80);
    expect(largeItem).toBeDefined();
    expect(largeItem?.action).toBe('stamp-letter');
    expect(snapshot.drops.some((d) => d.reason === 'queue-full')).toBe(false);
    // 已接受事件的 ID 不得出现在丢弃记录(WT-P2-006 复审)
    const highIds = snapshot.items.filter((i) => i.priority === 80).map((i) => i.eventId);
    expect(highIds.length).toBeGreaterThan(0);
    expect(snapshot.drops.some((d) => highIds.includes(d.eventId))).toBe(false);
    expect(snapshot.items.filter((i) => i.type === 'gift').length).toBe(2);
    interaction.resume();
  });

  it('满载结算中的小额洪峰不挤掉先到的大航海/醒目留言(WT-P2-006)', async () => {
    t = 0;
    const { interaction } = build();
    interaction.pause();
    // 大航海与 SC 先到达并入队;随后同窗口的 20 条小额结算洪峰涌入
    interaction.enqueue(guardEvent('舰长丙'));
    interaction.enqueue(superchatEvent('SC丁'));
    for (let i = 0; i < 20; i++) {
      interaction.enqueue(giftEvent({ user: `观众${i}`, giftId: `g-${i}`, giftName: '小心心' }));
    }
    t += 2000;
    interaction.tick();
    const snapshot = interaction.state().queue;
    expect(snapshot.items.some((i) => i.type === 'guard')).toBe(true);
    expect(snapshot.items.some((i) => i.type === 'superchat')).toBe(true);
    expect(snapshot.drops.some((d) => d.reason === 'queue-full')).toBe(false);
    interaction.resume();
  });

  it('二次合并保留已合并人名:已合并条目退出候选,不用「朋友」抹掉原点名(WT-P2-006)', async () => {
    t = 0;
    const { interaction } = build();
    interaction.pause();
    for (const u of ['甲', '乙', '丙', '丁', '戊', '己']) {
      interaction.enqueue(giftEvent({ user: u, giftId: `x1-${u}`, giftName: '小心心' }));
    }
    t += 2000;
    interaction.tick();
    // 第一批合并结果在队列,原点名完整
    const first = interaction.state().queue.items.find((i) => i.type === 'gift');
    expect(first?.say).toContain('甲、乙、丙、丁、戊 等朋友');
    // 乙组 5 人:候选不足阈值,不发生合并
    for (const u of ['乙1', '乙2', '乙3', '乙4', '乙5']) {
      interaction.enqueue(giftEvent({ user: u, giftId: `x2-${u}`, giftName: '小心心' }));
    }
    t += 2000;
    interaction.tick();
    expect(interaction.state().queue.items.filter((i) => i.type === 'gift').length).toBe(6);
    // 第 6 人到达:第二批小额合并,第一批合并条目原点名保持不变
    interaction.enqueue(giftEvent({ user: '庚', giftId: 'x2-庚', giftName: '小心心' }));
    t += 2000;
    interaction.tick();
    const gifts = interaction.state().queue.items.filter((i) => i.type === 'gift');
    expect(gifts.length).toBe(2);
    const says = gifts.map((i) => i.say).join('|');
    expect(says).toContain('甲、乙、丙、丁、戊 等朋友');
    expect(says).toContain('乙1、乙2、乙3、乙4、乙5 等朋友');
    expect(says).not.toContain('朋友、乙1');
    interaction.resume();
  });

  it('持续高峰:满队列含已合并条目时,大额/大航海/醒目留言仍能分别进入队列(WT-P2-006 复审)', async () => {
    t = 0;
    const { interaction } = build();
    interaction.pause();
    // 审核回放:16 批 × 6 位观众,每批结算合并为 1 条;第 16 批仅 5 人入队到满载,
    // 队列为 15 条合并条目 + 5 条普通小额 = 20 满
    for (let batch = 0; batch < 16; batch++) {
      for (let i = 0; i < 6; i++) {
        interaction.enqueue(giftEvent({ user: `b${batch}u${i}`, giftId: `g-${batch}-${i}`, giftName: '小心心' }));
      }
      t += 2000;
      interaction.tick();
    }
    const afterBatches = interaction.state().queue;
    expect(afterBatches.length).toBe(20);
    expect(afterBatches.items.filter((i) => i.type === 'gift' && i.say.includes('等朋友')).length).toBe(15);
    // 三种高档答谢相继到达:合并候选不足阈值,各自取代一条普通小额让位,均入队且被取代者有记录
    interaction.enqueue(guardEvent('舰长戊'));
    interaction.enqueue(superchatEvent('SC己'));
    interaction.enqueue(giftEvent({ user: '土豪', giftId: 'rocket', giftName: '火箭', quantity: 1, paidMilliYuan: 15000 }));
    t += 2000;
    interaction.tick();
    const snapshot = interaction.state().queue;
    expect(snapshot.items.some((i) => i.type === 'guard')).toBe(true);
    expect(snapshot.items.some((i) => i.type === 'superchat')).toBe(true);
    expect(snapshot.items.filter((i) => i.priority === 80).length).toBe(3);
    expect(snapshot.drops.filter((d) => d.reason === 'displaced-for-high-tier').length).toBe(3);
    // 已接受的高档事件 ID 不得出现在丢弃记录——只允许三条被取代小额的 displaced 记录(WT-P2-006 复审)
    const highIds = snapshot.items.filter((i) => i.priority === 80).map((i) => i.eventId);
    expect(snapshot.drops.some((d) => highIds.includes(d.eventId))).toBe(false);
    // 两批点名的既有行为保持:最早的合并条目原点名仍在
    const firstMerged = snapshot.items.find((i) => i.type === 'gift' && i.say.includes('等朋友'));
    expect(firstMerged?.say).toContain('b0u0、b0u1、b0u2、b0u3、b0u4');
    interaction.resume();
  });
});

describe('缺档动作回退(WT-P2-008)', () => {
  it('旧角色包(无档位动作):小额回退 gift 动作,大额/SC 回退 celebrate,不出现没动画的答谢', async () => {
    t = 0;
    const { interaction, playback } = build(false);
    interaction.enqueue(giftEvent({ user: '路人', giftId: 'f1', giftName: '小心心' }));
    interaction.enqueue(giftEvent({ user: '土豪', giftId: 'rocket', giftName: '火箭', quantity: 1, paidMilliYuan: 15000 }));
    interaction.enqueue(guardEvent('舰长丁'));
    t += 2000;
    interaction.tick();
    await settle();
    interaction.tick();
    await settle();
    interaction.tick();
    await settle();
    expect(playback.plays.length).toBe(3);
    const actions = playback.plays.map((p) => p.performance.action);
    expect(actions.filter((a) => a === 'gift').length).toBe(1); // 小额 → 旧 gift 动作
    expect(actions.filter((a) => a === 'celebrate').length).toBe(2); // 大额礼物+大航海 → 旧 celebrate 动作
  });

  it('正式角色包档位动作仍优先:小额 talk-nod、大额 stamp-letter', async () => {
    t = 0;
    const { interaction, playback } = build(true);
    interaction.enqueue(giftEvent({ user: '路人', giftId: 'f1', giftName: '小心心' }));
    interaction.enqueue(giftEvent({ user: '土豪', giftId: 'rocket', giftName: '火箭', quantity: 1, paidMilliYuan: 15000 }));
    t += 2000;
    interaction.tick();
    await settle();
    interaction.tick();
    await settle();
    const actions = playback.plays.map((p) => p.performance.action);
    expect(actions).toContain('talk-nod');
    expect(actions).toContain('stamp-letter');
  });
});
