// 轻量 DOM 构建工具:观众内容一律通过文本节点写入,不使用 innerHTML 拼接。

type ElAttrs = { className?: string; textContent?: string; title?: string };

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: ElAttrs = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs.className) node.className = attrs.className;
  if (attrs.textContent !== undefined) node.textContent = attrs.textContent;
  if (attrs.title) node.title = attrs.title;
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).message === 'string') {
    const code = (body as Record<string, unknown>).code;
    return `[${String(code)}] ${(body as Record<string, unknown>).message}`;
  }
  return fallback;
}
