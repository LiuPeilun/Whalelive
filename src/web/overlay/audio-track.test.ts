import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAudioTrack } from './audio-track.js';

// WT-P1-003 / WT-P1-006 回归:句柄化归属——迟到的加载回调与起播确认不触碰
// 新表演的媒体元素、不替新任务产生回执;起播确认与自然结束/播放期错误分开。
// FakeAudio 手动派发事件模拟浏览器时序。

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

describe('audio-track 句柄归属(WT-P1-003/006)', () => {
  it('迟到的旧加载回调不接管:句柄以 superseded 拒绝,元素被丢弃', async () => {
    const track = createAudioTrack();
    const p1 = track.prepare(url(1));
    const p2 = track.prepare(url(2)); // 取代 p1(p1 的元素即刻停声)
    FakeAudio.instances[1]!.emit('canplaythrough');
    const h2 = await p2;
    expect(track.currentSrc()).toBe(url(2));
    // p1 的 canplaythrough 迟到:必须拒绝且不抢占
    FakeAudio.instances[0]!.emit('canplaythrough');
    await expect(p1).rejects.toThrow('audio-load-superseded');
    expect(track.currentSrc()).toBe(url(2));
    expect(FakeAudio.instances[0]!.muted).toBe(true); // 旧元素已停声
  });

  it('stop 使在途加载失效,迟到回调不复活元素', async () => {
    const track = createAudioTrack();
    const p1 = track.prepare(url(1));
    track.stop(); // 紧急停止发生在加载完成前
    FakeAudio.instances[0]!.emit('canplaythrough');
    await expect(p1).rejects.toThrow();
    expect(track.currentSrc()).toBeNull();
    const p2 = track.prepare(url(2));
    FakeAudio.instances[1]!.emit('canplaythrough');
    await p2;
    expect(track.currentSrc()).toBe(url(2));
  });

  it('句柄 begin:失效句柄不触碰当前元素,起播被拒兑现 false(WT-P1-003/006)', async () => {
    const track = createAudioTrack();
    const pA = track.prepare(url(1));
    FakeAudio.instances[0]!.emit('canplaythrough');
    const hA = await pA;
    // A 被 B 取代
    const pB = track.prepare(url(2));
    FakeAudio.instances[1]!.emit('canplaythrough');
    const hB = await pB;
    FakeAudio.instances[1]!.playResult = Promise.resolve();

    // 迟到的 A 起播确认:兑现 false,且不得调用 B 元素的 play / 改其静音状态
    FakeAudio.instances[0]!.playResult = Promise.resolve();
    await expect(hA.begin({ audible: true })).resolves.toBe(false);
    expect(FakeAudio.instances[1]!.muted).toBe(true); // B 尚未 begin,保持静音
    expect(FakeAudio.instances[1]!.play).toBeDefined();

    // B 正常起播
    await expect(hB.begin({ audible: true })).resolves.toBe(true);
    expect(FakeAudio.instances[1]!.muted).toBe(false);

    // 起播被拒(C 元素)
    const pC = track.prepare(url(3));
    FakeAudio.instances[2]!.emit('canplaythrough');
    FakeAudio.instances[2]!.playResult = Promise.reject(new DOMException('NotAllowedError'));
    const hC = await pC;
    await expect(hC.begin({ audible: true })).resolves.toBe(false);
  });

  it('句柄 ended:自然结束/播放期错误分开,失效句柄立即 failed,stop 兑现等待', async () => {
    const track = createAudioTrack();
    const p = track.prepare(url(1));
    FakeAudio.instances[0]!.emit('canplaythrough');
    const h = await p;
    await h.begin({ audible: true });

    const endedP = h.ended();
    FakeAudio.instances[0]!.onerror?.();
    await expect(endedP).resolves.toBe('failed');

    const endedP2 = h.ended();
    FakeAudio.instances[0]!.onended?.();
    await expect(endedP2).resolves.toBe('ended');

    const endedP3 = h.ended();
    track.stop(); // 全局停止兑现等待,不悬挂
    await expect(endedP3).resolves.toBe('failed');

    // 失效句柄的新 ended() 立即 failed,不注册到新元素
    const pB = track.prepare(url(2));
    FakeAudio.instances[1]!.emit('canplaythrough');
    const hB = await pB;
    await expect(h.ended()).resolves.toBe('failed'); // 旧句柄
    expect(FakeAudio.instances[1]!.onended).toBeNull(); // 未污染新元素回调
    void hB;
  });
});
