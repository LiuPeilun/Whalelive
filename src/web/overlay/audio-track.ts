// 音频轨道:加载、播放、停止与完成。同一时刻只存在一个音频元素。
// 发声门槛:play({audible}) —— 仅持有效租约的播放端以可听音量播放,
// 其余(普通预览)静音播放但保持完整回执语义,服务端派发侧另有持有者校验。
// stop() 立即停止并兑现等待中的 play Promise(避免悬挂)。

export type AudioTrack = {
  prepare(url: string): Promise<void>;
  play(options?: { audible?: boolean }): Promise<void>;
  stop(): void;
  currentSrc(): string | null;
};

export function createAudioTrack(): AudioTrack {
  let current: HTMLAudioElement | null = null;
  let settlePlay: (() => void) | null = null;

  async function prepare(url: string): Promise<void> {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.muted = true; // 加载阶段静音;发声门槛在 play 时决定
    audio.src = url;
    await new Promise<void>((resolve, reject) => {
      const done = (ok: boolean) => {
        audio.removeEventListener('canplaythrough', onOk);
        audio.removeEventListener('error', onFail);
        if (ok) resolve();
        else reject(new Error('audio-load-failed'));
      };
      const onOk = () => done(true);
      const onFail = () => done(false);
      audio.addEventListener('canplaythrough', onOk);
      audio.addEventListener('error', onFail);
      audio.load();
    });
    current = audio;
  }

  function play(options: { audible?: boolean } = {}): Promise<void> {
    const audio = current;
    if (!audio) return Promise.resolve();
    const audible = options.audible === true;
    return new Promise<void>((resolve) => {
      settlePlay = resolve;
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      audio.muted = !audible;
      audio.volume = 1;
      void audio.play().catch(() => resolve());
    });
  }

  function stop(): void {
    if (settlePlay) {
      const settle = settlePlay;
      settlePlay = null;
      settle(); // 停止也是一次“完成”,避免等待方悬挂
    }
    if (current) {
      current.pause();
      current.onended = null;
      current.onerror = null;
      current.muted = true;
      current.src = '';
      current = null;
    }
  }

  function currentSrc(): string | null {
    return current?.src ?? null;
  }

  return { prepare, play, stop, currentSrc };
}
