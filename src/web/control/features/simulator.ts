import type { ControlContext } from '../main.js';
import { errorMessage } from '../../shared/dom.js';

// 模拟器:文本弹幕、快捷按钮与连击礼物。

export function mountSimulator(context: ControlContext): void {
  const input = document.getElementById('sim-text') as HTMLInputElement;
  const send = document.getElementById('sim-send') as HTMLButtonElement;
  const quickButtons = document.querySelectorAll<HTMLButtonElement>('#sec-sim button[data-sim]');

  async function submit(body: Record<string, unknown>): Promise<void> {
    const result = await context.request('/api/mock/events', { method: 'POST', body: JSON.stringify(body) });
    if (!result.ok) {
      context.notify(errorMessage(result.body, '事件提交失败'), true);
      return;
    }
    const payload = result.body as { eventId: string; ingest: string; enqueue: { accepted: boolean; reason: string | null } | null };
    if (payload.ingest !== 'accepted') {
      context.notify(`事件被去重/校验拦截(${payload.ingest})`);
      return;
    }
    if (payload.enqueue && !payload.enqueue.accepted) {
      context.notify(`已接收但未入队:${payload.enqueue.reason ?? '未知原因'}`);
      return;
    }
    context.notify('事件已提交');
  }

  async function submitChat(text: string): Promise<void> {
    if (text.trim() === '') return;
    await submit({ type: 'chat', text });
  }

  send.addEventListener('click', () => {
    void submitChat(input.value);
    input.value = '';
    input.focus();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      void submitChat(input.value);
      input.value = '';
    }
  });

  for (const button of quickButtons) {
    const spec = button.dataset.sim ?? '';
    button.addEventListener('click', () => {
      const [type, arg] = spec.split(':');
      if (type === 'chat') void submit({ type: 'chat', text: arg ?? '' });
      else if (type === 'gift') {
        const quantity = Number(arg ?? '1');
        // 连击:同一用户快速提交多条独立增量事件,由 2 秒窗口合并为一条感谢。
        for (let i = 0; i < quantity; i++) {
          void submit({ type: 'gift', userId: 'combo-user', userName: '连击测试员', gift: { id: 'xinxin', name: '小心心', quantity: 1 } });
        }
      } else if (type === 'guard' || type === 'superchat') {
        void submit({ type, userId: 'vip-user', userName: '贵宾测试员' });
      }
    });
  }
}
