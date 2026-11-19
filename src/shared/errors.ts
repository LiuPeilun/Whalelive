// 跨端稳定错误码与错误响应结构(AGENTS.md《文档基线与变更》冻结约定)。
// 服务端将外部提供方错误映射为这里的码,页面遇到未知码按通用错误展示。

export const ErrorCodes = {
  UNKNOWN: 'UNKNOWN',
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  AUTH_REJECTED: 'AUTH_REJECTED',
  SCOPE_DENIED: 'SCOPE_DENIED',
  AUTH_TIMEOUT: 'AUTH_TIMEOUT',
  PROTOCOL_VERSION_UNSUPPORTED: 'PROTOCOL_VERSION_UNSUPPORTED',
  ORIGIN_REJECTED: 'ORIGIN_REJECTED',
  HOST_REJECTED: 'HOST_REJECTED',
  NOT_FOUND: 'NOT_FOUND',
  ASSET_MISSING: 'ASSET_MISSING',
  NO_RENDERER: 'NO_RENDERER',
  RENDERER_LOST: 'RENDERER_LOST',
  LEASE_LOST: 'LEASE_LOST',
  AUDIO_LOAD_FAILED: 'AUDIO_LOAD_FAILED',
  AUDIO_START_REJECTED: 'AUDIO_START_REJECTED',
  AUDIO_PLAY_ERROR: 'AUDIO_PLAY_ERROR',
  PLAYBACK_TIMEOUT: 'PLAYBACK_TIMEOUT',
  STALE_SESSION: 'STALE_SESSION',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  QUEUE_FULL: 'QUEUE_FULL',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export type ApiError = {
  code: ErrorCode;
  message: string;
  stage?: string;
  traceId?: string;
};

const codeSet: ReadonlySet<string> = new Set(Object.values(ErrorCodes));

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && codeSet.has(value);
}

export function apiError(code: ErrorCode, message: string, stage?: string): ApiError {
  const err: ApiError = { code, message };
  if (stage !== undefined) err.stage = stage;
  return err;
}
