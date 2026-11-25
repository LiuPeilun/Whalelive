import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { PipelineStepError, runPipeline, warmConvertRuntime, type PipelineDeps, type PipelineStepName } from './pipeline.js';
import type { SingingSettings, SongJobStage } from '../../../shared/singing.js';
import { keyForMedianF0 } from './keys.js';
import type { Logger } from '../../infrastructure/logger.js';

// runPipeline 的子进程编排回归:用 node 冒充各步 Python(脚本换成同名文件、写 JS),
// 真实走 spawn / stdout 解析 / 错误映射,不依赖 RVC、Demucs 工具链与网络。
// 每个替身脚本启动时核对自己这一步的「阶段标记」文件——阶段回报必须先于该步启动。

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whaletalk-pipeline-'));
afterAll(() => {
  // 替身子进程的 cwd 在临时目录里,退出释放句柄可能有延迟,带重试清理
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

/** 步骤名 → 脚本文件;阶段标记按阶段名(每步启动前应已回报对应阶段)。 */
const STEP_SCRIPTS: Array<{ step: PipelineStepName; stage: SongJobStage; file: string }> = [
  { step: 'fetch', stage: 'fetching', file: 'fetch.py' },
  { step: 'separate', stage: 'separating', file: 'separate.py' },
  { step: 'analyze', stage: 'analyzing', file: 'f0key.py' },
  { step: 'convert', stage: 'converting', file: 'convert.py' },
];

const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => ({ ...silentLogger, child: () => silentLogger }),
};

/** 捕获 singing.warmup 日志行的替身 logger(warmConvertRuntime 断言用)。 */
function capturingLogger() {
  const lines: string[] = [];
  const base = {
    lines,
    debug: () => {},
    info: (_event: string, payload?: unknown) => {
      lines.push(String((payload as { line?: string } | undefined)?.line ?? _event));
    },
    warn: () => {},
    error: () => {},
    child: () => ({ ...base, child: () => base }),
  };
  return base;
}

/** 生成替身脚本目录(布局同真实 scripts/song:脚本在 steps/ 子目录);
 *  hangAt 的步骤挂起 60 秒(供中止用例),failAt 的步骤以 exit=3 失败。 */
function makeSteps(opts: { hangAt?: PipelineStepName; failAt?: PipelineStepName } = {}): PipelineDeps {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'steps-'));
  const body: Record<PipelineStepName, string> = {
    fetch: `console.log(JSON.stringify({ chosenTitle: process.argv[2] + ' 官方MV', clipPath: process.argv[3] + '/clip.wav', durationSec: 240 }));`,
    separate: `console.log(JSON.stringify({ vocalsPath: process.argv[2].replace('clip.wav', 'vocals.wav') }));`,
    analyze: `console.log(JSON.stringify({ medianHz: Number(process.env.STANDIN_MEDIAN_HZ ?? 205) }));`,
    convert: `
      require('fs').writeFileSync(process.argv[7] + '/convert-args.json', JSON.stringify(process.argv.slice(2)));
      console.log(JSON.stringify({ wavPath: process.argv[7] + '/song-converted.wav', medianHz: 303 }));`,
  };
  // 换声工作进程替身:复现 convert-worker.py 的 stdout 行协议(ready → 读一行指令 → done/error)。
  // 默认就绪后按指令写 wav;WORKER_MODE=fail-load 加载失败 / hang 永不就绪 / fail-convert 推理失败。
  const workerBody = `
    const fs = require('fs'), path = require('path');
    const DIR = ${JSON.stringify(dir)};
    function main() {
      if (!fs.existsSync(path.join(DIR, 'stage-fetching.txt'))) { console.error('stage marker missing: fetching'); process.exit(2); }
      const mode = process.env.WORKER_MODE ?? 'ok';
      if (mode === 'fail-load') { console.log(JSON.stringify({ event: 'error', phase: 'load', message: 'stand-in load boom' })); process.exit(1); }
      if (mode === 'hang') { setInterval(() => {}, 60000); return; }
      console.log(JSON.stringify({ event: 'ready', device: 'stand-in-dml' }));
      const line = fs.readFileSync(0, 'utf8');
      if (line.trim() === '') return;
      const cmd = JSON.parse(line);
      if (mode === 'fail-convert') { console.log(JSON.stringify({ event: 'error', phase: 'convert', message: 'stand-in inference boom' })); process.exit(1); }
      fs.writeFileSync(path.join(cmd.workDir, 'worker-cmd.json'), JSON.stringify(cmd));
      const wav = path.join(cmd.workDir, 'song-converted.wav');
      fs.writeFileSync(wav, 'RIFF');
      console.log(JSON.stringify({ event: 'done', wavPath: wav, medianHz: 303 }));
    }
    main();
  `;
  fs.mkdirSync(path.join(dir, 'steps'), { recursive: true });
  for (const { step, stage, file } of STEP_SCRIPTS) {
    const prelude = [
      `const fs = require('fs'), path = require('path');`,
      `if (!fs.existsSync(path.join(${JSON.stringify(dir)}, 'stage-${stage}.txt'))) { console.error('stage marker missing: ${stage}'); process.exit(2); }`,
      step === opts.hangAt ? `setTimeout(() => {}, 60000);` : '',
      step === opts.failAt ? `console.error('stand-in ${step} exploded'); process.exit(3);` : '',
    ];
    fs.writeFileSync(path.join(dir, 'steps', file), `${prelude.filter((l) => l !== '').join('\n')}\n${body[step]}\n`);
  }
  fs.writeFileSync(path.join(dir, 'steps', 'convert-worker.py'), workerBody);
    return {
      scriptsDir: dir,
    runtimePython: process.execPath,
    demucsPython: process.execPath,
    ffmpegPath: 'ff',
    torchHome: path.join(tmpDir, 'torch-home'),
    rvcBundleDir: tmpDir,
    logger: silentLogger,
  };
}

const settings: SingingSettings = {
  enabled: true, clipStartRatio: 0.4, clipSeconds: 24, targetHz: 310,
  keyMin: -6, keyMax: 24, indexRate: 0.3, protect: 0.33, rmsMixRate: 0.25, actionId: 'talk',
};

/** 阶段回报时落下对应标记(替身脚本启动时核对),并记录顺序。 */
function stageRecorder(dir: string): { stages: SongJobStage[]; onStage(stage: SongJobStage): void } {
  const stages: SongJobStage[] = [];
  return {
    stages,
    onStage(stage) {
      stages.push(stage);
      fs.writeFileSync(path.join(dir, `stage-${stage}.txt`), String(stages.length));
    },
  };
}

describe('runPipeline 子进程编排', () => {
  afterEach(() => {
    delete process.env.WORKER_MODE;
  });

  it('换声工作进程与搜歌并行启动:前段完成后直接推理,不再走 spawn-per-job', async () => {
    const deps = makeSteps();
    const workDir = path.join(tmpDir, 'work-ok');
    fs.mkdirSync(workDir, { recursive: true });
    const recorder = stageRecorder(deps.scriptsDir);
    const result = await runPipeline(deps, { title: '篇章 张韶涵', workDir, settings, signal: new AbortController().signal, onStage: recorder.onStage });

    expect(recorder.stages).toEqual(['fetching', 'separating', 'analyzing', 'converting']);
    expect(result.chosenTitle).toBe('篇章 张韶涵 官方MV');
    expect(result.inputMedianHz).toBe(205);
    // 205Hz → 310Hz:12×log2(310/205)=7.19 → +7(单一权威实现 keys.ts)
    expect(result.key).toBe(keyForMedianF0(205, 310, -6, 24));
    expect(result.key).toBe(7);
    // 工作进程路径:指令经 stdin 下发(路径与参数与设置一致),不再产生 convert.py 的 argv 记录
    const cmd = JSON.parse(fs.readFileSync(path.join(workDir, 'worker-cmd.json'), 'utf8')) as Record<string, unknown>;
    expect(path.basename(String(cmd.vocalsPath))).toBe('vocals.wav');
    expect(cmd).toMatchObject({ key: 7, indexRate: 0.3, protect: 0.33, rmsMixRate: 0.25, workDir });
    expect(fs.existsSync(path.join(workDir, 'convert-args.json'))).toBe(false);
    expect(path.basename(result.wavPath)).toBe('song-converted.wav');
    expect(path.dirname(result.wavPath)).toBe(workDir);
    expect(result.outputMedianHz).toBe(303);
  });

  it('工作进程加载失败:回退为 spawn-per-job 换声,行为与原实现一致', async () => {
    process.env.WORKER_MODE = 'fail-load';
    const deps = makeSteps();
    const workDir = path.join(tmpDir, 'work-fallback');
    fs.mkdirSync(workDir, { recursive: true });
    const recorder = stageRecorder(deps.scriptsDir);
    const result = await runPipeline(deps, { title: '任意', workDir, settings, signal: new AbortController().signal, onStage: recorder.onStage });

    expect(recorder.stages).toEqual(['fetching', 'separating', 'analyzing', 'converting']);
    expect(result.key).toBe(7);
    // 回退路径:convert.py 收到与原实现相同的 argv(workDir 是 argv[7])
    const args = JSON.parse(fs.readFileSync(path.join(workDir, 'convert-args.json'), 'utf8')) as string[];
    expect(path.basename(args[0] ?? '')).toBe('vocals.wav');
    expect(args.slice(1)).toEqual(['7', '0.3', '0.33', '0.25', workDir]);
    expect(fs.existsSync(path.join(workDir, 'worker-cmd.json'))).toBe(false);
  });

  it('工作进程启动超时:同样回退为 spawn-per-job 换声', async () => {
    process.env.WORKER_MODE = 'hang';
    const deps = { ...makeSteps(), convertWorkerStartupTimeoutMs: 800 };
    const workDir = path.join(tmpDir, 'work-timeout');
    fs.mkdirSync(workDir, { recursive: true });
    const recorder = stageRecorder(deps.scriptsDir);
    const result = await runPipeline(deps, { title: '任意', workDir, settings, signal: new AbortController().signal, onStage: recorder.onStage });

    expect(result.key).toBe(7);
    expect(fs.existsSync(path.join(workDir, 'convert-args.json'))).toBe(true);
    expect(fs.existsSync(path.join(workDir, 'worker-cmd.json'))).toBe(false);
  });

  it('工作进程推理失败:直接失败(不做二次回退),错误带步骤名与信息', async () => {
    process.env.WORKER_MODE = 'fail-convert';
    const deps = makeSteps();
    const workDir = path.join(tmpDir, 'work-infer-fail');
    fs.mkdirSync(workDir, { recursive: true });
    const recorder = stageRecorder(deps.scriptsDir);
    const promise = runPipeline(deps, { title: '任意', workDir, settings, signal: new AbortController().signal, onStage: recorder.onStage });
    void promise.catch(() => {}); // 断言前不留下未处理的拒绝
    await expect(promise).rejects.toMatchObject({ step: 'convert', tail: 'stand-in inference boom' });
    await expect(promise).rejects.toBeInstanceOf(PipelineStepError);
    expect(fs.existsSync(path.join(workDir, 'convert-args.json'))).toBe(false);
  });

  it('warmConvertRuntime:工作进程加载完成即收尾(缓存预热)', async () => {
    const deps = makeSteps();
    const logger = capturingLogger();
    // 预热在服务启动期发生,不经过 runPipeline;替身按约定核对「换声已在并行启动」标记
    fs.writeFileSync(path.join(deps.scriptsDir, 'stage-fetching.txt'), '1');
    warmConvertRuntime(deps, logger as unknown as Logger);
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (logger.lines.some((l) => l.includes('warmup finished (stand-in-dml)'))) break;
      if (Date.now() > deadline) throw new Error(`warmup 未完成: ${logger.lines.join(' | ')}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  it('某步失败:抛出带步骤名与输出尾部的 PipelineStepError,后续步骤不再启动', async () => {
    const deps = makeSteps({ failAt: 'separate' });
    const workDir = path.join(tmpDir, 'work-fail');
    fs.mkdirSync(workDir, { recursive: true });
    const recorder = stageRecorder(deps.scriptsDir);
    const promise = runPipeline(deps, { title: '任意', workDir, settings, signal: new AbortController().signal, onStage: recorder.onStage });
    void promise.catch(() => {}); // 断言前不留下未处理的拒绝
    await expect(promise).rejects.toMatchObject({ step: 'separate', tail: expect.stringContaining('stand-in separate exploded') });
    await expect(promise).rejects.toBeInstanceOf(PipelineStepError);
    expect(recorder.stages).toEqual(['fetching', 'separating']);
    expect(fs.existsSync(path.join(deps.scriptsDir, 'stage-analyzing.txt'))).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('中止:挂在某一步时杀掉整棵进程树并拒绝,阶段不再推进', async () => {
    const deps = makeSteps({ hangAt: 'separate' });
    const workDir = path.join(tmpDir, 'work-abort');
    fs.mkdirSync(workDir, { recursive: true });
    const recorder = stageRecorder(deps.scriptsDir);
    const controller = new AbortController();
    const promise = runPipeline(deps, { title: '任意', workDir, settings, signal: controller.signal, onStage: recorder.onStage });
    void promise.catch(() => {}); // 断言前不留下未处理的拒绝
    // 等替身走到挂起步骤(标记文件出现后再留出进程启动余量),然后中止
    for (let i = 0; i < 100 && !fs.existsSync(path.join(deps.scriptsDir, 'stage-separating.txt')); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 800));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ step: 'separate', tail: 'aborted' });
    expect(recorder.stages).toEqual(['fetching', 'separating']);
  });
});
