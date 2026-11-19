import { isValidVoiceShortName, type UserSettings } from '../../../shared/settings.js';

// 服务端配置结构校验。手写校验保持零依赖,错误信息面向控制台展示。

export type SettingsValidation = { ok: true } | { ok: false; field: string; reason: string };

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
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
    validatePlayback(v.playback),
    validateLease(v.lease),
    validateTts(v.tts),
  ];
  for (const c of checks) if (!c.ok) return c;
  return { ok: true };
}
