import type { LiveEvent } from '../../../shared/live-event.js';
import { validateLiveEvent } from '../../../shared/live-event.js';
import { createDedupWindow } from './dedup.js';

// events 模块:统一事件校验与来源去重(PROJECT_STRUCTURE《模块职责》)。
// ingest 返回接收结果,由 app.ts 连接到 interaction.enqueue。

export type IngestResult =
  | { accepted: true; event: LiveEvent }
  | { accepted: false; reason: 'invalid' | 'duplicate'; detail: string };

export type EventsModule = {
  ingest(event: unknown): IngestResult;
  dedupSize(): number;
};

export function createEvents(deps: { now(): number }): EventsModule {
  const dedup = createDedupWindow({ now: deps.now });

  function ingest(event: unknown): IngestResult {
    const checked = validateLiveEvent(event);
    if (!checked.ok) return { accepted: false, reason: 'invalid', detail: checked.reason };
    const e = checked.event;
    const key = `${e.source}|${e.roomId}|${e.sourceKey}`;
    if (!dedup.admit(key)) {
      return { accepted: false, reason: 'duplicate', detail: key };
    }
    return { accepted: true, event: e };
  }

  return { ingest, dedupSize: dedup.size };
}
