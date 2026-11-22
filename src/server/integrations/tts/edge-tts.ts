import { addAbortSignal, type Readable } from 'node:stream';
import { MsEdgeTTS, OUTPUT_FORMAT, type MetadataOptions, type Voice } from 'msedge-tts';
import type { SpeechProvider } from '../../modules/interaction/providers.js';
import type { AudioCache } from '../../infrastructure/audio-cache.js';
import type { Logger } from '../../infrastructure/logger.js';
import { isValidVoiceShortName, type EffectiveSettings } from '../../../shared/settings.js';
import { sanitizeSpeechText } from './speech-text.js';

// P1 第二批语音提供方:edge-tts(微软 Edge「大声朗读」通道,经 msedge-tts 客户端,
// 含 Sec-MS-GEC 令牌)。合成结果为 MP3,原子写入音频缓存并返回地址。
//
// 实例管理(WT-P1-015):客户端按音色缓存,每项请求在获取时拿到稳定引用——
// 等待握手期间其他调用换掉/退役缓存实例不影响本请求;退役实例(错误重试摘除)
// 只在最后一个在途请求结束后关闭,试听/列表绝不关闭直播在用连接。
// 超时(WT-P1-016):signal 覆盖握手与音频流等待的全过程,外部等待都有界。
// 文本(WT-P1-017):普通文本在 TTS 边界做 XML 转义与非法控制字符清理,
// 音色输入经统一短名校验后才送入合成。
// 合成失败/中止抛错或返回 null,由 interaction 按既有语义降级无声——不在本层
// 静默回退到罐头音,问题通过控制台试听与日志暴露。

/** msedge-tts 客户端的最小面(供测试替身实现) */
export interface EdgeTtsClient {
  setMetadata(voice: string, format: OUTPUT_FORMAT, options: MetadataOptions): Promise<void>;
  /** options 为音调等韵律参数(msedge-tts ProsodyOptions 的最小面)。 */
  toStream(input: string, options?: { pitch?: string }): { audioStream: Readable };
  close(): void;
}

export type EdgeTtsVoice = { shortName: string; gender: string; locale: string };
type VoiceListEntry = Pick<Voice, 'ShortName' | 'Gender' | 'Locale'>;

export type EdgeTtsSpeech = SpeechProvider & {
  /** 可用音色列表(中文在前)，独立请求并缓存 10 分钟。 */
  voices(): Promise<EdgeTtsVoice[]>;
  /** 按指定音色合成(试听/音色验证用;synthesize 使用当前设置音色) */
  synthesizeWith(input: { text: string; voice: string; signal: AbortSignal }): Promise<{ audioUrl: string; audioId: string } | null>;
  close(): void;
};

/** 按音色缓存的客户端条目:引用计数 + 退役标记 */
type Entry = { client: EdgeTtsClient; voice: string; retired: boolean; inFlight: number };
const MAX_IDLE_CLIENTS = 4;

async function fetchVoiceList(signal: AbortSignal): Promise<VoiceListEntry[]> {
  // 锁定版本的 getVoices 不接收 AbortSignal。沿用它的地址，以可取消的 fetch 请求列表。
  const url: unknown = Reflect.get(MsEdgeTTS, 'VOICES_URL');
  if (typeof url !== 'string') throw new Error('当前 msedge-tts 版本未提供音色列表地址');
  const response = await fetch(url, { signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Edge 音色列表请求失败 (HTTP ${response.status})`);
  }
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) throw new Error('Edge 音色列表格式无效');
  return raw;
}

export function createEdgeTtsSpeech(deps: {
  cache: AudioCache;
  logger: Logger;
  voice(): string;
  /** 音调微调(SSML pitch,如 "+15Hz";空串=不调,WT:用户选定可爱音色)。 */
  pitch?(): string;
  now(): number;
  createClient?(): EdgeTtsClient;
  fetchVoices?(signal: AbortSignal): Promise<VoiceListEntry[]>;
  /** voices 外部请求的等待上限(默认 8s;测试可注入短值) */
  voicesTimeoutMs?: number;
}): EdgeTtsSpeech {
  const createClient = deps.createClient ?? (() => new MsEdgeTTS({ enableLogger: false }));
  const fetchVoices = deps.fetchVoices ?? fetchVoiceList;
  const lifetime = new AbortController();
  const pool = new Map<string, Entry>();
  let voicesCache: { at: number; list: EdgeTtsVoice[] } | null = null;
  let voicesRequest: Promise<EdgeTtsVoice[]> | null = null;

  function closeIfIdle(entry: Entry): void {
    if (entry.retired && entry.inFlight === 0) {
      try { entry.client.close(); } catch { /* 已关闭 */ }
    }
  }

  function release(entry: Entry): void {
    entry.inFlight -= 1;
    closeIfIdle(entry);
    const idle = Array.from(pool.values()).filter((candidate) => candidate.inFlight === 0);
    for (const oldest of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_CLIENTS))) retire(oldest);
  }

  async function waitForHandshake(handshake: Promise<void>, signal: AbortSignal): Promise<void> {
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([handshake, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * 获取指定音色的客户端引用(WT-P1-015):命中即持有稳定引用;未命中则新建并
   * 握手——等待期间若同音色实例已由并发调用放入,关闭自建实例改用池内的。
   * 池内实例被替换/退役不影响已发出的引用。
   */
  async function acquire(voice: string, signal: AbortSignal): Promise<Entry> {
    signal.throwIfAborted();
    const cached = pool.get(voice);
    if (cached !== undefined && !cached.retired) {
      pool.delete(voice);
      pool.set(voice, cached);
      cached.inFlight += 1;
      return cached;
    }
    const client = createClient();
    const entry: Entry = { client, voice, retired: false, inFlight: 1 };
    try {
      // Edge 短名为 Locale 加末段人名。保留书写系统和地区变体，冷启动时也无需取列表。
      const voiceLocale = voice.slice(0, voice.lastIndexOf('-'));
      const handshake = client.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { voiceLocale });
      await waitForHandshake(handshake, signal);
      signal.throwIfAborted();
    } catch (err) {
      entry.inFlight = 0;
      entry.retired = true;
      closeIfIdle(entry); // 自建实例,关闭无碍
      throw err;
    }
    const winner = pool.get(voice);
    if (winner !== undefined && !winner.retired && winner !== entry) {
      // 并发握手重复:改用先入池者,自建实例退场
      entry.retired = true;
      entry.inFlight = 0;
      closeIfIdle(entry);
      winner.inFlight += 1;
      return winner;
    }
    pool.set(voice, entry);
    return entry;
  }

  /** 退役池内实例(仅当仍是当前条目);不关闭——在途请求结束后自行关闭 */
  function retire(entry: Entry): void {
    if (pool.get(entry.voice) === entry) pool.delete(entry.voice);
    entry.retired = true;
    closeIfIdle(entry);
  }

  /** 单次合成持有自己的客户端引用，提前关闭的音频流也会报错。 */
  async function synthesizeOnce(text: string, voice: string, signal: AbortSignal) {
    const entry = await acquire(voice, signal);
    // 音调微调随合成调用传递(ProsodyOptions 为逐次参数,不影响按音色缓存的客户端)
    const pitch = deps.pitch?.() ?? '';
    const prosody = pitch !== '' ? { pitch } : undefined;
    try {
      signal.throwIfAborted();
      const { audioStream } = entry.client.toStream(text, prosody);
      const chunks: Buffer[] = [];
      for await (const chunk of addAbortSignal(signal, audioStream)) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    } catch (err) {
      // 迟到错误只退役自己使用的实例，即使这个音色已有替换实例。
      if (!signal.aborted) retire(entry);
      throw err;
    } finally {
      release(entry);
    }
  }

  /** 失败(连接断开/退役)时:退役本次实例并新建重试一次;重试仍失败向上抛 */
  async function synthesizeWithRetry(text: string, voice: string, requested: AbortSignal) {
    const signal = AbortSignal.any([requested, lifetime.signal]);
    if (signal.aborted) return null;
    if (!isValidVoiceShortName(voice)) throw new Error('音色短名不合规');
    const safeText = sanitizeSpeechText(text);
    if (safeText === '') return null;
    let mp3: Buffer;
    try {
      mp3 = await synthesizeOnce(safeText, voice, signal);
    } catch (err) {
      if (signal.aborted) return null;
      deps.logger.warn('tts.edge-retry-after-error', { voice, error: String(err) });
      try {
        mp3 = await synthesizeOnce(safeText, voice, signal);
      } catch (err2) {
        if (signal.aborted) return null;
        throw new Error(`edge-tts 合成失败(重试后):${String(err2)}`);
      }
    }
    if (signal.aborted || mp3.length === 0) return null;
    const audioId = deps.cache.put(mp3, 'mp3');
    return { audioUrl: `/media/audio/${audioId}`, audioId };
  }

  return {
    synthesize({ text, signal }) {
      return synthesizeWithRetry(text, deps.voice(), signal);
    },

    synthesizeWith({ text, voice, signal }) {
      return synthesizeWithRetry(text, voice, signal);
    },

    async voices() {
      lifetime.signal.throwIfAborted();
      if (voicesCache !== null && deps.now() - voicesCache.at < 600_000) return voicesCache.list;
      if (voicesRequest !== null) return voicesRequest;
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(deps.voicesTimeoutMs ?? 8_000)]);
      voicesRequest = fetchVoices(signal).then((raw) => {
        signal.throwIfAborted();
        const list = raw
          .filter((v) => v && isValidVoiceShortName(v.ShortName) && typeof v.Gender === 'string' && typeof v.Locale === 'string')
          .map((v) => ({ shortName: v.ShortName, gender: v.Gender, locale: v.Locale }))
          .sort((a, b) => Number(b.locale.startsWith('zh')) - Number(a.locale.startsWith('zh'))
            || (a.shortName < b.shortName ? -1 : Number(a.shortName > b.shortName)));
        voicesCache = { at: deps.now(), list };
        return list;
      }).finally(() => { voicesRequest = null; });
      return voicesRequest;
    },

    close() {
      lifetime.abort();
      for (const entry of pool.values()) retire(entry);
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
