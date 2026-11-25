import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PipelineStepError, runPipeline, type PipelineDeps, type PipelineStepName } from './pipeline.js';
import type { SingingSettings, SongJobStage } from '../../../shared/singing.js';
import { keyForMedianF0 } from './keys.js';

// runPipeline 的子进程编排回归:用 node 冒充各步 Python(脚本换成同名文件、写 JS),
// 真实走 spawn / stdout 解析 / 错误映射,不依赖 RVC、Demucs 工具链与网络。
// 每个替身脚本启动时核对自己这一步的「阶段标记」文件——阶段回报必须先于该步启动。

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whaletalk-pipeline-'));
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
  it('四步按序执行,阶段在每步启动前回报;key 由 Node 计算后传给换声步', async () => {
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
    const args = JSON.parse(fs.readFileSync(path.join(workDir, 'convert-args.json'), 'utf8')) as string[];
    expect(path.basename(args[0] ?? '')).toBe('vocals.wav');
    // 换声步收到:key、indexRate、protect、rmsMixRate、workDir 均按设置原样传入
    expect(args.slice(1)).toEqual(['7', '0.3', '0.33', '0.25', workDir]);
    expect(path.dirname(result.wavPath)).toBe(workDir);
    expect(path.basename(result.wavPath)).toBe('song-converted.wav');
    expect(result.outputMedianHz).toBe(303);
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
