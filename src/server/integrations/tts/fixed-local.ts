import type { SpeechProvider } from '../../modules/interaction/providers.js';
import type { AudioCache } from '../../infrastructure/audio-cache.js';

// P1 第一批的语音提供方:用 Node 直接合成一段“语音状”音调 WAV(零外部依赖),
// 原子写入音频缓存并返回 /media/audio 地址。时长随文本长度变化(约 1.5–8 秒),
// 便于验证“说话动画循环到音频结束”。P1 第二批替换为 edge-tts 适配器。

const SAMPLE_RATE = 22_050;

/** 合成“咕噜”语音状音调:基频 + 颤音,按音节包络断句。 */
function synthesizeWav(durationSec: number): Buffer {
  const totalSamples = Math.max(1, Math.round(durationSec * SAMPLE_RATE));
  const dataSize = totalSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  // RIFF/WAVE 头(16bit PCM 单声道)
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // 单声道
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // 字节率
  buffer.writeUInt16LE(2, 32); // 块对齐
  buffer.writeUInt16LE(16, 34); // 位深
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  const syllable = SAMPLE_RATE * 0.34; // 一个“音节”约 0.34s
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    const phaseInSyllable = (i % syllable) / syllable;
    // 音节包络:前 15% 淡入,后 25% 淡出,间隙极短
    const envelope = phaseInSyllable < 0.15 ? phaseInSyllable / 0.15 : phaseInSyllable > 0.75 ? (1 - phaseInSyllable) / 0.25 : 1;
    // 基频缓慢漂移,颤音让它听起来像“说话”
    const drift = 196 + 44 * Math.sin(2 * Math.PI * 0.6 * t);
    const vibrato = 1 + 0.03 * Math.sin(2 * Math.PI * 5.5 * t);
    const freq = drift * vibrato;
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.55 * Math.max(0, envelope);
    buffer.writeInt16LE(Math.round(sample * 32_767), 44 + i * 2);
  }
  return buffer;
}

export function createFixedLocalSpeech(deps: { cache: AudioCache }): SpeechProvider {
  return {
    async synthesize({ text, signal }) {
      if (signal.aborted) return null;
      // 时长与文本长度挂钩:每字约 220ms,下限 1.5s、上限 8s(对齐 ARCHITECTURE §8 单次语音目标)
      const durationSec = Math.min(8, Math.max(1.5, 1.2 + text.length * 0.22));
      const wav = synthesizeWav(durationSec);
      if (signal.aborted) return null;
      const audioId = deps.cache.put(wav, 'wav');
      return { audioUrl: `/media/audio/${audioId}`, audioId };
    },
  };
}
