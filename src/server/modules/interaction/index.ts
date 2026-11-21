import { randomUUID } from 'node:crypto';
import type { LiveEvent } from '../../../shared/live-event.js';
import type { MetricsView, StageTimings, TaskView, TokenUsageView } from '../../../shared/protocol.js';
import type { Performance } from '../../../shared/performance.js';
import type { EffectiveSettings } from '../../../shared/settings.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { CharactersModule } from '../characters/index.js';
import type { PlaybackModule } from '../playback/index.js';
import type { ReplyProvider, SpeechProvider } from './providers.js';
import { createGiftAggregator } from './gifts.js';
import { createQueue, type DropRecord, type QueueItem } from './queue.js';
import { createRules, tierFor, type GiftTierKey, type PersonaConfig, type ResolvedGiftRules } from './rules.js';

// 互动编排:唯一待播队列、冷却、礼物合并、任务生命周期与紧急停止。
// 任务串行执行:出队 → 生成(指令短路/回复提供方)→ 语音合成 → playback.play 唯一终态
// → 核对任务版本 → 下一条。迟到的终态与生成结果经版本校验后丢弃。
// 提供方超时只取消当次调用(派生 signal),任务回落保底文本继续;

/** 答谢专属动作:保留给付费答谢规则(大额礼物/SC/大航海),普通弹幕的提示候选与结果采纳均排除。 */
export const RESERVED_GIFT_ACTIONS: readonly string[] = ['stamp-letter'];

/**
 * 模型建议动作的候选校验统一口径(WT-P2-001/002):直播派发与控制台预览共用。
 * 边界外(空/待机/清单外/素材缺失/答谢专属)返回 null——调用方保留回复文本,动作回落默认。
 */
export function resolveAdoptableAction(
  suggested: string | null,
  resolveAction: (id: string) => { available: boolean } | null,
): string | null {
  if (suggested === null || suggested === '' || suggested === 'idle') return null;
  const resolved = resolveAction(suggested);
  if (resolved === null || !resolved.available) return null;
  if (RESERVED_GIFT_ACTIONS.includes(suggested)) return null;
  return suggested;
}

export type EnqueueResult =
  | { accepted: true; eventId: string }
  | { accepted: false; eventId: string; reason: string };

export type InteractionState = {
  paused: boolean;
  queue: { capacity: number; length: number; items: QueueItem[]; drops: DropRecord[] };
  current: TaskView | null;
  metrics: MetricsView;
};

export type InteractionModule = {
  enqueue(event: LiveEvent): EnqueueResult;
  manualAction(actionId: string, say?: string): EnqueueResult;
  pause(): void;
  resume(): void;
  stop(): void;
  tick(): void;
  state(): InteractionState;
  onChange(cb: () => void): () => void;
};

const HISTORY_LIMIT = 30;
const COOLDOWN_LIMIT = 1000;
const REJECT_LOG_LIMIT = 20;
const SAY_MAX_LENGTH = 120;
/** 高峰合并播报的人名上限:超出以"等朋友"收尾,防止长名单拖长语音(v1.1 修正 3)。 */
const MERGED_NAMES_LIMIT = 5;
/** 礼物答谢优先级栈(v1.1):大额/SC/大航海 80 > 中额 66 > 小额 60 > 普通聊天 40。 */
const GIFT_TIER_PRIORITY: Record<GiftTierKey, number> = { small: 60, mid: 66, large: 80 };

type CurrentTask = {
  eventId: string;
  performanceId: string | null;
  stage: 'generating' | 'synthesizing' | 'waiting-playback';
  say: string;
  action: string;
  since: number;
  version: number;
  controller: AbortController;
  /** P1 第三批计时:每阶段独立起止,避免模型时长重复计入排队(WT-P1-022)。 */
  timings: {
    enqueuedAt: number;
    dequeuedAt: number;
    generationDoneAt: number | null;
    synthesisStartAt: number | null;
    synthesisDoneAt: number | null;
    playbackAt: number | null;
  };
  usage: TokenUsageView | null;
  provider: string;
};

/** 派生 signal:父任务中止传导给提供方调用;超时只取消调用本身,不杀任务。 */
function derivedSignal(parent: AbortSignal): { signal: AbortSignal; cancel(): void } {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (parent.aborted) ctl.abort();
  else parent.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctl.signal,
    cancel: () => {
      ctl.abort();
      parent.removeEventListener('abort', onAbort);
    },
  };
}

async function withTimeoutMs<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          onTimeout();
          resolve(null);
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createInteraction(deps: {
  settings(): EffectiveSettings;
  characters: CharactersModule;
  playback: PlaybackModule;
  replyProvider: ReplyProvider;
  speechProvider: SpeechProvider;
  persona: PersonaConfig;
  giftRules: ResolvedGiftRules;
  logger: Logger;
  now(): number;
}): InteractionModule {
  const { characters, playback, logger, now } = deps;
  const rules = createRules(deps.persona, deps.giftRules);
  const queue = createQueue({ capacity: deps.settings().queue.capacity, now });
  const gifts = createGiftAggregator({ mergeWindowMs: () => deps.settings().gift.mergeWindowMs, now });

  const listeners = new Set<() => void>();
  const cooldowns = new Map<string, number>();
  let rejectLog: DropRecord[] = [];
  let history: { eventId: string; performanceId: string | null; status: string; at: number }[] = [];
  let current: CurrentTask | null = null;
  let taskVersion = 0;
  let paused = false;
  // P1 第三批:累计 token 与最近一次任务的阶段耗时,随状态快照推送到控制台。
  const totals: TokenUsageView = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let completed = 0;
  let lastMetrics: MetricsView['last'] = null;

  function addUsage(usage: TokenUsageView | null): void {
    if (!usage) return;
    totals.promptTokens += usage.promptTokens;
    totals.completionTokens += usage.completionTokens;
    totals.totalTokens += usage.totalTokens;
  }

  function stageTimings(task: CurrentTask, endedAt: number): StageTimings {
    const t = task.timings;
    return {
      queueWaitMs: Math.max(0, t.dequeuedAt - t.enqueuedAt),
      generationMs: t.generationDoneAt !== null ? Math.max(0, t.generationDoneAt - t.dequeuedAt) : null,
      synthesisMs: t.synthesisStartAt !== null && t.synthesisDoneAt !== null
        ? Math.max(0, t.synthesisDoneAt - t.synthesisStartAt) : null,
      playbackMs: t.playbackAt !== null ? Math.max(0, endedAt - t.playbackAt) : null,
      totalMs: Math.max(0, endedAt - t.enqueuedAt),
    };
  }

  function notify(): void {
    for (const cb of listeners) cb();
  }

  function recordReject(eventId: string, reason: string): void {
    rejectLog.push({ eventId, reason, at: now() });
    if (rejectLog.length > REJECT_LOG_LIMIT) rejectLog = rejectLog.slice(-REJECT_LOG_LIMIT);
  }

  function chatCooldownActive(userKey: string): boolean {
    const last = cooldowns.get(userKey);
    if (last === undefined) return false;
    return now() - last < deps.settings().queue.userCooldownMs;
  }

  function touchCooldown(userKey: string): void {
    if (cooldowns.size >= COOLDOWN_LIMIT) {
      const oldest = cooldowns.keys().next().value;
      if (oldest !== undefined) cooldowns.delete(oldest);
    }
    cooldowns.set(userKey, now());
  }

  function enqueue(event: LiveEvent): EnqueueResult {
    const settings = deps.settings();
    const eventId = event.id;
    if (event.type === 'gift') {
      const gift = event.gift;
      if (!gift) return { accepted: false, eventId, reason: 'gift-missing-payload' };
      gifts.add({
        userKey: `${event.source}:${event.user.id}`,
        userName: event.user.name,
        giftId: gift.id,
        giftName: gift.name,
        quantity: gift.quantity,
        paidMilliYuan: gift.paidMilliYuan,
      });
      return { accepted: true, eventId };
    }
    if (event.type === 'guard' || event.type === 'superchat') {
      // SC 与大航海同属大额答谢档(v1.1 修正 2):动作取大额档配置,文案沿用大额模板。
      const kind = event.type === 'guard' ? '大航海' : '醒目留言';
      const item: QueueItem = {
        eventId,
        type: event.type,
        priority: GIFT_TIER_PRIORITY.large,
        enqueuedAt: now(),
        expiresAt: now() + 60_000,
        say: rules.thanksText('large', { user: event.user.name, gift: kind }),
        action: tierActionFor('large'),
        text: null,
        isCommand: true,
        userKey: `${event.source}:${event.user.id}`,
      };
      const pushed = pushWithPeakRelief(item);
      if (!pushed.ok) recordReject(eventId, pushed.reason);
      notify();
      return pushed.ok ? { accepted: true, eventId } : { accepted: false, eventId, reason: pushed.reason };
    }
    if (event.type !== 'chat') {
      recordReject(eventId, 'not-actionable');
      return { accepted: false, eventId, reason: 'not-actionable' };
    }
    const userKey = `${event.source}:${event.user.id}`;
    if (chatCooldownActive(userKey)) {
      recordReject(eventId, 'user-cooldown');
      return { accepted: false, eventId, reason: 'user-cooldown' };
    }
    // 指令在入队时即确定(确定性规则);语义弹幕延迟到出队后由回复提供方生成。
    const command = rules.detectCommand(event.text ?? '');
    const item: QueueItem = {
      eventId,
      type: 'chat',
      priority: 40,
      enqueuedAt: now(),
      expiresAt: now() + settings.queue.chatTtlMs,
      say: command?.say ?? '',
      action: command?.action ?? 'talk',
      text: command ? null : event.text ?? '',
      isCommand: command !== null,
      userKey,
    };
    const pushed = queue.push(item);
    if (!pushed.ok) {
      recordReject(eventId, pushed.reason);
      notify();
      return { accepted: false, eventId, reason: pushed.reason };
    }
    touchCooldown(userKey);
    notify();
    tick();
    return { accepted: true, eventId };
  }

  function manualAction(actionId: string, say = ''): EnqueueResult {
    // 试播也要求素材就位:缺失时明确拒绝,而非入队后在派发阶段无声失败(WT-P2-002)。
    const resolved = characters.resolveAction(actionId);
    if (resolved === null || !resolved.available) {
      const eventId = `manual-${randomUUID().slice(0, 8)}`;
      return { accepted: false, eventId, reason: 'asset-missing' };
    }
    const eventId = `manual-${randomUUID().slice(0, 8)}`;
    const item: QueueItem = {
      eventId,
      type: 'manual',
      priority: 100,
      enqueuedAt: now(),
      expiresAt: now() + 60_000,
      // 试播台词:非空时随表演走 TTS,用于控制台验证口型循环与素材效果。
      say: say.trim().slice(0, SAY_MAX_LENGTH),
      action: actionId,
      text: null,
      isCommand: true,
      userKey: null,
    };
    const pushed = queue.push(item);
    if (!pushed.ok) recordReject(eventId, pushed.reason);
    notify();
    tick();
    return pushed.ok ? { accepted: true, eventId } : { accepted: false, eventId, reason: pushed.reason };
  }

  function buildPerformance(item: QueueItem, say: string, action: string, audioUrl: string | undefined): { performance: Performance; asset: { assetId: string; loop: boolean; available: boolean } | null } {
    const resolved = characters.resolveAction(action);
    let actionId = action;
    let asset: { assetId: string; loop: boolean; available: boolean } | null = null;
    if (resolved) {
      actionId = resolved.actionId;
      asset = { assetId: resolved.file, loop: resolved.loop, available: resolved.available };
      if (!resolved.available) {
        logger.warn('interaction.asset-missing', { eventId: item.eventId, action: actionId, file: resolved.file });
      }
    } else {
      // 不在白名单:回退待机,白名单兜底优先(AGENTS《互动与状态一致性》)。
      const idle = characters.resolveAction('idle');
      actionId = idle?.actionId ?? 'idle';
      asset = idle && idle.available ? { assetId: idle.file, loop: idle.loop, available: true } : null;
      logger.warn('interaction.action-not-whitelisted', { eventId: item.eventId, requested: action, fallback: actionId });
    }
    const performance: Performance = {
      id: `pf-${randomUUID().slice(0, 8)}`,
      sourceEventId: item.eventId,
      priority: item.priority,
      say,
      action: actionId,
      expiresAt: now() + 60_000,
      ...(audioUrl !== undefined ? { audioUrl } : {}),
    };
    return { performance, asset };
  }

  async function dispatch(item: QueueItem): Promise<void> {
    taskVersion += 1;
    const version = taskVersion;
    try {
      await dispatchTask(item, version);
    } catch (err) {
      // 兜底:任何未预期异常(含提供方拒绝逃逸)不得阻塞调度(WT-P1-001);
      // 仅当异常任务仍持有 current 时清理,避免清掉已接替的新任务。
      logger.error('interaction.dispatch-unexpected', { eventId: item.eventId, error: String(err) });
      if (current !== null && current.version === version) {
        current = null;
        notify();
        tick();
      }
    }
  }

  async function dispatchTask(item: QueueItem, version: number): Promise<void> {
    const controller = new AbortController();
    // 版本仍归属本任务(未被停止/替换)才允许推进与写入 current
    const alive = () => current !== null && current.version === version && !controller.signal.aborted;

    let say = item.say;
    let action = item.action;
    let usage: TokenUsageView | null = null;
    let provider = item.isCommand ? 'rule' : 'fixed-local';
    const dequeuedAt = now();
    current = {
      eventId: item.eventId, performanceId: null, stage: 'generating', say: '', action, since: dequeuedAt, version, controller,
      timings: {
        enqueuedAt: item.enqueuedAt, dequeuedAt, generationDoneAt: null,
        synthesisStartAt: null, synthesisDoneAt: null, playbackAt: null,
      },
      usage: null, provider,
    };
    notify();

    // 生成:语义弹幕调用回复提供方;指令/礼物等确定性文本跳过。
    // 拒绝与超时同样安全化:结果为 null 走保底文本(WT-P1-001)。
    if (!item.isCommand && item.text !== null) {
      const call = derivedSignal(controller.signal);
      let result: Awaited<ReturnType<ReplyProvider['generate']>> | null = null;
      try {
        result = await withTimeoutMs(
          deps.replyProvider.generate({ text: item.text, userKey: item.userKey ?? '', signal: call.signal }),
          deps.settings().generation.llmTimeoutMs,
          () => call.cancel(),
        );
      } catch (err) {
        logger.warn('interaction.reply-error', { eventId: item.eventId, error: String(err) });
      } finally {
        call.cancel(); // 释放派生监听
      }
      // 用量在取得结果时即按本次请求归属累计一次,与播放终态解耦(WT-P1-022)。
      // 即使随后被停止、或输出非法走保底,上游已发生的 token 仍如实计入。
      if (result !== null && current !== null && current.version === version) {
        const u = result.usage;
        if (u) {
          usage = { promptTokens: u.promptTokens, completionTokens: u.completionTokens, totalTokens: u.totalTokens };
          addUsage(usage);
        }
      }
      if (current === null || current.version !== version) return; // 停止后的迟到结果丢弃
      if (result !== null && typeof result.say === 'string' && result.say.trim() !== '') {
        say = result.say.trim().slice(0, SAY_MAX_LENGTH);
        if (result.provider && result.provider !== '') provider = result.provider;
        const suggested = typeof result.action === 'string' && result.action !== '' ? result.action : null;
        // 采纳走统一候选校验:边界外(含 idle/答谢专属/缺素材)保留回复文本,动作回落默认(WT-P2-001/002)。
        const adopted = resolveAdoptableAction(suggested, (id) => characters.resolveAction(id));
        if (suggested !== null && adopted !== null) {
          action = adopted;
        } else if (suggested !== null) {
          const resolved = characters.resolveAction(suggested);
          const reason = resolved === null ? 'not-whitelisted'
            : !resolved.available ? 'asset-missing'
            : suggested === 'idle' ? 'idle-not-in-candidates'
            : 'reserved-gift';
          logger.warn('interaction.action-not-adopted', { eventId: item.eventId, requested: suggested, reason, fallback: action });
        }
      } else {
        say = rules.fallbackReply();
        provider = 'fallback';
        logger.warn('interaction.reply-fallback', { eventId: item.eventId, why: result === null ? 'timeout-or-error' : 'empty-or-invalid' });
      }
      if (!alive()) return;
      current = {
        ...current, say, action, usage, provider, stage: 'synthesizing',
        timings: { ...current.timings, generationDoneAt: now(), synthesisStartAt: now() },
      };
      notify();
    }

    // 合成:非空文本请求语音;拒绝/失败/超时降级为无声表演(字幕与动作保留,WT-P1-001)
    // 规则回复不经过生成分支,合成起点在此设置,保证其合成耗时同样可观测(WT-P1-022)。
    if (current !== null && current.timings.synthesisStartAt === null) {
      current = { ...current, timings: { ...current.timings, synthesisStartAt: now() } };
    }
    let audioUrl: string | undefined;
    if (say !== '' && !controller.signal.aborted) {
      const call = derivedSignal(controller.signal);
      let synth: Awaited<ReturnType<SpeechProvider['synthesize']>> = null;
      try {
        synth = await withTimeoutMs(
          deps.speechProvider.synthesize({ text: say, signal: call.signal }),
          deps.settings().generation.ttsTimeoutMs,
          () => call.cancel(),
        );
      } catch (err) {
        logger.warn('interaction.tts-error', { eventId: item.eventId, error: String(err) });
      } finally {
        call.cancel();
      }
      if (current === null || current.version !== version) return;
      if (synth !== null && typeof synth.audioUrl === 'string' && synth.audioUrl !== '') {
        audioUrl = synth.audioUrl;
      } else {
        logger.warn('interaction.tts-unavailable', { eventId: item.eventId, why: synth === null ? 'timeout-or-error' : 'no-audio' });
      }
    }
    if (current === null || current.version !== version) return;

    const { performance, asset } = buildPerformance(item, say, action, audioUrl);
    const synthesisDoneAt = now();
    current = {
      ...current,
      performanceId: performance.id, stage: 'waiting-playback', say, action: performance.action,
      timings: { ...current.timings, synthesisDoneAt, playbackAt: synthesisDoneAt },
    };
    logger.info('interaction.dispatch', {
      eventId: item.eventId,
      performanceId: performance.id,
      action: performance.action,
      priority: item.priority,
      audio: audioUrl !== undefined,
      generated: !item.isCommand,
    });
    notify();
    await playback
      .play({ performance, asset, signal: controller.signal })
      .then((result) => {
        if (current === null || current.version !== version) {
          logger.info('interaction.late-result-dropped', { eventId: item.eventId, performanceId: performance.id, result: result.status });
          return;
        }
        history.push({ eventId: item.eventId, performanceId: performance.id, status: result.status, at: now() });
        if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
        logger.info('interaction.task-finished', { eventId: item.eventId, performanceId: performance.id, status: result.status });
        // P1 第三批:记录本次阶段耗时与用量。用量已在取得结果时累计,此处不再重复。
        const endedAt = now();
        if (result.status === 'ended') completed += 1;
        lastMetrics = {
          eventId: item.eventId,
          ...stageTimings(current, endedAt),
          usage: current.usage,
          provider: current.provider,
        };
        current = null;
        notify();
        tick();
      })
      .catch((err: unknown) => {
        // playback.play 约定只 resolve;此处仅防御性兜底,保证调度不悬挂。
        logger.error('interaction.playback-unexpected', { eventId: item.eventId, error: String(err) });
        if (current === null || current.version !== version) return; // 不清理已接替的新任务
        current = null;
        notify();
        tick();
      });
  }

  /**
   * 档位动作解析(WT-P2-008):档位配置动作缺失或素材不可用时回退旧礼物动作,
   * 保证旧角色包/默认包不出现"有台词没动画"。正式角色包的档位资源仍优先使用。
   */
  function tierActionFor(tier: GiftTierKey): string {
    const preferred = deps.giftRules.tiers[tier].action;
    const resolved = characters.resolveAction(preferred);
    if (resolved !== null && resolved.available) return preferred;
    const fallback = tier === 'large' ? 'celebrate' : 'gift';
    logger.warn('interaction.tier-action-fallback', { tier, preferred, fallback });
    return fallback;
  }

  /**
   * 入队;队列满载时先执行高峰合并腾位再入队(WT-P2-006):
   * 满是小额答谢的队列不得拒收后到的大额/SC/大航海答谢。
   * 腾位发生在拒收之前,不产生 queue-full 丢弃记录;无候选可合并时保持原腾位规则。
   */
  function pushWithPeakRelief(item: QueueItem): { ok: true } | { ok: false; reason: string } {
    if (queue.length() >= queue.getCapacity()) mergePeakSmallThanks();
    return queue.push(item);
  }

  /**
   * 高峰降级(v1.1 修正 3):待播小额答谢达到阈值时,合并为一句跨用户播报。
   * 定位在调度层而非聚合层——合并的是"待播队列"里的低档答谢,与连击聚合(同用户同礼物、
   * 入队前)是两层;大额/SC/大航海答谢始终独立保留。
   * 合并产物标记 merged,退出后续合并候选:二次高峰不会用「朋友」抹掉已点名的人(WT-P2-006)。
   */
  function mergePeakSmallThanks(): boolean {
    const threshold = deps.settings().gift.tiering.peakMergeCount;
    const smalls = queue.snapshot().filter((item) => item.type === 'gift' && item.giftTier === 'small' && item.merged !== true);
    if (smalls.length < threshold) return false;
    const removed = queue.removeMany(new Set(smalls.map((item) => item.eventId)), 'peak-merged');
    if (removed.length === 0) return false;
    const names: string[] = [];
    for (const item of removed) {
      const name = item.userName ?? '朋友';
      if (!names.includes(name)) names.push(name);
      if (names.length >= MERGED_NAMES_LIMIT) break;
    }
    const namesText = names.join('、') + (names.length >= MERGED_NAMES_LIMIT ? ' 等朋友' : '');
    const merged: QueueItem = {
      eventId: `gift-merged-${randomUUID().slice(0, 8)}`,
      type: 'gift',
      giftTier: 'small',
      merged: true,
      priority: GIFT_TIER_PRIORITY.small,
      enqueuedAt: now(),
      expiresAt: now() + 60_000,
      say: rules.mergedThanks(namesText),
      action: tierActionFor('small'),
      text: null,
      isCommand: true,
      userKey: null,
    };
    const pushed = queue.push(merged);
    if (!pushed.ok) {
      recordReject(merged.eventId, pushed.reason);
      // 合并结果入队失败(极端容量竞争):原答谢放回,不静默丢感谢。
      for (const item of removed) queue.push(item);
      return false;
    }
    logger.info('interaction.gift-peak-merged', { mergedCount: removed.length, names: namesText });
    return true;
  }

  /** 调度心跳:礼物窗口出队 → 容量同步 → 空闲时取下一条。由 app 统一定时调用。 */
  function tick(): void {
    queue.setCapacity(deps.settings().queue.capacity);
    const emissions = gifts.sweep();
    for (const emission of emissions) {
      const tiering = deps.settings().gift.tiering;
      const tier = tierFor(emission.totalPaidYuan, emission.paidKnown, tiering);
      const item: QueueItem = {
        eventId: `gift-${randomUUID().slice(0, 8)}`,
        type: 'gift',
        giftTier: tier,
        priority: GIFT_TIER_PRIORITY[tier],
        enqueuedAt: now(),
        expiresAt: now() + 60_000,
        say: rules.thanksText(tier, {
          user: emission.userName,
          gift: emission.giftName,
          count: emission.totalQuantity,
          ...(emission.totalPaidYuan > 0 ? { amountYuan: emission.totalPaidYuan } : {}),
        }),
        action: tierActionFor(tier),
        text: null,
        isCommand: true,
        userKey: emission.userKey,
        userName: emission.userName,
      };
      const pushed = pushWithPeakRelief(item);
      if (!pushed.ok) recordReject(item.eventId, pushed.reason);
    }
    const merged = mergePeakSmallThanks();
    if (emissions.length > 0 || merged) notify();
    if (paused || current !== null) return;
    const next = queue.popBest();
    if (next) void dispatch(next);
  }

  function pause(): void {
    paused = true;
    logger.info('interaction.paused', {});
    notify();
  }

  function resume(): void {
    paused = false;
    logger.info('interaction.resumed', {});
    notify();
    tick();
  }

  /** 紧急停止:版本失效 → 清队列 → 停播放 → 保持暂停,等待显式恢复。 */
  function stop(): void {
    paused = true;
    taskVersion += 1;
    if (current) {
      // 停止时保留当前任务的阶段统计与已取得的用量,避免迟到终态被丢弃后无记录(WT-P1-022)。
      const endedAt = now();
      lastMetrics = {
        eventId: current.eventId,
        ...stageTimings(current, endedAt),
        usage: current.usage,
        provider: current.provider,
      };
      current.controller.abort();
      current = null;
    }
    const cleared = queue.clear('stopped');
    gifts.clear();
    playback.stop();
    logger.warn('interaction.emergency-stop', { cleared });
    notify();
  }

  function state(): InteractionState {
    const settings = deps.settings();
    return {
      paused,
      queue: {
        capacity: settings.queue.capacity,
        length: queue.length(),
        items: queue.snapshot().map((item) => ({
          eventId: item.eventId,
          type: item.type,
          priority: item.priority,
          enqueuedAt: item.enqueuedAt,
          expiresAt: item.expiresAt,
          say: item.say,
          action: item.action,
          text: item.text,
          isCommand: item.isCommand,
          userKey: item.userKey,
        })),
        drops: [...queue.dropLog(), ...rejectLog].sort((a, b) => a.at - b.at).slice(-20),
      },
      current:
        current === null
          ? null
          : {
              eventId: current.eventId,
              performanceId: current.performanceId,
              stage: current.stage,
              say: current.say,
              action: current.action,
              since: current.since,
            },
      metrics: {
        last: lastMetrics,
        totals: { ...totals },
        completed,
      },
    };
  }

  return { enqueue, manualAction, pause, resume, stop, tick, state, onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); } };
}
