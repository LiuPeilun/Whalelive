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

export interface SpeechProvider {
  synthesize(input: { text: string; signal: AbortSignal }): Promise<{ audioUrl: string; audioId: string } | null>;
}
