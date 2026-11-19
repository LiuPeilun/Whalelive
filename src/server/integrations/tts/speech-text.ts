// msedge-tts 将输入拼入 SSML，弹幕回复与礼物感谢都应作为普通文本处理。
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML_RE = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

/** 普通文本 → SSML 文本节点安全内容;全部字符非法时返回空串 */
export function sanitizeSpeechText(text: string): string {
  return text
    .replace(ILLEGAL_XML_RE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
