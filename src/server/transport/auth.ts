import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCodes } from '../../shared/errors.js';
import type { ClientRole } from '../../shared/protocol.js';
import type { AppPaths } from '../infrastructure/paths.js';
import { ensureDir } from '../infrastructure/paths.js';
import type { Logger } from '../infrastructure/logger.js';

// 本机作用域凭据与 Origin/回环兼容策略(PROJECT_STRUCTURE《P0 连接注册与权限》)。
// - 首次启动生成 control / playback 双凭据,存 data/access.json;普通重启沿用,显式重置撤销。
// - WS 升级:Host 必须合法;Origin 显式非法或 "null" 拒绝;Origin 缺失时仅放行回环对端进入待认证。
// - HTTP 控制与设置接口复用同一凭据(Bearer),媒体接口按本机只读策略单独检查。

export type AccessCredentials = { control: string; playback: string; createdAt: string };

export type UpgradeCheck = { ok: true } | { ok: false; code: typeof ErrorCodes.HOST_REJECTED | typeof ErrorCodes.ORIGIN_REJECTED };

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function digest(token: string): Buffer {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

export function createAccessControl(deps: { paths: AppPaths; logger: Logger; port(): number }) {
  let credentials: AccessCredentials | null = null;

  function ensure(opts: { reset?: boolean } = {}): AccessCredentials {
    if (credentials && !opts.reset) return credentials;
    let loaded: AccessCredentials | null = null;
    try {
      const raw = JSON.parse(fs.readFileSync(deps.paths.accessFile, 'utf8')) as AccessCredentials;
      if (typeof raw.control === 'string' && typeof raw.playback === 'string' && raw.control.length >= 16 && raw.playback.length >= 16) {
        loaded = raw;
      }
    } catch {
      /* 首次启动无文件 */
    }
    if (opts.reset || loaded === null) {
      loaded = {
        control: crypto.randomBytes(24).toString('base64url'),
        playback: crypto.randomBytes(24).toString('base64url'),
        createdAt: new Date().toISOString(),
      };
      ensureDir(path.dirname(deps.paths.accessFile));
      const tmp = `${deps.paths.accessFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(loaded, null, 2), 'utf8');
      fs.renameSync(tmp, deps.paths.accessFile);
      deps.logger.info('access.credentials-generated', { reset: opts.reset === true, file: deps.paths.accessFile });
    }
    credentials = loaded;
    return credentials;
  }

  /** 常时比较:双方 sha256 后 timingSafeEqual,避免时序侧信道。凭据必须是非空字符串。 */
  function verify(credential: string, scope: ClientRole): boolean {
    if (!credentials) return false;
    if (typeof credential !== 'string' || credential.length === 0) return false;
    const expected = scope === 'control' ? credentials.control : credentials.playback;
    return crypto.timingSafeEqual(digest(credential), digest(expected));
  }

  function allowedHosts(): Set<string> {
    const port = deps.port();
    return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  }

  function allowedOrigins(): Set<string> {
    const port = deps.port();
    return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  }

  /** HTTP Authorization 头 → 命中的角色;未命中返回 null。 */
  function httpRole(authorization: unknown): ClientRole | null {
    if (typeof authorization !== 'string') return null;
    const match = /^Bearer\s+(.+)$/.exec(authorization);
    if (!match) return null;
    const token = match[1] ?? '';
    if (verify(token, 'control')) return 'control';
    if (verify(token, 'playback')) return 'playback';
    return null;
  }

  /** 控制类 HTTP 接口:要求 control 凭据;Origin 存在时做同源校验。 */
  function checkControlRequest(headers: { authorization?: unknown; origin?: unknown }): { ok: true } | { ok: false; code: 'HOST_REJECTED' | 'ORIGIN_REJECTED' | 'AUTH_REJECTED' } {
    if (typeof headers.origin === 'string' && headers.origin !== '' && !allowedOrigins().has(headers.origin) && headers.origin !== 'null') {
      return { ok: false, code: ErrorCodes.ORIGIN_REJECTED };
    }
    if (httpRole(headers.authorization) !== 'control') {
      return { ok: false, code: ErrorCodes.AUTH_REJECTED };
    }
    return { ok: true };
  }

  /** 业务 WS 升级前检查:Host 必须合法;Origin 显式非法拒绝;缺失时仅回环放行到待认证。 */
  function checkUpgrade(headers: { host?: unknown; origin?: unknown }, remoteAddress: string | undefined): UpgradeCheck {
    const host = typeof headers.host === 'string' ? headers.host.toLowerCase() : '';
    if (!allowedHosts().has(host)) {
      return { ok: false, code: ErrorCodes.HOST_REJECTED };
    }
    if (typeof headers.origin === 'string' && headers.origin !== '') {
      if (headers.origin === 'null' || !allowedOrigins().has(headers.origin)) {
        return { ok: false, code: ErrorCodes.ORIGIN_REJECTED };
      }
      return { ok: true };
    }
    // Origin 缺失(OBS/CEF 等非标准浏览器客户端):仅回环对端允许进入待认证,凭据仍是硬门槛。
    if (remoteAddress === undefined || !LOOPBACK_ADDRESSES.has(remoteAddress)) {
      return { ok: false, code: ErrorCodes.ORIGIN_REJECTED };
    }
    return { ok: true };
  }

  /** 媒体本机匿名只读:回环 + 合法 Host,Origin 不作要求。 */
  function checkMediaRequest(headers: { host?: unknown }, remoteAddress: string | undefined): boolean {
    const host = typeof headers.host === 'string' ? headers.host.toLowerCase() : '';
    if (!allowedHosts().has(host)) return false;
    return remoteAddress !== undefined && LOOPBACK_ADDRESSES.has(remoteAddress);
  }

  function controlUrl(): string {
    const c = credentials ?? ensure();
    const port = deps.port();
    return `http://127.0.0.1:${port}/control#${c.control}`;
  }

  function overlayUrl(): string {
    const c = credentials ?? ensure();
    const port = deps.port();
    // ?audio=1:声明音频归属用途(OBS 用此链接;普通预览开不带参数的 /overlay 即静音,WT-P1-005)
    return `http://127.0.0.1:${port}/overlay?audio=1#${c.playback}`;
  }

  return { ensure, verify, httpRole, checkControlRequest, checkUpgrade, checkMediaRequest, controlUrl, overlayUrl };
}
