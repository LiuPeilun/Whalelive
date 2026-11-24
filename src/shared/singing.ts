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

export type SongRequestResult =
  | { ok: true; jobId: string; cached: boolean }
  | { ok: false; code: 'disabled' | 'empty-title' | 'busy-title' | 'busy-limit'; detail: string };
