// 唱歌管线分步计时探针(测量工具,不经过服务):
// 用与 src/server/modules/singing/pipeline.ts 相同的步骤脚本、参数与工具链路径,
// 顺序跑完 搜歌 → 分离 → 测 f0 → 换声 → 编码,报告每步墙钟耗时与前后空闲内存。
//
// 开机后第一次运行得到的是「冷启动」数字(依赖库与模型首次读盘、杀软首次扫描);
// 紧接着再运行一次得到「热启动」数字。两者之差就是预加载/预热能省掉的部分。
//
// 用法: node scripts/song/pipeline-timing-probe.mjs "<歌名 歌手>" [--keep]
//   --keep 保留中间产物目录(默认跑完即删)

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const title = args.filter((a) => a !== '--keep').join(' ').trim();
if (title === '') {
  console.error('用法: node scripts/song/pipeline-timing-probe.mjs "<歌名 歌手>" [--keep]');
  process.exit(2);
}

// 工具链路径与 app.ts 的组装保持一致(仓库相对约定,见 GETTING_STARTED §7.1)
const rvcBundle = path.join(root, '.tools', 'rvc', 'RVC20260718DML');
const toolchain = {
  runtimePython: path.join(rvcBundle, 'runtime', 'python.exe'),
  demucsPython: path.join(root, '.tools', 'conda', 'whaletalk-song', 'python.exe'),
  ffmpegPath: path.join(rvcBundle, 'ffmpeg.exe'),
  torchHome: path.join(root, '.tools', 'torch-home'),
  stepDir: path.join(root, 'scripts', 'song', 'steps'),
};
for (const [name, file] of Object.entries(toolchain)) {
  if (!fs.existsSync(file)) {
    console.error(`缺少 ${name}:${file}\n工具链摆放见 docs/GETTING_STARTED.md §7.1「点歌唱歌」。`);
    process.exit(2);
  }
}

const settings = JSON.parse(fs.readFileSync(path.join(root, 'config', 'defaults.json'), 'utf8')).singing;
// 与 src/server/modules/singing/keys.ts 同式(探针不改由 keys.ts 单独负责的权威实现)
const keyForMedianF0 = (medianHz) => {
  if (!Number.isFinite(medianHz) || medianHz <= 0) return 0;
  const natural = Math.round(12 * Math.log2(settings.targetHz / medianHz));
  return Math.max(settings.keyMin, Math.min(settings.keyMax, natural));
};

// 数据目录放项目内(data/ 已忽略):%TEMP% 对 RVC runtime 的写入会被杀软拦截
const workDir = path.join(root, 'data', `.song-timing-probe-${Date.now()}`);
fs.mkdirSync(workDir, { recursive: true });

const gb = () => `${(os.freemem() / 2 ** 30).toFixed(1)}GB`;

function runStep(name, cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(cmd, argv, {
      cwd: opts.cwd ?? root,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(opts.env ?? {}) },
      windowsHide: true,
    });
    onInterrupt = () => {
      if (child.pid !== undefined) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    };
    const decOut = new StringDecoder('utf8');
    const decErr = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += decOut.write(d); });
    child.stderr.on('data', (d) => { stderr += decErr.write(d); });
    child.on('close', (code) => {
      onInterrupt = null;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
      const last = lines[lines.length - 1] ?? '';
      let json = null;
      if (last.startsWith('{')) {
        try { json = JSON.parse(last); } catch { /* 非 JSON 结果 */ }
      }
      resolve({ name, ms, code, json, stderr });
    });
  });
}

let onInterrupt = null;
process.on('SIGINT', () => {
  onInterrupt?.();
  process.exit(130);
});

const rows = [];
const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`;

console.log(`歌名:${title}`);
console.log(`数据目录:${workDir}`);
console.log(`空闲内存(开始):${gb()}`);

await (async () => {
  const s = settings;
  const fetch = await runStep('搜歌下载', toolchain.runtimePython, [
    path.join(toolchain.stepDir, 'fetch.py'), title, workDir, String(s.clipStartRatio), String(s.clipSeconds), toolchain.ffmpegPath,
  ]);
  rows.push({ ...fetch, note: fetch.json?.chosenTitle ?? '' });
  if (fetch.code !== 0 || !fetch.json) return [fetch];

  const separate = await runStep('人声分离', toolchain.demucsPython, [
    path.join(toolchain.stepDir, 'separate.py'), fetch.json.clipPath, workDir,
  ], { env: { TORCH_HOME: toolchain.torchHome } });
  rows.push({ ...separate, note: separate.json ? `htdemucs → ${path.basename(separate.json.vocalsPath)}` : '' });
  if (separate.code !== 0 || !separate.json) return [fetch, separate];

  const analyze = await runStep('音高分析', toolchain.runtimePython, [
    path.join(toolchain.stepDir, 'f0key.py'), separate.json.vocalsPath,
  ]);
  const key = analyze.json ? keyForMedianF0(analyze.json.medianHz) : null;
  rows.push({ ...analyze, note: analyze.json ? `输入中位 ${analyze.json.medianHz.toFixed(1)}Hz → key ${key >= 0 ? '+' : ''}${key}` : '' });
  if (analyze.code !== 0 || !analyze.json) return [fetch, separate, analyze];

  const convert = await runStep('换声', toolchain.runtimePython, [
    path.join(toolchain.stepDir, 'convert.py'), separate.json.vocalsPath, String(key),
    String(s.indexRate), String(s.protect), String(s.rmsMixRate), workDir,
  ], { cwd: rvcBundle });
  rows.push({ ...convert, note: convert.json ? `输出中位 ${convert.json.medianHz.toFixed(1)}Hz` : '' });
  if (convert.code !== 0 || !convert.json) return [fetch, separate, analyze, convert];

  const outMp3 = path.join(workDir, 'probe.mp3');
  const encode = await runStep('编码 mp3', toolchain.ffmpegPath, [
    '-y', '-v', 'error', '-i', convert.json.wavPath, '-codec:a', 'libmp3lame', '-q:a', '3', outMp3,
  ]);
  rows.push({ ...encode, note: fs.existsSync(outMp3) ? `${(fs.statSync(outMp3).size / 1024).toFixed(0)}KB` : '' });
  return [fetch, separate, analyze, convert, encode];
})();

const total = rows.reduce((sum, r) => sum + r.ms, 0);
console.log('');
for (const r of rows) {
  console.log(`${r.name.padEnd(6, '　')}  ${fmt(r.ms).padStart(7)}  ${r.code === 0 ? '成功' : `失败(exit=${r.code})`}  ${r.note}`);
  if (r.code !== 0) console.error(r.stderr.split('\n').slice(-12).join('\n'));
}
console.log(`${'合计'.padEnd(6, '　')}  ${fmt(total).padStart(7)}`);
console.log(`空闲内存(结束):${gb()}`);
console.log(keep ? `\n中间产物保留在 ${workDir}` : '');

if (!keep) fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
process.exit(rows.every((r) => r.code === 0) ? 0 : 1);
