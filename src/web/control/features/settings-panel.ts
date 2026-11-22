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
  { key: 'smallMaxYuan', label: '小额礼物上限(元)', get: (v) => v.user.gift.tiering.smallMaxYuan, min: 0, max: 10000, step: 0.5 },
  { key: 'largeMinYuan', label: '大额礼物下限(元)', get: (v) => v.user.gift.tiering.largeMinYuan, min: 0.01, max: 100000, step: 1 },
  { key: 'peakMergeCount', label: '高峰合并条数(待播小额达此数合并播报)', get: (v) => v.user.gift.tiering.peakMergeCount, min: 2, max: 100, step: 1 },
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

  // ---- 回复模型(LLM)区块:P1 第三批 ----
  const llmProviderSelect = document.createElement('select');
  for (const [value, label] of [['fixed-local', '固定回复(离线,零配置)'], ['deepseek', 'DeepSeek(需服务端配置密钥)']] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    llmProviderSelect.append(opt);
  }
  const llmStatus = document.createElement('span');
  llmStatus.className = 'muted';
  const previewText = document.createElement('input');
  previewText.type = 'text';
  previewText.value = '今天天气不错呀';
  previewText.style.flex = '1';
  const llmPreviewBtn = document.createElement('button');
  llmPreviewBtn.textContent = '生成回复';
  llmPreviewBtn.type = 'button';
  const previewOut = document.createElement('div');
  previewOut.className = 'muted mono';
  box.append(
    el('label', { className: 'field' }, [el('span', { textContent: '回复来源' }), llmProviderSelect]),
    el('label', { className: 'field' }, [el('span', { textContent: '配置状态' }), llmStatus]),
    el('label', { className: 'field' }, [el('span', { textContent: '回复预览' }), previewText, llmPreviewBtn]),
    previewOut,
  );

  /** 读取模型配置状态(脱敏)并显示;密钥是否配置由服务端判定。 */
  async function refreshLlmConfig(): Promise<void> {
    try {
      const result = await apiFetch('/api/llm/config', context.credential);
      if (!result.ok) throw new Error(errorMessage(result.body, '配置读取失败'));
      const cfg = result.body as { active: string; configured: boolean; model: string; thinking: boolean; fallbackReason?: string | null };
      const activeLabel = cfg.active === 'deepseek' ? 'DeepSeek' : '固定回复';
      // 选了 DeepSeek 却回退到固定回复时,明确显示原因,避免误以为模型可用(WT-P1-021)。
      const fallback = cfg.fallbackReason === 'DEEPSEEK_KEY_MISSING' ? ' | 回退原因:服务端未配置密钥' : '';
      llmStatus.textContent = `当前生效:${activeLabel} | 密钥:${cfg.configured ? '已配置' : '未配置'} | 模型:${cfg.model} | 思考:${cfg.thinking ? '开' : '关'}${fallback}`;
    } catch (err) {
      llmStatus.textContent = `配置状态读取失败:${err instanceof Error ? err.message : String(err)}`;
    }
  }

  llmPreviewBtn.addEventListener('click', async () => {
    const text = previewText.value.trim();
    if (text === '') {
      context.notify('请输入预览文本', true);
      return;
    }
    llmPreviewBtn.disabled = true;
    llmPreviewBtn.textContent = '生成中…';
    try {
      const result = await apiFetch('/api/llm/preview', context.credential, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      if (!result.ok) throw new Error(errorMessage(result.body, '生成失败'));
      const r = result.body as { say: string; action: string | null; emotion?: string; provider?: string; usage?: { totalTokens: number }; elapsedMs: number };
      previewOut.textContent = `${r.say}  [动作:${r.action ?? '无'} 情绪:${r.emotion ?? '-'} 来源:${r.provider ?? '-'} ${r.elapsedMs}ms token:${r.usage?.totalTokens ?? 0}]`;
    } catch (err) {
      context.notify(`回复预览失败:${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      llmPreviewBtn.disabled = false;
      llmPreviewBtn.textContent = '生成回复';
    }
  });

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
    llmProviderSelect.value = view.user.llm.provider;
    void refreshLlmConfig();
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
    // 金额类字段允许小数(如 0.5 元小额上限),不截断,保留两位内精度。
    const decimal = (key: string, fallback: number): number => {
      const raw = inputs.get(key)?.value;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : fallback;
    };
    const draft = {
      petId: view.user.petId,
      queue: {
        capacity: number('capacity', view.user.queue.capacity),
        chatTtlMs: number('chatTtlMs', view.user.queue.chatTtlMs),
        userCooldownMs: number('userCooldownMs', view.user.queue.userCooldownMs),
      },
      gift: {
        mergeWindowMs: number('mergeWindowMs', view.user.gift.mergeWindowMs),
        tiering: {
          smallMaxYuan: decimal('smallMaxYuan', view.user.gift.tiering.smallMaxYuan),
          largeMinYuan: decimal('largeMinYuan', view.user.gift.tiering.largeMinYuan),
          peakMergeCount: number('peakMergeCount', view.user.gift.tiering.peakMergeCount),
        },
      },
      // 问候与冷场(互动第三批):本批未提供界面控件,保存时透传当前值避免被丢弃
      greetings: { ...view.user.greetings },
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
      llm: {
        provider: llmProviderSelect.value as 'fixed-local' | 'deepseek',
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
