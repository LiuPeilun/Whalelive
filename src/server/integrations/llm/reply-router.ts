import type { ReplyProvider, ReplyResult } from '../../modules/interaction/providers.js';
import type { EffectiveSettings } from '../../../shared/settings.js';
import type { Logger } from '../../infrastructure/logger.js';

// 按设置中的 llm.provider 在固定回复与 DeepSeek 之间委托(设置热更新即时生效)。
// DeepSeek 未配置 API Key 时自动降级到固定回复:零配置也能启动,填好 Key 后无需改界面即可生效。
// 模型调用失败/超时/非法输出由 interaction 既有保底链路处理,不在路由层静默替换文本来源。

/** 预览诊断错误:携带可展示给操作者的原因,由 HTTP 层映射为错误码(WT-P1-021)。 */
export type LlmPreviewReason = 'NOT_CONFIGURED' | 'UPSTREAM_ERROR' | 'TIMEOUT';
export class LlmPreviewError extends Error {
  readonly reason: LlmPreviewReason;
  constructor(reason: LlmPreviewReason, message: string) {
    super(message);
    this.name = 'LlmPreviewError';
    this.reason = reason;
  }
}

export type ReplyRouter = ReplyProvider & {
  active(): 'fixed-local' | 'deepseek';
  /** 预览专用:不吞上游故障,直接抛出可诊断错误;直播仍用 generate 的自动降级。 */
  generateStrict(input: Parameters<ReplyProvider['generate']>[0]): Promise<ReplyResult>;
  /** 配置诊断:区分主动选择固定回复与"选了 DeepSeek 但缺 Key 回退"。 */
  diagnose(): { requested: string; active: string; configured: boolean; fallbackReason: string | null };
};

export function createReplyRouter(deps: {
  fixed: ReplyProvider;
  deepseek: ReplyProvider & { configured(): boolean };
  settings(): Pick<EffectiveSettings, 'llm'>;
  logger: Logger;
}): ReplyRouter {
  const active = (): 'fixed-local' | 'deepseek' => {
    if (deps.settings().llm.provider === 'deepseek' && deps.deepseek.configured()) return 'deepseek';
    return 'fixed-local';
  };
  return {
    active,
    diagnose() {
      const requested = deps.settings().llm.provider;
      const configured = deps.deepseek.configured();
      return {
        requested,
        active: active(),
        configured,
        fallbackReason: requested === 'deepseek' && !configured ? 'DEEPSEEK_KEY_MISSING' : null,
      };
    },
    async generate(input): Promise<ReplyResult> {
      const provider = active();
      if (provider === 'deepseek') {
        try {
          return await deps.deepseek.generate(input);
        } catch (err) {
          // 未配置或调用失败:记录后降级固定回复,保证直播链路不中断。
          deps.logger.warn('llm.deepseek-fallback', { error: String(err), reason: 'provider-error' });
          return deps.fixed.generate(input);
        }
      }
      return deps.fixed.generate(input);
    },
    async generateStrict(input): Promise<ReplyResult> {
      // 预览需要真实反映上游状态:缺 Key、HTTP 失败、超时、非法输出都抛出,
      // 由 HTTP 层映射错误码,操作者才能区分无效密钥/超时/主动选固定回复(WT-P1-021)。
      const requested = deps.settings().llm.provider;
      if (requested === 'fixed-local') return deps.fixed.generate(input);
      if (!deps.deepseek.configured()) {
        throw new LlmPreviewError('NOT_CONFIGURED', '已选择 DeepSeek 但服务端未配置 API Key');
      }
      try {
        return await deps.deepseek.generate(input);
      } catch (err) {
        if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          throw new LlmPreviewError('TIMEOUT', '模型请求超时');
        }
        throw new LlmPreviewError('UPSTREAM_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/** 固定回复提供方补齐 provider 标识,便于统计区分来源。 */
export function withProviderLabel(provider: ReplyProvider, label: string): ReplyProvider {
  return {
    async generate(input) {
      const result = await provider.generate(input);
      return { ...result, provider: label };
    },
  };
}
