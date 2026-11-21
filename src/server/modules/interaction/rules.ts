// 明确动作指令与回复策略:P0 无 DeepSeek,聊天经确定性规则或人设兜底回复。
// P1 接入 DeepSeek 后,本文件保留“确定性指令”部分,语义回复切换到 reply.ts + providers。

export type PersonaConfig = {
  name: string;
  fallbackReplies: string[];
  commandReplies: Record<string, string>;
  /** P1 第三批:注入模型系统提示的人设描述;缺省时只用 name。 */
  systemPrompt?: string;
};

export type GiftRuleConfig = {
  thanksTemplate: string; // 例:"谢谢 {user} 的 {gift} ×{count}!"
  celebrateText: string;
};

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

export function createRules(persona: PersonaConfig, giftRules: GiftRuleConfig) {
  let fallbackCursor = 0;

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

  function thanks(user: string, gift: string, count: number): string {
    return giftRules.thanksTemplate.replaceAll('{user}', user).replaceAll('{gift}', gift).replaceAll('{count}', String(count));
  }

  function celebrate(user: string, kind: string): string {
    return giftRules.celebrateText.replaceAll('{user}', user).replaceAll('{kind}', kind);
  }

  return { detectCommand, fallbackReply, thanks, celebrate };
}
