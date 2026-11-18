import { readCredentialFromHash, createWsClient } from '../shared/ws-client.js';
import type { PerformanceDispatch } from '../../shared/performance.js';
import { createVideoTrack } from './video-track.js';
import { createAudioTrack } from './audio-track.js';
import { createPlayer } from './player.js';

// 连接、播放端注册与页面生命周期(PROJECT_STRUCTURE 目标目录注释):
// 认证 → renderer-register → 申请/续租播放租约 → 接收表演并回执;
// 断线时本地停止音频,重连后重新登记;收到新 runId 后清理旧播放状态。
// 回执与本地停止绑定“派发身份”:每个表演使用派发时的租约快照
// (WT-P0-007),服务端租约回收后自动推进的下一项以新身份回执,不被旧租约判失效。

function main(): void {
  const statusEl = document.getElementById('status') as HTMLElement;
  const caption = document.getElementById('caption') as HTMLElement;
  const videoA = document.getElementById('video-a') as HTMLVideoElement;
  const videoB = document.getElementById('video-b') as HTMLVideoElement;
  const placeholder = document.getElementById('placeholder') as HTMLElement;
  const placeholderLabel = document.getElementById('placeholder-label') as HTMLElement;

  const credential = readCredentialFromHash();
  if (credential === null) {
    placeholderLabel.textContent = '缺少访问凭据:请使用服务启动时输出的播放页链接';
    placeholder.style.display = 'flex';
  }
  // 音频归属模式(WT-P1-005):仅 ?audio=1 的入口(OBS/控制台分发的播放链接)
  // 申请播放租约;普通预览不持有租约、始终静音,不会抢走 OBS 的音频播放权。
  const audioMode = new URLSearchParams(window.location.search).get('audio') === '1';

  let runId: string | null = null;
  let rendererId: string | null = null;
  let leaseId: string | null = null;
  let currentPerformanceId: string | null = null;
  let currentDispatchLeaseId: string | null = null; // 当前表演派发时的租约快照(回执与停止的归属依据)
  let leaseTimer: number | null = null;
  let leaseDeadlineTimer: number | null = null;
  let statusHideTimer: number | null = null;
  // 断线时仍持有的租约(WT-P1-004):本地 stopAll 已停声但服务端无从得知;
  // 重连登记后补发释放作为真实停止确认,解除新端的接管安全等待。
  let pendingReleaseLeaseId: string | null = null;

  function setStatus(text: string, ok: boolean, sticky = false): void {
    statusEl.textContent = text;
    statusEl.className = ok ? 'ok' : '';
    statusEl.style.display = 'block';
    if (statusHideTimer !== null) window.clearTimeout(statusHideTimer);
    if (!sticky) {
      statusHideTimer = window.setTimeout(() => {
        statusEl.style.display = 'none';
      }, 2500);
    }
  }

  const video = createVideoTrack(videoA, videoB, placeholder, placeholderLabel);
  const audio = createAudioTrack();
  const player = createPlayer({
    video,
    audio,
    caption,
    placeholder,
    placeholderLabel,
    report(track, status, reason) {
      if (runId === null || rendererId === null) return;
      ws.send({
        kind: 'playback-report',
        report: {
          runId,
          leaseId: currentDispatchLeaseId,
          performanceId: currentPerformanceId ?? 'unknown',
          rendererId,
          track,
          status,
          at: Date.now(),
          ...(reason !== undefined ? { reason } : {}),
        },
      });
    },
  });

  function clearLeaseTimer(): void {
    if (leaseTimer !== null) {
      window.clearInterval(leaseTimer);
      leaseTimer = null;
    }
  }

  function clearLeaseDeadline(): void {
    if (leaseDeadlineTimer !== null) {
      window.clearTimeout(leaseDeadlineTimer);
      leaseDeadlineTimer = null;
    }
  }

  // 租约申请恢复(WT-P0-007):lease-result 失败(续租被拒 / 首次被拒)后
  // 以唯一计时器受控重试,指数退避;成功或断线时复位。首次尝试立即发送。
  let leaseRetryTimer: number | null = null;
  let leaseRetryAttempt = 0;

  function clearLeaseRetry(): void {
    if (leaseRetryTimer !== null) {
      window.clearTimeout(leaseRetryTimer);
      leaseRetryTimer = null;
    }
    leaseRetryAttempt = 0;
  }

  function scheduleLeaseRequest(serverRetryAfterMs?: number): void {
    if (!audioMode) return; // 预览模式不参与租约
    if (leaseRetryTimer !== null) return; // 唯一待执行重申请
    // 服务端给出等待建议(接管安全期限,WT-P1-004)时以其为准(加少量余量);
    // 否则指数退避。不设上限钳制:服务端期限是权威,多轮被拒只是无谓轮询。
    const delay = serverRetryAfterMs !== undefined
      ? serverRetryAfterMs + 250
      : (leaseRetryAttempt === 0 ? 0 : Math.min(2000 * 2 ** (leaseRetryAttempt - 1), 15_000));
    leaseRetryAttempt += 1;
    leaseRetryTimer = window.setTimeout(() => {
      leaseRetryTimer = null;
      if (leaseId !== null) return; // 等待期间已取得租约
      ws.send({ kind: 'lease-request' });
    }, delay);
  }

  /** 失去播放权(lostLeaseId 为失效的租约):仅当进行中的表演以该租约派发时才本地停止;
   *  服务端租约回收后自动推进的表演携带新派发身份(null / 新租约),继续播放(WT-P0-007)。
   *  重申请由调用点负责(续租失败按 retryAfterMs 延迟,看门狗立即)。 */
  function dropLeaseAndStopIfHeld(lostLeaseId: string | null): void {
    const affected = lostLeaseId !== null && currentDispatchLeaseId === lostLeaseId;
    leaseId = null;
    clearLeaseTimer();
    clearLeaseDeadline();
    if (affected) {
      setStatus('播放权已失效,本端停止', false, true);
      player.stop(currentPerformanceId);
    }
  }

  /** 本地截止看门狗:超过租约时长仍未成功续租,认定当前全局租约失效,
   *  按派发身份过滤后停止归属表演,并重新申请租约。 */
  function armLeaseDeadline(ttlMs: number): void {
    clearLeaseDeadline();
    leaseDeadlineTimer = window.setTimeout(() => {
      leaseDeadlineTimer = null;
      if (leaseId === null) return;
      const lostLeaseId = leaseId;
      setStatus('播放租约已失效', false, true);
      dropLeaseAndStopIfHeld(lostLeaseId);
      scheduleLeaseRequest();
    }, ttlMs + 500);
  }

  const ws = createWsClient({
    role: 'playback',
    credential: credential ?? '',
    onMessage(message) {
      switch (message.kind) {
        case 'auth-result': {
          if (!message.ok) {
            setStatus(`认证失败(${message.code}),请使用最新播放页链接`, false, true);
            return;
          }
          if (runId !== null && runId !== message.runId) {
            // 服务重启(runId 变化):本地停止音频,清理旧会话状态。
            player.stopAll();
            leaseId = null;
          }
          runId = message.runId;
          ws.send({ kind: 'renderer-register' });
          return;
        }
        case 'renderer-registered': {
          rendererId = message.rendererId;
          player.setIdle(message.idle);
          clearLeaseRetry();
          if (pendingReleaseLeaseId !== null) {
            // 断线遗留租约的停止确认(WT-P1-004):本页已 stopAll,先释放旧租约
            // 解除新端安全等待,再申请新租约,避免一次注定被拒的申请轮次。
            ws.send({ kind: 'lease-release', leaseId: pendingReleaseLeaseId });
            pendingReleaseLeaseId = null;
          }
          if (audioMode) {
            ws.send({ kind: 'lease-request' });
          } else {
            setStatus('预览模式(静音)', true);
          }
          return;
        }
        case 'lease-result': {
          if (message.ok) {
            leaseId = message.leaseId;
            pendingReleaseLeaseId = null; // 新租约成立,服务端已作废旧断线确认
            clearLeaseRetry();
            clearLeaseTimer();
            leaseTimer = window.setInterval(() => {
              if (leaseId) ws.send({ kind: 'lease-renew', leaseId });
            }, message.renewIntervalMs);
            armLeaseDeadline(message.ttlMs);
          } else if (audioMode) {
            // 续租/首次申请被拒:失效租约归属过滤后停止,并进入受控重申请(WT-P0-007);
            // 拒绝响应携带安全期限等待建议时按其重试(WT-P1-004)
            dropLeaseAndStopIfHeld(leaseId);
            scheduleLeaseRequest(message.retryAfterMs);
          }
          return;
        }
        case 'performance': {
          const dispatch: PerformanceDispatch = message.dispatch;
          currentPerformanceId = dispatch.performance.id;
          currentDispatchLeaseId = dispatch.leaseId; // 回执与本地停止绑定派发身份(WT-P0-007)
          player.play(dispatch);
          return;
        }
        case 'stop': {
          player.stop(message.performanceId);
          if (message.performanceId === currentPerformanceId) {
            currentPerformanceId = null;
            currentDispatchLeaseId = null;
          }
          return;
        }
        case 'state': {
          // 播放页仅用于状态展示调试;表演与停止以专用消息驱动。
          return;
        }
        default:
          return;
      }
    },
    onStatus(status) {
      if (status === 'disconnected') {
        setStatus('连接断开,已停止声音,重连中…', false, true);
        player.stopAll(); // 先停声;持有时记录遗留租约供重连后补发释放(WT-P1-004)
        pendingReleaseLeaseId = leaseId ?? pendingReleaseLeaseId;
        clearLeaseTimer();
        clearLeaseDeadline();
        clearLeaseRetry();
        leaseId = null;
        currentDispatchLeaseId = null;
        rendererId = null;
      } else if (status === 'connected') {
        setStatus('已连接', true);
      }
    },
  });

  window.addEventListener('beforeunload', () => {
    clearLeaseTimer();
    clearLeaseDeadline();
    clearLeaseRetry();
    player.stopAll(); // 先完成本地停声,释放才对应“停止确认”(WT-P1-004 契约)
    if (leaseId && rendererId) {
      ws.send({ kind: 'lease-release', leaseId });
    }
    ws.close();
  });
}

main();
