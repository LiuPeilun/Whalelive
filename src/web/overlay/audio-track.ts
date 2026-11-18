// 音频轨道:加载、起播确认、自然结束与停止。
//
// 句柄化归属(WT-P1-003):prepare 返回绑定本次加载的 AudioHandle,
// begin/ended 只作用于"该句柄仍是当前归属"的元素——被替换或全局停止后的
// 迟到回调一律不触碰新表演的媒体元素、不替新任务产生回执。
// 全局 stop() 由播放页停止路径调用(紧急停止/断线),清当前元素并使一切句柄失效。

export type AudioEndResult = 'ended' | 'failed'; // 自然结束 | 播放期错误/失效

export type AudioHandle = {
  /** 起播确认:浏览器真正开始播放兑现 true;被拒或句柄已失效兑现 false(不触碰当前元素)。 */
  begin(options?: { audible?: boolean }): Promise<boolean>;
  /** 终态:自然结束 'ended';播放期错误或句柄已失效 'failed'(调用方按自身令牌决定是否上报)。 */
  ended(): Promise<AudioEndResult>;
};

export type AudioTrack = {
  prepare(url: string): Promise<AudioHandle>;
  stop(): void;
  currentSrc(): string | null;
};

export function createAudioTrack(): AudioTrack {
  let current: HTMLAudioElement | null = null;
  let currentToken = 0; // 归属令牌:每次 prepare/stop 递增,旧句柄全部失效
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

  function releaseCurrent(): void {
    if (settleEnded) {
      const settle = settleEnded;
      settleEnded = null;
      settle('failed'); // 旧句柄的等待以失效收尾,不悬挂
    }
    if (current) {
      discardElement(current);
      current = null;
    }
  }

  async function prepare(url: string): Promise<AudioHandle> {
    const myToken = ++currentToken;
    releaseCurrent(); // 新加载即刻取代旧归属(旧元素停声、旧等待失效)
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
    }).catch((err: unknown) => {
      if (myToken !== currentToken) {
        discardElement(audio);
        throw new Error('audio-load-superseded');
      }
      throw err;
    });
    if (myToken !== currentToken) {
      // 等待期间被新加载/停止取代:丢弃元素,交给新归属
      discardElement(audio);
      throw new Error('audio-load-superseded');
    }
    current = audio;

    const owned = () => myToken === currentToken && current === audio;
    const handle: AudioHandle = {
      begin(options: { audible?: boolean } = {}) {
        if (!owned()) return Promise.resolve(false); // 迟到起播:不触碰新表演的元素(WT-P1-003)
        const audible = options.audible === true;
        audio.muted = !audible;
        audio.volume = 1;
        return audio.play().then(
          () => true,
          () => false, // 自动播放策略等拒绝:上报失败,不当作成功(WT-P1-006)
        );
      },
      ended() {
        if (!owned()) return Promise.resolve('failed'); // 失效句柄:调用方按自身令牌不会上报
        return new Promise<AudioEndResult>((resolve) => {
          settleEnded = resolve;
          audio.onended = () => resolve('ended');
          audio.onerror = () => resolve('failed'); // 播放期错误与自然结束分开上报
        });
      },
    };
    return handle;
  }

  function stop(): void {
    currentToken += 1; // 一切句柄失效
    releaseCurrent();
  }

  function currentSrc(): string | null {
    return current?.src ?? null;
  }

  return { prepare, stop, currentSrc };
}
