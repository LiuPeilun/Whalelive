import fs from 'node:fs';
import path from 'node:path';
import type { CharacterManifest, CharacterAction, CharacterView } from '../../../shared/character.js';
import { CANONICAL_ACTION_IDS } from '../../../shared/character.js';
import type { AppPaths } from '../../infrastructure/paths.js';
import { ensureDir } from '../../infrastructure/paths.js';
import type { Logger } from '../../infrastructure/logger.js';

// 角色清单、动作白名单与素材解析(PROJECT_STRUCTURE《模块职责》)。
// manifest 缺失时从 config/pet-defaults 落盘默认清单,便于新环境开箱即用;
// 素材文件按“清单相对路径 + 防目录穿越 + realpath 归属”解析,缺文件时标记不可用并回退待机。

export type ResolvedAction = {
  actionId: string;
  file: string;
  loop: boolean;
  available: boolean;
};

export type CharactersModule = {
  reload(): void;
  view(): CharacterView;
  petId(): string;
  /** 白名单查找:不在清单返回 null;在清单但文件缺失返回 available:false。 */
  resolveAction(actionId: string): ResolvedAction | null;
  /** 按 assetId(清单中的相对文件路径)解析媒体文件,含归属校验。 */
  resolveAsset(assetId: string): { file: string; mime: string; loop: boolean } | null;
  missingActions(): string[];
};

const MIME_BY_EXT: Record<string, string> = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.gif': 'image/gif',
};

function validateManifest(value: unknown, petId: string): CharacterManifest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.formatVersion !== 1 || v.petId !== petId || !Array.isArray(v.actions)) return null;
  const seen = new Set<string>();
  const actions: CharacterAction[] = [];
  for (const raw of v.actions) {
    if (typeof raw !== 'object' || raw === null) return null;
    const a = raw as Record<string, unknown>;
    if (typeof a.id !== 'string' || typeof a.file !== 'string' || a.id === '' || a.file === '') return null;
    if (seen.has(a.id)) return null;
    seen.add(a.id);
    actions.push({ id: a.id, file: a.file, loop: a.loop === true });
  }
  return {
    formatVersion: 1,
    petId,
    name: typeof v.name === 'string' ? v.name : petId,
    license: (typeof v.license === 'object' && v.license !== null ? v.license : { name: '未登记' }) as CharacterManifest['license'],
    actions,
  };
}

/** 相对路径防穿越:拒绝绝对路径、盘符与“..”段。 */
function safeRelative(file: string): string | null {
  if (file.includes('\\') || file.includes(':')) return null;
  if (file.split('/').some((seg) => seg === '..' || seg === '')) return null;
  return file;
}

export function createCharacters(deps: { paths: AppPaths; petId: string; logger: Logger }): CharactersModule {
  const { paths, logger } = deps;
  let manifest: CharacterManifest;
  let available = new Map<string, boolean>();
  const petRoot = paths.petDir(deps.petId);

  function provisionDefaultManifest(): boolean {
    const source = path.join(paths.versionedConfigDir, 'pet-defaults', 'manifest.json');
    if (!fs.existsSync(source)) return false;
    const target = path.join(petRoot, 'manifest.json');
    if (fs.existsSync(target)) return true;
    ensureDir(petRoot);
    fs.copyFileSync(source, target);
    logger.info('characters.manifest-provisioned', { petId: deps.petId, target });
    return true;
  }

  function load(): void {
    const manifestPath = path.join(petRoot, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      provisionDefaultManifest();
    }
    let raw: unknown = null;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      logger.error('characters.manifest-read-failed', { error: String(err) });
    }
    const parsed = validateManifest(raw, deps.petId);
    if (parsed === null) {
      // 清单不可用时退化为“仅知道动作 ID,全部不可用”,保持系统可启动。
      manifest = {
        formatVersion: 1,
        petId: deps.petId,
        name: deps.petId,
        license: { name: '未登记' },
        actions: CANONICAL_ACTION_IDS.map((id) => ({ id, file: `animations/${id}.webm` })),
      };
      logger.warn('characters.manifest-invalid-fallback', { petId: deps.petId });
    } else {
      manifest = parsed;
    }
    const next = new Map<string, boolean>();
    for (const action of manifest.actions) {
      const rel = safeRelative(action.file);
      if (rel === null) {
        next.set(action.id, false);
        continue;
      }
      next.set(action.id, checkFile(rel));
    }
    available = next;
    const missing = [...available.entries()].filter(([, ok]) => !ok).map(([id]) => id);
    logger.info('characters.loaded', { petId: deps.petId, actions: manifest.actions.length, missing: missing.join(',') || 'none' });
  }

  function checkFile(rel: string): boolean {
    try {
      const full = path.resolve(petRoot, rel);
      const realRoot = fs.realpathSync(petRoot);
      const realFull = fs.realpathSync(full);
      const ok = realFull === realRoot || realFull.startsWith(realRoot + path.sep);
      if (!ok) deps.logger.warn('characters.checkfile-reject', { rel, realRoot, realFull });
      return ok;
    } catch (err) {
      deps.logger.warn('characters.checkfile-error', { rel, petRoot, error: String(err) });
      return false;
    }
  }

  function resolveFile(rel: string): string | null {
    const safe = safeRelative(rel);
    if (safe === null) return null;
    const full = path.resolve(petRoot, safe);
    try {
      const realRoot = fs.realpathSync(petRoot);
      const realFull = fs.realpathSync(full);
      if (realFull !== realRoot && !realFull.startsWith(realRoot + path.sep)) return null;
      return realFull;
    } catch {
      return null;
    }
  }

  function mimeOf(file: string): string {
    return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  }

  load();

  return {
    reload: load,
    petId: () => deps.petId,
    view() {
      return {
        petId: manifest.petId,
        name: manifest.name,
        licenseName: manifest.license?.name ?? '未登记',
        actions: manifest.actions.map((a) => ({
          id: a.id,
          available: available.get(a.id) === true,
          loop: a.loop === true,
        })),
      };
    },
    resolveAction(actionId) {
      const action = manifest.actions.find((a) => a.id === actionId);
      if (!action) return null;
      return {
        actionId: action.id,
        file: action.file,
        loop: action.loop === true,
        available: available.get(action.id) === true,
      };
    },
    resolveAsset(assetId) {
      const action = manifest.actions.find((a) => a.file === assetId);
      if (!action) return null;
      const file = resolveFile(action.file);
      if (file === null) return null;
      return { file, mime: mimeOf(file), loop: action.loop === true };
    },
    missingActions() {
      return [...available.entries()].filter(([, ok]) => !ok).map(([id]) => id);
    },
  };
}
