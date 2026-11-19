import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { WebSocketServer } from 'ws';
import { VITE_HMR_PATH, WS_PATH, type StateSnapshot } from '../shared/protocol.js';
import { createAccessControl } from './transport/auth.js';
import { registerHttpRoutes } from './transport/http/index.js';
import { createWsTransport } from './transport/ws/index.js';
import { createLogger, redactUrl, type Logger } from './infrastructure/logger.js';
import { createAudioCache } from './infrastructure/audio-cache.js';
import { createPaths, ensureDir, type AppPaths } from './infrastructure/paths.js';
import { createSettings, type SettingsModule } from './modules/settings/index.js';
import { createCharacters, type CharactersModule } from './modules/characters/index.js';
import { createEvents } from './modules/events/index.js';
import { createInteraction, type InteractionModule } from './modules/interaction/index.js';
import { createPlayback, type PlaybackModule } from './modules/playback/index.js';
import { mockEvent, type MockEventInput } from './integrations/platforms/mock.js';
import { createFixedReplyProvider } from './integrations/llm/fixed.js';
import { createDeepSeekReplyProvider, type DeepSeekConfig } from './integrations/llm/deepseek.js';
import { createReplyRouter, withProviderLabel } from './integrations/llm/reply-router.js';
import { createFixedLocalSpeech } from './integrations/tts/fixed-local.js';
import { createEdgeTtsSpeech, createSpeechRouter } from './integrations/tts/edge-tts.js';
import type { GiftRuleConfig, PersonaConfig } from './modules/interaction/rules.js';

// 依赖组装与资源关闭(PROJECT_STRUCTURE《依赖方向》):
// app.ts 只做创建、连接与生命周期;任务选择与调度在业务模块。

export type App = {
  runId: string;
  paths: AppPaths;
  logger: Logger;
  settings: SettingsModule;
  characters: CharactersModule;
  interaction: InteractionModule;
  playback: PlaybackModule;
  urls: { base: string; control: string; overlay: string };
  close(): Promise<void>;
};

function readJson<T>(file: string, fallback: T, logger: Logger, what: string): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    logger.warn('app.config-read-failed', { what, file, error: String(err) });
    return fallback;
  }
}

export async function createApp(opts: { env: Record<string, string | undefined>; resetAccess?: boolean }): Promise<App> {
  const now = () => Date.now();
  const paths = createPaths(opts.env.WHALETALK_DATA_DIR);
  for (const dir of [paths.dataDir, paths.userConfigDir, paths.petsDir, paths.audioCacheDir, paths.logsDir, paths.dbDir]) {
    ensureDir(dir);
  }
  const logger = createLogger({ logsDir: paths.logsDir });
  const runId = `run-${now().toString(36)}-${randomUUID().slice(0, 6)}`;

  const env = { ...opts.env };
  const settings = createSettings({ paths, env, logger });
  const effective = () => settings.effective();

  const access = createAccessControl({ paths, logger, port: () => effective().server.port });
  access.ensure({ reset: opts.resetAccess === true });

  const characters = createCharacters({ paths, petId: effective().petId, logger });
  const events = createEvents({ now });
  const playback = createPlayback({
    runId,
    settings: effective,
    logger,
    now,
    urlForAsset(assetId) {
      const petId = effective().petId;
      const encoded = assetId.split('/').map(encodeURIComponent).join('/');
      return `/media/pets/${encodeURIComponent(petId)}/${encoded}`;
    },
  });

  const personaFallback: PersonaConfig = { name: '大肥鱼', fallbackReplies: ['我看到你的弹幕啦~'], commandReplies: {} };
  const giftFallback: GiftRuleConfig = { thanksTemplate: '谢谢 {user} 的 {gift} ×{count}!', celebrateText: '欢迎 {user} 加入{kind}!' };
  const persona = readJson<PersonaConfig>(path.join(paths.versionedConfigDir, 'persona.json'), personaFallback, logger, 'persona');
  const giftRulesCfg = readJson<GiftRuleConfig>(path.join(paths.versionedConfigDir, 'gift-rules.json'), giftFallback, logger, 'gift-rules');

  // P1 第三批:DeepSeek 配置全部来自服务端 env;密钥不进入设置视图与浏览器。
  const deepSeekConfig: DeepSeekConfig = {
    apiKey: env.DEEPSEEK_API_KEY?.trim() ?? '',
    baseUrl: env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
    // ARCHITECTURE §6 契约默认名;本地兼容端点可由 DEEPSEEK_MODEL 覆盖(WT-P1-023)。
    model: env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash',
    thinking: env.DEEPSEEK_THINKING?.trim().toLowerCase() === 'enabled',
  };
  const audioCache = createAudioCache({ audioDir: paths.audioCacheDir, logger, now });
  const fixedReply = withProviderLabel(createFixedReplyProvider({ fallbackReplies: persona.fallbackReplies }), 'fixed-local');
  const deepseek = createDeepSeekReplyProvider({
    config: deepSeekConfig,
    personaName: persona.name,
    personaPrompt: persona.systemPrompt ?? '',
    isAllowedAction: (id) => characters.resolveAction(id) !== null,
    logger,
  });
  const replyProvider = createReplyRouter({ fixed: fixedReply, deepseek, settings: effective, logger });
  // P1 第二批:edge-tts 真实合成(默认),fixed-local 保留为离线备选;按设置热切换
  const fixedSpeech = createFixedLocalSpeech({ cache: audioCache });
  const edgeTts = createEdgeTtsSpeech({ cache: audioCache, logger, now, voice: () => effective().tts.voice });
  const speechProvider = createSpeechRouter({ fixed: fixedSpeech, edge: edgeTts, settings: () => effective().tts });

  const interaction = createInteraction({ settings: effective, characters, playback, replyProvider, speechProvider, persona, giftRules: giftRulesCfg, logger, now });

  // 控制台试听:直接经 edge 适配器(验证真实通道),音色可覆盖;超时对齐 generation.ttsTimeoutMs
  const ttsPreview = async (input: { text: string; voice?: string }): Promise<{ audioUrl: string } | null> => {
    const voice = input.voice ?? effective().tts.voice;
    const signal = AbortSignal.timeout(effective().generation.ttsTimeoutMs);
    const result = await edgeTts.synthesizeWith({ text: input.text, voice, signal });
    if (result === null && !signal.aborted) throw new Error('未生成可用音频');
    return result;
  };

  // 平台适配器 → events → app 连接的回调 → interaction(PROJECT_STRUCTURE《依赖方向》)
  let mockSeq = 0;
  const submitMock = (input: MockEventInput) => {
    const event = mockEvent(input, now, () => (mockSeq += 1));
    const ingest = events.ingest(event);
    if (!ingest.accepted) {
      logger.info('mock.event-dropped', { eventId: event.id, reason: ingest.reason });
      return { eventId: event.id, ingest: ingest.reason, enqueue: null };
    }
    const enqueue = interaction.enqueue(ingest.event);
    return {
      eventId: event.id,
      ingest: 'accepted',
      enqueue: { accepted: enqueue.accepted, reason: 'reason' in enqueue ? enqueue.reason : null },
    };
  };

  const startedAt = now();
  const stateSnapshot = (): StateSnapshot => {
    const st = interaction.state();
    const view = settings.view();
    return {
      runId,
      startedAt,
      paused: st.paused,
      platform: effective().platform,
      petId: effective().petId,
      queue: {
        capacity: st.queue.capacity,
        length: st.queue.length,
        items: st.queue.items.map((item) => ({
          eventId: item.eventId,
          type: item.type,
          priority: item.priority,
          enqueuedAt: item.enqueuedAt,
          sayPreview: item.say.slice(0, 30),
        })),
        dropped: st.queue.drops,
      },
      current: st.current,
      playback: { ...playback.view(), action: st.current?.action ?? null },
      renderers: playback.renderersView(),
      metrics: st.metrics,
      settingsVersion: view.savedVersion,
      serverTime: now(),
    };
  };

  const fastify = Fastify({ logger: false, disableRequestLogging: true });
  const idleInfo = (): { url: string; loop: boolean; available: boolean } | null => {
    const idle = characters.resolveAction('idle');
    if (!idle) return null;
    return { url: `/media/pets/${encodeURIComponent(effective().petId)}/${idle.file.split('/').map(encodeURIComponent).join('/')}`, loop: idle.loop, available: idle.available };
  };
  const ws = createWsTransport({ runId, access, playback, stateSnapshot, settings: effective, idleInfo, logger, now });

  registerHttpRoutes(fastify, {
    runId,
    startedAt,
    settings,
    access,
    interaction,
    characters,
    stateSnapshot,
    submitMock,
    overlayUrl: () => access.overlayUrl(),
    audioCache,
    edgeTts,
    ttsPreview,
    llm: {
      generateStrict: (input) => replyProvider.generateStrict(input),
      diagnose: () => replyProvider.diagnose(),
      active: () => replyProvider.active(),
      configured: () => deepseek.configured(),
      model: deepSeekConfig.model,
      baseUrl: deepSeekConfig.baseUrl,
      thinking: deepSeekConfig.thinking,
    },
    logger,
  });

  // 页面入口统一尾斜杠形式;重定向保留查询参数(如 ?blend=screen,WT-P0-012),
  // fragment 不随请求发送、由浏览器重定向后自动带回,凭据不丢失。
  const redirectToTrailingSlash = (request: import('fastify').FastifyRequest, target: string, reply: import('fastify').FastifyReply) => {
    const raw = request.raw.url ?? '';
    const search = raw.includes('?') ? raw.slice(raw.indexOf('?')) : '';
    return reply.code(308).redirect(`${target}/${search}`);
  };
  fastify.get('/control', async (request, reply) => redirectToTrailingSlash(request, '/control', reply));
  fastify.get('/overlay', async (request, reply) => redirectToTrailingSlash(request, '/overlay', reply));

  // P0 源码运行:页面经 Vite 开发中间件同源提供,业务 /ws 与 HMR 共用同一 HTTP server。
  // 全部路由(含本代理路由)必须在 ready/listen 之前注册;Vite 实例在监听建立后创建并绑定。
  let viteDev: Awaited<ReturnType<typeof import('vite')['createServer']>> | null = null;
  fastify.route({
    method: ['GET', 'HEAD'],
    url: '/*',
    handler: (request, reply) => {
      if (!viteDev) {
        reply.code(503).send({ code: 'UNKNOWN', message: '页面服务初始化中,请稍后刷新' });
        return;
      }
      reply.hijack();
      viteDev.middlewares(request.raw, reply.raw, () => {
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 404;
          reply.raw.end('not found');
        }
      });
    },
  });

  await fastify.ready();
  const httpServer = fastify.server;

  const wss = new WebSocketServer({ noServer: true });
  ws.attach(wss);

  // 升级路由:业务 /ws 精确接管;Vite HMR 交给其自身监听;未知路径明确拒绝。
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      socket.destroy();
      return;
    }
    logger.info('ws.upgrade', { pathname, origin: typeof req.headers.origin === 'string' ? redactUrl(req.headers.origin) : '(缺失)', host: typeof req.headers.host === 'string' ? req.headers.host : '(缺失)' });
    if (pathname === WS_PATH) {
      const check = access.checkUpgrade(req.headers, req.socket.remoteAddress);
      if (!check.ok) {
        logger.warn('ws.upgrade-rejected', { code: check.code, pathname });
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client, req));
      return;
    }
    if (pathname === VITE_HMR_PATH) return;
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });

  const pushState = () => ws.broadcastState();
  interaction.onChange(pushState);
  playback.onChange(pushState);
  const ticker = setInterval(() => {
    interaction.tick();
    playback.tick();
  }, 250);

  const listen = effective().server;
  await fastify.listen(listen);
  // 端口为 0 时由系统分配空闲端口，凭据 URL 和来源检查使用实际监听端口。
  const address = httpServer.address();
  if (listen.port === 0 && address && typeof address !== 'string') env.PORT = String(address.port);
  const { host, port } = effective().server;

  // Vite 在监听建立后创建:middleware 模式提供页面,HMR WS 经 server.ws.server 挂同一 server。
  const viteModule = await import('vite');
  viteDev = await viteModule.createServer({
    root: path.join(paths.projectRoot, 'src', 'web'),
    configFile: path.join(paths.projectRoot, 'vite.config.ts'),
    server: { ws: { server: httpServer } },
  });
  logger.info('server.pages-ready', { hmr: VITE_HMR_PATH });

  logger.info('server.started', { runId, host, port, control: redactUrl(access.controlUrl()) });

  async function close(): Promise<void> {
    clearInterval(ticker);
    interaction.stop();
    edgeTts.close();
    ws.closeAll();
    wss.close();
    if (viteDev) await viteDev.close();
    await fastify.close();
    logger.info('server.stopped', { runId });
  }

  return {
    runId,
    paths,
    logger,
    settings,
    characters,
    interaction,
    playback,
    urls: {
      base: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
      control: access.controlUrl(),
      overlay: access.overlayUrl(),
    },
    close,
  };
}
