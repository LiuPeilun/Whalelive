// 模型与语音的小型业务接口:interaction 仅依赖这两个接口,具体适配器由 app.ts 注入。
// P1 第一批:固定回复 + 本地 WAV 合成;后续替换为 DeepSeek 与 edge-tts 适配器。

export interface ReplyProvider {
  generate(input: { text: string; userKey: string; signal: AbortSignal }): Promise<{ say: string; action: string | null }>;
}

export interface SpeechProvider {
  synthesize(input: { text: string; signal: AbortSignal }): Promise<{ audioUrl: string; audioId: string } | null>;
}
