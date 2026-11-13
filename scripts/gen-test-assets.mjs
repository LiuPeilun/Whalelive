// 生成 P0 占位角色素材:8 段带透明通道的纯色 VP9-alpha WebM。
// 仅供本地链路验证(预加载、双缓冲、回执、OBS 透明),不包含任何第三方形象。
// 用法:npm run gen:test-assets  (需要 ffmpeg 在 PATH 中)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'data', 'pets', 'main', 'animations');
// 系统 PATH 无 libvpx 时,可用 FFMPEG_PATH 指向带 libvpx 的便携版 ffmpeg
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

const ACTIONS = [
  { id: 'idle', color: '0x2E86DE', seconds: 3, loop: true },
  { id: 'wave', color: '0x27AE60', seconds: 2, loop: false },
  { id: 'think', color: '0x8E44AD', seconds: 2, loop: false },
  { id: 'talk', color: '0xE67E22', seconds: 3, loop: true },
  { id: 'eat', color: '0xC0392B', seconds: 2, loop: false },
  { id: 'dance', color: '0xD4AC0D', seconds: 2, loop: false },
  { id: 'gift', color: '0x16A085', seconds: 2, loop: false },
  { id: 'celebrate', color: '0xE91E63', seconds: 2, loop: false },
];

function hasFfmpeg() {
  try {
    execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!hasFfmpeg()) {
  console.error('未找到 ffmpeg。占位素材需要 ffmpeg(含 libvpx-vp9)生成。');
  console.error('未生成素材时系统仍可运行:界面会显示素材缺失原因,动画回退待机占位。');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
let created = 0;
let skipped = 0;
for (const action of ACTIONS) {
  const target = path.join(outDir, `${action.id}.webm`);
  if (fs.existsSync(target)) {
    skipped += 1;
    continue;
  }
  execFileSync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=${action.color}@0.65:s=320x180:d=${action.seconds}:r=15`,
    '-vf', 'format=yuva420p',
    '-c:v', 'libvpx-vp9',
    '-b:v', '0',
    '-crf', '42',
    '-an',
    target,
  ], { stdio: 'ignore' });
  created += 1;
  console.log(`生成 ${path.relative(root, target)}`);
}
console.log(`完成:新增 ${created} 段,已存在跳过 ${skipped} 段。`);
