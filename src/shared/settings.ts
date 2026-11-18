// 页面可见的设置结构。服务端保存的用户覆盖只含可热更新字段,
// 监听地址等需重启项只读展示(环境覆盖字段在视图中标明)。

export type QueueSettings = {
  capacity: number;
  chatTtlMs: number;
  userCooldownMs: number;
};

export type GiftSettings = {
  mergeWindowMs: number;
};

export type PlaybackSettings = {
  preloadTimeoutMs: number;
  overallTimeoutMs: number;
  noRendererGraceMs: number;
};

export type LeaseSettings = {
  ttlMs: number;
  renewIntervalMs: number;
};

/** 界面可编辑并写入 data/config 的用户覆盖。 */
export type UserSettings = {
  petId: string;
  queue: QueueSettings;
  gift: GiftSettings;
  playback: PlaybackSettings;
  lease: LeaseSettings;
};

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
