import type { ReplyProvider, ReplyResult } from '../../modules/interaction/providers.js';
import type { EffectiveSettings } from '../../../shared/settings.js';
import type { Logger } from '../../infrastructure/logger.js';

// 按设置中的 llm.provider 在固定回复与 DeepSeek 之间委托(设置热更新即时生效)。
// DeepSeek 未配置 API Key 时自动降级到固定回复:零配置也能启动,填好 Key 后无需改界面即可生效。
// 模型调用失败/超时/非法输出由 interaction 既有保底链路处理,不在路由层静默替换文本来源。

export function createReplyRouter(deps: {
  fixed: ReplyProvider;
  deepseek: ReplyProvider & { configured(): boolean };
  settings(): Pick<EffectiveSettings, 'llm'>;
  logger: Logger;
}): ReplyProvider & { active(): 'fixed-local' | 'deepseek' } {
  const active = (): 'fixed-local' | 'deepseek' => {
    if (deps.settings().llm.provider === 'deepseek' && deps.deepseek.configured()) return 'deepseek';
    return 'fixed-local';
  };
  return {
    active,
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
