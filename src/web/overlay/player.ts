import type { PerformanceDispatch, PlaybackTrack } from '../../shared/performance.js';
import { ErrorCodes } from '../../shared/errors.js';
import type { AudioTrack } from './audio-track.js';
import type { VideoTrack } from './video-track.js';
import { showPlaceholder } from './video-track.js';

// 一次表演的本机执行与回执(ARCHITECTURE §7/§8):
// 预加载 → ready 回执 → 切换开播 → started 回执 → 轨道结束 → ended 回执;
// 素材缺失立即回报 failed(ASSET_MISSING)并以字幕时长兜底展示后回待机。
// playToken 使旧的停止/迟到事件令后续流程失效,与服务端版本校验对应。

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
  let idleClipPromise: Promise<import('./video-track.js').PreparedClip> | null = null;
  let idleLoop = true;

  function showCaption(text: string): void {
    if (text === '') return;
    deps.caption.textContent = text;
    deps.caption.style.display = 'block';
  }

  function hideCaption(): void {
    deps.caption.style.display = 'none';
  }

  function backToIdle(token: number): void {
    if (token !== playToken) return;
    if (idleClipPromise) {
      void idleClipPromise.then((clip) => {
        if (token !== playToken) return;
        clip.show();
        clip.play();
      });
    } else {
      showPlaceholder('待机(素材未配置)', deps.placeholder, deps.placeholderLabel);
    }
  }

  function subtitleEstimateMs(text: string): number {
    return Math.min(9000, 1500 + text.length * 220);
  }

  function setIdle(idle: { url: string; loop: boolean; available: boolean } | null): void {
    idleLoop = idle?.loop ?? true;
    if (idle && idle.available) {
      // 待机无限循环:直到表演派发或停止才离开,不做“一轮即结束”
      idleClipPromise = deps.video.prepare(idle.url, idleLoop, true);
      void idleClipPromise
        .then((clip) => {
          clip.show();
          clip.play();
        })
        .catch(() => {
          idleClipPromise = null;
          showPlaceholder('待机(素材加载失败)', deps.placeholder, deps.placeholderLabel);
        });
    } else {
      idleClipPromise = null;
      showPlaceholder(idle ? `待机(${idle.url ? '素材未配置' : '无待机素材'})` : '待机(无待机素材)', deps.placeholder, deps.placeholderLabel);
    }
  }

  function play(dispatch: PerformanceDispatch): void {
    playToken += 1;
    const token = playToken;
    const { performance, asset } = dispatch;
    const hasAudio = typeof performance.audioUrl === 'string' && performance.audioUrl !== '';

    const finishAnimationOnly = (reason: string) => {
      // 素材缺失:立即回报 failed,字幕按估算时长展示后回待机。
      deps.report('animation', 'failed', reason);
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

    deps.video
      .prepare(asset.url, asset.loop)
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

    if (hasAudio && performance.audioUrl) {
      deps.audio
        .prepare(performance.audioUrl)
        .then(() => {
          if (token !== playToken) return;
          deps.report('audio', 'ready');
          deps.report('audio', 'started');
          return deps.audio.play().then(() => {
            if (token !== playToken) return;
            deps.report('audio', 'ended');
          });
        })
        .catch(() => {
          if (token !== playToken) return;
          // P0 无语音,音频失败不阻塞动画/字幕;P1 起按 ARCHITECTURE §7 处理降级。
          deps.report('audio', 'failed', 'AUDIO_LOAD_FAILED');
        });
    }
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
