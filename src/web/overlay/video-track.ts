// 视频轨道:预加载、双缓冲与切换(PROJECT_STRUCTURE《模块职责》/ARCHITECTURE §8)。
// 两个 video 元素交替使用:新片段在隐藏位预加载到可播放帧后再切换,避免黑屏。
// loop 素材在完成“一个循环”后视为 ended(说话动作循环到音频/字幕结束的 P0 近似)。

export type PreparedClip = {
  show(): void;
  play(): void;
  ended(): Promise<void>;
  stop(): void;
};

export type VideoTrack = {
  /** @param indefinite true 时媒体元素自身持续循环(待机),ended 仅经 stop() 兑现 */
  prepare(url: string, loop: boolean, indefinite?: boolean): Promise<PreparedClip>;
  hideAll(): void;
};

export function createVideoTrack(videoA: HTMLVideoElement, videoB: HTMLVideoElement, placeholder: HTMLElement, placeholderLabel: HTMLElement): VideoTrack {
  let slots: HTMLVideoElement[] = [videoA, videoB];
  let activeSlot = -1;

  function hide(slot: HTMLVideoElement): void {
    slot.pause();
    slot.classList.add('hidden');
  }

  function prepare(url: string, loop: boolean, indefinite = false): Promise<PreparedClip> {
    const slot = slots.find((_, index) => index !== activeSlot) ?? slots[0]!;
    const nextActive = slots.indexOf(slot);
    return new Promise<PreparedClip>((resolve, reject) => {
      let settled = false;
      const onLoaded = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(makeClip(slot, nextActive, loop, indefinite));
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
      // indefinite 由媒体元素自身循环(待机);表演循环仍按“一轮即结束”由 ended() 判定
      slot.loop = indefinite;
      slot.muted = true;
      slot.playsInline = true;
      slot.src = url;
      slot.load();
    });
  }

  function makeClip(slot: HTMLVideoElement, slotIndex: number, loop: boolean, indefinite: boolean): PreparedClip {
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
      if (indefinite) return; // 媒体元素循环,ended 不兑现
      finish();
    };
    const onTime = () => {
      if (indefinite) return;
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

  return { prepare, hideAll };
}

export function showPlaceholder(label: string, placeholder: HTMLElement, placeholderLabel: HTMLElement): void {
  for (const video of document.querySelectorAll('#videos video')) {
    (video as HTMLVideoElement).classList.add('hidden');
  }
  placeholderLabel.textContent = label;
  placeholder.style.display = 'flex';
}
