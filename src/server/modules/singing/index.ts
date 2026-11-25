// 唱歌模块(P3):点歌任务生命周期与成片发布。
// 任务态在内存(重启后未完成任务自然失效,轨迹在日志);成片缓存落 audioCacheDir(重启后仍命中)。
// 依赖注入:Python/ffmpeg 路径与脚本目录由 app.ts 组装;interaction 通过注入回调接住成片。

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppPaths } from '../../infrastructure/paths.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { SingingJobsView, SingingSettings, SongJobStage, SongJobView, SongRequestResult } from '../../../shared/singing.js';
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
  /** WT-P3-007 复审:可接性判定(单一实现,probe 与 requestSong 共用)。 */
  assess(title: string): { cached: boolean; reusable: boolean; acceptable: boolean };
  /** WT-P3-007 复审:只读探测可接性(缓存命中不受配额约束)。 */
  probe(title: string): { cached: boolean; acceptable: boolean };
  requestSong(title: string, source: { eventId: string }): SongRequestResult;
  job(jobId: string): SongJobView | null;
  jobs(): SongJobView[];
  /** 点歌面板只读快照(GET /api/singing/jobs)。 */
  jobsView(): SingingJobsView;
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
  /** WT-P3-005 复审:成片引用保护(已入队/在播的成片不参与缓存淘汰)。 */
  isProtected?(audioId: string): boolean;
  logger: Logger;
  now(): number;
  /** 成片就绪回调(interaction 组装队列条目)。返回受理结果:
   *  待播队列满等场景下成片可能无法入队(WT-P3-007 复审),job 将标记 failed 供状态查询。 */
  onSongReady(payload: SongReadyPayload): { ok: boolean; reason?: string };
}): SingingModule {
  const { paths, pipeline: pipelineDeps, logger, now } = deps;
  const cache: SongCache = createSongCache({
    audioDir: paths.audioCacheDir,
    ...(deps.isProtected ? { isProtected: deps.isProtected } : {}),
  });
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

  /** 在途判定(并发配额与面板视图共用同一口径):未到 ready/failed 即在途,cancelling 计入。 */
  function isActive(stage: SongJobStage): boolean {
    return stage !== 'ready' && stage !== 'failed';
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
    // WT-P3-002 复审:中止/失败路径也要清理半成品 MP3(路径提前声明供所有收尾分支使用)
    let outMp3: string | null = null;
    try {
      fs.mkdirSync(workDir, { recursive: true });
      const result = await runPipeline(pipelineDeps, {
        title: job.title,
        workDir,
        settings: s,
        signal: controller.signal,
        // 阶段随管线步骤推进(点歌面板显示真实进度);cancelling 由紧急停止置位,不被后续步骤覆盖
        onStage: (stage) => {
          if (job.stage !== 'cancelling') touch(job, { stage });
        },
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
      outMp3 = path.join(paths.audioCacheDir, audioId);
      await encodeMp3(pipelineDeps.ffmpegPath, result.wavPath, outMp3, {
        timeoutMs: 120_000,
        signal: controller.signal,
      });
      if (controller.signal.aborted || stopped) {
        // 被中止的编码可能留下半成品 MP3,清理后才释放配额
        settleCancelled(job, outMp3);
        return;
      }

      const published = cache.store(fs.readFileSync(outMp3), job.title, settingsFingerprint(s));
      fs.rmSync(outMp3, { force: true });
      const url = `/media/audio/${published}`;
      // WT-P3-007 复审:onSongReady(可能因待播队列满拒绝)先于 ready touch——
      // 入队失败时 fail() 才能落 failed,不再谎报 ready。
      const accepted = deps.onSongReady({ jobId: job.jobId, eventId: job.eventId, title: job.title, key, audioUrl: url });
      if (!accepted.ok) {
        fail(job, `queue-full: ${accepted.reason ?? ''}`);
        fs.rmSync(workDir, { recursive: true, force: true });
        return;
      }
      touch(job, { stage: 'ready', audioUrl: url, controller: null });
      logger.info('singing.job-ready', {
        jobId: job.jobId, title: job.title, chosenTitle: result.chosenTitle,
        inputMedianHz: result.inputMedianHz, key, audioUrl: url,
      });
      // workDir 清理(中间产物只保留日志结论)
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (err) {
      if (controller.signal.aborted || stopped) {
        // 中止路径:清理半成品 MP3,子进程确认退出后才释放配额
        settleCancelled(job, outMp3);
        return;
      }
      // WT-P3-002 复审:编码超时/进程报错/发布失败同样清理半成品 outMp3
      if (outMp3 !== null) {
        try { fs.rmSync(outMp3, { force: true }); } catch { /* 已不存在 */ }
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
    /** WT-P3-007 复审:可接性判定单一实现(probe 与 requestSong 共用,杜绝预判漂移)。
   *  cached=已有成片(零成本,不受配额);reusable=同标题在途可复用(不新增管线,不受配额);
   *  acceptable=enabled 且 (cached || reusable || 活跃<配额)。cancelling 计入占用。 */
    assess(title: string): { cached: boolean; reusable: boolean; acceptable: boolean } {
      const s = settings();
      const clean = title.trim();
      const cached = clean !== '' && cache.lookup(clean, settingsFingerprint(s)) !== null;
      let reusable = false;
      let activeCount = 0;
      for (const job of jobs.values()) {
        const ended = !isActive(job.stage);
        if (!ended) activeCount += 1;
        if (job.title === clean && !ended && job.stage !== 'cancelling') reusable = true;
      }
      const acceptable = s.enabled && clean !== '' && (cached || reusable || activeCount < MAX_ACTIVE);
      return { cached, reusable, acceptable };
    },
    /** 只读探测(供互动预判确认语)。 */
    probe(title: string): { cached: boolean; acceptable: boolean } {
      const a = this.assess(title);
      return { cached: a.cached, acceptable: a.acceptable };
    },
    requestSong(title, source): SongRequestResult {
      if (!settings().enabled) return { ok: false, code: 'disabled', detail: 'singing disabled' };
      const clean = title.trim();
      if (clean === '') return { ok: false, code: 'empty-title', detail: 'empty title' };
      prune();

      // WT-P3-007 复审:可接性判定单一来源(assess),probe 与此处共用,杜绝预判漂移
      const a = this.assess(clean);
      if (a.cached) {
        // 缓存命中:零成本直接就绪;先入队回调(可能因待播队列满失败),失败如实标记
        const cachedJob: JobState = {
          jobId: `song-${randomUUID().slice(0, 8)}`,
          eventId: source.eventId,
          title: clean,
          stage: 'queued',
          key: null,
          audioUrl: null,
          chosenTitle: null,
          cached: true,
          error: null,
          startedAt: now(),
          updatedAt: now(),
          controller: null,
        };
        jobs.set(cachedJob.jobId, cachedJob);
        const audioId = cache.lookup(clean, settingsFingerprint(settings()));
        const accepted = deps.onSongReady({
          jobId: cachedJob.jobId, eventId: source.eventId, title: clean,
          key: null, audioUrl: `/media/audio/${audioId}`,
        });
        if (!accepted.ok) {
          fail(cachedJob, `queue-full: ${accepted.reason ?? ''}`);
          return { ok: false, code: 'busy-limit', detail: 'cache hit but queue full' };
        }
        touch(cachedJob, { stage: 'ready', audioUrl: `/media/audio/${audioId}` });
        logger.info('singing.cache-hit', { jobId: cachedJob.jobId, title: clean, audioUrl: cachedJob.audioUrl });
        return { ok: true, jobId: cachedJob.jobId, cached: true };
      }
      if (a.reusable) {
        // 同标题在途任务复用(同一首歌多人点不重复跑管线);cancelling 不可复用
        for (const job of jobs.values()) {
          if (job.title === clean && job.stage !== 'ready' && job.stage !== 'failed' && job.stage !== 'cancelling') {
            return { ok: true, jobId: job.jobId, cached: false };
          }
        }
      }
      if (!a.acceptable) {
        // WT-P3-002:并发上限(不同歌名同时点不无限启动管线,争抢 CPU/磁盘);
        // cancelling 仍占配额——急停后旧任务退出前,新点歌不允许启动。
        return { ok: false, code: 'busy-limit', detail: 'too many active jobs' };
      }
      const cachedId = null;
      const job: JobState = {
        jobId: `song-${randomUUID().slice(0, 8)}`,
        eventId: source.eventId,
        title: clean,
        stage: 'queued',
        key: null,
        audioUrl: null,
        chosenTitle: null,
        cached: false,
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

    jobsView(): SingingJobsView {
      const all = this.jobs();
      return {
        enabled: settings().enabled,
        maxActive: MAX_ACTIVE,
        active: all.filter((job) => isActive(job.stage)).length,
        jobs: all,
      };
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
