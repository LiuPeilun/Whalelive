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

const COMMAND_PATTERNS: { action: string; pattern: RegExp }[] = [
  { action: 'dance', pattern: /(跳个舞|跳舞|跳一支舞|来段舞)/ },
  { action: 'wave', pattern: /(挥手|打个招呼|say hi|嗨|哈喽|你好呀|大家好)/ },
  { action: 'eat', pattern: /(吃什么|吃饭|干饭|吃点啥)/ },
  { action: 'think', pattern: /(想想|思考一下|想一下|为什么)/ },
  { action: 'gift', pattern: /(拆礼物|开礼物)/ },
];

export function createRules(persona: PersonaConfig, giftRules: GiftRuleConfig) {
  let fallbackCursor = 0;

  /** 确定性指令检测:命中返回动作与固定回复,语义弹幕返回 null(出队后走回复提供方)。 */
  function detectCommand(text: string): { action: string; say: string } | null {
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
