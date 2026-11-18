import type { PerformanceDispatch, PlaybackTrack } from '../../shared/performance.js';
import { ErrorCodes } from '../../shared/errors.js';
import type { AudioTrack } from './audio-track.js';
import type { PreparedClip, VideoTrack } from './video-track.js';
import { showPlaceholder } from './video-track.js';

// 一次表演的本机执行与回执(ARCHITECTURE §7/§8):
// 预加载 → ready 回执 → 切换开播 → started 回执 → 轨道结束 → ended 回执;
// 素材缺失立即回报 failed(ASSET_MISSING)并以字幕时长兜底展示后回待机。
// playToken 使旧的停止/迟到事件令后续流程失效,与服务端版本校验对应。
// 待机片段缓存(稳定缓冲位 + 代数):预加载完成晚于表演派发时不得覆盖
// 进行中的表演(WT-P0-009),缓存失败后回到待机时按需重建。

export type PlayerReport = (track: PlaybackTrack, status: 'ready' | 'started' | 'ended' | 'cancelled' | 'failed', reason?: string) => void;

export type Player = {
  setIdle(idle: { url: string; loop: boolean; available: boolean } | null): void;
  play(dispatch: PerformanceDispatch): void;
  stop(performanceId: string | null): void;
  stopAll(): void;
};

export function createPlayer(deps: {
  video: VideoTrack;
  audio: AudioTrack;
  caption: HTMLElement;
  placeholder: HTMLElement;
  placeholderLabel: HTMLElement;
  report: PlayerReport;
}): Player {
  let playToken = 0;
  let idleDescriptor: { url: string; loop: boolean } | null = null;
  let idleClipPromise: Promise<PreparedClip> | null = null;
  let idleGeneration = 0;

  function showCaption(text: string): void {
    if (text === '') return;
    deps.caption.textContent = text;
    deps.caption.style.display = 'block';
  }

  function hideCaption(): void {
    deps.caption.style.display = 'none';
  }

  function startIdlePrepare(): void {
    const desc = idleDescriptor;
    if (!desc) return;
    const gen = ++idleGeneration;
    const tokenAtStart = playToken;
    const promise = deps.video.prepareIdle(desc.url, desc.loop);
    idleClipPromise = promise;
    void promise
      .then((clip) => {
        if (gen !== idleGeneration) return; // 已被更新的 setIdle 取代
        if (tokenAtStart !== playToken) return; // 迟到的待机不覆盖进行中的表演,缓存留待回待机使用
        clip.show();
        clip.play();
      })
      .catch(() => {
        if (gen !== idleGeneration) return;
        idleClipPromise = null;
        if (tokenAtStart === playToken) {
          showPlaceholder('待机(素材加载失败)', deps.placeholder, deps.placeholderLabel);
        }
      });
  }

  function backToIdle(token: number): void {
    if (token !== playToken) return;
    if (idleClipPromise) {
      void idleClipPromise.then((clip) => {
        if (token !== playToken) return;
        clip.show();
        clip.play();
      });
      return;
    }
    if (idleDescriptor) {
      startIdlePrepare(); // 此前加载失败:回到待机时按需重建
      return;
    }
    showPlaceholder('待机(素材未配置)', deps.placeholder, deps.placeholderLabel);
  }

  function subtitleEstimateMs(text: string): number {
    return Math.min(9000, 1500 + text.length * 220);
  }

  function setIdle(idle: { url: string; loop: boolean; available: boolean } | null): void {
    const next = idle && idle.available ? { url: idle.url, loop: idle.loop } : null;
    const unchanged = next !== null && idleDescriptor !== null && next.url === idleDescriptor.url;
    idleDescriptor = next;
    if (next === null) {
      idleGeneration += 1; // 使旧的准备过程失效
      idleClipPromise = null;
      showPlaceholder(idle ? `待机(${idle.url ? '素材未配置' : '无待机素材'})` : '待机(无待机素材)', deps.placeholder, deps.placeholderLabel);
      return;
    }
    if (idleClipPromise !== null && unchanged) {
      // 缓存复用(断线重连/重新登记):占位可见时恢复待机画面与循环播放(WT-P0-010);
      // 表演进行中(占位隐藏)不动,保留 WT-P0-009 的“迟到待机不覆盖动作”约束。
      if (deps.placeholder.style.display !== 'none') {
        const gen = idleGeneration;
        void idleClipPromise.then((clip) => {
          if (gen !== idleGeneration) return;
          if (deps.placeholder.style.display === 'none') return; // 已有可见画面
          clip.show();
          clip.play();
        });
      }
      return;
    }
    // 首次/失败后/更换素材:准备
    startIdlePrepare();
  }

  function play(dispatch: PerformanceDispatch): void {
    playToken += 1;
    const token = playToken;
    const { performance, asset } = dispatch;
    const audioUrl = typeof performance.audioUrl === 'string' ? performance.audioUrl : '';
    const hasAudio = audioUrl !== '';
    // 服务端只向租约持有者派发音频;此处再守一层 —— 无租约的派发(降级/异常)静音播放
    const audible = hasAudio && dispatch.leaseId !== null;

    const finishAnimationOnly = (reason: string) => {
      // 素材缺失:立即回报 failed,字幕按估算时长展示后回待机;音频同步取消。
      deps.report('animation', 'failed', reason);
      if (hasAudio) {
        deps.audio.stop();
        deps.report('audio', 'cancelled');
      }
      showCaption(performance.say);
      window.setTimeout(() => {
        if (token !== playToken) return;
        hideCaption();
        backToIdle(token);
      }, performance.say === '' ? 800 : subtitleEstimateMs(performance.say));
    };

    if (!asset || !asset.available) {
      showPlaceholder(`动作 ${performance.action}(素材未配置)`, deps.placeholder, deps.placeholderLabel);
      finishAnimationOnly(ErrorCodes.ASSET_MISSING);
      return;
    }

    if (!hasAudio) {
      // 纯动画(P0 语义):非循环一轮即结束,循环动作一轮结束
      deps.video
        .prepareAction(asset.url, asset.loop)
        .then((clip) => {
          if (token !== playToken) {
            clip.stop();
            return;
          }
          deps.report('animation', 'ready');
          clip.show();
          clip.play();
          deps.report('animation', 'started');
          showCaption(performance.say);
          return clip.ended().then(() => {
            if (token !== playToken) return;
            deps.report('animation', 'ended');
            hideCaption();
            backToIdle(token);
          });
        })
        .catch(() => {
          if (token !== playToken) return;
          showPlaceholder(`动作 ${performance.action}(素材加载失败)`, deps.placeholder, deps.placeholderLabel);
          finishAnimationOnly(ErrorCodes.ASSET_MISSING);
        });
      return;
    }

    // 带音频:动画持续循环,由音频结束驱动整场表演结束(ARCHITECTURE §7)
    void (async () => {
      let clip: import('./video-track.js').PreparedClip | null = null;
      let audioOk = false;
      try {
        audioOk = await deps.audio.prepare(audioUrl).then(
          () => true,
          () => false,
        );
        if (token !== playToken) return;
        clip = await deps.video.prepareAction(asset.url, asset.loop, true); // endless
      } catch {
        clip = null;
      }
      if (token !== playToken) {
        clip?.stop();
        deps.audio.stop();
        return;
      }

      if (clip === null) {
        // 动画素材失败:保留字幕与音频(可听),动画回报失败
        showPlaceholder(`动作 ${performance.action}(素材加载失败)`, deps.placeholder, deps.placeholderLabel);
        deps.report('animation', 'failed', ErrorCodes.ASSET_MISSING);
        if (audioOk) {
          deps.report('audio', 'ready');
          showCaption(performance.say);
          deps.report('audio', 'started');
          await deps.audio.play({ audible });
          if (token !== playToken) return;
          deps.report('audio', 'ended');
        } else {
          deps.report('audio', 'failed', 'AUDIO_LOAD_FAILED');
        }
        window.setTimeout(() => {
          if (token !== playToken) return;
          hideCaption();
          backToIdle(token);
        }, subtitleEstimateMs(performance.say));
        return;
      }

      deps.report('animation', 'ready');
      if (!audioOk) {
        // 音频加载失败:降级为“字幕时长”驱动的无声表演(ARCHITECTURE §7)
        deps.report('audio', 'failed', 'AUDIO_LOAD_FAILED');
        clip.show();
        clip.play();
        deps.report('animation', 'started');
        showCaption(performance.say);
        window.setTimeout(
          () => {
            if (token !== playToken) return;
            deps.report('animation', 'ended');
            clip?.stop();
            hideCaption();
            backToIdle(token);
          },
          performance.say === '' ? 1500 : subtitleEstimateMs(performance.say),
        );
        return;
      }

      deps.report('audio', 'ready');
      clip.show();
      clip.play();
      deps.report('animation', 'started');
      showCaption(performance.say);
      deps.report('audio', 'started');
      await deps.audio.play({ audible });
      if (token !== playToken) return;
      deps.report('audio', 'ended');
      deps.report('animation', 'ended');
      clip.stop();
      hideCaption();
      backToIdle(token);
    })();
  }

  function stop(performanceId: string | null): void {
    void performanceId;
    playToken += 1;
    deps.audio.stop();
    hideCaption();
    backToIdle(playToken);
  }

  function stopAll(): void {
    playToken += 1;
    deps.audio.stop();
    hideCaption();
    showPlaceholder('连接断开,等待重连…', deps.placeholder, deps.placeholderLabel);
  }

  return { setIdle, play, stop, stopAll };
}
