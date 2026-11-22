// 页面可见的设置结构。服务端保存的用户覆盖只含可热更新字段,
// 监听地址等需重启项只读展示(环境覆盖字段在视图中标明)。

export type QueueSettings = {
  capacity: number;
  chatTtlMs: number;
  userCooldownMs: number;
};

/** 礼物分层(P2 互动第二批):按已确认实付金额分档答谢,金额口径仅金瓜子计价。 */
export type GiftTieringSettings = {
  /** 小额上限(元):实付低于该值为小额档;免费/银瓜子/未知价格一律按小额普通感谢。 */
  smallMaxYuan: number;
  /** 大额下限(元):实付达到该值为大额档,SC 与大航海同属大额档。 */
  largeMinYuan: number;
  /** 待播小额答谢达到该数量时合并为一句播报(高峰降级)。 */
  peakMergeCount: number;
};

export type GiftSettings = {
  mergeWindowMs: number;
  tiering: GiftTieringSettings;
};

/** 问候与冷场(互动第三批):进场聚合、关注/分享播报、冷场自救节奏。 */
export type GreetingsSettings = {
  /** 自动播报总开关(进场/关注/分享);冷场话题同受其约束。 */
  enabled: boolean;
  /** 进场聚合窗口(毫秒)。 */
  enterWindowMs: number;
  /** 窗口内逐个念名的人数上限,超出改发全房欢迎。 */
  maxNamedCount: number;
  /** 全房欢迎最小间隔(毫秒),被限流的欢迎直接过期。 */
  allRoomIntervalMs: number;
  /** 冷场判定空闲时长(毫秒):期间无任何真实互动且无在播/无待播才触发。 */
  coldIdleMs: number;
  /** 两次冷场话题的最小间隔(毫秒)。 */
  coldIntervalMs: number;
};

export type PlaybackSettings = {
  preloadTimeoutMs: number;
  overallTimeoutMs: number;
  noRendererGraceMs: number;
};

export type LeaseSettings = {
  ttlMs: number;
  renewIntervalMs: number;
  /** 接管安全窗:旧租约过期后,再等该窗口(覆盖旧端本地截止与停止消息处理)才允许新端接管发声。 */
  takeoverSafetyMs: number;
};

/** 语音合成(P1 第二批):提供方选择与 edge-tts 音色(ShortName,如 zh-CN-XiaoxiaoNeural)。 */
export type TtsSettings = {
  provider: 'fixed-local' | 'edge-tts';
  voice: string;
};

/** 音色短名可包含地区或书写系统，如 zh-CN-liaoning-XiaobeiNeural。 */
export function isValidVoiceShortName(voice: unknown): voice is string {
  return typeof voice === 'string'
    && voice.length <= 128
    && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)+-[A-Za-z0-9]+Neural$/.test(voice);
}

/** 界面可编辑并写入 data/config 的用户覆盖。 */
export type UserSettings = {
  petId: string;
  queue: QueueSettings;
  gift: GiftSettings;
  greetings: GreetingsSettings;
  playback: PlaybackSettings;
  lease: LeaseSettings;
  tts: TtsSettings;
  llm: LlmSettings;
};

/** 回复提供方(P1 第三批):fixed-local 为离线罐头回复,deepseek 为真实模型。 */
export type LlmSettings = {
  provider: 'fixed-local' | 'deepseek';
};

export function isLlmProvider(value: unknown): value is LlmSettings['provider'] {
  return value === 'fixed-local' || value === 'deepseek';
}

/** 合成后的有效配置(含只读的服务器与平台项)。 */
export type EffectiveSettings = UserSettings & {
  server: { host: string; port: number };
  platform: string;
  auth: { timeoutMs: number };
  /** 生成链路超时(ARCHITECTURE §8:LLM 8s / TTS 10s),默认值只读,不进用户覆盖。 */
  generation: { llmTimeoutMs: number; ttsTimeoutMs: number };
};

export type SettingsView = {
  savedVersion: number;
  user: UserSettings;
  effective: EffectiveSettings;
  envOverrides: string[];
  restartRequired: string[];
};

export type SettingsUpdateRequest = {
  expectedVersion: number;
  settings: UserSettings;
};
