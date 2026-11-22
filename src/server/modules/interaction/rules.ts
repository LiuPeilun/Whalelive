// 明确动作指令与回复策略:P0 无 DeepSeek,聊天经确定性规则或人设兜底回复。
// P1 接入 DeepSeek 后,本文件保留“确定性指令”部分,语义回复切换到 reply.ts + providers。
// P2 互动第二批:礼物三档分层答谢——小额/中额/大额各配动作与模板,SC 与大航海同属大额档;
// 免费礼物、银瓜子、未知价格一律按小额普通感谢,不冒进高档(v1.1 修正 2)。

export type PersonaConfig = {
  name: string;
  fallbackReplies: string[];
  commandReplies: Record<string, string>;
  /** P1 第三批:注入模型系统提示的人设描述;缺省时只用 name。 */
  systemPrompt?: string;
};

/** 礼物答谢档位:小额(<smallMaxYuan)/中额/大额(≥largeMinYuan 或 SC/大航海)。 */
export type GiftTierKey = 'small' | 'mid' | 'large';

export type GiftTierRule = {
  /** 该档答谢动作(须在角色清单内;stamp-letter 为大额专属仪式)。 */
  action: string;
  /** 答谢模板:支持 {user} {gift}(={kind}) {count} {amount} 占位符。 */
  template: string;
};

/**
 * gift-rules.json 的原始形态(允许缺省分层配置,兼容既有文件);
 * 经 resolveGiftRules 归一后交付运行时。
 */
export type GiftRuleConfig = {
  /** 兼容旧字段:未配置分层时作为小额档模板。 */
  thanksTemplate?: string;
  /** 兼容旧字段:未配置分层时作为大额档模板。 */
  celebrateText?: string;
  tiers?: Partial<Record<GiftTierKey, GiftTierRule>>;
  /** 高峰合并播报模板:支持 {names} 占位符。 */
  mergedThanksTemplate?: string;
};

export type ResolvedGiftRules = {
  tiers: Record<GiftTierKey, GiftTierRule>;
  mergedThanksTemplate: string;
};

/**
 * 问候规则(互动第三批):进场/关注/分享播报与冷场自救话题。
 * 原始形态允许缺省,经 resolveGreetings 归一后交付运行时。
 */
export type GreetingRuleConfig = {
  /** 进场念名模板:{names} 为去重观众名列表(≤ 上限)。 */
  enterNamedTemplate?: string;
  /** 超出念名上限时的全房欢迎模板。 */
  enterAllTemplate?: string;
  /** 关注感谢模板:{user}。 */
  followTemplate?: string;
  /** 分享感谢模板:{user}。 */
  shareTemplate?: string;
  /** 冷场提示词池(轮换发给回复提供方生成话题);缺省用内置池。 */
  coldPrompts?: string[];
};

export type ResolvedGreetings = {
  enter: { action: string; namedTemplate: string; allTemplate: string };
  follow: { action: string; template: string };
  share: { action: string; template: string };
  cold: { action: string; prompts: string[] };
};

const DEFAULT_COLD_PROMPTS = [
  '直播间安静下来了,主动挑一个有意思的话题和观众聊聊',
  '没人说话的话,分享一个今天遇到的小趣事或冷知识',
  '主动向大家提问,带动直播间气氛',
];

/** 问候默认动作:进场挥手迎接,关注/分享开心回应,冷场用认真口型抛话题。 */
const DEFAULT_GREETING_ACTIONS = {
  enter: 'wave',
  follow: 'laugh',
  share: 'laugh',
  cold: 'talk-serious',
};

/** 归一化问候规则:缺省项用内置默认(动作均在角色清单内)。 */
export function resolveGreetings(raw: GreetingRuleConfig): ResolvedGreetings {
  return {
    enter: {
      action: DEFAULT_GREETING_ACTIONS.enter,
      namedTemplate: raw.enterNamedTemplate ?? '欢迎 {names} 登船!',
      allTemplate: raw.enterAllTemplate ?? '欢迎新朋友登船!',
    },
    follow: { action: DEFAULT_GREETING_ACTIONS.follow, template: raw.followTemplate ?? '谢谢 {user} 的关注!' },
    share: { action: DEFAULT_GREETING_ACTIONS.share, template: raw.shareTemplate ?? '谢谢 {user} 的分享!' },
    cold: { action: DEFAULT_GREETING_ACTIONS.cold, prompts: raw.coldPrompts?.length ? raw.coldPrompts : DEFAULT_COLD_PROMPTS },
  };
}

const DEFAULT_SMALL_TEMPLATE = '谢谢 {user} 的 {gift} ×{count}!';
const DEFAULT_MERGED_THANKS = '感谢 {names} 送来的礼物,大肥鱼都记好啦!';

/** 内置默认档位:动作均已在角色清单登记(talk-nod 循环口型/laugh/stamp-letter 盖章仪式)。 */
const DEFAULT_TIERS: Record<GiftTierKey, GiftTierRule> = {
  small: { action: 'talk-nod', template: DEFAULT_SMALL_TEMPLATE },
  mid: { action: 'laugh', template: '哇,{user} 送的{gift}大肥鱼超喜欢!' },
  large: { action: 'stamp-letter', template: '{user} 的{gift}!大肥鱼给你盖个章,记一辈子!' },
};

/** 归一化礼物规则:旧字段(thanksTemplate/celebrateText)作为缺档回退,缺省项用内置默认。 */
export function resolveGiftRules(raw: GiftRuleConfig): ResolvedGiftRules {
  return {
    tiers: {
      small: raw.tiers?.small ?? { action: DEFAULT_TIERS.small.action, template: raw.thanksTemplate ?? DEFAULT_TIERS.small.template },
      mid: raw.tiers?.mid ?? DEFAULT_TIERS.mid,
      large: raw.tiers?.large ?? { action: DEFAULT_TIERS.large.action, template: raw.celebrateText ?? DEFAULT_TIERS.large.template },
    },
    mergedThanksTemplate: raw.mergedThanksTemplate ?? DEFAULT_MERGED_THANKS,
  };
}

/** 分层阈值(来自设置 gift.tiering,可热更新)。 */
export type GiftTierThresholds = { smallMaxYuan: number; largeMinYuan: number };

/**
 * 档位判定:v1.1 定稿边界——实付 <smallMaxYuan 小额、[smallMaxYuan, largeMinYuan) 中额、
 * ≥largeMinYuan 大额;免费/银瓜子/未知价格(paidKnown=false 或金额为 0)一律小额。
 */
export function tierFor(paidYuan: number, paidKnown: boolean, thresholds: GiftTierThresholds): GiftTierKey {
  if (!paidKnown || paidYuan <= 0) return 'small';
  if (paidYuan >= thresholds.largeMinYuan) return 'large';
  if (paidYuan >= thresholds.smallMaxYuan) return 'mid';
  return 'small';
}

/** 金额展示:保留两位内小数,整除则去掉小数点(0.5→"0.5",10→"10")。 */
function formatYuan(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/**
 * 明确口令:弹幕 trim 后整句全等才触发,含口令词的普通提问不命中(走问答流程)。
 * 与 COMMAND_PATTERNS(包含匹配)区分,避免高频词误触。
 */
const PHRASE_COMMANDS: { action: string; phrase: string }[] = [
  { action: 'salute', phrase: '敬个礼' },
  { action: 'sip-tea', phrase: '喝口茶' },
];

const COMMAND_PATTERNS: { action: string; pattern: RegExp }[] = [
  { action: 'dance', pattern: /(跳个舞|跳舞|跳一支舞|来段舞)/ },
  { action: 'wave', pattern: /(挥手|打个招呼|say hi|嗨|哈喽|你好呀|大家好)/ },
  // 「吃饭」为高频名词(吃饭前/后类提问),移除;点播意图由「吃什么/干饭/开饭/来点吃的」覆盖。
  { action: 'eat', pattern: /(吃什么|吃点啥|干饭|开饭|来点吃的)/ },
  // 「为什么」是高频疑问词,与普通提问高冲突(带口令词的提问会被截获),移除;思考类仍可由口令/模型路由触发。
  { action: 'think', pattern: /(想想|思考一下|想一下)/ },
  { action: 'gift', pattern: /(拆礼物|开礼物)/ },
];

export function createRules(persona: PersonaConfig, giftRules: ResolvedGiftRules, greetings: ResolvedGreetings) {
  let fallbackCursor = 0;
  let coldCursor = 0;

  /** 确定性指令检测:先查整句口令(全等),含彩蛋词但非整句的普通提问跳过包含类指令走问答,再查其余包含类指令。 */
  function detectCommand(text: string): { action: string; say: string } | null {
    const trimmed = text.trim();
    for (const cmd of PHRASE_COMMANDS) {
      if (trimmed === cmd.phrase) {
        return { action: cmd.action, say: persona.commandReplies[cmd.action] ?? `${persona.name}收到!` };
      }
    }
    // 含彩蛋词但非整句命中(如「为什么要喝口茶?」「吃饭前喝口茶对肠胃有影响吗?」)
    // 属于含彩蛋词的普通提问,按第一批约定走问答,不被包含类指令截获(WT-P2-003)。
    if (PHRASE_COMMANDS.some((cmd) => trimmed.includes(cmd.phrase))) return null;
    for (const cmd of COMMAND_PATTERNS) {
      if (cmd.pattern.test(text)) {
        return { action: cmd.action, say: persona.commandReplies[cmd.action] ?? `${persona.name}收到!` };
      }
    }
    return null;
  }

  /** 兜底回复(提供方失败/超时时使用),按序轮换。 */
  function fallbackReply(): string {
    const reply = persona.fallbackReplies[fallbackCursor % persona.fallbackReplies.length] ?? `${persona.name}看到你的弹幕啦~`;
    fallbackCursor += 1;
    return reply;
  }

  /**
   * 按档取答谢文案。{gift} 与 {kind} 等值(大航海/醒目留言复用大额模板);
   * count/amount 未提供时对应占位符替换为空串。
   */
  function thanksText(
    tier: GiftTierKey,
    input: { user: string; gift: string; count?: number; amountYuan?: number },
  ): string {
    const template = giftRules.tiers[tier]?.template ?? DEFAULT_SMALL_TEMPLATE;
    return template
      .replaceAll('{user}', input.user)
      .replaceAll('{gift}', input.gift)
      .replaceAll('{kind}', input.gift)
      .replaceAll('{count}', input.count !== undefined ? String(input.count) : '')
      .replaceAll('{amount}', input.amountYuan !== undefined ? formatYuan(input.amountYuan) : '');
  }

  /** 高峰合并播报:{names} 已由调用方按人名数量截断(超出以"等朋友"收尾)。 */
  function mergedThanks(names: string): string {
    return giftRules.mergedThanksTemplate.replaceAll('{names}', names);
  }

  /** 问候播报文案:按问候种类取模板并替换占位符({names}/{user})。 */
  function greetingText(kind: 'enterNamed' | 'enterAll' | 'follow' | 'share', input: { names?: string; user?: string }): string {
    const template = kind === 'enterNamed'
      ? greetings.enter.namedTemplate
      : kind === 'enterAll'
        ? greetings.enter.allTemplate
        : kind === 'follow'
          ? greetings.follow.template
          : greetings.share.template;
    return template.replaceAll('{names}', input.names ?? '').replaceAll('{user}', input.user ?? '');
  }

  /** 冷场提示词轮换(发给回复提供方生成话题;失败走保底回复)。 */
  function coldPrompt(): string {
    const prompts = greetings.cold.prompts;
    const prompt = prompts[coldCursor % prompts.length] ?? DEFAULT_COLD_PROMPTS[0]!;
    coldCursor += 1;
    return prompt;
  }

  return { detectCommand, fallbackReply, thanksText, mergedThanks, greetingText, coldPrompt };
}
