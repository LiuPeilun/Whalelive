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
import { createSongCache, settingsFingerprint, type SongCache } from './cache.js';

export type SongReadyPayload = {
  jobId: string;
  eventId: string;
  title: string;
  /** 管线内实际换声 key;缓存命中时未知为 null(WT-P3-008)。 */
  key: number | null;
  audioUrl: string;
};

export type SingingModule = {
  /** 只读探测缓存命中(不产生副作用)。 */
  peekCached(title: string): boolean;
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
const MAX_ACTIVE = 2; // 同时跑管线的上限(WT-P3-002):超出直接拒绝,不排队

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

  // WT-P3-002:只清理已结束任务(活跃任务永不删,否则紧急取消与状态追踪会漏);
  // 容量上限只对已结束任务生效,最旧优先淘汰。
  function prune(): void {
    const cutoff = now() - JOB_TTL_MS;
    const ended: JobState[] = [];
    for (const [id, job] of jobs) {
      if (job.stage !== 'ready' && job.stage !== 'failed') continue;
      if (job.updatedAt < cutoff) {
        jobs.delete(id);
        continue;
      }
      ended.push(job);
    }
    ended.sort((a, b) => a.updatedAt - b.updatedAt);
    while (ended.length > MAX_JOBS) {
      const oldest = ended.shift();
      if (oldest === undefined) break;
      jobs.delete(oldest.jobId);
    }
  }

  function fail(job: JobState, error: string): void {
    if (job.stage === 'ready' || job.stage === 'failed') return;
    logger.warn('singing.job-failed', { jobId: job.jobId, title: job.title, error });
    touch(job, { stage: 'failed', error, controller: null });
  }

  /** WT-P3-002 复审:急停/中止后的收尾。此时子进程树已确认退出(管线 close 后才结算),
   * 临时成片一并清理,配额从此处才真正释放。 */
  function settleCancelled(job: JobState, outMp3Path: string | null): void {
    if (outMp3Path !== null) {
      try { fs.rmSync(outMp3Path, { force: true }); } catch { /* 已不存在 */ }
    }
    fail(job, 'cancelled');
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
      if (controller.signal.aborted || stopped) {
        settleCancelled(job, null);
        return;
      }
      touch(job, { chosenTitle: result.chosenTitle });

      // key 为管线内基于输入 f0 的实际换声参数(WT-P3-008:不再用输出 f0 二次重算)
      const key = result.key;
      touch(job, { key, stage: 'converting' });

      // wav → mp3 → 确定性缓存文件(二次点歌秒出);编码同样可中止(WT-P3-002)
      const audioId = `song-${job.jobId}.mp3`.replace(/[^A-Za-z0-9_.-]/g, '_');
      const outMp3 = path.join(paths.audioCacheDir, audioId);
      await encodeMp3(pipelineDeps.ffmpegPath, result.wavPath, outMp3, {
        timeoutMs: 120_000,
        signal: controller.signal,
      });
      if (controller.signal.aborted || stopped) {
        // WT-P3-002 复审:被中止的编码也可能留下半成品 MP3,清理后才释放配额
        settleCancelled(job, outMp3);
        return;
      }

      const published = cache.store(fs.readFileSync(outMp3), job.title, settingsFingerprint(s));
      fs.rmSync(outMp3, { force: true });
      const url = `/media/audio/${published}`;
      touch(job, { stage: 'ready', audioUrl: url, controller: null });
      logger.info('singing.job-ready', {
        jobId: job.jobId, title: job.title, chosenTitle: result.chosenTitle,
        inputMedianHz: result.inputMedianHz, key, audioUrl: url,
      });
      // workDir 清理(中间产物只保留日志结论)
      fs.rmSync(workDir, { recursive: true, force: true });
      deps.onSongReady({ jobId: job.jobId, eventId: job.eventId, title: job.title, key, audioUrl: url });
    } catch (err) {
      if (controller.signal.aborted || stopped) {
        settleCancelled(job, null);
        return;
      }
      const message = err instanceof PipelineStepError ? `${err.step}: ${err.tail.slice(-200)}` : String(err);
      fail(job, message);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  return {
    /** 只读探测:标题是否已有成片缓存(供互动确认语区分"这就来/正在准备")。 */
    peekCached(title: string): boolean {
      return cache.lookup(title.trim(), settingsFingerprint(settings())) !== null;
    },
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
      // WT-P3-002:并发上限(不同歌名同时点不无限启动管线,争抢 CPU/磁盘)。
      // 复审修正:cancelling(已 abort 但子进程尚未退出)仍占配额——急停后旧任务
      // 退出前,新点歌不允许启动,避免实际并发的任务数突破上限。
      const activeCount = [...jobs.values()].filter((j) => j.stage !== 'ready' && j.stage !== 'failed').length;
      if (activeCount >= MAX_ACTIVE) {
        return { ok: false, code: 'busy-limit', detail: 'too many active jobs' };
      }
      // WT-P3-007 复审:缓存命中零成本,不受 CPU 配额约束——先于配额检查
      const cachedId = cache.lookup(clean, settingsFingerprint(settings()));
      if (cachedId !== null) {
        const cachedJob: JobState = {
          jobId: `song-${randomUUID().slice(0, 8)}`,
          eventId: source.eventId,
          title: clean,
          stage: 'ready',
          key: null,
          audioUrl: `/media/audio/${cachedId}`,
          chosenTitle: null,
          cached: true,
          error: null,
          startedAt: now(),
          updatedAt: now(),
          controller: null,
        };
        jobs.set(cachedJob.jobId, cachedJob);
        logger.info('singing.cache-hit', { jobId: cachedJob.jobId, title: clean, audioUrl: cachedJob.audioUrl });
        deps.onSongReady({
          jobId: cachedJob.jobId, eventId: source.eventId, title: clean,
          key: null, audioUrl: cachedJob.audioUrl!,
        });
        return { ok: true, jobId: cachedJob.jobId, cached: true };
      }
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
          // WT-P3-008:缓存成片的移调参数未知,标记 null 而非编造数值
          key: null, audioUrl: job.audioUrl!,
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
        if (job.stage === 'ready' || job.stage === 'failed' || job.stage === 'cancelling') continue;
        // WT-P3-002 复审:只发起中止并标记 cancelling(仍占并发配额);
        // 待管线 close 确认退出后由 execute 的 settleCancelled 落 failed 并释放配额。
        job.controller?.abort();
        touch(job, { stage: 'cancelling' });
        logger.info('singing.job-cancelling', { jobId: job.jobId, title: job.title, reason });
      }
    },

    stop(): void {
      stopped = true;
      for (const job of jobs.values()) job.controller?.abort();
    },
  };
}
