// 音频轨道:加载、播放、停止与完成。P0 无语音合成,本轨道随 P1 的 TTS 缓存启用。
// 同一时刻只存在一个音频元素;stop 立即暂停并释放,ended 在自然播完时兑现。

export type AudioTrack = {
  prepare(url: string): Promise<void>;
  play(): Promise<void>;
  stop(): void;
  currentSrc(): string | null;
};

export function createAudioTrack(): AudioTrack {
  let current: HTMLAudioElement | null = null;
  let playToken = 0;

  async function prepare(url: string): Promise<void> {
    const audio = new Audio();
    audio.preload = 'auto';
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

  function play(): Promise<void> {
    const audio = current;
    if (!audio) return Promise.resolve();
    playToken += 1;
    const token = playToken;
    return new Promise<void>((resolve) => {
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      void audio.play().catch(() => resolve());
      void token;
    });
  }

  function stop(): void {
    playToken += 1;
    if (current) {
      current.pause();
      current.onended = null;
      current.onerror = null;
      current.src = '';
      current = null;
    }
  }

  function currentSrc(): string | null {
    return current?.src ?? null;
  }

  return { prepare, play, stop, currentSrc };
}
