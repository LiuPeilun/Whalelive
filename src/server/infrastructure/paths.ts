import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 所有本地路径由本文件统一解析(PROJECT_STRUCTURE《路径解析》)。
// 项目根按“同时存在 package.json 与 AGENTS.md”向上查找,与进程工作目录无关,
// 因此从项目外目录启动也能定位同一配置与角色包。

export type AppPaths = {
  projectRoot: string;
  versionedConfigDir: string;
  dataDir: string;
  userConfigDir: string;
  petsDir: string;
  petDir(petId: string): string;
  audioCacheDir: string;
  logsDir: string;
  dbDir: string;
  accessFile: string;
  userSettingsFile: string;
};

function findProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'AGENTS.md'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`未找到项目根(缺少 package.json / AGENTS.md):从 ${startDir} 向上查找失败`);
    }
    dir = parent;
  }
}

export function createPaths(envDataDir: string | undefined): AppPaths {
  const projectRoot = findProjectRoot(path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..'));
  const dataDir =
    envDataDir && envDataDir.trim() !== ''
      ? path.resolve(projectRoot, envDataDir.trim())
      : path.join(projectRoot, 'data');
  return {
    projectRoot,
    versionedConfigDir: path.join(projectRoot, 'config'),
    dataDir,
    userConfigDir: path.join(dataDir, 'config'),
    petsDir: path.join(dataDir, 'pets'),
    petDir(petId: string) {
      return path.join(dataDir, 'pets', petId);
    },
    audioCacheDir: path.join(dataDir, 'cache', 'audio'),
    logsDir: path.join(dataDir, 'logs'),
    dbDir: path.join(dataDir, 'db'),
    accessFile: path.join(dataDir, 'access.json'),
    userSettingsFile: path.join(dataDir, 'config', 'settings.json'),
  };
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
