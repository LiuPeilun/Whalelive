import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createEdgeTtsSpeech, createSpeechRouter, type EdgeTtsClient } from './edge-tts.js';
import type { AudioCache } from '../../infrastructure/audio-cache.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { SpeechProvider } from '../../modules/interaction/providers.js';

// edge-tts 适配器:连接复用、音色切换重建、失败重建重试、signal 中止与路由委托。
// 客户端为注入替身,不触网。

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

/** 可编程 fake 客户端:每次 toStream 按脚本产出 Buffer 或销毁流(模拟连接故障) */
class FakeClient implements EdgeTtsClient {
  script: Array<() => Buffer | Error> = [];
  idx = 0;
  setMetadataCalls: string[] = [];
  toStreamCalls: string[] = [];
  closed = false;

  async setMetadata(voice: string): Promise<void> {
    this.setMetadataCalls.push(voice);
  }

  toStream(text: string) {
    this.toStreamCalls.push(text);
    const step = this.script[Math.min(this.idx, this.script.length - 1)] ?? okMp3;
    this.idx += 1;
    const outcome = step();
    const stream = new Readable({
      read() {
        if (outcome instanceof Error) stream.destroy(outcome);
        else {
          stream.push(outcome);
          stream.push(null);
        }
      },
    });
    return { audioStream: stream, metadataStream: null };
  }

  async getVoices() {
    return [
      { ShortName: 'zh-CN-XiaoxiaoNeural', Gender: 'Female', Locale: 'zh-CN' },
      { ShortName: 'en-US-AriaNeural', Gender: 'Female', Locale: 'en-US' },
    ];
  }

  close(): void {
    this.closed = true;
  }
}

/** 客户端工厂替身:按序返回预配置实例,供断言检查 */
function fakeFactory(setups: Array<{ voice?: string; script: Array<() => Buffer | Error> }>) {
  const clients: FakeClient[] = [];
  let i = 0;
  return {
    clients,
    create: (): FakeClient => {
      const c = new FakeClient();
      const setup = setups[Math.min(i, setups.length - 1)] ?? { script: [okMp3] };
      c.script = setup.script;
      clients.push(c);
      i += 1;
      return c;
    },
  };
}

const freshSignal = () => new AbortController().signal;
const okMp3 = () => Buffer.from('mp3-bytes');

describe('edge-tts 适配器', () => {
  it('合成成功:MP3 入缓存并返回地址,同音色连接复用', async () => {
    const { cache, puts } = newCache();
    const f = fakeFactory([{ script: [okMp3, okMp3] }]);
    const speech = createEdgeTtsSpeech({ cache, logger: silentLogger, now: () => 1_000, voice: () => 'zh-CN-XiaoxiaoNeural', createClient: f.create });
    const r1 = await speech.synthesize({ text: '甲', signal: freshSignal() });
    const r2 = await speech.synthesize({ text: '乙', signal: freshSignal() });
    expect(r1).toMatchObject({ audioUrl: '/media/audio/id-1.mp3' });
    expect(r2).toMatchObject({ audioUrl: '/media/audio/id-2.mp3' });
    expect(puts.every((p) => p.ext === 'mp3')).toBe(true);
    expect(f.clients.length).toBe(1); // 连接复用
    expect(f.clients[0]?.toStreamCalls).toEqual(['甲', '乙']);
  });

  it('第一连接失败:重建一次连接重试成功', async () => {
    const { cache } = newCache();
    const f = fakeFactory([
      { script: [() => new Error('socket retired'), () => new Error('unused')] }, // 首连接:第一次流失败
      { script: [okMp3] }, // 重建连接:成功
    ]);
    const speech = createEdgeTtsSpeech({ cache, logger: silentLogger, now: () => 1_000, voice: () => 'zh-CN-XiaoxiaoNeural', createClient: f.create });
    const r = await speech.synthesize({ text: '你好', signal: freshSignal() });
    expect(r).toMatchObject({ audioUrl: '/media/audio/id-1.mp3' });
    expect(f.clients.length).toBe(2);
    expect(f.clients[0]?.closed).toBe(true); // 旧连接已关闭
  });

  it('重试仍失败:抛错并关闭全部连接(由 interaction 降级无声)', async () => {
    const { cache } = newCache();
    const f = fakeFactory([{ script: [() => new Error('down')] }, { script: [() => new Error('still down')] }]);
    const speech = createEdgeTtsSpeech({ cache, logger: silentLogger, now: () => 1_000, voice: () => 'zh-CN-XiaoxiaoNeural', createClient: f.create });
    await expect(speech.synthesize({ text: '你好', signal: freshSignal() })).rejects.toThrow(/edge-tts 合成失败/);
    expect(f.clients.every((c) => c.closed)).toBe(true);
  });

  it('音色变化重建连接;synthesizeWith 使用覆盖音色', async () => {
    const { cache } = newCache();
    const f = fakeFactory([{ script: [okMp3] }, { script: [okMp3] }, { script: [okMp3] }]);
    const speech = createEdgeTtsSpeech({ cache, logger: silentLogger, now: () => 1_000, voice: () => 'zh-CN-XiaoxiaoNeural', createClient: f.create });
    await speech.synthesize({ text: '甲', signal: freshSignal() }); // 实例1(默认音色)
    const r = await speech.synthesizeWith({ text: '乙', voice: 'zh-CN-YunjianNeural', signal: freshSignal() }); // 实例2(覆盖音色)
    expect(r).toMatchObject({ audioUrl: expect.stringContaining('.mp3') });
    expect(f.clients[0]?.setMetadataCalls).toEqual(['zh-CN-XiaoxiaoNeural']);
    expect(f.clients[1]?.setMetadataCalls).toEqual(['zh-CN-YunjianNeural']);
    await speech.synthesize({ text: '丙', signal: freshSignal() }); // 回到默认音色 → 实例3
    expect(f.clients.length).toBe(3);
  });

  it('signal 已中止:立即返回 null,不建连接不写缓存', async () => {
    const { cache, puts } = newCache();
    const f = fakeFactory([{ script: [okMp3] }]);
    const speech = createEdgeTtsSpeech({ cache, logger: silentLogger, now: () => 1_000, voice: () => 'zh-CN-XiaoxiaoNeural', createClient: f.create });
    const ac = new AbortController();
    ac.abort();
    const r = await speech.synthesize({ text: '你好', signal: ac.signal });
    expect(r).toBeNull();
    expect(puts.length).toBe(0);
    expect(f.clients.length).toBe(0);
  });

  it('voices:中文在前,10 分钟内命中缓存', async () => {
    const { cache } = newCache();
    const f = fakeFactory([{ script: [okMp3] }]);
    const speech = createEdgeTtsSpeech({ cache, logger: silentLogger, now: () => 1_000, voice: () => 'zh-CN-XiaoxiaoNeural', createClient: f.create });
    const v1 = await speech.voices();
    expect(v1.map((x) => x.shortName)).toEqual(['zh-CN-XiaoxiaoNeural', 'en-US-AriaNeural']);
    const v2 = await speech.voices();
    expect(v2).toBe(v1); // 同一引用 = 命中缓存
  });

  it('路由按 provider 委托,设置热切换即时生效', async () => {
    const fixed: SpeechProvider = { synthesize: vi.fn(async () => ({ audioUrl: '/media/audio/f.wav', audioId: 'f.wav' })) };
    const { cache } = newCache();
    const f = fakeFactory([{ script: [okMp3] }]);
    const edge = createEdgeTtsSpeech({ cache, logger: silentLogger, now: () => 1_000, voice: () => 'zh-CN-XiaoxiaoNeural', createClient: f.create });
    let provider: 'fixed-local' | 'edge-tts' = 'edge-tts';
    const router = createSpeechRouter({ fixed, edge, settings: () => ({ provider }) });

    const r1 = await router.synthesize({ text: 'x', signal: freshSignal() });
    expect(r1?.audioUrl).toContain('.mp3'); // edge 委托
    provider = 'fixed-local';
    const r2 = await router.synthesize({ text: 'x', signal: freshSignal() });
    expect(r2).toMatchObject({ audioUrl: '/media/audio/f.wav' }); // fixed 委托
    expect(fixed.synthesize).toHaveBeenCalledTimes(1);
  });
});
