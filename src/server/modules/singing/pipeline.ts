// 唱歌预处理管线:子进程编排(B站取歌→Demucs分离→测f0→RVC换声)。
// 每步独立超时;中止经 Windows taskkill /T 杀整棵进程树(脚本内有 ffmpeg/demucs 子进程)。
// 脚本成功约定:stdout 最后一行输出 JSON 对象;失败 exit≠0。

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Logger } from '../../infrastructure/logger.js';
import type { SingingSettings } from '../../../shared/singing.js';
import { keyForMedianF0 } from './keys.js';

export type PipelineDeps = {
  scriptsDir: string;
  runtimePython: string;
  demucsPython: string;
  ffmpegPath: string;
  torchHome: string;
  /** RVC 包目录(convert 步骤 cwd:模型/索引为包内相对路径)。 */
  rvcBundleDir: string;
  logger: Logger;
};

export type PipelineResult = {
  chosenTitle: string;
  medianHz: number;
  wavPath: string;
};

export type PipelineStepName = 'fetch' | 'separate' | 'analyze' | 'convert';

export class PipelineStepError extends Error {
  step: PipelineStepName;
  tail: string;
  constructor(step: PipelineStepName, tail: string) {
    super(`singing pipeline step failed: ${step}`);
    this.step = step;
    this.tail = tail;
  }
}

type RunOpts = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
};

/** 运行一步;返回 stdout。中止/超时用 taskkill /T /F 杀进程树。 */
function runStep(
  step: PipelineStepError['step'],
  cmd: string,
  args: string[],
  opts: RunOpts,
  log: (line: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (err: Error | null, out?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(out ?? '');
    };
    const killTree = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      // Windows:直接 kill 只杀直接子进程,树内孙进程(ffmpeg/demucs)需 taskkill /T
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    };
    const timer = setTimeout(() => {
      killTree();
      finish(new PipelineStepError(step, `timeout after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    const onAbort = (): void => {
      killTree();
      finish(new PipelineStepError(step, 'aborted'));
    };
    if (opts.signal.aborted) {
      onAbort();
      return;
    }
    opts.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (code === 0) finish(null, stdout);
      else {
        const tail = (stderr || stdout).split('\n').filter((l) => l.trim() !== '').slice(-14).join('\n');
        log(`exit=${code} tail:\n${tail}`);
        finish(new PipelineStepError(step, tail));
      }
    });
    for (const line of stderr.split('\n')) if (line.trim() !== '') log(line);
  });
}

function lastJson(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n').filter((l) => l.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (line.startsWith('{')) {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        /* 继续向前找 */
      }
    }
  }
  throw new Error('step produced no JSON result');
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v === '') throw new Error(`missing ${field} in step JSON`);
  return v;
}

function num(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`missing ${field} in step JSON`);
  return v;
}

/** 跑完四步,返回换声 wav 与 f0/key 中间值。 */
export async function runPipeline(
  deps: PipelineDeps,
  opts: {
    title: string;
    workDir: string;
    settings: SingingSettings;
    signal: AbortSignal;
  },
): Promise<PipelineResult> {
  const { scriptsDir, runtimePython, demucsPython, ffmpegPath, torchHome, rvcBundleDir, logger } = deps;
  const step = path.join(scriptsDir, 'steps');
  const s = opts.settings;
  const log = (line: string): void => logger.info('singing.step', { title: opts.title, line });

  // [1/4] 搜歌+下载+切片(runtime python,仅标准库+ffmpeg)
  const fetchOut = await runStep(
    'fetch',
    runtimePython,
    [path.join(step, 'fetch.py'), opts.title, opts.workDir, String(s.clipStartRatio), String(s.clipSeconds), ffmpegPath],
    { timeoutMs: 180_000, signal: opts.signal },
    log,
  );
  const fetchJson = lastJson(fetchOut);
  const clipPath = str(fetchJson.clipPath, 'clipPath');
  const chosenTitle = str(fetchJson.chosenTitle, 'chosenTitle');

  // [2/4] Demucs 分离片段(whaletalk-song 环境;TORCH_HOME 指项目内缓存)
  const sepOut = await runStep(
    'separate',
    demucsPython,
    [path.join(step, 'separate.py'), clipPath, opts.workDir],
    { timeoutMs: 180_000, signal: opts.signal, env: { TORCH_HOME: torchHome } },
    log,
  );
  const vocalsPath = str(lastJson(sepOut).vocalsPath, 'vocalsPath');

  // [3/4] 测 f0(RVC runtime 带 librosa/pyin);key 由 Node 侧 keys.ts 计算(单一权威实现)
  const f0Out = await runStep(
    'analyze',
    runtimePython,
    [path.join(step, 'f0key.py'), vocalsPath],
    { timeoutMs: 90_000, signal: opts.signal },
    log,
  );
  const medianHz = num(lastJson(f0Out).medianHz, 'medianHz');
  const key = keyForMedianF0(medianHz, s.targetHz, s.keyMin, s.keyMax);

  // [4/4] RVC 换声(key 由参数传入)
  const convOut = await runStep(
    'convert',
    runtimePython,
    [
      path.join(step, 'convert.py'),
      vocalsPath,
      String(key),
      String(s.indexRate), String(s.protect), String(s.rmsMixRate),
      opts.workDir,
    ],
    { timeoutMs: 240_000, signal: opts.signal, cwd: rvcBundleDir },
    log,
  );
  const convJson = lastJson(convOut);
  const wavPath = str(convJson.wavPath, 'wavPath');
  const convMedian = num(convJson.medianHz, 'medianHz');

  return { chosenTitle, medianHz: convMedian > 0 ? convMedian : medianHz, wavPath };
}

/** wav → mp3(成片发布格式)。 */
export function encodeMp3(ffmpegPath: string, wavPath: string, outMp3Path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      ['-y', '-v', 'error', '-i', wavPath, '-codec:a', 'libmp3lame', '-q:a', '3', outMp3Path],
      { windowsHide: true },
    );
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit=${code}: ${stderr.slice(-300)}`))));
  });
}
