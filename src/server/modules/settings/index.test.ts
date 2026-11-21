import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createSettings } from './index.js';
import type { AppPaths } from '../../infrastructure/paths.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { UserSettings } from '../../../shared/settings.js';

// 验证配置原子保存与版本冲突(PROJECT_STRUCTURE《配置覆盖与保存》)。
// 用户覆盖文件写入临时目录,避免污染真实 data/。

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whaletalk-settings-'));
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => ({ ...silentLogger, child: () => silentLogger }),
};

function makePaths(): AppPaths {
  // 测试位于 src/server/modules/settings/ → 项目根需向上 4 级;每个用例独立临时目录
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const dir = fs.mkdtempSync(path.join(tmpDir, 'case-'));
  return {
    projectRoot: root,
    versionedConfigDir: path.join(root, 'config'),
    dataDir: dir,
    userConfigDir: path.join(dir, 'config'),
    petsDir: dir,
    petDir: () => dir,
    audioCacheDir: dir,
    logsDir: dir,
    dbDir: dir,
    accessFile: path.join(dir, 'access.json'),
    userSettingsFile: path.join(dir, 'config', 'settings.json'),
  };
}

function validSettings(petId = 'main'): UserSettings {
  return {
    petId,
    queue: { capacity: 20, chatTtlMs: 30_000, userCooldownMs: 10_000 },
    gift: { mergeWindowMs: 2_000, tiering: { smallMaxYuan: 1, largeMinYuan: 10, peakMergeCount: 6 } },
    playback: { preloadTimeoutMs: 8_000, overallTimeoutMs: 120_000, noRendererGraceMs: 3_000 },
    lease: { ttlMs: 15_000, renewIntervalMs: 5_000, takeoverSafetyMs: 800 },
    tts: { provider: 'fixed-local', voice: 'zh-CN-XiaoxiaoNeural' },
    llm: { provider: 'fixed-local' },
  };
}

describe('settings 分层配置与原子保存', () => {
  it('默认值生效,环境变量覆盖端口与平台', () => {
    const settings = createSettings({ paths: makePaths(), env: { PORT: '4000', PLATFORM: 'mock' }, logger: silentLogger });
    const eff = settings.effective();
    expect(eff.server.port).toBe(4000);
    expect(eff.queue.capacity).toBe(20);
    expect(settings.view().envOverrides).toContain('server.port');
  });

  it('更新成功:版本 +1,文件落盘,重启后沿用', () => {
    const paths = makePaths();
    const settings = createSettings({ paths, env: {}, logger: silentLogger });
    const result = settings.update({ expectedVersion: 0, settings: validSettings() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedVersion).toBe(1);
    const raw = JSON.parse(fs.readFileSync(paths.userSettingsFile, 'utf8')) as { savedVersion: number };
    expect(raw.savedVersion).toBe(1);
    // 模拟重启:新实例读到同一用户覆盖
    const reopened = createSettings({ paths, env: {}, logger: silentLogger });
    expect(reopened.view().savedVersion).toBe(1);
    expect(reopened.effective().queue.capacity).toBe(20);
  });

  it('版本冲突:期望版本过期返回 VERSION_CONFLICT', () => {
    const settings = createSettings({ paths: makePaths(), env: {}, logger: silentLogger });
    settings.update({ expectedVersion: 0, settings: validSettings() });
    const stale = settings.update({ expectedVersion: 0, settings: validSettings() }); // 仍是旧版本号
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('VERSION_CONFLICT');
  });

  it('非法配置被校验拦截,不落盘', () => {
    const paths = makePaths();
    const settings = createSettings({ paths, env: {}, logger: silentLogger });
    const bad = validSettings();
    bad.queue.capacity = 9999;
    const rejected = settings.update({ expectedVersion: 0, settings: bad });
    expect(rejected.ok).toBe(false);
    expect(fs.existsSync(paths.userSettingsFile)).toBe(false);
  });
});
