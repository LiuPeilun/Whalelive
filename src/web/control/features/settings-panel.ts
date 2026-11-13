import type { ControlContext } from '../main.js';
import { apiFetch } from '../../shared/ws-client.js';
import { errorMessage, el } from '../../shared/dom.js';
import type { SettingsView } from '../../../shared/settings.js';

// 设置面板:读取脱敏视图,编辑可热更新字段;保存带期望版本,冲突时提示刷新。

type FieldSpec = { key: string; label: string; get(view: SettingsView): number; min: number; max: number; step: number };

const FIELDS: FieldSpec[] = [
  { key: 'capacity', label: '待处理互动上限(条)', get: (v) => v.user.queue.capacity, min: 1, max: 200, step: 1 },
  { key: 'chatTtlMs', label: '普通聊天有效期(毫秒)', get: (v) => v.user.queue.chatTtlMs, min: 1000, max: 600000, step: 500 },
  { key: 'userCooldownMs', label: '同用户回复冷却(毫秒)', get: (v) => v.user.queue.userCooldownMs, min: 0, max: 600000, step: 500 },
  { key: 'mergeWindowMs', label: '礼物合并窗口(毫秒)', get: (v) => v.user.gift.mergeWindowMs, min: 100, max: 30000, step: 100 },
  { key: 'preloadTimeoutMs', label: '预加载超时(毫秒)', get: (v) => v.user.playback.preloadTimeoutMs, min: 1000, max: 60000, step: 500 },
  { key: 'overallTimeoutMs', label: '播放整体超时(毫秒)', get: (v) => v.user.playback.overallTimeoutMs, min: 5000, max: 600000, step: 500 },
  { key: 'ttlMs', label: '播放端租约时长(毫秒)', get: (v) => v.user.lease.ttlMs, min: 3000, max: 120000, step: 500 },
  { key: 'renewIntervalMs', label: '租约续租间隔(毫秒)', get: (v) => v.user.lease.renewIntervalMs, min: 500, max: 60000, step: 500 },
];

export function mountSettingsPanel(context: ControlContext): void {
  const box = document.getElementById('settings-fields') as HTMLDivElement;
  const save = document.getElementById('settings-save') as HTMLButtonElement;
  const versionNote = document.getElementById('settings-version') as HTMLElement;
  const note = document.getElementById('settings-note') as HTMLElement;
  const inputs = new Map<string, HTMLInputElement>();
  let view: SettingsView | null = null;

  for (const field of FIELDS) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(field.step);
    inputs.set(field.key, input);
    const label = el('label', { className: 'field' }, [el('span', { textContent: field.label }), input]);
    box.append(label);
  }

  async function refresh(): Promise<void> {
    const result = await context.request('/api/settings');
    if (!result.ok) {
      note.textContent = errorMessage(result.body, '设置读取失败');
      return;
    }
    view = result.body as SettingsView;
    for (const field of FIELDS) {
      const input = inputs.get(field.key);
      if (input) input.value = String(field.get(view));
    }
    versionNote.textContent = `配置版本 v${view.savedVersion}`;
    const env = view.envOverrides.length > 0 ? `环境覆盖:${view.envOverrides.join(', ')}(界面修改不生效)` : '';
    const restart = `需重启生效:${view.restartRequired.join(', ')}`;
    note.textContent = [env, restart].filter(Boolean).join(' | ');
  }

  save.addEventListener('click', async () => {
    if (!view) return;
    const number = (key: string, fallback: number): number => {
      const raw = inputs.get(key)?.value;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
    };
    const draft = {
      petId: view.user.petId,
      queue: {
        capacity: number('capacity', view.user.queue.capacity),
        chatTtlMs: number('chatTtlMs', view.user.queue.chatTtlMs),
        userCooldownMs: number('userCooldownMs', view.user.queue.userCooldownMs),
      },
      gift: { mergeWindowMs: number('mergeWindowMs', view.user.gift.mergeWindowMs) },
      playback: {
        preloadTimeoutMs: number('preloadTimeoutMs', view.user.playback.preloadTimeoutMs),
        overallTimeoutMs: number('overallTimeoutMs', view.user.playback.overallTimeoutMs),
        noRendererGraceMs: view.user.playback.noRendererGraceMs,
      },
      lease: {
        ttlMs: number('ttlMs', view.user.lease.ttlMs),
        renewIntervalMs: number('renewIntervalMs', view.user.lease.renewIntervalMs),
      },
    };
    const result = await apiFetch('/api/settings', context.credential, {
      method: 'PUT',
      body: JSON.stringify({ expectedVersion: view.savedVersion, settings: draft }),
    });
    if (result.ok) {
      const saved = result.body as { savedVersion: number };
      context.notify(`设置已保存(版本 v${saved.savedVersion}),下次调度生效`);
      await refresh();
    } else if (result.status === 409) {
      context.notify('版本冲突:设置已被其他会话修改,已刷新为最新值,请重试。', true);
      await refresh();
    } else {
      context.notify(errorMessage(result.body, '保存失败'), true);
    }
  });

  void refresh();
}
