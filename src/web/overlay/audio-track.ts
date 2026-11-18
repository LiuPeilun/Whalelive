// 音频轨道:加载、起播确认、自然结束与停止。同一时刻只存在一个归属音频。
//
// 归属令牌(WT-P1-003):prepare 的异步回调只在令牌仍匹配时接管 current,
// 迟到的旧加载不得替换后续表演的媒体对象;stop/新 prepare 使旧加载失效。
//
// 起播确认(WT-P1-006):begin() 在浏览器确认真正开始播放后才兑现 true,
// play() 被自动播放策略等拒绝时兑现 false(上报失败而非成功);
// ended() 区分自然结束 'ended' 与播放期错误 'failed'。

export type AudioBeginResult = boolean; // true = 起播确认;false = 起播被拒
export type AudioEndResult = 'ended' | 'failed'; // 自然结束 | 播放期错误

export type AudioTrack = {
  prepare(url: string): Promise<void>;
  begin(options: { audible?: boolean }): Promise<AudioBeginResult>;
  ended(): Promise<AudioEndResult>;
  stop(): void;
  currentSrc(): string | null;
};

export function createAudioTrack(): AudioTrack {
  let current: HTMLAudioElement | null = null;
  let loadToken = 0; // 归属令牌:每次 prepare/stop 递增,旧回调全部失效
  let settleEnded: ((result: AudioEndResult) => void) | null = null;

  function discardElement(el: HTMLAudioElement): void {
    el.onended = null;
    el.onerror = null;
    el.muted = true;
    try {
      el.pause();
      el.removeAttribute('src');
      el.load();
    } catch {
      /* 忽略 */
    }
  }

  async function prepare(url: string): Promise<void> {
    const myToken = ++loadToken;
    const audio = new Audio();
    audio.preload = 'auto';
    audio.muted = true; // 加载阶段静音;发声门槛在 begin 时决定
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
    }).then(
      () => {
        if (myToken !== loadToken) {
          // 已被后续 prepare/stop 取代:丢弃该元素,不接管 current(WT-P1-003)
          discardElement(audio);
          throw new Error('audio-load-superseded');
        }
        current = audio;
      },
      (err: unknown) => {
        if (myToken !== loadToken) {
          discardElement(audio);
          throw new Error('audio-load-superseded');
        }
        throw err;
      },
    );
  }

  function begin(options: { audible?: boolean } = {}): Promise<AudioBeginResult> {
    const audio = current;
    if (!audio) return Promise.resolve(false);
    const audible = options.audible === true;
    audio.muted = !audible;
    audio.volume = 1;
    return audio.play().then(
      () => true,
      () => false, // 自动播放策略等拒绝:上报失败,不当作成功(WT-P1-006)
    );
  }

  function ended(): Promise<AudioEndResult> {
    const audio = current;
    if (!audio) return Promise.resolve('ended');
    return new Promise<AudioEndResult>((resolve) => {
      settleEnded = resolve;
      audio.onended = () => resolve('ended');
      audio.onerror = () => resolve('failed'); // 播放期错误与自然结束分开上报
    });
  }

  function stop(): void {
    loadToken += 1; // 在途加载与等待全部失效
    if (settleEnded) {
      const settle = settleEnded;
      settleEnded = null;
      settle('failed'); // 停止也兑现等待,避免悬挂;调用方按 token 不再上报
    }
    if (current) {
      discardElement(current);
      current = null;
    }
  }

  function currentSrc(): string | null {
    return current?.src ?? null;
  }

  return { prepare, begin, ended, stop, currentSrc };
}
