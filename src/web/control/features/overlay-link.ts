import type { ControlContext } from '../main.js';
import { errorMessage } from '../../shared/dom.js';

// OBS 播放页链接:由服务端按播放端凭据生成,通过控制台凭据保护的接口下发并复制。

export function mountOverlayLink(context: ControlContext): void {
  const box = document.getElementById('overlay-url') as HTMLInputElement;
  const copy = document.getElementById('overlay-copy') as HTMLButtonElement;

  async function load(): Promise<void> {
    const result = await context.request('/api/overlay-link');
    if (!result.ok) {
      box.value = '';
      context.notify(errorMessage(result.body, '无法获取播放页链接'), true);
      return;
    }
    box.value = (result.body as { url: string }).url;
  }

  copy.addEventListener('click', async () => {
    if (box.value === '') return;
    try {
      await navigator.clipboard.writeText(box.value);
      context.notify('已复制 OBS 播放页链接(含播放端凭据,请勿外传)');
    } catch {
      box.select();
      context.notify('复制失败,请手动复制文本框内容', true);
    }
  });

  void load();
}
