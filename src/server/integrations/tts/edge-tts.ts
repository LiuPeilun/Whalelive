import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { SpeechProvider } from '../../modules/interaction/providers.js';
import type { AudioCache } from '../../infrastructure/audio-cache.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { EffectiveSettings } from '../../../shared/settings.js';

// P1 第二批语音提供方:edge-tts(微软 Edge「大声朗读」通道,经 msedge-tts 客户端,
// 含 Sec-MS-GEC 令牌与连接管理)。合成结果为 MP3,原子写入音频缓存并返回地址。
// 连接按当前音色惰性建立并复用;音色变化或连接失效时重建一次重试。
// 合成失败/中止抛错或返回 null,由 interaction 按既有语义降级无声——不在本层
// 静默回退到罐头音,问题通过控制台试听与日志暴露。

/** msedge-tts 客户端的最小面(供测试替身实现) */
export interface EdgeTtsClient {
  setMetadata(voice: string, format: (typeof OUTPUT_FORMAT)[keyof typeof OUTPUT_FORMAT]): Promise<void>;
  toStream(input: string): { audioStream: NodeJS.ReadableStream & { destroy(): void }; metadataStream: NodeJS.ReadableStream | null };
  getVoices(): Promise<Array<{ ShortName: string; Gender: string; Locale: string }>>;
  close(): void;
}

export type EdgeTtsVoice = { shortName: string; gender: string; locale: string };

export type EdgeTtsSpeech = SpeechProvider & {
  /** 可用音色列表(中文在前);首次调用拉取并缓存 10 分钟,失败抛错 */
  voices(): Promise<EdgeTtsVoice[]>;
  /** 按指定音色合成(试听/音色验证用;synthesize 使用当前设置音色) */
  synthesizeWith(input: { text: string; voice: string; signal: AbortSignal }): Promise<{ audioUrl: string; audioId: string } | null>;
};

export function createEdgeTtsSpeech(deps: {
  cache: AudioCache;
  logger: Logger;
  voice(): string;
  now(): number;
  createClient?(): EdgeTtsClient;
}): EdgeTtsSpeech {
  const createClient = deps.createClient ?? (() => new MsEdgeTTS({ enableLogger: false }) as unknown as EdgeTtsClient);
  let client: EdgeTtsClient | null = null;
  let clientVoice = '';
  let voicesCache: { at: number; list: EdgeTtsVoice[] } | null = null;

  function closeClient(): void {
    if (client !== null) {
      try { client.close(); } catch { /* 已关闭 */ }
    }
    client = null;
    clientVoice = '';
  }

  /** 取指定音色的就绪客户端(惰性建立;音色变化时重建) */
  async function readyClient(voice: string): Promise<EdgeTtsClient> {
    if (client === null || clientVoice !== voice) {
      closeClient();
      client = createClient();
      await client.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      clientVoice = voice;
    }
    return client;
  }

  /** 收集音频流为 Buffer;signal 中止时销毁流并返回 null */
  function collectAudio(stream: NodeJS.ReadableStream & { destroy(): void }, signal: AbortSignal): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const onAbort = () => {
        stream.destroy();
        resolve(null);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        signal.removeEventListener('abort', onAbort);
        resolve(Buffer.concat(chunks));
      });
      stream.on('error', (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });
    });
  }

  /** 单次合成;连接就绪 → 流收集 → 入缓存。失败向上抛,由调用方决定重试。 */
  async function synthesizeOnce(text: string, voice: string, signal: AbortSignal) {
    const c = await readyClient(voice);
    if (signal.aborted) return null;
    const { audioStream } = c.toStream(text);
    const mp3 = await collectAudio(audioStream, signal);
    if (mp3 === null || mp3.length === 0) return null;
    const audioId = deps.cache.put(mp3, 'mp3');
    return { audioUrl: `/media/audio/${audioId}`, audioId };
  }

  /** 单入口:失败(连接断开/退役)时重建一次连接重试,再失败向上抛 */
  async function synthesizeWithRetry(text: string, voice: string, signal: AbortSignal) {
    try {
      return await synthesizeOnce(text, voice, signal);
    } catch (err) {
      if (signal.aborted) return null;
      deps.logger.warn('tts.edge-retry-after-error', { voice, error: String(err) });
      closeClient();
      try {
        return await synthesizeOnce(text, voice, signal);
      } catch (err2) {
        closeClient();
        throw new Error(`edge-tts 合成失败(重试后):${String(err2)}`);
      }
    }
  }

  return {
    synthesize({ text, signal }) {
      if (signal.aborted) return Promise.resolve(null);
      return synthesizeWithRetry(text, deps.voice(), signal);
    },

    synthesizeWith({ text, voice, signal }) {
      if (signal.aborted) return Promise.resolve(null);
      return synthesizeWithRetry(text, voice, signal);
    },

    async voices() {
      const now = deps.now();
      if (voicesCache !== null && now - voicesCache.at < 600_000) return voicesCache.list;
      const c = await readyClient(deps.voice());
      const raw = await c.getVoices();
      const list = raw
        .map((v) => ({ shortName: v.ShortName, gender: v.Gender, locale: v.Locale }))
        .sort((a, b) => (a.locale.startsWith('zh') === b.locale.startsWith('zh') ? a.shortName.localeCompare(b.shortName) : a.locale.startsWith('zh') ? -1 : 1));
      voicesCache = { at: now, list };
      return list;
    },
  };
}

/** 按设置中的 tts.provider 在固定本地与 edge-tts 之间委托(设置热更新即时生效)。 */
export function createSpeechRouter(deps: {
  fixed: SpeechProvider;
  edge: EdgeTtsSpeech;
  settings(): Pick<EffectiveSettings['tts'], 'provider'>;
}): SpeechProvider {
  return {
    synthesize(input) {
      return deps.settings().provider === 'edge-tts' ? deps.edge.synthesize(input) : deps.fixed.synthesize(input);
    },
  };
}
