// 唱歌预处理管线:子进程编排(B站取歌→Demucs分离→测f0→RVC换声)。
// 每步独立超时;中止经 Windows taskkill /T 杀整棵进程树(脚本内有 ffmpeg/demucs 子进程)。
// 脚本成功约定:stdout 最后一行输出 JSON 对象;失败 exit≠0。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Logger } from '../../infrastructure/logger.js';
import type { SingingSettings, SongJobStage } from '../../../shared/singing.js';
import { keyForMedianF0 } from './keys.js';

export type PipelineDeps = {
  scriptsDir: string;
  runtimePython: string;
  demucsPython: string;
  ffmpegPath: string;
  torchHome: string;
  /** RVC 包目录(convert 步骤 cwd:模型/索引为包内相对路径)。 */
  rvcBundleDir: string;
  /** 换声工作进程启动超时(默认 180 秒,覆盖冷盘首次读取与杀软首扫);仅测试注入更短值。 */
  convertWorkerStartupTimeoutMs?: number;
  logger: Logger;
};

export type PipelineResult = {
  chosenTitle: string;
  /** 输入人声 f0 中位(key 的计算依据)。 */
  inputMedianHz: number;
  /** 实际传给换声的移调半音数(WT-P3-008:上层直接使用,不得用输出 f0 重算)。 */
  key: number;
  /** 换声输出 f0 中位(仅诊断参考)。 */
  outputMedianHz: number;
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
      // WT-P3-009:固定 Python 子进程 IO 编码为 UTF-8(Windows 重定向下默认 GBK 损坏中文)
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(opts.env ?? {}) },
      windowsHide: true,
    });
    // WT-P3-009:跨数据块解码(多字节字符被 chunk 切开时逐块 toString 会损坏)
    const decOut = new StringDecoder('utf8');
    const decErr = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killReason: string | null = null; // 非空=已发起 taskkill,等 close 再结算(WT-P3-002)
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
      killReason = `timeout after ${opts.timeoutMs}ms`;
      killTree();
    }, opts.timeoutMs);
    const onAbort = (): void => {
      killReason = 'aborted';
      killTree();
    };
    if (opts.signal.aborted) {
      onAbort();
      return;
    }
    opts.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      stdout += decOut.write(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      const text = decErr.write(d);
      stderr += text;
      // 步骤进度(如 "model loaded"、demucs 阶段)随到达随记,不再只留失败 tail
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed !== '') log(trimmed.slice(0, 400));
      }
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (killReason !== null) {
        finish(new PipelineStepError(step, killReason));
        return;
      }
      if (code === 0) finish(null, stdout);
      else {
        const tail = (stderr || stdout).split('\n').filter((l) => l.trim() !== '').slice(-14).join('\n');
        log(`exit=${code} tail:\n${tail}`);
        finish(new PipelineStepError(step, tail));
      }
    });
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

/** 换声指令(工作进程推理一次的全部参数;与 convert.py 的 argv 语义一致)。 */
export type ConvertCommand = {
  vocalsPath: string;
  key: number;
  indexRate: number;
  protect: number;
  rmsMixRate: number;
  workDir: string;
};

export type ConvertWorkerHandle = {
  /** resolve 模型设备信息;进程提前退出、启动失败或超时 resolve null(调用方回退 spawn-per-job 换声)。 */
  whenReady: Promise<string | null>;
  /** 单次换声(仅在 whenReady 非 null 后调用);进程推理一次后自行退出。 */
  convert(cmd: ConvertCommand): Promise<{ wavPath: string; medianHz: number }>;
  /** 杀整棵进程树(幂等;进程已退出时是无害操作)。 */
  kill(reason: string): void;
};

/** 拉起换声工作进程(convert-worker.py):导入与模型加载就绪后待命,收一条指令推理一次即退出。
 *  启动即加载是流水预热(P)的前提——与搜歌并行拉起,把 16-28 秒的启动开销藏进管线前段;
 *  endStdin 立即关闭 stdin 时脚本加载完因 EOF 自行退出,同一入口供启动期缓存预热(W)使用。 */
export function spawnConvertWorker(
  deps: PipelineDeps,
  opts: { signal: AbortSignal; startupTimeoutMs: number; endStdin?: boolean; inferenceTimeoutMs?: number },
  log: (line: string) => void,
): ConvertWorkerHandle {
  const child = spawn(deps.runtimePython, [path.join(deps.scriptsDir, 'steps', 'convert-worker.py')], {
    cwd: deps.rvcBundleDir,
    // WT-P3-009:固定 Python 子进程 IO 编码为 UTF-8(中文路径与 GBK 坑同前)
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // stdio 显式声明为 pipe,stdout/stderr 不会为 null
  const out = child.stdout!;
  const err = child.stderr!;
  const decOut = new StringDecoder('utf8');
  const decErr = new StringDecoder('utf8');
  let stdoutBuf = '';
  let stderrLines: string[] = [];
  let killed: string | null = null;
  let readySettled = false;
  let doneSettled = false;
  let settleReady: ((value: string | null) => void) | null = null;
  let settleDone: ((r: { wavPath: string; medianHz: number }) => void) | null = null;
  let failDone: ((err: Error) => void) | null = null;
  const whenReady = new Promise<string | null>((resolve) => { settleReady = resolve; });

  const failConvert = (tail: string): void => {
    if (doneSettled) return;
    doneSettled = true;
    failDone?.(new PipelineStepError('convert', tail));
  };

  const kill = (reason: string): void => {
    if (killed !== null) return;
    killed = reason;
    const pid = child.pid;
    if (pid !== undefined) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  };

  const resolveReady = (value: string | null): void => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(startupTimer);
    settleReady?.(value);
  };

  const startupTimer = setTimeout(() => {
    log('convert worker startup timeout');
    kill('startup-timeout');
    resolveReady(null);
  }, opts.startupTimeoutMs);

  const onAbort = (): void => {
    kill('aborted');
    resolveReady(null);
    failConvert('aborted');
  };
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener('abort', onAbort, { once: true });
  // 预热(W):立即关闭 stdin,脚本加载完读到 EOF 自行退出
  if (opts.endStdin) child.stdin?.end();

  child.on('error', (err) => {
    log(`convert worker spawn error: ${String(err)}`);
    resolveReady(null);
  });

  out.on('data', (d: Buffer) => {
    stdoutBuf += decOut.write(d);
    for (;;) {
      const idx = stdoutBuf.indexOf('\n');
      if (idx < 0) break;
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line === '') continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        log(`worker stdout(非 JSON): ${line.slice(0, 200)}`);
        continue;
      }
      if (event.event === 'ready') {
        resolveReady(typeof event.device === 'string' && event.device !== '' ? event.device : 'unknown');
      } else if (event.event === 'done') {
        if (doneSettled) continue;
        doneSettled = true;
        settleDone?.({ wavPath: String(event.wavPath ?? ''), medianHz: Number(event.medianHz) });
      } else if (event.event === 'error') {
        const phase = String(event.phase ?? '?');
        const message = String(event.message ?? '');
        log(`worker error(${phase}): ${message}`);
        if (phase === 'load') resolveReady(null);
        else failConvert(message);
      }
    }
  });

  err.on('data', (d: Buffer) => {
    for (const line of decErr.write(d).split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      stderrLines.push(trimmed);
      if (stderrLines.length > 40) stderrLines.shift();
      log(trimmed.slice(0, 400));
    }
  });

  child.on('close', (code) => {
    resolveReady(null); // close 前未就绪 = 启动失败;已就绪时此调用无效
    if (!doneSettled) {
      doneSettled = true;
      const tail = stderrLines.slice(-14).join('\n');
      failDone?.(new PipelineStepError('convert', killed !== null ? killed : `worker exit=${code}${tail === '' ? '' : ` tail:\n${tail}`}`));
    }
  });

  return {
    whenReady,
    convert(cmd) {
      if (killed !== null) return Promise.reject(new PipelineStepError('convert', `worker ${killed}`));
      if (child.exitCode !== null) return Promise.reject(new PipelineStepError('convert', `worker already exited (code=${child.exitCode})`));
      const timeoutMs = opts.inferenceTimeoutMs ?? 240_000;
      return new Promise<{ wavPath: string; medianHz: number }>((resolve, reject) => {
        const timer = setTimeout(() => {
          doneSettled = true; // 防 close 再走 failDone(已 reject,避免无人接的拒绝)
          kill('inference-timeout');
          reject(new PipelineStepError('convert', `inference timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        settleDone = (r) => {
          clearTimeout(timer);
          resolve(r);
        };
        failDone = (e) => {
          clearTimeout(timer);
          reject(e);
        };
        // 指令写完即关 stdin:脚本只读一行,关掉让它推理完自然退出
        child.stdin?.write(`${JSON.stringify(cmd)}\n`, 'utf-8', () => child.stdin?.end());
      });
    },
    kill(reason) {
      kill(reason);
    },
  };
}

/** 启动期缓存预热(W):唱歌开启时拉起一个换声工作进程,完成依赖导入与模型加载后立即收尾——
 *  把首次磁盘读取与杀软扫描挪到服务启动期;无常驻内存,失败仅记日志不影响服务。 */
export function warmConvertRuntime(deps: PipelineDeps, logger: Logger): void {
  const log = (line: string): void => logger.info('singing.warmup', { line });
  try {
    const worker = spawnConvertWorker(
      deps,
      { signal: new AbortController().signal, startupTimeoutMs: 180_000, endStdin: true },
      log,
    );
    void worker.whenReady.then((device) => {
      log(device === null ? 'convert worker unavailable; warmup skipped' : `warmup finished (${device})`);
      worker.kill('warmup-finished'); // 加载完成即达预热目的;与脚本 EOF 自退收尾竞争无害
    });
  } catch (err) {
    logger.warn('singing.warmup-failed', { error: String(err) });
  }
}

/** 跑完四步,返回换声 wav 与 f0/key 中间值。 */
export async function runPipeline(
  deps: PipelineDeps,
  opts: {
    title: string;
    workDir: string;
    settings: SingingSettings;
    signal: AbortSignal;
    /** 每步开始前回报阶段(任务视图据此显示真实进度;失败时停在该步)。 */
    onStage?(stage: SongJobStage): void;
  },
): Promise<PipelineResult> {
  const { scriptsDir, runtimePython, demucsPython, ffmpegPath, torchHome, rvcBundleDir, logger } = deps;
  const step = path.join(scriptsDir, 'steps');
  const s = opts.settings;
  const log = (line: string): void => logger.info('singing.step', { title: opts.title, line });

  // [1/4] 搜歌+下载+切片(runtime python,仅标准库+ffmpeg)
  opts.onStage?.('fetching');
  // [0] 换声工作进程与搜歌并行启动:用管线前段(搜歌+分离+测 f0,热态约 1 分钟)完成
  // 依赖导入与模型加载(实测 16-28 秒),前段结束直接推理——省掉每首一次的换声启动开销。
  // 工作进程未能就绪(工具链缺失、被杀软拦截等)时回退为原 spawn-per-job 换声,行为不变。
  const worker = spawnConvertWorker(deps, {
    signal: opts.signal,
    startupTimeoutMs: deps.convertWorkerStartupTimeoutMs ?? 180_000,
  }, log);
  const abortWorker = (): void => worker.kill('aborted');
  if (opts.signal.aborted) abortWorker();
  else opts.signal.addEventListener('abort', abortWorker, { once: true });

  try {
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
    opts.onStage?.('separating');
    const sepOut = await runStep(
      'separate',
      demucsPython,
      [path.join(step, 'separate.py'), clipPath, opts.workDir],
      { timeoutMs: 180_000, signal: opts.signal, env: { TORCH_HOME: torchHome } },
      log,
    );
    const vocalsPath = str(lastJson(sepOut).vocalsPath, 'vocalsPath');

    // [3/4] 测 f0(RVC runtime 带 librosa/pyin);key 由 Node 侧 keys.ts 计算(单一权威实现)
    opts.onStage?.('analyzing');
    const f0Out = await runStep(
      'analyze',
      runtimePython,
      [path.join(step, 'f0key.py'), vocalsPath],
      { timeoutMs: 90_000, signal: opts.signal },
      log,
    );
    const inputMedianHz = num(lastJson(f0Out).medianHz, 'medianHz');
    const key = keyForMedianF0(inputMedianHz, s.targetHz, s.keyMin, s.keyMax);

    // [4/4] RVC 换声(key 由参数传入):优先用已就绪的工作进程,就绪失败回退 spawn-per-job
    opts.onStage?.('converting');
    const device = await worker.whenReady;
    let wavPath: string;
    let outputMedianHz: number;
    if (device !== null) {
      log(`convert worker ready (${device}); dispatching inference`);
      const done = await worker.convert({
        vocalsPath,
        key,
        indexRate: s.indexRate,
        protect: s.protect,
        rmsMixRate: s.rmsMixRate,
        workDir: opts.workDir,
      });
      wavPath = str(done.wavPath, 'wavPath');
      outputMedianHz = num(done.medianHz, 'medianHz');
    } else {
      log('convert worker unavailable; falling back to spawn-per-job convert');
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
      wavPath = str(convJson.wavPath, 'wavPath');
      outputMedianHz = num(convJson.medianHz, 'medianHz');
    }

    return { chosenTitle, inputMedianHz, key, outputMedianHz, wavPath };
  } finally {
    opts.signal.removeEventListener('abort', abortWorker);
    worker.kill('pipeline-finished'); // 成功路径脚本已自行退出;此处幂等兜底
  }
}

/** wav → mp3(成片发布格式);支持中止与超时(WT-P3-002:停止后不再遗留临时成片)。 */
export function encodeMp3(
  ffmpegPath: string,
  wavPath: string,
  outMp3Path: string,
  opts: { timeoutMs: number; signal: AbortSignal },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      ['-y', '-v', 'error', '-i', wavPath, '-codec:a', 'libmp3lame', '-q:a', '3', outMp3Path],
      { windowsHide: true },
    );
    let stderr = '';
    let settled = false;
    let killReason: string | null = null; // WT-P3-002 复审:kill 后等 close 确认退出才结算
    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const killTree = (): void => {
      const pid = child.pid;
      if (pid !== undefined) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    };
    const timer = setTimeout(() => {
      killReason = `encode timeout after ${opts.timeoutMs}ms`;
      killTree();
    }, opts.timeoutMs);
    const onAbort = (): void => {
      killReason = 'aborted';
      killTree();
    };
    if (opts.signal.aborted) {
      onAbort();
      return;
    }
    opts.signal.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (killReason !== null) {
        finish(new Error(`encode ${killReason}`));
        return;
      }
      if (code === 0) finish(null);
      else finish(new Error(`ffmpeg exit=${code}: ${stderr.slice(-300)}`));
    });
  });
}
