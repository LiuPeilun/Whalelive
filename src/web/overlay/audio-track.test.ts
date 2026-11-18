import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAudioTrack } from './audio-track.js';

// WT-P1-003 / WT-P1-006 回归:归属令牌使迟到的加载回调不抢占后续表演的媒体对象;
// 起播确认与自然结束/播放期错误分开上报。FakeAudio 手动派发事件模拟浏览器时序。

class FakeAudio {
  static instances: FakeAudio[] = [];
  src = '';
  muted = true;
  volume = 1;
  preload = '';
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<() => void>>();
  playResult: Promise<void> = Promise.resolve();

  constructor() {
    FakeAudio.instances.push(this);
  }

  addEventListener(type: string, cb: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  removeEventListener(type: string, cb: () => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  load(): void { /* 空实现 */ }

  pause(): void { /* 空实现 */ }

  removeAttribute(): void {
    this.src = '';
  }

  play(): Promise<void> {
    return this.playResult;
  }

  // ---- 测试辅助 ----
  emit(type: string): void {
    for (const cb of this.listeners.get(type) ?? []) cb();
  }
}

beforeEach(() => {
  FakeAudio.instances = [];
  vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const url = (n: number) => `http://127.0.0.1:3210/media/audio/f${n}.wav`;

describe('audio-track 归属与起播(WT-P1-003/006)', () => {
  it('迟到的旧加载回调不替换 current,旧元素被丢弃', async () => {
    const track = createAudioTrack();
    const p1 = track.prepare(url(1));
    const p2 = track.prepare(url(2)); // 取代 p1
    // p2 的加载先完成
    FakeAudio.instances[1]!.emit('canplaythrough');
    await p2;
    expect(track.currentSrc()).toBe(url(2));
    // p1 的 canplaythrough 迟到:必须拒绝(superseded)且不抢占
    FakeAudio.instances[0]!.emit('canplaythrough');
    await expect(p1).rejects.toThrow('audio-load-superseded');
    expect(track.currentSrc()).toBe(url(2));
  });

  it('stop 使在途加载失效,迟到回调不复活元素', async () => {
    const track = createAudioTrack();
    const p1 = track.prepare(url(1));
    track.stop(); // 紧急停止发生在加载完成前
    FakeAudio.instances[0]!.emit('canplaythrough');
    await expect(p1).rejects.toThrow();
    expect(track.currentSrc()).toBeNull();
    // 新表演照常
    const p2 = track.prepare(url(2));
    FakeAudio.instances[1]!.emit('canplaythrough');
    await p2;
    expect(track.currentSrc()).toBe(url(2));
  });

  it('begin:play() 被拒兑现 false,确认起播兑现 true(WT-P1-006)', async () => {
    const track = createAudioTrack();
    const p = track.prepare(url(1));
    FakeAudio.instances[0]!.emit('canplaythrough');
    await p;

    FakeAudio.instances[0]!.playResult = Promise.reject(new DOMException('NotAllowedError'));
    await expect(track.begin({ audible: true })).resolves.toBe(false);

    FakeAudio.instances[0]!.playResult = Promise.resolve();
    await expect(track.begin({ audible: false })).resolves.toBe(true);
    expect(FakeAudio.instances[0]!.muted).toBe(true); // 非音频归属静音
  });

  it('ended:自然结束 ended,播放期错误 failed,stop 兑现等待', async () => {
    const track = createAudioTrack();
    const p = track.prepare(url(1));
    FakeAudio.instances[0]!.emit('canplaythrough');
    await p;
    await track.begin({ audible: true });

    const endedP = track.ended();
    FakeAudio.instances[0]!.onerror?.();
    await expect(endedP).resolves.toBe('failed');

    const endedP2 = track.ended();
    FakeAudio.instances[0]!.onended?.();
    await expect(endedP2).resolves.toBe('ended');

    const endedP3 = track.ended();
    track.stop(); // 等待中的 ended 由停止兑现,不悬挂
    await expect(endedP3).resolves.toBe('failed');
  });
});
