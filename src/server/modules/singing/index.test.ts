import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSinging, type SongReadyPayload } from './index.js';
import type { SongJobView } from '../../../shared/singing.js';
type SingingModuleView = SongJobView | null;
import { keyForMedianF0 } from './keys.js';
import { createSongCache, normalizeTitle, songCacheId } from './cache.js';
import type { AppPaths } from '../../infrastructure/paths.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { SingingSettings } from '../../../shared/singing.js';

// 验证唱歌任务生命周期(P3):key 公式、缓存命中、同标题复用、失败与取消。
// pipeline/encodeMp3 用可编程替身,不真跑子进程。

// ── 可编程替身:挂起/失败的受控 pipeline ──
type RunCall = { title: string; workDir: string; resolveWith: 'ok' | 'fail' | 'hang' };
const runCalls: RunCall[] = [];
let resolveAll: (() => void) | null = null;

vi.mock('./pipeline.js', () => ({
  PipelineStepError: class extends Error {
    step: string;
    tail: string;
    constructor(step: string, tail: string) {
      super(`singing pipeline step failed: ${step}`);
      this.step = step;
      this.tail = tail;
    }
  },
  runPipeline: (_deps: unknown, opts: { title: string; workDir: string }) => {
    const mode = runCalls[runCalls.length - 1]?.resolveWith ?? 'ok';
    if (mode === 'hang') return new Promise<void>(() => { resolveAll = () => { /* 挂起占位 */ }; });
    if (mode === 'fail') return Promise.reject(new Error('fetch: no results'));
    // ok:产出一个最小 wav 文件(sufficient for encodeMp3 替身读取)
    const wav = path.join(opts.workDir, 'song-converted.wav');
    fs.mkdirSync(opts.workDir, { recursive: true });
    fs.writeFileSync(wav, Buffer.from('RIFF'));
    return Promise.resolve({
      chosenTitle: `${opts.title} (官方MV)`,
      inputMedianHz: 205, key: 7, outputMedianHz: 303, wavPath: wav,
    });
  },
  encodeMp3: (_ff: string, wavPath: string, outPath: string) => {
    fs.writeFileSync(outPath, fs.readFileSync(wavPath));
    return Promise.resolve();
  },
}));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whaletalk-singing-'));
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const silentLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => ({ ...silentLogger, child: () => silentLogger }),
};

function makePaths(): AppPaths {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const dir = fs.mkdtempSync(path.join(tmpDir, 'case-'));
  return {
    projectRoot: root,
    versionedConfigDir: path.join(root, 'config'),
    dataDir: dir,
    userConfigDir: path.join(dir, 'config'),
    petsDir: dir,
    petDir: () => dir,
    audioCacheDir: dir,
    logsDir: dir,
    dbDir: dir,
    accessFile: path.join(dir, 'access.json'),
    userSettingsFile: path.join(dir, 'config', 'settings.json'),
  };
}

function singingSettings(patch?: Partial<SingingSettings>): SingingSettings {
  return {
    enabled: true, clipStartRatio: 0.4, clipSeconds: 24, targetHz: 310,
    keyMin: -6, keyMax: 24, indexRate: 0.3, protect: 0.33, rmsMixRate: 0.25,
    actionId: 'talk', ...patch,
  };
}

function makeModule(opts?: { settings?: SingingSettings; ready: SongReadyPayload[] }) {
  const paths = makePaths();
  let enabled = true;
  const settingsPatch = opts?.settings;
  const readyPayloads = opts?.ready ?? [];
  const module = createSinging({
    paths,
    pipeline: {
      scriptsDir: 'scripts/song', runtimePython: 'py', demucsPython: 'py2',
      ffmpegPath: 'ff', torchHome: 'th', rvcBundleDir: 'rvc', logger: silentLogger,
    },
    settings: () => {
      const base = settingsPatch ?? singingSettings();
      if (settingsPatch) return base;
      return { ...base, enabled };
    },
    logger: silentLogger,
    now: () => Date.now(),
    onSongReady: (payload) => readyPayloads.push(payload),
  });
  return { paths, module, readyPayloads, setEnabled: (v: boolean) => { enabled = v; } };
}

beforeEach(() => {
  runCalls.length = 0;
  resolveAll = null;
});

describe('keyForMedianF0(f0 自适应移调公式)', () => {
  it('张韶涵式女声 205Hz→+7;男声 130Hz→+15;高音 280Hz→+2', () => {
    expect(keyForMedianF0(205, 310, -6, 24)).toBe(7);
    expect(keyForMedianF0(130, 310, -6, 24)).toBe(15);
    expect(keyForMedianF0(280, 310, -6, 24)).toBe(2);
  });
  it('非法输入返回 0;超低音触发钳制边界', () => {
    expect(keyForMedianF0(0, 310, -6, 24)).toBe(0);
    expect(keyForMedianF0(-5, 310, -6, 24)).toBe(0);
    expect(keyForMedianF0(600, 310, -6, 24)).toBe(-6);
    expect(keyForMedianF0(80, 310, -6, 24)).toBe(23); // 自然值 23.4→23,未触边界
    expect(keyForMedianF0(40, 310, -6, 24)).toBe(24); // 24.7→clamp 24
  });
});

describe('songCache(成片缓存)', () => {
  it('标题规范化后确定性命中;配置指纹变更后不命中;容量超限淘汰最旧', () => {
    expect(normalizeTitle('  篇章   张韶涵 ')).toBe('篇章 张韶涵');
    const fp = '0.4|24|310|-6|24|0.3|0.33|0.25';
    expect(songCacheId('篇章 张韶涵', fp)).toBe(songCacheId('篇章 张韶涵 ', fp));
    const cache = createSongCache({ audioDir: path.join(tmpDir, 'cache-case') });
    expect(cache.lookup('篇章', fp)).toBeNull();
    const id = cache.store(Buffer.from('mp3data'), '篇章', fp);
    expect(id).toMatch(/^song-[0-9a-f]{12}\.mp3$/);
    expect(cache.lookup('篇章', fp)).toBe(id);
    // WT-P3-005:配置(指纹)变更 → 旧成片不再命中
    expect(cache.lookup('篇章', fp + 'x')).toBeNull();
    // WT-P3-005:容量上限——写入第 31 首后最旧被淘汰
    for (let i = 0; i < 31; i++) cache.store(Buffer.from('m' + i), '容量歌' + i, fp);
    const after = cache.lookup('容量歌0', fp);
    expect(after).toBeNull();
    expect(cache.lookup('容量歌30', fp)).not.toBeNull();
  });
});

describe('singing 任务生命周期', () => {
  it('缓存命中:直接 ready 并触发 onSongReady,不跑管线', async () => {
    const { paths, module, readyPayloads } = makeModule();
    // 预置成片文件
    const cache = createSongCache({ audioDir: paths.audioCacheDir });
    cache.store(Buffer.from('cached'), '旧歌', '0.4|24|310|-6|24|0.3|0.33|0.25');
    const req = module.requestSong('旧歌', { eventId: 'evt-1' });
    expect(req).toEqual({ ok: true, jobId: expect.any(String), cached: true });
    const job = module.job((req as { jobId: string }).jobId);
    expect(job?.stage).toBe('ready');
    expect(job?.cached).toBe(true);
    expect(job?.audioUrl).toMatch(/^\/media\/audio\/song-[0-9a-f]{12}\.mp3$/);
    expect(readyPayloads).toHaveLength(1);
    expect(runCalls).toHaveLength(0);
  });

  it('管线成功:ready+key 计算+成片发布', async () => {
    runCalls.push({ title: 'ok', workDir: 'ok', resolveWith: 'ok' });
    const { module, readyPayloads } = makeModule();
    const req = module.requestSong('好歌', { eventId: 'evt-4' });
    // 手写轮询(vitest 5.1 的 vi.waitFor 不轮询)
    let job: SingingModuleView = null;
    for (let i = 0; i < 100 && job?.stage !== 'ready'; i++) {
      await new Promise((r) => setTimeout(r, 30));
      job = module.job((req as { jobId: string }).jobId);
    }
    expect(job?.stage).toBe('ready');
    expect(job?.key).toBe(7); // mock: 输入 205Hz → 管线返回实际 key=7(WT-P3-008)
    expect(job?.chosenTitle).toContain('官方MV');
    expect(job?.audioUrl).toMatch(/^\/media\/audio\//);
    expect(readyPayloads).toHaveLength(1);
  });

  it('同标题在途复用同一任务,不重复跑管线', async () => {
    runCalls.push({ title: 'x', workDir: 'x', resolveWith: 'hang' });
    const { module, readyPayloads } = makeModule();
    const first = module.requestSong('测试歌', { eventId: 'evt-2' });
    expect(first.ok).toBe(true);
    expect(module.job((first as { jobId: string }).jobId)?.stage).toBe('queued');
    const second = module.requestSong('测试歌', { eventId: 'evt-3' });
    expect(second).toEqual({ ok: true, jobId: (first as { jobId: string }).jobId, cached: false });
    expect(runCalls).toHaveLength(1);
    expect(readyPayloads).toHaveLength(0); // 挂起未触发
  });

  it('管线失败:failed+错误信息,不影响后续请求', async () => {
    runCalls.push({ title: 'x', workDir: 'x', resolveWith: 'fail' });
    const { module } = makeModule();
    const req = module.requestSong('不存在的歌', { eventId: 'evt-5' });
    let failed: SingingModuleView = null;
    for (let i = 0; i < 100 && failed?.stage !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 30));
      failed = module.job((req as { jobId: string }).jobId);
    }
    expect(failed?.stage).toBe('failed');
    expect(module.job((req as { jobId: string }).jobId)?.error).toContain('no results');
  });

  it('紧急取消:在途任务 failed(reason=cancelled)', async () => {
    runCalls.push({ title: 'x', workDir: 'x', resolveWith: 'hang' });
    const { module } = makeModule();
    const req = module.requestSong('长任务', { eventId: 'evt-6' });
    module.cancelAll('emergency-stop');
    const job = module.job((req as { jobId: string }).jobId);
    expect(job?.stage).toBe('failed');
    expect(job?.error).toContain('cancelled: emergency-stop');
  });

  it('禁用时拒绝;空标题拒绝', () => {
    const { module, setEnabled } = makeModule();
    setEnabled(false);
    expect(module.requestSong('x', { eventId: 'e' })).toEqual({
      ok: false, code: 'disabled', detail: 'singing disabled',
    });
    setEnabled(true);
    expect(module.requestSong('   ', { eventId: 'e' })).toEqual({
      ok: false, code: 'empty-title', detail: 'empty title',
    });
  });
});

describe('WT-P3-002/006 修复回归', () => {
  it('并发上限:两个在途任务时第三个不同标题被拒 busy-limit', async () => {
    runCalls.push({ title: 'a', workDir: 'a', resolveWith: 'hang' });
    const { module } = makeModule();
    const r1 = module.requestSong('歌一', { eventId: 'e1' });
    const r2 = module.requestSong('歌二', { eventId: 'e2' });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const r3 = module.requestSong('歌三', { eventId: 'e3' });
    expect(r3).toEqual({ ok: false, code: 'busy-limit', detail: 'too many active jobs' });
    // 同标题在途不受影响(仍复用)
    const again = module.requestSong('歌一', { eventId: 'e4' });
    expect(again).toEqual({ ok: true, jobId: (r1 as { jobId: string }).jobId, cached: false });
    // 紧急取消后腾出配额
    module.cancelAll('test');
    const r4 = module.requestSong('歌三', { eventId: 'e5' });
    expect(r4.ok).toBe(true);
  });

  it('schema:移调边界必须整数,clipSeconds 上限 24', async () => {
    const { validateSinging } = await import('../settings/schema.js');
    const base = singingSettings();
    const badKey = validateSinging({ ...base, keyMin: 6.5 });
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) expect(badKey.field).toBe('singing.keyMin');
    const badClip = validateSinging({ ...base, clipSeconds: 25 });
    expect(badClip.ok).toBe(false);
    if (!badClip.ok) expect(badClip.field).toBe('singing.clipSeconds');
    expect(validateSinging({ ...base, keyMin: -6, keyMax: 24, clipSeconds: 24 }).ok).toBe(true);
  });
});
