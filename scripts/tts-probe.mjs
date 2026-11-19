// edge-tts 连通性探针:音色列表 + 真实合成一段中文 MP3 落盘。
// 用法:node scripts/tts-probe.mjs [文本] [音色ShortName]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = process.argv[2] ?? '大家好,我是大肥鱼!欢迎来到直播间,今天我们一起玩。';
const voice = process.argv[3] ?? 'zh-CN-XiaoxiaoNeural';

const t0 = Date.now();
const tts = new MsEdgeTTS({ enableLogger: false });
try {
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const voices = await tts.getVoices();
  const zh = voices.filter((v) => v.ShortName.startsWith('zh-'));
  console.log(`连通 OK(${((Date.now() - t0) / 1000).toFixed(1)}s),可用音色 ${voices.length} 个,其中中文 ${zh.length} 个`);
  console.log('常用中文音色:', zh.slice(0, 6).map((v) => `${v.ShortName}(${v.Gender === 'Female' ? '女' : '男'})`).join(', '), '…');

  const t1 = Date.now();
  const { audioFilePath } = await tts.toFile(path.join(root, '.tools'), text);
  const stat = fs.statSync(audioFilePath);
  console.log(`合成 OK(${((Date.now() - t1) / 1000).toFixed(1)}s): ${audioFilePath} (${(stat.size / 1024).toFixed(1)} KB, 文本 ${text.length} 字)`);
  tts.close();
  process.exit(0);
} catch (err) {
  console.error('探针失败:', err.message ?? err);
  try { tts.close(); } catch { /* ignore */ }
  process.exit(1);
}
