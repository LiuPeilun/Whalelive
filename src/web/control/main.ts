import { CANONICAL_ACTION_IDS } from '../../shared/character.js';
import type { StateSnapshot } from '../../shared/protocol.js';
import { createWsClient, readCredentialFromHash, apiFetch, type WsClientHandle } from '../shared/ws-client.js';
import { errorMessage } from '../shared/dom.js';
import { mountStatusBar } from './features/status-bar.js';
import { mountSimulator } from './features/simulator.js';
import { mountManualAction } from './features/manual-action.js';
import { mountQueueView } from './features/queue-view.js';
import { mountSettingsPanel } from './features/settings-panel.js';
import { mountOverlayLink } from './features/overlay-link.js';

export type ControlContext = {
  credential: string;
  ws: WsClientHandle;
  request(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }>;
  notify(text: string, isError?: boolean): void;
  onState(cb: (state: StateSnapshot) => void): void;
  pushState(state: StateSnapshot | null): void;
};

function main(): void {
  const credential = readCredentialFromHash();
  const msgBox = document.getElementById('msg') as HTMLDivElement;

  function notify(text: string, isError = false): void {
    msgBox.textContent = text;
    msgBox.className = isError ? 'err' : '';
    msgBox.style.display = 'block';
    setTimeout(() => {
      msgBox.style.display = 'none';
    }, 4000);
  }

  if (credential === null) {
    notify('缺少访问凭据:请使用服务启动时输出的控制台链接打开本页。', true);
  }

  const stateCallbacks: ((state: StateSnapshot) => void)[] = [];
  let lastState: StateSnapshot | null = null;

  const ws = createWsClient({
    role: 'control',
    credential: credential ?? '',
    onMessage(message) {
      if (message.kind === 'state') {
        lastState = message.state;
        for (const cb of stateCallbacks) cb(message.state);
      }
    },
    onStatus(status) {
      const pill = document.getElementById('conn');
      if (!pill) return;
      pill.textContent = status === 'connected' ? '已连接' : status === 'connecting' ? '连接中' : '已断开';
      pill.className = `pill ${status === 'connected' ? 'ok' : 'bad'}`;
    },
  });

  const context: ControlContext = {
    credential: credential ?? '',
    ws,
    async request(path, init) {
      const result = await apiFetch(path, credential ?? '', init);
      if (result.status === 401) notify('凭据无效:请用服务输出的最新控制台链接打开。', true);
      return result;
    },
    notify,
    onState(cb) {
      stateCallbacks.push(cb);
      if (lastState) cb(lastState);
    },
    pushState(state) {
      if (state) for (const cb of stateCallbacks) cb(state);
    },
  };

  mountStatusBar(context);
  mountSimulator(context);
  mountManualAction(context, [...CANONICAL_ACTION_IDS]);
  mountQueueView(context);
  mountSettingsPanel(context);
  mountOverlayLink(context);
}

main();
