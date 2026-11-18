// 视频轨道:预加载、双缓冲与切换(PROJECT_STRUCTURE《模块职责》/ARCHITECTURE §8)。
// 缓冲位按角色固定(WT-P0-009):位 0 恒为待机、位 1 恒为表演动作,
// 待机预加载与动作派发交错时互不覆盖,回到待机的资源与循环配置始终正确。
// 待机由媒体元素自身持续循环;表演循环按“一轮即结束”判定(P0 无语音的近似)。

export type PreparedClip = {
  show(): void;
  play(): void;
  ended(): Promise<void>;
  stop(): void;
};

export type VideoTrack = {
  /** 待机:媒体元素自身持续循环,ended 仅经 stop() 兑现 */
  prepareIdle(url: string, loop: boolean): Promise<PreparedClip>;
  /** 表演动作;endless=true(带音频的说话类表演)时持续循环到音频结束,
   *  结束由播放器手动上报,而非“一轮即结束”。 */
  prepareAction(url: string, loop: boolean, endless?: boolean): Promise<PreparedClip>;
  hideAll(): void;
};

export function createVideoTrack(videoA: HTMLVideoElement, videoB: HTMLVideoElement, placeholder: HTMLElement, placeholderLabel: HTMLElement): VideoTrack {
  const slots: HTMLVideoElement[] = [videoA, videoB];
  const IDLE_SLOT = 0;
  const ACTION_SLOT = 1;
  let activeSlot = -1;

  function hide(slot: HTMLVideoElement): void {
    slot.pause();
    slot.classList.add('hidden');
  }

  function prepareOn(slotIndex: number, url: string, loop: boolean, endless: boolean): Promise<PreparedClip> {
    const slot = slots[slotIndex]!;
    return new Promise<PreparedClip>((resolve, reject) => {
      let settled = false;
      const onLoaded = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(makeClip(slot, slotIndex, loop, endless));
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        slot.removeAttribute('src');
        reject(new Error('asset-load-failed'));
      };
      const cleanup = () => {
        slot.removeEventListener('loadeddata', onLoaded);
        slot.removeEventListener('canplay', onLoaded);
        slot.removeEventListener('error', onError);
      };
      slot.addEventListener('loadeddata', onLoaded);
      slot.addEventListener('canplay', onLoaded);
      slot.addEventListener('error', onError);
      // endless(待机/带音频的说话)由媒体元素自身循环;否则表演循环按“一轮即结束”
      slot.loop = endless;
      slot.muted = true;
      slot.playsInline = true;
      slot.src = url;
      slot.load();
    });
  }

  function makeClip(slot: HTMLVideoElement, slotIndex: number, loop: boolean, endless: boolean): PreparedClip {
    let endedResolve: (() => void) | null = null;
    let ended = false;
    const endedPromise = new Promise<void>((resolve) => {
      endedResolve = resolve;
    });
    const finish = () => {
      if (ended) return;
      ended = true;
      endedResolve?.();
    };
    const onEnded = () => {
      if (endless) return; // 元素持续循环(待机或音频驱动的说话),ended 不自行兑现
      finish();
    };
    const onTime = () => {
      if (endless) return;
      if (loop && slot.duration > 0 && slot.currentTime >= slot.duration - 0.08) finish();
    };
    const onError = () => finish(); // 播放中途出错按结束处理,避免悬挂
    slot.addEventListener('ended', onEnded);
    slot.addEventListener('timeupdate', onTime);
    slot.addEventListener('error', onError);
    return {
      show() {
        if (activeSlot >= 0 && activeSlot !== slotIndex) hide(slots[activeSlot]!);
        activeSlot = slotIndex;
        slot.classList.remove('hidden');
        placeholder.style.display = 'none';
      },
      play() {
        void slot.play().catch(() => finish());
      },
      ended: () => endedPromise,
      stop() {
        finish();
        slot.removeEventListener('ended', onEnded);
        slot.removeEventListener('timeupdate', onTime);
        slot.removeEventListener('error', onError);
        hide(slot);
        if (activeSlot === slotIndex) activeSlot = -1;
      },
    };
  }

  function hideAll(): void {
    for (const slot of slots) hide(slot);
    activeSlot = -1;
    placeholder.style.display = 'flex';
    placeholderLabel.textContent = '待机(素材未配置)';
  }

  // 初始状态:显示占位,等待待机素材
  hideAll();

  return {
    prepareIdle(url, loop) {
      return prepareOn(IDLE_SLOT, url, loop, true);
    },
    prepareAction(url, loop, endless = false) {
      return prepareOn(ACTION_SLOT, url, loop || endless, endless);
    },
    hideAll,
  };
}

export function showPlaceholder(label: string, placeholder: HTMLElement, placeholderLabel: HTMLElement): void {
  for (const video of document.querySelectorAll('#videos video')) {
    (video as HTMLVideoElement).classList.add('hidden');
  }
  placeholderLabel.textContent = label;
  placeholder.style.display = 'flex';
}
