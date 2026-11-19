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

    const assetUnavailable = !asset || !asset.available;
    if (assetUnavailable && !hasAudio) {
      showPlaceholder(`动作 ${performance.action}(素材未配置)`, deps.placeholder, deps.placeholderLabel);
      finishAnimationOnly(ErrorCodes.ASSET_MISSING);
      return;
    }

    if (!hasAudio) {
      // 纯动画(P0 语义):非循环一轮即结束,循环动作一轮结束
      // (assetUnavailable 且无音频已在上方同步收尾,此处 asset 必可用)
      deps.video
        .prepareAction(asset!.url, asset!.loop)
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

    // 带音频:双轨协同(ARCHITECTURE §7 / WT-P1-006 / WT-P1-007)
    // - 说话类动作(素材 loop=true)持续循环,由音频结束驱动结束;
    // - 一次性动作(如 dance)自然播完,即使确认音频先结束也不截断;
    // - 两轨各自上报终态,全部终态后再清理回待机。
    void (async () => {
      const speechLoop = asset?.loop === true; // 清单 loop 标记即“说话/待机”类(素材缺失时按说话类收尾)
      let clip: import('./video-track.js').PreparedClip | null = null;
      let audioHandle: import('./audio-track.js').AudioHandle | null = null;
      // 双轨准备分别捕获(WT-P1-008):音频失败不拖垮动画与字幕,动画失败不拖垮音频
      try {
        audioHandle = await deps.audio.prepare(audioUrl);
      } catch {
        audioHandle = null; // 句柄弃置(含 superseded),走无声降级
      }
      if (token !== playToken) {
        // 迟到加载:不触碰共享轨道(那里可能是新表演的元素,WT-P1-003),直接弃置本任务。
        return;
      }
      if (assetUnavailable) {
        clip = null; // 素材缺失:不准备视频,音频路径保留(WT-P1-008)
      } else {
        try {
          clip = await deps.video.prepareAction(asset!.url, asset!.loop, speechLoop); // 仅说话类 endless
        } catch {
          clip = null;
        }
      }
      if (token !== playToken) {
        clip?.stop(); // clip 仅操作本任务自己的缓冲位
        audioHandle = null; // 失效句柄不产生任何回执
        return;
      }
      const audioOk = audioHandle !== null;

      // 动画素材失败:动画回报失败,字幕无条件展示;音频可用时照常发声(WT-P1-008)
      if (clip === null) {
        showPlaceholder(`动作 ${performance.action}(素材加载失败)`, deps.placeholder, deps.placeholderLabel);
        deps.report('animation', 'failed', ErrorCodes.ASSET_MISSING);
        showCaption(performance.say); // 字幕不依赖音频可用性
        if (audioOk && audioHandle !== null) {
          deps.report('audio', 'ready');
          if (await audioHandle.begin({ audible })) {
            if (token !== playToken) return; // 迟到起播确认:不替新任务上报(WT-P1-003)
            deps.report('audio', 'started');
            const audioResult = await audioHandle.ended();
            if (token !== playToken) return;
            deps.report('audio', audioResult === 'ended' ? 'ended' : 'failed', audioResult === 'failed' ? 'AUDIO_PLAY_ERROR' : undefined);
          } else {
            if (token !== playToken) return;
            deps.report('audio', 'failed', 'AUDIO_START_REJECTED');
          }
        } else {
          deps.report('audio', 'failed', 'AUDIO_LOAD_FAILED');
        }
        // 双轨各自的终态都已上报;字幕保留估算时长后回收(WT-P1-008)
        window.setTimeout(() => {
          if (token !== playToken) return;
          hideCaption();
          backToIdle(token);
        }, subtitleEstimateMs(performance.say));
        return;
      }

      deps.report('animation', 'ready');

      // 音频加载失败:无声降级,字幕时长驱动(说话类此时也按估算收尾)
      if (!audioOk) {
        deps.report('audio', 'failed', 'AUDIO_LOAD_FAILED');
        clip.show();
        clip.play();
        deps.report('animation', 'started');
        showCaption(performance.say);
        const estimateMs = speechLoop ? subtitleEstimateMs(performance.say) : -1;
        const animationDone = estimateMs >= 0
          ? new Promise<void>((resolve) => setTimeout(resolve, estimateMs)).then(() => {
              if (token === playToken) deps.report('animation', 'ended');
            })
          : clip.ended().then(() => {
              if (token === playToken) deps.report('animation', 'ended');
            });
        await animationDone;
        if (token !== playToken) return;
        clip.stop();
        hideCaption();
        backToIdle(token);
        return;
      }

      deps.report('audio', 'ready');
      clip.show();
      clip.play();
      deps.report('animation', 'started');
      showCaption(performance.say);

      // 起播确认后再报 started;被拒按失败上报(WT-P1-006);
      // 迟到的成功确认属于已失效句柄(begin 兑现 false)或需再次核对令牌(WT-P1-003)
      if (!(await audioHandle!.begin({ audible }))) {
        if (token !== playToken) return;
        deps.report('audio', 'failed', 'AUDIO_START_REJECTED');
        // 保留无声动作与字幕的合理展示时间,再继续队列
        const estimateMs = speechLoop ? subtitleEstimateMs(performance.say) : -1;
        if (estimateMs >= 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, estimateMs));
          if (token !== playToken) return;
          deps.report('animation', 'ended');
        } else {
          await clip.ended();
          if (token !== playToken) return;
          deps.report('animation', 'ended');
        }
        clip.stop();
        hideCaption();
        backToIdle(token);
        return;
      }
      if (token !== playToken) return; // 迟到起播确认不替新任务上报 started
      deps.report('audio', 'started');

      // 双轨并行,各自终态:说话类动画在音频结束后手动收尾;
      // 一次性动作自然播完(音频先结束也不截断,WT-P1-007)。
      const audioDone = audioHandle!.ended().then((result) => {
        if (token === playToken) {
          deps.report('audio', result === 'ended' ? 'ended' : 'failed', result === 'failed' ? 'AUDIO_PLAY_ERROR' : undefined);
          hideCaption(); // 字幕随语音消失;一次性动作画面继续到自然结束
        }
        return result;
      });
      const animationDone = speechLoop
        ? audioDone.then(() => {
            if (token === playToken) deps.report('animation', 'ended');
          })
        : clip.ended().then(() => {
            if (token === playToken) deps.report('animation', 'ended');
          });
      await Promise.all([animationDone, audioDone]);
      if (token !== playToken) return;
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
