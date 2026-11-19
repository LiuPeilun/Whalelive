// 模型与语音的小型业务接口:interaction 仅依赖这两个接口,具体适配器由 app.ts 注入。
// P1 第一批:固定回复 + 本地 WAV 合成;P1 第二批 edge-tts;P1 第三批 DeepSeek。

/** 模型调用的 token 用量(各提供方可选上报,缺失按 0 计)。 */
export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

/** 回复结果:say/action 为必需;情绪、用量、提供方标识为 P1 第三批新增的可选元数据。 */
export type ReplyResult = {
  say: string;
  action: string | null;
  emotion?: string;
  usage?: TokenUsage;
  provider?: string;
};

export interface ReplyProvider {
  generate(input: { text: string; userKey: string; signal: AbortSignal }): Promise<ReplyResult>;
}

/**
 * 提供方已取得上游响应但输出不可用(非法 JSON/截断/空内容)时的类型化错误。
 * usage 为该次请求上游已返回的 token 用量——即使内容不可用,已发生的调用
 * 仍应计入统计(WT-P1-022);调用方降级保底文本时把 usage 随结果归属本次请求。
 */
export class ReplyInvalidError extends Error {
  readonly usage?: TokenUsage;
  constructor(message: string, usage?: TokenUsage) {
    super(message);
    this.name = 'ReplyInvalidError';
    if (usage !== undefined) this.usage = usage;
  }
}

export interface SpeechProvider {
  synthesize(input: { text: string; signal: AbortSignal }): Promise<{ audioUrl: string; audioId: string } | null>;
}
