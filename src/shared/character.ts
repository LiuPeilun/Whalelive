// 页面可见的角色与动作描述。P0 动作集合:idle / wave / think / talk / eat / dance / gift / celebrate。

export type CharacterAction = {
  id: string;
  file: string;
  loop?: boolean;
};

export type CharacterLicense = {
  name: string;
  source?: string;
  note?: string;
};

export type CharacterManifest = {
  formatVersion: number;
  petId: string;
  name: string;
  license: CharacterLicense;
  actions: CharacterAction[];
};

export type CharacterActionView = {
  id: string;
  available: boolean;
  loop: boolean;
};

export type CharacterView = {
  petId: string;
  name: string;
  licenseName: string;
  actions: CharacterActionView[];
};

export const CANONICAL_ACTION_IDS = [
  'idle',
  'wave',
  'think',
  'talk',
  'eat',
  'dance',
  'gift',
  'celebrate',
] as const;

export type CanonicalActionId = (typeof CANONICAL_ACTION_IDS)[number];
