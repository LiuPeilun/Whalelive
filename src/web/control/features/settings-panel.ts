import type { ControlContext } from '../main.js';
import { apiFetch } from '../../shared/ws-client.js';
import { errorMessage, el } from '../../shared/dom.js';
import type { SettingsView } from '../../../shared/settings.js';

// 设置面板:读取脱敏视图,编辑可热更新字段;保存带期望版本,冲突时提示刷新。
// P1 第二批:语音(TTS)区块——提供方选择、edge-tts 音色下拉与试听。

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

  // ---- 语音(TTS)区块:P1 第二批 ----
  const providerSelect = document.createElement('select');
  for (const [value, label] of [['edge-tts', 'edge-tts(真实人声)'], ['fixed-local', 'fixed-local(本地罐头音,离线可用)']] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    providerSelect.append(opt);
  }
  const voiceSelect = document.createElement('select');
  voiceSelect.style.flex = '1';
  const previewBtn = document.createElement('button');
  previewBtn.textContent = '试听';
  previewBtn.type = 'button';
  const previewRow = el('label', { className: 'field' }, [el('span', { textContent: '试听语音' }), previewBtn]);
  box.append(
    el('label', { className: 'field' }, [el('span', { textContent: '语音提供方' }), providerSelect]),
    el('label', { className: 'field' }, [el('span', { textContent: '音色(edge-tts)' }), voiceSelect]),
    previewRow,
  );

  /** 加载 edge-tts 音色列表(中文在前);失败时仅保留当前值并提示,不阻塞面板 */
  async function loadVoices(): Promise<void> {
    const current = voiceSelect.value || view?.user.tts.voice || '';
    voiceSelect.replaceChildren();
    const currentOpt = document.createElement('option');
    currentOpt.value = current;
    currentOpt.textContent = current === '' ? '未选择' : `${current}(当前)`;
    voiceSelect.append(currentOpt);
    try {
      const result = await apiFetch('/api/tts/voices', context.credential);
      if (!result.ok) throw new Error(errorMessage(result.body, '音色列表获取失败'));
      const list = (result.body as { voices: Array<{ shortName: string; gender: string }> }).voices;
      voiceSelect.replaceChildren();
      let hasCurrent = false;
      for (const v of list) {
        const opt = document.createElement('option');
        opt.value = v.shortName;
        opt.textContent = `${v.shortName}(${v.gender === 'Female' ? '女' : v.gender === 'Male' ? '男' : v.gender})`;
        if (v.shortName === current) hasCurrent = true;
        voiceSelect.append(opt);
      }
      if (current !== '' && !hasCurrent) {
        const opt = document.createElement('option');
        opt.value = current;
        opt.textContent = `${current}(当前)`;
        voiceSelect.append(opt);
      }
      voiceSelect.value = current;
    } catch {
      context.notify('音色列表获取失败(网络?),音色保持当前值,可直接保存', true);
    }
  }

  previewBtn.addEventListener('click', async () => {
    previewBtn.disabled = true;
    previewBtn.textContent = '合成中…';
    try {
      const text = '大家好,我是大肥鱼!欢迎来到直播间。';
      const voice = voiceSelect.value || undefined;
      const result = await apiFetch('/api/tts/preview', context.credential, {
        method: 'POST',
        body: JSON.stringify(voice !== undefined ? { text, voice } : { text }),
      });
      if (!result.ok) throw new Error(errorMessage(result.body, '试听失败'));
      const { audioUrl } = result.body as { audioUrl: string };
      await new Audio(audioUrl).play();
    } catch (err) {
      context.notify(`试听失败:${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      previewBtn.disabled = false;
      previewBtn.textContent = '试听';
    }
  });

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
    providerSelect.value = view.user.tts.provider;
    voiceSelect.value = view.user.tts.voice;
    if (voiceSelect.value !== view.user.tts.voice) {
      // 当前值不在选项中(列表未加载):插入占位项保证回填正确
      const opt = document.createElement('option');
      opt.value = view.user.tts.voice;
      opt.textContent = `${view.user.tts.voice}(当前)`;
      voiceSelect.prepend(opt);
      voiceSelect.value = view.user.tts.voice;
    }
    if (view.user.tts.provider === 'edge-tts' && voiceSelect.options.length <= 1) void loadVoices();
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
        takeoverSafetyMs: view.user.lease.takeoverSafetyMs,
      },
      tts: {
        provider: providerSelect.value as 'fixed-local' | 'edge-tts',
        voice: voiceSelect.value,
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
