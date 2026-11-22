import { describe, expect, it } from 'vitest';
import { createRules, resolveGiftRules, resolveGreetings, tierFor } from './rules.js';

// P2 互动第二批:礼物三档分层——边界、兼容回退与模板占位符。

describe('tierFor 档位边界', () => {
  const th = { smallMaxYuan: 1, largeMinYuan: 10 };

  it('实付低于小额上限为小额', () => {
    expect(tierFor(0.99, true, th)).toBe('small');
  });

  it('达到小额上限为中额(下界含)', () => {
    expect(tierFor(1, true, th)).toBe('mid');
  });

  it('大额下限之下为中额', () => {
    expect(tierFor(9.99, true, th)).toBe('mid');
  });

  it('达到大额下限为大额(下界含)', () => {
    expect(tierFor(10, true, th)).toBe('large');
  });

  it('免费/银瓜子/未知价格一律小额,不冒进高档(v1.1 修正 2)', () => {
    expect(tierFor(0, true, th)).toBe('small');
    expect(tierFor(0, false, th)).toBe('small');
    // 金额未知(paidKnown=false)即使携带非零数值也不升档
    expect(tierFor(15, false, th)).toBe('small');
  });
});

describe('resolveGiftRules 兼容回退', () => {
  it('旧字段作缺档回退,缺省档位用内置默认动作', () => {
    const r = resolveGiftRules({ thanksTemplate: '谢谢 {user}!', celebrateText: '{kind}!' });
    expect(r.tiers.small.template).toBe('谢谢 {user}!');
    expect(r.tiers.small.action).toBe('talk-nod');
    expect(r.tiers.mid.action).toBe('laugh');
    expect(r.tiers.large.template).toBe('{kind}!');
    expect(r.tiers.large.action).toBe('stamp-letter');
    expect(r.mergedThanksTemplate).toContain('{names}');
  });

  it('显式 tiers 优先于旧字段', () => {
    const r = resolveGiftRules({ thanksTemplate: '旧模板', tiers: { small: { action: 'wave', template: '新模板 {user}' } } });
    expect(r.tiers.small.action).toBe('wave');
    expect(r.tiers.small.template).toBe('新模板 {user}');
  });
});

describe('thanksText 与 mergedThanks 模板', () => {
  const persona = { name: '大肥鱼', fallbackReplies: ['x'], commandReplies: {} };

  it('金额格式化:整除去小数,小数保留两位内', () => {
    const rr = createRules(persona, resolveGiftRules({ tiers: { large: { action: 'stamp-letter', template: '{user} 的{gift}({amount}元)!' } } }), resolveGreetings({}));
    expect(rr.thanksText('large', { user: '甲', gift: '火箭', amountYuan: 15.5 })).toBe('甲 的火箭(15.5元)!');
    expect(rr.thanksText('large', { user: '甲', gift: '火箭', amountYuan: 10 })).toBe('甲 的火箭(10元)!');
    expect(rr.thanksText('large', { user: '甲', gift: '火箭', amountYuan: 0.1 })).toBe('甲 的火箭(0.1元)!');
  });

  it('{kind} 与 {gift} 等值(大航海/醒目留言复用大额模板)', () => {
    const rr = createRules(persona, resolveGiftRules({ celebrateText: '欢迎 {user} 的{kind}!' }), resolveGreetings({}));
    expect(rr.thanksText('large', { user: '舰长甲', gift: '大航海' })).toBe('欢迎 舰长甲 的大航海!');
  });

  it('count/amount 未提供时占位符替换为空串,不留孤立花括号', () => {
    const rr = createRules(persona, resolveGiftRules({}), resolveGreetings({}));
    const text = rr.thanksText('large', { user: '甲', gift: '火箭' });
    expect(text).not.toContain('{');
    expect(text).toContain('甲');
  });

  it('mergedThanks 替换 {names}', () => {
    const rr = createRules(persona, resolveGiftRules({ mergedThanksTemplate: '感谢 {names} 的礼物!' }), resolveGreetings({}));
    expect(rr.mergedThanks('甲、乙 等朋友')).toBe('感谢 甲、乙 等朋友 的礼物!');
  });
});
