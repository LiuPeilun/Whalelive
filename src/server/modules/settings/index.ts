import fs from 'node:fs';
import path from 'node:path';
import type { UserSettings, EffectiveSettings, SettingsView, SettingsUpdateRequest } from '../../../shared/settings.js';
import { ErrorCodes } from '../../../shared/errors.js';
import type { AppPaths } from '../../infrastructure/paths.js';
import { ensureDir } from '../../infrastructure/paths.js';
import type { Logger } from '../../infrastructure/logger.js';
import { validateUserSettings } from './schema.js';

// 配置加载、校验、原子保存与生效版本(PROJECT_STRUCTURE《配置覆盖与保存》)。
// 生效顺序:config/defaults.json → data/config/settings.json → .env.local / 进程环境。
// 保存先写临时文件再替换;更新带期望版本,过期返回 VERSION_CONFLICT。

type DefaultsFile = {
  formatVersion: number;
  petId: string;
  queue: UserSettings['queue'];
  gift: UserSettings['gift'];
  playback: UserSettings['playback'];
  lease: UserSettings['lease'];
  tts: UserSettings['tts'];
  llm: UserSettings['llm'];
  auth: { timeoutMs: number };
  generation?: { llmTimeoutMs: number; ttsTimeoutMs: number };
};

type UserFile = {
  formatVersion: number;
  savedVersion: number;
  settings: UserSettings;
};

export type SettingsUpdateResult =
  | { ok: true; savedVersion: number; settings: UserSettings }
  | { ok: false; code: typeof ErrorCodes.VERSION_CONFLICT | typeof ErrorCodes.VALIDATION_FAILED; detail: string };

export type SettingsModule = {
  effective(): EffectiveSettings;
  view(): SettingsView;
  update(req: SettingsUpdateRequest): SettingsUpdateResult;
  onVersionChange(cb: (savedVersion: number) => void): () => void;
};

export function createSettings(deps: { paths: AppPaths; env: Record<string, string | undefined>; logger: Logger }): SettingsModule {
  const { paths, env, logger } = deps;

  const defaultsPath = path.join(paths.versionedConfigDir, 'defaults.json');
  const defaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf8')) as DefaultsFile;

  let userFile: UserFile | null = readUserFile();
  const envOverrides: string[] = [];
  const listeners = new Set<(v: number) => void>();

  function readUserFile(): UserFile | null {
    try {
      const raw = fs.readFileSync(paths.userSettingsFile, 'utf8');
      const parsed = JSON.parse(raw) as UserFile;
      if (parsed.formatVersion !== 1 || typeof parsed.savedVersion !== 'number') {
        logger.warn('settings.user-file-invalid', { file: paths.userSettingsFile });
        return null;
      }
      return parsed;
    } catch {
      return null; // 无用户覆盖文件属正常情况
    }
  }

  function envNumber(name: string): number | undefined {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  function baseUser(): UserSettings {
    const user = userFile?.settings;
    return {
      petId: user?.petId ?? defaults.petId,
      queue: { ...defaults.queue, ...user?.queue },
      gift: { ...defaults.gift, ...user?.gift },
      playback: { ...defaults.playback, ...user?.playback },
      lease: { ...defaults.lease, ...user?.lease },
      tts: { ...defaults.tts, ...user?.tts },
      llm: { ...defaults.llm, ...user?.llm },
    };
  }

  function effective(): EffectiveSettings {
    const envPort = envNumber('PORT');
    const envHost = env.HOST?.trim();
    const envPlatform = env.PLATFORM?.trim();
    const envPet = env.PET_ID?.trim();
    if (envPort !== undefined && !envOverrides.includes('server.port')) envOverrides.push('server.port');
    if (envHost && envHost !== '127.0.0.1' && !envOverrides.includes('server.host')) envOverrides.push('server.host');
    if (envPlatform && !envOverrides.includes('platform')) envOverrides.push('platform');
    if (envPet && !envOverrides.includes('petId')) envOverrides.push('petId');
    const user = baseUser();
    return {
      petId: envPet || user.petId,
      queue: user.queue,
      gift: user.gift,
      playback: user.playback,
      lease: user.lease,
      tts: user.tts,
      llm: user.llm,
      server: { host: envHost || '127.0.0.1', port: envPort ?? 3210 },
      platform: envPlatform || 'mock',
      auth: { timeoutMs: defaults.auth.timeoutMs },
      generation: {
        llmTimeoutMs: defaults.generation?.llmTimeoutMs ?? 8_000,
        ttsTimeoutMs: defaults.generation?.ttsTimeoutMs ?? 10_000,
      },
    };
  }

  function view(): SettingsView {
    return {
      savedVersion: userFile?.savedVersion ?? 0,
      user: baseUser(),
      effective: effective(),
      envOverrides: [...envOverrides],
      restartRequired: ['server.host', 'server.port', 'platform'],
    };
  }

  /** 原子落盘:临时文件 + rename;同步执行,保证 update 返回后文件已就绪。 */
  function atomicWriteSync(next: UserFile): void {
    ensureDir(paths.userConfigDir);
    const tmp = path.join(paths.userConfigDir, `.settings-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, paths.userSettingsFile);
  }

  function update(req: SettingsUpdateRequest): SettingsUpdateResult {
    const currentVersion = userFile?.savedVersion ?? 0;
    if (req.expectedVersion !== currentVersion) {
      return { ok: false, code: ErrorCodes.VERSION_CONFLICT, detail: `期望版本 ${req.expectedVersion},当前版本 ${currentVersion},请刷新后重试` };
    }
    const check = validateUserSettings(req.settings);
    if (!check.ok) {
      return { ok: false, code: ErrorCodes.VALIDATION_FAILED, detail: `${check.field}: ${check.reason}` };
    }
    const next: UserFile = { formatVersion: 1, savedVersion: currentVersion + 1, settings: req.settings };
    // 先校验完整新配置,再原子落盘;落盘异常时保持旧内存态并回滚版本。
    try {
      atomicWriteSync(next);
    } catch (err) {
      logger.error('settings.save-failed', { error: String(err) });
      return { ok: false, code: ErrorCodes.VALIDATION_FAILED, detail: `配置写入失败:${String(err)}` };
    }
    userFile = next;
    logger.info('settings.updated', { savedVersion: next.savedVersion });
    for (const cb of listeners) cb(next.savedVersion);
    return { ok: true, savedVersion: next.savedVersion, settings: req.settings };
  }

  return {
    effective,
    view,
    update,
    onVersionChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
