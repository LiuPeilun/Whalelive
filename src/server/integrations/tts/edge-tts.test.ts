import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createEdgeTtsSpeech, createSpeechRouter, type EdgeTtsClient } from './edge-tts.js';
import { isValidVoiceShortName } from '../../../shared/settings.js';
import { sanitizeSpeechText } from './speech-text.js';
import type { AudioCache } from '../../infrastructure/audio-cache.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { SpeechProvider } from '../../modules/interaction/providers.js';

// edge-tts 适配器(WT-P1-015/016/017/018):实例池化与引用计数、并发音色隔离、
// 超时覆盖、SSML 转义与音色短名契约、路由委托。客户端为注入替身,不触网。

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => silentLogger } as unknown as Logger;

function newCache() {
  const puts: Array<{ data: Buffer; ext: string }> = [];
  const cache = {
    put(data: Buffer, ext?: 'wav' | 'mp3') {
      puts.push({ data, ext: ext ?? 'wav' });
      return `id-${puts.length}.${ext}`;
    },
  } as unknown as AudioCache;
  return { cache, puts };
}

type ScriptStep = () => Buffer | Error | Promise<Buffer | Error>;

/** 可编程 fake 客户端:setMetadata 可挂起(竞态复现),toStream 按脚本产出 */
class FakeClient implements EdgeTtsClient {
  script: ScriptStep[] = [];
  idx = 0;
  setMetadataDelayMs = 0;
  setMetadataCalls: string[] = [];
  locales: Array<string | undefined> = [];
  toStreamCalls: string[] = [];
  closed = false;

  async setMetadata(...[voice, , options]: Parameters<EdgeTtsClient['setMetadata']>): Promise<void> {
    this.setMetadataCalls.push(voice);
    this.locales.push(options.voiceLocale);
    if (this.setMetadataDelayMs > 0) await new Promise((r) => setTimeout(r, this.setMetadataDelayMs));
  }

  toStream(text: string) {
    this.toStreamCalls.push(text);
    const step = this.script[Math.min(this.idx, this.script.length - 1)] ?? (() => Buffer.from('mp3'));
    this.idx += 1;
    const stream = new Readable({ read() {} });
    void (async () => {
      try {
        const outcome = await step();
        if (outcome instanceof Error) stream.destroy(outcome);
        else {
          stream.push(outcome);
          stream.push(null);
        }
      } catch (err) {
        stream.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    })();
    return { audioStream: stream, metadataStream: null };
  }

  close(): void {
    this.closed = true;
  }
}

type Setup = Partial<Pick<FakeClient, 'script' | 'setMetadataDelayMs'>>;
type SpeechOptions = Partial<Pick<Parameters<typeof createEdgeTtsSpeech>[0], 'voice' | 'fetchVoices' | 'voicesTimeoutMs'>>;
const voiceList = [
  { ShortName: 'zh-CN-XiaoxiaoNeural', Gender: 'Female', Locale: 'zh-CN' },
  { ShortName: 'zh-CN-liaoning-XiaobeiNeural', Gender: 'Female', Locale: 'zh-CN' },
  { ShortName: 'en-US-AriaNeural', Gender: 'Female', Locale: 'en-US' },
];

function makeSpeech(setups: Setup[], opts: SpeechOptions = {}) {
  const { cache, puts } = newCache();
  const clients: FakeClient[] = [];
  let i = 0;
  const speech = createEdgeTtsSpeech({
    cache,
    logger: silentLogger,
    now: () => 1_000,
    voice: () => 'zh-CN-XiaoxiaoNeural',
    fetchVoices: async () => voiceList,
    ...opts,
    createClient: () => {
      const setup = setups[Math.min(i, setups.length - 1)] ?? {};
      const c = new FakeClient();
      if (setup.script !== undefined) c.script = setup.script;
      if (setup.setMetadataDelayMs !== undefined) c.setMetadataDelayMs = setup.setMetadataDelayMs;
      clients.push(c);
      i += 1;
      return c;
    },
  });
  return { speech, clients, puts };
}

const freshSignal = () => new AbortController().signal;
const okMp3 = (): Buffer => Buffer.from('mp3-bytes');

describe('edge-tts 实例管理(WT-P1-015)', () => {
  it('合成成功:同音色复用池内实例,MP3 入缓存', async () => {
    const { speech, clients, puts } = makeSpeech([{ script: [okMp3, okMp3] }]);
    const r1 = await speech.synthesize({ text: '甲', signal: freshSignal() });
    const r2 = await speech.synthesize({ text: '乙', signal: freshSignal() });
    expect(r1).toMatchObject({ audioUrl: '/media/audio/id-1.mp3' });
    expect(r2).toMatchObject({ audioUrl: '/media/audio/id-2.mp3' });
    expect(clients.length).toBe(1);
    expect(clients[0]?.toStreamCalls).toEqual(['甲', '乙']);
    expect(puts.every((p) => p.ext === 'mp3')).toBe(true);
  });

  it('直播合成与换音色试听并发:各用各的音色实例,互不干扰(复现口径)', async () => {
    // 直播(晓晓)握手挂起 80ms;期间控制台试听云健——两者都必须用自己的音色完成
    const { speech, clients } = makeSpeech([
      { setMetadataDelayMs: 80, script: [okMp3] }, // 晓晓
      { script: [okMp3] }, // 云健
    ]);
    const livePromise = speech.synthesize({ text: '直播回复', signal: freshSignal() });
    await new Promise((r) => setTimeout(r, 10)); // 直播进入握手等待
    const previewPromise = speech.synthesizeWith({ text: '试听', voice: 'zh-CN-YunjianNeural', signal: freshSignal() });
    const [live, preview] = await Promise.all([livePromise, previewPromise]);
    expect(live).toMatchObject({ audioUrl: expect.stringContaining('.mp3') });
    expect(preview).toMatchObject({ audioUrl: expect.stringContaining('.mp3') });
    expect(clients[0]?.setMetadataCalls).toEqual(['zh-CN-XiaoxiaoNeural']); // 直播用晓晓
    expect(clients[0]?.toStreamCalls).toEqual(['直播回复']);
    expect(clients[1]?.setMetadataCalls).toEqual(['zh-CN-YunjianNeural']); // 试听用云健
    expect(clients[1]?.toStreamCalls).toEqual(['试听']);
    expect(clients.every((c) => !c.closed)).toBe(true); // 无一被关闭
  });

  it('直播音频流开始后试听另一音色:直播连接不被关闭,结果完整(复现口径)', async () => {
    const slowLive: ScriptStep = () => new Promise((resolve) => setTimeout(() => resolve(okMp3()), 100));
    const { speech, clients } = makeSpeech([
      { script: [slowLive] }, // 直播实例(流挂起 100ms)
      { script: [okMp3] }, // 试听实例(另一音色)
    ]);
    const livePromise = speech.synthesize({ text: '直播', signal: freshSignal() });
    await new Promise((r) => setTimeout(r, 20)); // 直播流已开始(挂起中)
    const preview = await speech.synthesizeWith({ text: '试听', voice: 'zh-CN-YunjianNeural', signal: freshSignal() });
    expect(preview).toMatchObject({ audioUrl: expect.stringContaining('.mp3') });
    const live = await livePromise;
    expect(live).toMatchObject({ audioUrl: expect.stringContaining('.mp3') }); // 直播未被中断
    expect(clients[0]?.closed).toBe(false);
  });

  it('双失败退役后新实例可用;退役实例关闭由引用计数收尾(验收)', async () => {
    const { speech, clients } = makeSpeech([
      { script: [() => new Error('down'), () => new Error('down')] }, // 实例1:两次都失败
      { script: [okMp3] }, // 实例2:重试新建成功
    ]);
    const r = await speech.synthesize({ text: '再试', signal: freshSignal() });
    expect(r).toMatchObject({ audioUrl: expect.stringContaining('.mp3') });
    expect(clients[0]?.closed).toBe(true); // 退役实例(无在途)已关闭
    expect(clients[1]?.closed).toBe(false); // 新实例留存池内
  });

  it('旧连接的迟到错误不会退役已经接管的同音色实例', async () => {
    let failOld!: (error: Error) => void;
    let markActive!: () => void;
    const oldError = new Promise<Error>((resolve) => { failOld = resolve; });
    const oldActive = new Promise<void>((resolve) => { markActive = resolve; });
    const { speech, clients } = makeSpeech([
      { script: [okMp3, () => { markActive(); return oldError; }, () => new Error('首次断开')] },
      { script: [okMp3] },
    ]);
    await speech.synthesize({ text: '预热', signal: freshSignal() });
    const old = speech.synthesize({ text: '旧请求', signal: freshSignal() });
    await oldActive;
    await speech.synthesize({ text: '替换连接', signal: freshSignal() });
    expect(clients[0]?.closed).toBe(false);
    failOld(new Error('迟到错误'));
    expect(await old).not.toBeNull();
    expect(clients).toHaveLength(2);
    expect(clients[0]?.closed).toBe(true);
    expect(clients[1]?.closed).toBe(false);
    expect(clients[1]?.toStreamCalls).toEqual(['替换连接', '旧请求']);
  });

  it('连续试听多种音色时只保留有限数量的空闲连接', async () => {
    const { speech, clients } = makeSpeech([]);
    for (const voice of ['Xiaoxiao', 'Yunjian', 'Yunxi', 'Xiaoyi', 'Yunyang']) {
      await speech.synthesizeWith({ text: '试听', voice: `zh-CN-${voice}Neural`, signal: freshSignal() });
    }
    expect(clients).toHaveLength(5);
    expect(clients[0]?.closed).toBe(true);
    expect(clients.filter((client) => !client.closed)).toHaveLength(4);
    speech.close();
    expect(clients.every((client) => client.closed)).toBe(true);
  });

  it('signal 已中止:立即返回 null,不建连接不写缓存', async () => {
    const { speech, clients, puts } = makeSpeech([{ script: [okMp3] }]);
    const ac = new AbortController();
    ac.abort();
    const r = await speech.synthesize({ text: '你好', signal: ac.signal });
    expect(r).toBeNull();
    expect(puts.length).toBe(0);
    expect(clients.length).toBe(0);
  });

  it('握手期间 signal 到期:及时返回 null,自建实例关闭(外部等待有界,WT-P1-016)', async () => {
    const { speech, clients, puts } = makeSpeech([{ setMetadataDelayMs: 300, script: [okMp3] }]);
    const ac = new AbortController();
    const started = Date.now();
    const pending = speech.synthesize({ text: '你好', signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    const r = await pending;
    expect(r).toBeNull();
    expect(Date.now() - started).toBeLessThan(250); // 未等完 300ms 握手
    expect(puts.length).toBe(0);
    expect(clients[0]?.closed).toBe(true);
  });
});

describe('edge-tts voices(WT-P1-016/018)', () => {
  it('列表中文在前且含变体短名;10 分钟内命中缓存', async () => {
    const { speech } = makeSpeech([]);
    const v1 = await speech.voices();
    expect(v1.map((x) => x.shortName)).toEqual(['zh-CN-XiaoxiaoNeural', 'zh-CN-liaoning-XiaobeiNeural', 'en-US-AriaNeural']);
    const v2 = await speech.voices();
    expect(v2).toBe(v1);
  });

  it('并发列表查询共用请求，超时传给传输层，后续可恢复', async () => {
    const fetchVoices = vi.fn<(signal: AbortSignal) => Promise<typeof voiceList>>();
    fetchVoices.mockImplementationOnce((signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })).mockResolvedValueOnce(voiceList);
    const { speech, clients } = makeSpeech([], { fetchVoices, voicesTimeoutMs: 80 });
    const results = await Promise.allSettled([speech.voices(), speech.voices()]);
    expect(results).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ name: 'TimeoutError' }) },
      { status: 'rejected', reason: expect.objectContaining({ name: 'TimeoutError' }) },
    ]);
    expect(fetchVoices).toHaveBeenCalledTimes(1);
    expect(fetchVoices.mock.calls[0]?.[0].aborted).toBe(true);
    expect(await speech.voices()).toHaveLength(3);
    expect(clients).toHaveLength(0);
  });

  it('关闭适配器会取消音色请求和正在收集的合成流', async () => {
    let markActive!: () => void;
    const active = new Promise<void>((resolve) => { markActive = resolve; });
    const { speech, clients } = makeSpeech([
      { script: [() => { markActive(); return new Promise(() => {}); }] },
    ], {
      fetchVoices: (signal) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    const results = Promise.allSettled([speech.voices(), speech.synthesize({ text: '关闭', signal: freshSignal() })]);
    await active;
    speech.close();
    expect(await results).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ name: 'AbortError' }) },
      { status: 'fulfilled', value: null },
    ]);
    expect(clients[0]?.closed).toBe(true);
  });
});

describe('TTS 文本与音色契约(WT-P1-017/018)', () => {
  it.each([
    ['iu-Cans-CA-SiqiniqNeural', 'iu-Cans-CA'],
    ['iu-Latn-CA-TaqqiqNeural', 'iu-Latn-CA'],
    ['zh-CN-liaoning-XiaobeiNeural', 'zh-CN-liaoning'],
    ['zh-CN-XiaoxiaoNeural', 'zh-CN'],
  ])('冷启动合成 %s 时显式传递 %s，无需请求音色列表', async (voice, locale) => {
    const fetchVoices = vi.fn(async () => { throw new Error('音色列表不可用'); });
    const { speech, clients } = makeSpeech([], { voice: () => voice, fetchVoices });
    expect(await speech.synthesize({ text: '你好', signal: freshSignal() })).not.toBeNull();
    expect(clients[0]?.setMetadataCalls).toEqual([voice]);
    expect(clients[0]?.locales).toEqual([locale]);
    expect(fetchVoices).not.toHaveBeenCalled();
  });

  it('sanitizeSpeechText 转义 XML 符号并剔除非法控制字符', () => {
    expect(sanitizeSpeechText('鱼 & 寿司 <3 > "话" \'音\'')).toBe('鱼 &amp; 寿司 &lt;3 &gt; &quot;话&quot; &apos;音&apos;');
    // eslint-disable-next-line no-control-regex
    expect(sanitizeSpeechText('ab')).toBe('ab'); // \x01 为非法 XML 控制字符
    expect(sanitizeSpeechText(' ')).toBe(' '); // 普通空格保留
    expect(sanitizeSpeechText('𠮷🐟\uD800')).toBe('𠮷🐟');
  });

  it('适配器把转义后的文本送入合成(& 不再裸拼进 SSML)', async () => {
    const { speech, clients } = makeSpeech([{ script: [okMp3] }]);
    await speech.synthesize({ text: '鱼 & 寿司', signal: freshSignal() });
    expect(clients[0]?.toStreamCalls).toEqual(['鱼 &amp; 寿司']);
  });

  it('全部字符非法的文本返回 null;不合规音色短名抛错', async () => {
    const { speech } = makeSpeech([{ script: [okMp3] }]);
    // eslint-disable-next-line no-control-regex
    const r = await speech.synthesize({ text: '', signal: freshSignal() });
    expect(r).toBeNull();
    await expect(speech.synthesizeWith({ text: '好', voice: '不是音色', signal: freshSignal() })).rejects.toThrow(/音色短名不合规/);
  });

  it('isValidVoiceShortName:三段与带变体的四段短名均合法', () => {
    expect(isValidVoiceShortName('zh-CN-XiaoxiaoNeural')).toBe(true);
    expect(isValidVoiceShortName('zh-CN-liaoning-XiaobeiNeural')).toBe(true);
    expect(isValidVoiceShortName('iu-Cans-CA-SiqiniqNeural')).toBe(true);
    expect(isValidVoiceShortName('zh-HK-HiuMaanNeural')).toBe(true);
    expect(isValidVoiceShortName('en-US-GuyNeural')).toBe(true);
    expect(isValidVoiceShortName('not-a-voice')).toBe(false);
    expect(isValidVoiceShortName('')).toBe(false);
    expect(isValidVoiceShortName(42)).toBe(false);
  });
});

describe('路由委托', () => {
  it('按 provider 委托,设置热切换即时生效', async () => {
    const fixed: SpeechProvider = { synthesize: vi.fn(async () => ({ audioUrl: '/media/audio/f.wav', audioId: 'f.wav' })) };
    const { speech: edge } = makeSpeech([{ script: [okMp3] }]);
    let provider: 'fixed-local' | 'edge-tts' = 'edge-tts';
    const router = createSpeechRouter({ fixed, edge, settings: () => ({ provider }) });
    const r1 = await router.synthesize({ text: 'x', signal: freshSignal() });
    expect(r1?.audioUrl).toContain('.mp3');
    provider = 'fixed-local';
    const r2 = await router.synthesize({ text: 'x', signal: freshSignal() });
    expect(r2).toMatchObject({ audioUrl: '/media/audio/f.wav' });
    expect(fixed.synthesize).toHaveBeenCalledTimes(1);
  });
});
