import { randomUUID } from 'node:crypto';
import type { LiveEvent } from '../../../shared/live-event.js';
import type { TaskView } from '../../../shared/protocol.js';
import type { Performance } from '../../../shared/performance.js';
import type { EffectiveSettings } from '../../../shared/settings.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { CharactersModule } from '../characters/index.js';
import type { PlaybackModule } from '../playback/index.js';
import { createGiftAggregator } from './gifts.js';
import { createQueue, type DropRecord, type QueueItem } from './queue.js';
import { createRules, type GiftRuleConfig, type PersonaConfig } from './rules.js';

// 互动编排:唯一待播队列、冷却、礼物合并、任务生命周期与紧急停止。
// 任务串行执行:出队 → 固定动作与素材 → playback.play 的唯一终态 → 核对任务版本 → 下一条。
// 迟到的终态经版本校验后丢弃,防止停止后旧结果重新驱动调度。

export type EnqueueResult =
  | { accepted: true; eventId: string }
  | { accepted: false; eventId: string; reason: string };

export type InteractionState = {
  paused: boolean;
  queue: { capacity: number; length: number; items: QueueItem[]; drops: DropRecord[] };
  current: TaskView | null;
};

export type InteractionModule = {
  enqueue(event: LiveEvent): EnqueueResult;
  manualAction(actionId: string): EnqueueResult;
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

export function createInteraction(deps: {
  settings(): EffectiveSettings;
  characters: CharactersModule;
  playback: PlaybackModule;
  persona: PersonaConfig;
  giftRules: GiftRuleConfig;
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
  let current: {
    eventId: string;
    performanceId: string;
    stage: 'dispatching' | 'waiting-playback';
    say: string;
    action: string;
    since: number;
    version: number;
    controller: AbortController;
  } | null = null;
  let taskVersion = 0;
  let paused = false;

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
      });
      return { accepted: true, eventId };
    }
    if (event.type === 'guard' || event.type === 'superchat') {
      const say = rules.celebrate(event.user.name, event.type === 'guard' ? '大航海' : '醒目留言');
      const item: QueueItem = {
        eventId,
        type: event.type,
        priority: 80,
        enqueuedAt: now(),
        expiresAt: now() + 60_000,
        say,
        action: 'celebrate',
        userKey: `${event.source}:${event.user.id}`,
      };
      const pushed = queue.push(item);
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
    const parsed = rules.parseChat(event.text ?? '');
    const item: QueueItem = {
      eventId,
      type: 'chat',
      priority: 40,
      enqueuedAt: now(),
      expiresAt: now() + settings.queue.chatTtlMs,
      say: parsed.say,
      action: parsed.action ?? 'talk',
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

  function manualAction(actionId: string): EnqueueResult {
    const eventId = `manual-${randomUUID().slice(0, 8)}`;
    const item: QueueItem = {
      eventId,
      type: 'manual',
      priority: 100,
      enqueuedAt: now(),
      expiresAt: now() + 60_000,
      say: '',
      action: actionId,
      userKey: null,
    };
    const pushed = queue.push(item);
    if (!pushed.ok) recordReject(eventId, pushed.reason);
    notify();
    tick();
    return pushed.ok ? { accepted: true, eventId } : { accepted: false, eventId, reason: pushed.reason };
  }

  function buildPerformance(item: QueueItem): { performance: Performance; asset: { assetId: string; loop: boolean; available: boolean } | null } {
    const resolved = characters.resolveAction(item.action);
    let actionId = item.action;
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
      logger.warn('interaction.action-not-whitelisted', { eventId: item.eventId, requested: item.action, fallback: actionId });
    }
    const performance: Performance = {
      id: `pf-${randomUUID().slice(0, 8)}`,
      sourceEventId: item.eventId,
      priority: item.priority,
      say: item.say,
      action: actionId,
      expiresAt: now() + 60_000,
    };
    return { performance, asset };
  }

  function dispatch(item: QueueItem): void {
    taskVersion += 1;
    const version = taskVersion;
    const { performance, asset } = buildPerformance(item);
    const controller = new AbortController();
    current = {
      eventId: item.eventId,
      performanceId: performance.id,
      stage: 'waiting-playback',
      say: performance.say,
      action: performance.action,
      since: now(),
      version,
      controller,
    };
    logger.info('interaction.dispatch', { eventId: item.eventId, performanceId: performance.id, action: performance.action, priority: item.priority });
    notify();
    playback
      .play({ performance, asset, signal: controller.signal })
      .then((result) => {
        if (current === null || current.version !== version) {
          logger.info('interaction.late-result-dropped', { eventId: item.eventId, performanceId: performance.id, result: result.status });
          return;
        }
        history.push({ eventId: item.eventId, performanceId: performance.id, status: result.status, at: now() });
        if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
        logger.info('interaction.task-finished', { eventId: item.eventId, performanceId: performance.id, status: result.status });
        current = null;
        notify();
        tick();
      })
      .catch((err: unknown) => {
        // playback.play 约定只 resolve;此处仅防御性兜底,保证调度不悬挂。
        logger.error('interaction.playback-unexpected', { eventId: item.eventId, error: String(err) });
        current = null;
        notify();
        tick();
      });
  }

  /** 调度心跳:礼物窗口出队 → 容量同步 → 空闲时取下一条。由 app 统一定时调用。 */
  function tick(): void {
    queue.setCapacity(deps.settings().queue.capacity);
    const emissions = gifts.sweep();
    for (const emission of emissions) {
      const item: QueueItem = {
        eventId: `gift-${randomUUID().slice(0, 8)}`,
        type: 'gift',
        priority: 60,
        enqueuedAt: now(),
        expiresAt: now() + 60_000,
        say: rules.thanks(emission.userName, emission.giftName, emission.totalQuantity),
        action: 'gift',
        userKey: emission.userKey,
      };
      const pushed = queue.push(item);
      if (!pushed.ok) recordReject(item.eventId, pushed.reason);
    }
    if (emissions.length > 0) notify();
    if (paused || current !== null) return;
    const next = queue.popBest();
    if (next) dispatch(next);
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
    };
  }

  return { enqueue, manualAction, pause, resume, stop, tick, state, onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); } };
}
