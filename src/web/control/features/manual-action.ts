import type { ControlContext } from '../main.js';
import { errorMessage } from '../../shared/dom.js';

// 角色试播:动作清单来自服务端角色视图(GET /api/control/character),
// 台词非空时随表演合成语音——口型类(loop)动作循环到语音结束。

type CharacterView = {
  petId: string;
  name: string;
  actions: Array<{ id: string; available: boolean; loop: boolean }>;
};

export function mountManualAction(context: ControlContext): void {
  const select = document.getElementById('manual-action') as HTMLSelectElement;
  const sayInput = document.getElementById('manual-say') as HTMLInputElement;
  const send = document.getElementById('manual-send') as HTMLButtonElement;

  void (async () => {
    const result = await context.request('/api/control/character', { method: 'GET' });
    if (!result.ok) {
      context.notify(errorMessage(result.body, '读取角色视图失败'), true);
      return;
    }
    const view = result.body as CharacterView;
    for (const action of view.actions) {
      const option = document.createElement('option');
      option.value = action.id;
      option.textContent = action.available
        ? (action.loop ? `${action.id} (循环)` : action.id)
        : `${action.id} (素材缺失)`;
      option.disabled = !action.available;
      select.append(option);
    }
  })();

  send.addEventListener('click', async () => {
    const actionId = select.value;
    const say = sayInput.value.trim();
    const result = await context.request('/api/control/action', {
      method: 'POST',
      body: JSON.stringify(say !== '' ? { actionId, say } : { actionId }),
    });
    if (result.ok) context.notify(say !== '' ? `已试播 ${actionId} 带台词` : `已点播动作 ${actionId},等待当前表演结束后执行`);
    else context.notify(errorMessage(result.body, '试播失败'), true);
  });
}
