import type { ControlContext } from '../main.js';
import { errorMessage } from '../../shared/dom.js';

// 手动动作点播:动作列表来自冻结的 P0 标准动作集合,服务端按清单白名单再校验。

export function mountManualAction(context: ControlContext, actionIds: string[]): void {
  const select = document.getElementById('manual-action') as HTMLSelectElement;
  const send = document.getElementById('manual-send') as HTMLButtonElement;

  for (const id of actionIds) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id;
    select.append(option);
  }

  send.addEventListener('click', async () => {
    const actionId = select.value;
    const result = await context.request('/api/control/action', { method: 'POST', body: JSON.stringify({ actionId }) });
    if (result.ok) context.notify(`已点播动作 ${actionId},等待当前表演结束后执行`);
    else context.notify(errorMessage(result.body, '点播失败'), true);
  });
}
