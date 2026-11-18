import type { ReplyProvider } from '../../modules/interaction/providers.js';

// P1 第一批的回复提供方:非指令弹幕返回轮换的固定回复,不依赖任何外部服务。
// 用于先打通“生成 → 合成 → 播放 → 取消”链路;P1 第三批替换为 DeepSeek 适配器。

export function createFixedReplyProvider(deps: { fallbackReplies: string[] }): ReplyProvider {
  let cursor = 0;
  return {
    async generate({ text }) {
      void text;
      const say = deps.fallbackReplies[cursor % deps.fallbackReplies.length] ?? '我看到你的弹幕啦~';
      cursor += 1;
      return { say, action: null };
    },
  };
}
