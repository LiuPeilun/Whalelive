import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCodes, apiError } from '../../../shared/errors.js';
import type { StateSnapshot } from '../../../shared/protocol.js';
import { isValidVoiceShortName, type SettingsUpdateRequest } from '../../../shared/settings.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { CharactersModule } from '../../modules/characters/index.js';
import { resolveAdoptableAction } from '../../modules/interaction/index.js';
import type { InteractionModule } from '../../modules/interaction/index.js';
import type { SettingsModule } from '../../modules/settings/index.js';
import type { MockEventInput } from '../../integrations/platforms/mock.js';
import type { EdgeTtsSpeech } from '../../integrations/tts/edge-tts.js';
import type { ReplyProvider } from '../../modules/interaction/providers.js';
import type { ReplyRouter } from '../../integrations/llm/reply-router.js';
import { LlmPreviewError } from '../../integrations/llm/reply-router.js';
import type { SingingModule } from '../../modules/singing/index.js';
import type { createAccessControl } from '../auth.js';

// 路由、请求校验、响应与资源传输(PROJECT_STRUCTURE《接口与页面路径》)。
// 处理器只做输入校验、凭据检查、调用与错误映射,业务规则在业务模块。

export type HttpDeps = {
  runId: string;
  startedAt: number;
  settings: SettingsModule;
  access: ReturnType<typeof createAccessControl>;
  interaction: InteractionModule;
  characters: CharactersModule;
  stateSnapshot(): StateSnapshot;
  submitMock(input: MockEventInput): { eventId: string; ingest: string; enqueue: { accepted: boolean; reason: string | null } | null };
  overlayUrl(): string;
  audioCache: { resolve(audioId: string): { file: string; mime: string } | null };
  /** edge-tts 适配器(音色列表与试听;当前生效 provider 由设置决定,路由内部不做委托) */
  edgeTts: Pick<EdgeTtsSpeech, 'voices'>;
  /** 试听合成:按当前(或覆盖)音色合成一段文本,返回音频地址;失败抛错由路由映射 */
  ttsPreview(input: { text: string; voice?: string }): Promise<{ audioUrl: string } | null>;
  /** P1 第三批:回复提供方(用于预览与配置状态),不入队、不播放。 */
  llm: Pick<ReplyRouter, 'generateStrict' | 'diagnose'> & {
    active(): 'fixed-local' | 'deepseek';
    configured(): boolean;
    model: string;
    baseUrl: string;
    thinking: boolean;
  };
  /** 点歌面板只读快照(P3 增强)。 */
  singing: Pick<SingingModule, 'jobsView'>;
  logger: Logger;
};

function guardControl(deps: HttpDeps, request: FastifyRequest, reply: FastifyReply): boolean {
  const check = deps.access.checkControlRequest(request.headers);
  if (!check.ok) {
    reply.code(check.code === ErrorCodes.ORIGIN_REJECTED ? 403 : 401).send(apiError(check.code, '控制接口需要有效的控制台凭据', 'http'));
    return false;
  }
  return true;
}

function sendTtsError(reply: FastifyReply, err: unknown, action: string): FastifyReply {
  const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
  return reply.code(timedOut ? 504 : 502).send(apiError(
    timedOut ? ErrorCodes.TTS_TIMEOUT : ErrorCodes.TTS_UNAVAILABLE,
    `${action}${timedOut ? '超时' : '失败'}`,
    'tts',
  ));
}

function sendLlmError(reply: FastifyReply, err: unknown): FastifyReply {
  // 预览专用诊断错误(WT-P1-021):区分未配置、超时与上游故障,返回对应错误码。
  if (err instanceof LlmPreviewError) {
    const code = err.reason === 'TIMEOUT' ? ErrorCodes.LLM_TIMEOUT : ErrorCodes.LLM_UNAVAILABLE;
    const status = err.reason === 'TIMEOUT' ? 504 : 502;
    return reply.code(status).send(apiError(code, err.message, 'llm'));
  }
  const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
  return reply.code(timedOut ? 504 : 502).send(apiError(
    timedOut ? ErrorCodes.LLM_TIMEOUT : ErrorCodes.LLM_UNAVAILABLE,
    `回复预览${timedOut ? '超时' : '失败'}:${err instanceof Error ? err.message : String(err)}`,
    'llm',
  ));
}

function serveFile(request: FastifyRequest, reply: FastifyReply, file: string, mime: string, method: 'GET' | 'HEAD'): void {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    reply.code(404).send(apiError(ErrorCodes.NOT_FOUND, '资源不存在或不可用', 'media'));
    return;
  }
  let start = 0;
  let end = size - 1;
  let status: 200 | 206 = 200;
  let contentRange: string | undefined;
  const range = request.headers.range;
  if (typeof range === 'string') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    const rejectRange = (message: string): void => {
      reply.code(416).header('content-range', `bytes */${size}`).send(apiError(ErrorCodes.BAD_REQUEST, message, 'media'));
    };
    if (!match) {
      rejectRange('Range 请求格式不受支持');
      return;
    }
    const rawStart = match[1] ?? '';
    const rawEnd = match[2] ?? '';
    if (rawStart === '' && rawEnd === '') {
      rejectRange('Range 为空');
      return;
    }
    if (rawStart === '') {
      // 后缀范围:bytes=-N
      const suffix = Math.min(Number(rawEnd), size);
      start = size - suffix;
      end = size - 1;
    } else {
      start = Number(rawStart);
      end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
      rejectRange('Range 超出资源范围');
      return;
    }
    status = 206;
    contentRange = `bytes ${start}-${end}/${size}`;
  }
  // 媒体流经 hijack 直写原始响应,精确控制状态码与 Range 头。
  reply.hijack();
  const raw = reply.raw;
  const headers: Record<string, string> = {
    'content-type': mime,
    'content-length': String(end - start + 1),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  if (contentRange !== undefined) headers['content-range'] = contentRange;
  raw.writeHead(status, headers);
  if (method === 'HEAD') {
    raw.end();
    return;
  }
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => raw.destroy());
  stream.pipe(raw);
}

export function registerHttpRoutes(fastify: FastifyInstance, deps: HttpDeps): void {
  fastify.get('/api/health', async () => ({
    ok: true,
    app: 'whaletalk',
    phase: 'P0',
    runId: deps.runId,
    uptimeMs: Date.now() - deps.startedAt,
  }));

  fastify.get('/api/state', async (request, reply) => {
    if (!guardControl(deps, request, reply)) return reply;
    return deps.stateSnapshot();
  });

  fastify.post('/api/mock/events', async (request, reply) => {
    if (!guardControl(deps, request, reply)) return reply;
    const body = request.body as Partial<MockEventInput> | undefined;
    if (!body || typeof body.type !== 'string' || !['chat', 'gift', 'guard', 'superchat', 'enter', 'like', 'follow', 'share'].includes(body.type)) {
      reply.code(400).send(apiError(ErrorCodes.VALIDATION_FAILED, 'type 需为 chat / gift / guard / superchat / enter / like / follow / share', 'mock'));
      return reply;
    }
    const result = deps.submitMock(body as MockEventInput);
    return { eventId: result.eventId, ingest: result.ingest, enqueue: result.enqueue };
  });

  // P1 第二批:edge-tts 音色列表与试听(控制台凭据;列表中文在前,适配器缓存 10 分钟)
  fastify.get('/api/tts/voices', async (request, reply) => {
    if (!guardControl(deps, request, reply)) return reply;
    try {
      return { voices: await deps.edgeTts.voices() };
    } catch (err) {
      deps.logger.warn('http.tts-voices-failed', { error: String(err) });
      return sendTtsError(reply, err, '音色列表获取');
    }
  });

  fastify.post('/api/tts/preview', async (request, reply) => {
    if (!guardControl(deps, request, reply)) return reply;
    const body = request.body as { text?: unknown; voice?: unknown } | undefined;
    const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 120) : '';
    if (text === '') {
      reply.code(400).send(apiError(ErrorCodes.VALIDATION_FAILED, 'text 需为 1-120 字的文本', 'tts'));
      return reply;
    }
    const voice = body?.voice === '' ? undefined : body?.voice;
    if (voice !== undefined && !isValidVoiceShortName(voice)) {
      reply.code(400).send(apiError(ErrorCodes.VALIDATION_FAILED, 'voice 需为合法的音色短名', 'tts'));
      return reply;
    }
    try {
      const result = await deps.ttsPreview(voice !== undefined ? { text, voice } : { text });
      if (result === null) {
        reply.code(504).send(apiError(ErrorCodes.TTS_TIMEOUT, '试听合成超时或被取消', 'tts'));
        return reply;
      }
      return result;
    } catch (err) {
      deps.logger.warn('http.tts-preview-failed', { error: String(err) });
      return sendTtsError(reply, err, '试听合成');
    }
  });

  // P1 第三批:模型配置状态(脱敏,不含密钥)与回复预览(调模型但不入队、不播放)。
  fastify.get('/api/llm/config', async (request, reply) => {
    if (!guardControl(deps, request, reply)) return reply;
    const diag = deps.llm.diagnose();
    return {
      provider: diag.requested,
      active: diag.active,
      configured: diag.configured,
      fallbackReason: diag.fallbackReason,
      model: deps.llm.model,
      baseUrl: deps.llm.baseUrl,
      thinking: deps.llm.thinking,
    };
  });

  fastify.post('/api/llm/preview', async (request, reply) => {
    if (!guardControl(deps, request, reply)) return reply;
    const body = request.body as { text?: unknown } | undefined;
    const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 120) : '';
    if (text === '') {
      reply.code(400).send(apiError(ErrorCodes.VALIDATION_FAILED, 'text 需为 1-120 字的文本', 'llm'));
      return reply;
    }
    const startedAt = Date.now();
    try {
      const signal = AbortSignal.timeout(deps.settings.effective().generation.llmTimeoutMs);
      const result = await deps.llm.generateStrict({ text, userKey: 'preview', signal });
      // 预览与直播派发同口径校验动作候选:边界外保留回复文本、动作置空(WT-P2-002)。
      const action = resolveAdoptableAction(result.action ?? null, (id) => deps.characters.resolveAction(id));
      return { ...result, action, elapsedMs: Date.now() - startedAt };
    } catch (err) {
      deps.logger.warn('http.llm-preview-failed', { error: String(err) });
      return sendLlmError(reply, err);
    }
  });

  fastify.post('/api/control/action', async (request, reply) => {
    if (!guardControl(deps, request, reply)) return reply;
    const body = request.body as { actionId?: unknown; say?: unknown } | undefined;
    if (typeof body?.actionId !== 'string' || body.actionId === '') {
      reply.code(400).send(apiError(ErrorCodes.VALIDATION_FAILED, '缺少 actionId', 'control'));
      return reply;
    }
    if (deps.characters.resolveAction(body.actionId) === null) {
      reply.code(400).send(apiError(ErrorCodes.VALIDATION_FAILED, `动作 ${body.actionId} 不在角色清单白名单`, 'control'));
      return reply;
    }
    // 可选试播台词:非空时随表演合成语音,用于验证口型循环到语音结束。
    const say = typeof body.say === 'string' && body.say.trim() !== '' ? body.say : undefined;
    const result = deps.interaction.manualAction(body.actionId, say);
    if (!result.accepted && result.reason === 'asset-missing') {
      // 素材缺失的试播直接拒绝,给出明确反馈而非入队后无声失败(WT-P2-002)。
      reply.code(400).send(apiError(ErrorCodes.ASSET_MISSING, `动作 ${body.actionId} 的素材缺失,无法试播`, 'control'));
      return reply;
    }
    return result;
  });

  // 角色视图(含动作清单):控制台试播器的下拉数据源。
  fastify.get('/api/control/character', async (request, reply) => {
    if (!guardControl(deps, request, reply)) return reply;
    return deps.characters.view();
  });

  // 点歌面板只读快照:控制台凭据(与 /api/state 同一校验),播放端凭据不可读——
  // 任务标题来自观众输入,失败原因含子进程 stderr,只给本机操作者。
  fastify.get('/api/singing/jobs', async (request, reply) => {
    if (!guardControl(deps, request, reply)) return reply;
    return deps.singing.jobsView();
  });

  fastify.post('/api/control/pause', async (request, reply) => {
    if (!guardControl(deps, request, reply)) return reply;
    deps.interaction.pause();
    return { ok: true, paused: true };
  });

  fastify.post('/api/control/resume', async (request, reply) => {
    if (!guardControl(deps, request, reply)) return reply;
    deps.interaction.resume();
    return { ok: true, paused: false };
  });

  fastify.post('/api/control/stop', async (request, reply) => {
    if (!guardControl(deps, request, reply)) return reply;
    deps.interaction.stop();
    return { ok: true, paused: true };
  });

  fastify.get('/api/settings', async (request, reply) => {
    if (!guardControl(deps, request, reply)) return reply;
    return deps.settings.view();
  });

  // 控制台展示“可复制到 OBS 的播放链接”(PROJECT_STRUCTURE《P0 连接注册与权限》),
  // 该链接含播放端凭据,仅发给持有控制台凭据的本机操作者。
  fastify.get('/api/overlay-link', async (request, reply) => {
    if (!guardControl(deps, request, reply)) return reply;
    return { url: deps.overlayUrl() };
  });

  fastify.put('/api/settings', async (request, reply) => {
    if (!guardControl(deps, request, reply)) return reply;
    const body = request.body as Partial<SettingsUpdateRequest> | undefined;
    if (
      !body ||
      typeof body.expectedVersion !== 'number' ||
      typeof body.settings !== 'object' ||
      body.settings === null
    ) {
      reply.code(400).send(apiError(ErrorCodes.VALIDATION_FAILED, '需要 { expectedVersion, settings }', 'settings'));
      return reply;
    }
    const result = deps.settings.update({ expectedVersion: body.expectedVersion, settings: body.settings });
    if (!result.ok) {
      reply.code(result.code === ErrorCodes.VERSION_CONFLICT ? 409 : 400).send(apiError(result.code, result.detail, 'settings'));
      return reply;
    }
    return { savedVersion: result.savedVersion, settings: result.settings };
  });

  const mediaGuard = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!deps.access.checkMediaRequest(request.headers, request.socket.remoteAddress)) {
      reply.code(403).send(apiError(ErrorCodes.SCOPE_DENIED, '媒体接口仅限本机只读访问', 'media'));
      return false;
    }
    return true;
  };

  const petAsset = async (request: FastifyRequest, reply: FastifyReply, method: 'GET' | 'HEAD') => {
    if (!mediaGuard(request, reply)) return;
    const params = request.params as { petId?: string } & Record<'*', string | undefined>;
    const petId = params.petId;
    const assetId = params['*'];
    if (!petId || !assetId || petId !== deps.settings.effective().petId) {
      reply.code(404).send(apiError(ErrorCodes.NOT_FOUND, '角色或资源不存在', 'media'));
      return;
    }
    const resolved = deps.characters.resolveAsset(assetId);
    if (!resolved) {
      reply.code(404).send(apiError(ErrorCodes.ASSET_MISSING, '资源不在角色清单或不可用', 'media'));
      return;
    }
    serveFile(request, reply, resolved.file, resolved.mime, method);
  };

  // 单一路由同时声明 GET/HEAD(fastify.get 会隐式占用 HEAD,显式 head 会冲突)
  fastify.route({
    method: ['GET', 'HEAD'],
    url: '/media/pets/:petId/*',
    handler: async (request, reply) => petAsset(request, reply, request.method === 'HEAD' ? 'HEAD' : 'GET'),
  });

  const audioHandler = async (request: FastifyRequest, reply: FastifyReply, method: 'GET' | 'HEAD') => {
    if (!mediaGuard(request, reply)) return;
    const audioId = (request.params as { audioId?: string }).audioId ?? '';
    const resolved = deps.audioCache.resolve(audioId);
    if (!resolved) {
      reply.code(404).send(apiError(ErrorCodes.NOT_FOUND, '音频不存在或已过期', 'media'));
      return;
    }
    serveFile(request, reply, resolved.file, resolved.mime, method);
  };

  // 单一路由同时声明 GET/HEAD(fastify.get 会隐式占用 HEAD,显式 head 会冲突)
  fastify.route({
    method: ['GET', 'HEAD'],
    url: '/media/audio/:audioId',
    handler: async (request, reply) => audioHandler(request, reply, request.method === 'HEAD' ? 'HEAD' : 'GET'),
  });
}
