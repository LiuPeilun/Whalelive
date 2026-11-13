// 表演计划与播放回执契约(ARCHITECTURE §8)。
// runId = 本次服务启动标识;leaseId = 播放端音频租约;performanceId = 单次表演。

export type Performance = {
  id: string;
  sourceEventId: string;
  priority: number;
  say: string;
  action: string;
  audioUrl?: string;
  expiresAt: number;
};

export type PlaybackTrack = 'animation' | 'audio';

export type PlaybackReportStatus = 'ready' | 'started' | 'ended' | 'cancelled' | 'failed';

export type PlaybackReport = {
  runId: string;
  leaseId: string | null;
  performanceId: string;
  rendererId: string;
  track: PlaybackTrack;
  status: PlaybackReportStatus;
  at: number;
  reason?: string;
};

export type PlaybackResult =
  | { performanceId: string; status: 'ended' }
  | { performanceId: string; status: 'cancelled' }
  | { performanceId: string; status: 'failed'; code: string };

/** 派发给播放端的完整命令:表演 + 解析后的资源地址与循环配置。 */
export type PerformanceDispatch = {
  runId: string;
  leaseId: string | null;
  performance: Performance;
  asset: {
    url: string;
    mime: string;
    loop: boolean;
    /** 素材缺失时为 false,播放端回报 ASSET_MISSING 并以字幕时长兜底展示。 */
    available: boolean;
  } | null;
};

export function isPlaybackReport(value: unknown): value is PlaybackReport {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.runId === 'string' &&
    (v.leaseId === null || typeof v.leaseId === 'string') &&
    typeof v.performanceId === 'string' &&
    typeof v.rendererId === 'string' &&
    (v.track === 'animation' || v.track === 'audio') &&
    typeof v.status === 'string' &&
    ['ready', 'started', 'ended', 'cancelled', 'failed'].includes(v.status) &&
    typeof v.at === 'number'
  );
}
