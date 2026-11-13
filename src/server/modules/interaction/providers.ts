// 模型与语音的小型业务接口:interaction 仅依赖这两个接口,具体适配器由 app.ts 注入。
// P0 使用罐头回复与空语音实现;P1 替换为 DeepSeek / edge-tts 适配器。

export interface ReplyProvider {
  generate(input: { text: string; userKey: string; signal: AbortSignal }): Promise<{ say: string; action: string | null }>;
}

export interface SpeechProvider {
  synthesize(input: { text: string; signal: AbortSignal }): Promise<{ audioUrl: string; audioId: string } | null>;
}

export function createCannedReplyProvider(parse: (text: string) => { action: string | null; say: string }): ReplyProvider {
  return {
    async generate({ text }) {
      return parse(text);
    },
  };
}

export const nullSpeechProvider: SpeechProvider = {
  async synthesize() {
    return null; // P0 无语音合成,表演不携带 audioUrl
  },
};
