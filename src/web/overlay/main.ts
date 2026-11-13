import { readCredentialFromHash, createWsClient } from '../shared/ws-client.js';
import type { PerformanceDispatch } from '../../shared/performance.js';
import { createVideoTrack } from './video-track.js';
import { createAudioTrack } from './audio-track.js';
import { createPlayer } from './player.js';

// 连接、播放端注册与页面生命周期(PROJECT_STRUCTURE 目标目录注释):
// 认证 → renderer-register → 申请/续租播放租约 → 接收表演并回执;
// 断线时本地停止音频,重连后重新登记;收到新 runId 后清理旧播放状态。

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

  let runId: string | null = null;
  let rendererId: string | null = null;
  let leaseId: string | null = null;
  let leaseTimer: number | null = null;
  let leaseDeadlineTimer: number | null = null;
  let statusHideTimer: number | null = null;

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
          leaseId,
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

  let currentPerformanceId: string | null = null;

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

  /** 本地截止看门狗:超过租约时长仍未成功续租,即认定播放权失效,停止当前播放并重新申请。 */
  function armLeaseDeadline(ttlMs: number): void {
    clearLeaseDeadline();
    leaseDeadlineTimer = window.setTimeout(() => {
      leaseDeadlineTimer = null;
      if (leaseId === null) return;
      leaseId = null;
      clearLeaseTimer();
      setStatus('播放租约已失效,已停止声音', false, true);
      player.stop(currentPerformanceId);
      ws.send({ kind: 'lease-request' });
    }, ttlMs + 1500);
  }

  /** 失去播放权时停止本端表演;无租约在身(如首次申请被拒)只需重试。 */
  function dropLeaseAndStopIfHeld(): void {
    const hadLease = leaseId !== null;
    leaseId = null;
    clearLeaseTimer();
    clearLeaseDeadline();
    if (hadLease) {
      setStatus('播放权已转交,本端停止', false, true);
      player.stop(currentPerformanceId);
    }
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
          ws.send({ kind: 'lease-request' });
          return;
        }
        case 'lease-result': {
          if (message.ok) {
            leaseId = message.leaseId;
            clearLeaseTimer();
            leaseTimer = window.setInterval(() => {
              if (leaseId) ws.send({ kind: 'lease-renew', leaseId });
            }, message.renewIntervalMs);
            armLeaseDeadline(message.ttlMs);
          } else {
            dropLeaseAndStopIfHeld();
            window.setTimeout(() => ws.send({ kind: 'lease-request' }), message.retryAfterMs ?? 2000);
          }
          return;
        }
        case 'performance': {
          const dispatch: PerformanceDispatch = message.dispatch;
          currentPerformanceId = dispatch.performance.id;
          player.play(dispatch);
          return;
        }
        case 'stop': {
          player.stop(message.performanceId);
          if (message.performanceId === currentPerformanceId) currentPerformanceId = null;
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
        player.stopAll();
        clearLeaseTimer();
        clearLeaseDeadline();
        leaseId = null;
        rendererId = null;
      } else if (status === 'connected') {
        setStatus('已连接', true);
      }
    },
  });

  window.addEventListener('beforeunload', () => {
    clearLeaseTimer();
    clearLeaseDeadline();
    if (leaseId && rendererId) {
      ws.send({ kind: 'lease-release', leaseId });
    }
    ws.close();
  });
}

main();
