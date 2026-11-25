// 唱歌管线跨端契约:任务阶段/视图。浏览器只读展示,管线编排全在服务端。
// 设置类型(SingingSettings)以 shared/settings.ts 为单一来源,此处仅复用。

import type { SingingSettings } from './settings.js';
export type { SingingSettings } from './settings.js';

export type SongJobStage =
  | 'queued'
  | 'fetching'
  | 'separating'
  | 'analyzing'
  | 'converting'
  /** 已发起取消但子进程树尚未确认退出(WT-P3-002:此间仍占并发配额)。 */
  | 'cancelling'
  | 'ready'
  | 'failed';

export type SongJobView = {
  jobId: string;
  title: string;
  stage: SongJobStage;
  /** f0 自适应移调值(半音);ready 前为 null。 */
  key: number | null;
  audioUrl: string | null;
  /** 源视频标题(择源结果);用于确认搜到的版本正确。 */
  chosenTitle: string | null;
  /** 是否命中成片缓存(二次点歌秒出)。 */
  cached: boolean;
  error: string | null;
  startedAt: number;
  updatedAt: number;
};

/** 点歌面板只读快照(GET /api/singing/jobs,控制台凭据)。 */
export type SingingJobsView = {
  /** 当前生效的 singing.enabled。 */
  enabled: boolean;
  /** 并发在途上限:超出直接拒绝(busy-limit),不排队。 */
  maxActive: number;
  /** 在途任务数(含 cancelling),与点歌受理判定同口径。 */
  active: number;
  /** 最近任务,新 → 旧;已结束任务保留一段时间后被清理。 */
  jobs: SongJobView[];
};

export type SongRequestResult =
  | { ok: true; jobId: string; cached: boolean }
  | { ok: false; code: 'disabled' | 'empty-title' | 'busy-title' | 'busy-limit'; detail: string };
