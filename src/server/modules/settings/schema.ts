import { isLlmProvider, isValidVoiceShortName, type UserSettings } from '../../../shared/settings.js';

// 服务端配置结构校验。手写校验保持零依赖,错误信息面向控制台展示。

export type SettingsValidation = { ok: true } | { ok: false; field: string; reason: string };

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function isNumber(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function validateQueue(v: unknown): SettingsValidation {
  if (!isRecord(v)) return { ok: false, field: 'queue', reason: '必须是对象' };
  if (!isInt(v.capacity, 1, 200)) return { ok: false, field: 'queue.capacity', reason: '需为 1-200 的整数' };
  if (!isInt(v.chatTtlMs, 1000, 600_000)) return { ok: false, field: 'queue.chatTtlMs', reason: '需为 1秒-10分钟 的毫秒数' };
  if (!isInt(v.userCooldownMs, 0, 600_000)) return { ok: false, field: 'queue.userCooldownMs', reason: '需为 0-10分钟 的毫秒数' };
  return { ok: true };
}

export function validateGift(v: unknown): SettingsValidation {
  if (!isRecord(v)) return { ok: false, field: 'gift', reason: '必须是对象' };
  if (!isInt(v.mergeWindowMs, 100, 30_000)) return { ok: false, field: 'gift.mergeWindowMs', reason: '需为 0.1-30秒 的毫秒数' };
  const tiering = v.tiering;
  if (!isRecord(tiering)) return { ok: false, field: 'gift.tiering', reason: '必须是对象' };
  if (!isNumber(tiering.smallMaxYuan, 0, 10_000)) return { ok: false, field: 'gift.tiering.smallMaxYuan', reason: '需为 0-10000 的金额(元)' };
  if (!isNumber(tiering.largeMinYuan, 0.01, 100_000)) return { ok: false, field: 'gift.tiering.largeMinYuan', reason: '需为 0.01-100000 的金额(元)' };
  if (!(tiering.largeMinYuan > tiering.smallMaxYuan)) return { ok: false, field: 'gift.tiering.largeMinYuan', reason: '需大于小额上限' };
  if (!isInt(tiering.peakMergeCount, 2, 100)) return { ok: false, field: 'gift.tiering.peakMergeCount', reason: '需为 2-100 的整数' };
  return { ok: true };
}

export function validateGreetings(v: unknown): SettingsValidation {
  if (!isRecord(v)) return { ok: false, field: 'greetings', reason: '必须是对象' };
  if (v.enabled !== true && v.enabled !== false) return { ok: false, field: 'greetings.enabled', reason: '需为布尔值' };
  if (!isInt(v.enterWindowMs, 1_000, 60_000)) return { ok: false, field: 'greetings.enterWindowMs', reason: '需为 1秒-60秒 的毫秒数' };
  if (!isInt(v.maxNamedCount, 0, 10)) return { ok: false, field: 'greetings.maxNamedCount', reason: '需为 0-10 的整数' };
  if (!isInt(v.allRoomIntervalMs, 0, 600_000)) return { ok: false, field: 'greetings.allRoomIntervalMs', reason: '需为 0-10分钟 的毫秒数' };
  if (!isInt(v.coldIdleMs, 30_000, 900_000)) return { ok: false, field: 'greetings.coldIdleMs', reason: '需为 30秒-15分钟 的毫秒数' };
  if (!isInt(v.coldIntervalMs, 0, 1_800_000)) return { ok: false, field: 'greetings.coldIntervalMs', reason: '需为 0-30分钟 的毫秒数' };
  return { ok: true };
}

export function validatePlayback(v: unknown): SettingsValidation {
  if (!isRecord(v)) return { ok: false, field: 'playback', reason: '必须是对象' };
  if (!isInt(v.preloadTimeoutMs, 1000, 60_000)) return { ok: false, field: 'playback.preloadTimeoutMs', reason: '需为 1-60秒 的毫秒数' };
  if (!isInt(v.overallTimeoutMs, 5_000, 600_000)) return { ok: false, field: 'playback.overallTimeoutMs', reason: '需为 5秒-10分钟 的毫秒数' };
  if (!isInt(v.noRendererGraceMs, 0, 30_000)) return { ok: false, field: 'playback.noRendererGraceMs', reason: '需为 0-30秒 的毫秒数' };
  if (typeof v.preloadTimeoutMs === 'number' && typeof v.overallTimeoutMs === 'number' && v.preloadTimeoutMs >= v.overallTimeoutMs) {
    return { ok: false, field: 'playback.preloadTimeoutMs', reason: '预加载超时应小于整体超时' };
  }
  return { ok: true };
}

export function validateLease(v: unknown): SettingsValidation {
  if (!isRecord(v)) return { ok: false, field: 'lease', reason: '必须是对象' };
  if (!isInt(v.ttlMs, 3_000, 120_000)) return { ok: false, field: 'lease.ttlMs', reason: '需为 3秒-2分钟 的毫秒数' };
  if (!isInt(v.renewIntervalMs, 500, 60_000)) return { ok: false, field: 'lease.renewIntervalMs', reason: '需为 0.5-60秒 的毫秒数' };
  if (!isInt(v.takeoverSafetyMs, 0, 10_000)) return { ok: false, field: 'lease.takeoverSafetyMs', reason: '需为 0-10秒 的毫秒数' };
  if (typeof v.ttlMs === 'number' && typeof v.renewIntervalMs === 'number' && v.renewIntervalMs * 2 > v.ttlMs) {
    return { ok: false, field: 'lease.renewIntervalMs', reason: '续租间隔需小于租约时长的 1/2' };
  }
  return { ok: true };
}

/** 语音合成配置(P1 第二批):提供方枚举 + 音色短名(与 TTS 边界统一契约,WT-P1-018:
 * 覆盖 zh-CN-liaoning-XiaobeiNeural 等带地区变体的真实短名)。 */
export function validateTts(v: unknown): SettingsValidation {
  if (!isRecord(v)) return { ok: false, field: 'tts', reason: '必须是对象' };
  if (v.provider !== 'fixed-local' && v.provider !== 'edge-tts') {
    return { ok: false, field: 'tts.provider', reason: '需为 fixed-local 或 edge-tts' };
  }
  if (!isValidVoiceShortName(v.voice)) {
    return { ok: false, field: 'tts.voice', reason: '需为形如 zh-CN-XiaoxiaoNeural 或 zh-CN-liaoning-XiaobeiNeural 的音色短名' };
  }
  if (v.pitch !== undefined && v.pitch !== '' && (typeof v.pitch !== 'string' || !/^[+-]\d{1,4}Hz$/.test(v.pitch))) {
    return { ok: false, field: 'tts.pitch', reason: '需为形如 +15Hz / -20Hz 的音调微调,或空串(不调)' };
  }
  return { ok: true };
}

/** 回复提供方(P1 第三批):deepseek 需服务端配置密钥,界面仅选择来源。 */
export function validateLlm(v: unknown): SettingsValidation {
  if (!isRecord(v)) return { ok: false, field: 'llm', reason: '必须是对象' };
  if (!isLlmProvider(v.provider)) {
    return { ok: false, field: 'llm.provider', reason: '需为 fixed-local 或 deepseek' };
  }
  return { ok: true };
}

/** 唱歌管线(P3):点歌预处理参数。 */
export function validateSinging(v: unknown): SettingsValidation {
  if (!isRecord(v)) return { ok: false, field: 'singing', reason: '必须是对象' };
  if (typeof v.enabled !== 'boolean') {
    return { ok: false, field: 'singing.enabled', reason: '需为布尔' };
  }
  const num = (key: string, min: number, max: number): SettingsValidation | null => {
    const n = v[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
      return { ok: false, field: `singing.${key}`, reason: `需为 ${min}-${max} 的数值` };
    }
    return null;
  };
  // WT-P3-006:移调边界必须整数(小数会让 Python 端 int() 转换抛错);
  // clipSeconds 上限对齐后端安全时长(该 RVC 包 >24s 换声输入崩溃)。
  const numInt = (key: string, min: number, max: number): SettingsValidation | null => {
    const fail = num(key, min, max);
    if (fail) return fail;
    if (!Number.isInteger(v[key])) {
      return { ok: false, field: `singing.${key}`, reason: '需为整数' };
    }
    return null;
  };
  for (const c of [
    num('clipStartRatio', 0, 0.9),
    numInt('clipSeconds', 5, 24),
    numInt('targetHz', 100, 600),
    numInt('keyMin', -12, 12),
    numInt('keyMax', 6, 30),
    num('indexRate', 0, 1),
    num('protect', 0, 0.9),
    num('rmsMixRate', 0, 1),
  ]) {
    if (c) return c;
  }
  if (typeof v.keyMin !== 'number' || typeof v.keyMax !== 'number' || v.keyMin > v.keyMax) {
    return { ok: false, field: 'singing.keyMin', reason: 'keyMin 不得大于 keyMax' };
  }
  if (typeof v.actionId !== 'string' || v.actionId === '') {
    return { ok: false, field: 'singing.actionId', reason: '需为非空动作 id' };
  }
  return { ok: true };
}

export function validateUserSettings(v: unknown): SettingsValidation {
  if (!isRecord(v)) return { ok: false, field: 'settings', reason: '必须是对象' };
  if (typeof v.petId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v.petId)) {
    return { ok: false, field: 'petId', reason: '需为 1-64 位的字母/数字/下划线/短横线' };
  }
  const checks = [
    validateQueue(v.queue),
    validateGift(v.gift),
    validateGreetings(v.greetings),
    validatePlayback(v.playback),
    validateLease(v.lease),
    validateTts(v.tts),
    validateLlm(v.llm),
    validateSinging(v.singing),
  ];
  for (const c of checks) if (!c.ok) return c;
  return { ok: true };
}
