// 唱歌模块(P3):点歌任务生命周期与成片发布。
// 任务态在内存(重启后未完成任务自然失效,轨迹在日志);成片缓存落 audioCacheDir(重启后仍命中)。
// 依赖注入:Python/ffmpeg 路径与脚本目录由 app.ts 组装;interaction 通过注入回调接住成片。

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppPaths } from '../../infrastructure/paths.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { SingingSettings, SongJobStage, SongJobView, SongRequestResult } from '../../../shared/singing.js';
import { encodeMp3, PipelineStepError, runPipeline, type PipelineDeps } from './pipeline.js';
import { createSongCache, type SongCache } from './cache.js';
import { keyForMedianF0 } from './keys.js';

export type SongReadyPayload = {
  jobId: string;
  eventId: string;
  title: string;
  key: number;
  audioUrl: string;
};

export type SingingModule = {
  requestSong(title: string, source: { eventId: string }): SongRequestResult;
  job(jobId: string): SongJobView | null;
  jobs(): SongJobView[];
  /** 紧急停止:终止全部在途任务(成片缓存不受影响)。 */
  cancelAll(reason: string): void;
  stop(): void;
};

type JobState = {
  jobId: string;
  eventId: string;
  title: string;
  stage: SongJobStage;
  key: number | null;
  audioUrl: string | null;
  chosenTitle: string | null;
  cached: boolean;
  error: string | null;
  startedAt: number;
  updatedAt: number;
  controller: AbortController | null;
};

const JOB_TTL_MS = 30 * 60_000; // 结束任务保留 30 分钟供状态查询,超时清理
const MAX_JOBS = 40;

export function createSinging(deps: {
  paths: AppPaths;
  pipeline: PipelineDeps;
  settings(): SingingSettings;
  logger: Logger;
  now(): number;
  /** 成片就绪回调(interaction 组装队列条目)。 */
  onSongReady(payload: SongReadyPayload): void;
}): SingingModule {
  const { paths, pipeline: pipelineDeps, logger, now } = deps;
  const cache: SongCache = createSongCache({ audioDir: paths.audioCacheDir });
  const jobs = new Map<string, JobState>();
  let stopped = false;

  function settings(): SingingSettings {
    return deps.settings();
  }

  function touch(job: JobState, patch: Partial<JobState>): void {
    Object.assign(job, patch, { updatedAt: now() });
  }

  function view(job: JobState): SongJobView {
    return {
      jobId: job.jobId,
      title: job.title,
      stage: job.stage,
      key: job.key,
      audioUrl: job.audioUrl,
      chosenTitle: job.chosenTitle,
      cached: job.cached,
      error: job.error,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
    };
  }

  function prune(): void {
    const cutoff = now() - JOB_TTL_MS;
    for (const [id, job] of jobs) {
      const ended = job.stage === 'ready' || job.stage === 'failed';
      if (ended && job.updatedAt < cutoff) jobs.delete(id);
    }
    while (jobs.size > MAX_JOBS) {
      const oldest = jobs.keys().next().value;
      if (oldest === undefined) break;
      jobs.delete(oldest);
    }
  }

  function fail(job: JobState, error: string): void {
    if (job.stage === 'ready' || job.stage === 'failed') return;
    logger.warn('singing.job-failed', { jobId: job.jobId, title: job.title, error });
    touch(job, { stage: 'failed', error, controller: null });
  }

  async function execute(job: JobState): Promise<void> {
    const s = settings();
    const controller = new AbortController();
    touch(job, { controller });
    const workDir = path.join(paths.dataDir, 'song-work', job.jobId);
    try {
      fs.mkdirSync(workDir, { recursive: true });
      const result = await runPipeline(pipelineDeps, {
        title: job.title,
        workDir,
        settings: s,
        signal: controller.signal,
      });
      if (controller.signal.aborted || stopped) return;
      touch(job, { chosenTitle: result.chosenTitle });

      // f0 → 自适应 key(单一权威实现:keys.ts)
      const key = keyForMedianF0(result.medianHz, s.targetHz, s.keyMin, s.keyMax);
      touch(job, { key, stage: 'converting' });

      // wav → mp3 → 确定性缓存文件(二次点歌秒出)
      const audioId = `song-${job.jobId}.mp3`.replace(/[^A-Za-z0-9_.-]/g, '_');
      const outMp3 = path.join(paths.audioCacheDir, audioId);
      await encodeMp3(pipelineDeps.ffmpegPath, result.wavPath, outMp3);
      if (controller.signal.aborted || stopped) return;

      const published = cache.store(fs.readFileSync(outMp3), job.title);
      fs.rmSync(outMp3, { force: true });
      const url = `/media/audio/${published}`;
      touch(job, { stage: 'ready', audioUrl: url, controller: null });
      logger.info('singing.job-ready', {
        jobId: job.jobId, title: job.title, chosenTitle: result.chosenTitle,
        medianHz: result.medianHz, key, audioUrl: url,
      });
      // workDir 清理(中间产物只保留日志结论)
      fs.rmSync(workDir, { recursive: true, force: true });
      deps.onSongReady({ jobId: job.jobId, eventId: job.eventId, title: job.title, key, audioUrl: url });
    } catch (err) {
      if (controller.signal.aborted || stopped) return;
      const message = err instanceof PipelineStepError ? `${err.step}: ${err.tail.slice(-200)}` : String(err);
      fail(job, message);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  return {
    requestSong(title, source): SongRequestResult {
      if (!settings().enabled) return { ok: false, code: 'disabled', detail: 'singing disabled' };
      const clean = title.trim();
      if (clean === '') return { ok: false, code: 'empty-title', detail: 'empty title' };
      prune();

      // 同标题在途任务复用(同一首歌多人点不重复跑管线)
      for (const job of jobs.values()) {
        if (job.title === clean && job.stage !== 'ready' && job.stage !== 'failed') {
          return { ok: true, jobId: job.jobId, cached: false };
        }
      }
      const cachedId = cache.lookup(clean);
      const job: JobState = {
        jobId: `song-${randomUUID().slice(0, 8)}`,
        eventId: source.eventId,
        title: clean,
        stage: cachedId !== null ? 'ready' : 'queued',
        key: null,
        audioUrl: cachedId !== null ? `/media/audio/${cachedId}` : null,
        chosenTitle: null,
        cached: cachedId !== null,
        error: null,
        startedAt: now(),
        updatedAt: now(),
        controller: null,
      };
      jobs.set(job.jobId, job);
      if (cachedId !== null) {
        logger.info('singing.cache-hit', { jobId: job.jobId, title: clean, audioUrl: job.audioUrl });
        deps.onSongReady({
          jobId: job.jobId, eventId: source.eventId, title: clean,
          // 缓存命中沿用成片生成时的 key 语义:此处无重测,取 0 占位由播放侧透传(成片已是最终音频)
          key: 0, audioUrl: job.audioUrl!,
        });
      } else {
        void execute(job);
      }
      return { ok: true, jobId: job.jobId, cached: cachedId !== null };
    },

    job(jobId: string): SongJobView | null {
      const job = jobs.get(jobId);
      return job ? view(job) : null;
    },

    jobs(): SongJobView[] {
      prune();
      return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(view);
    },

    cancelAll(reason: string): void {
      for (const job of jobs.values()) {
        if (job.stage === 'ready' || job.stage === 'failed') continue;
        job.controller?.abort();
        touch(job, { stage: 'failed', error: `cancelled: ${reason}`, controller: null });
        logger.info('singing.job-cancelled', { jobId: job.jobId, title: job.title, reason });
      }
    },

    stop(): void {
      stopped = true;
      for (const job of jobs.values()) job.controller?.abort();
    },
  };
}
