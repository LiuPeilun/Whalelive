import type { ControlContext } from '../main.js';
import { errorMessage } from '../../shared/dom.js';

// 顶栏:暂停 / 恢复 / 紧急停止 与运行状态展示。

export function mountStatusBar(context: ControlContext): void {
  const btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
  const btnResume = document.getElementById('btn-resume') as HTMLButtonElement;
  const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
  const runPill = document.getElementById('run') as HTMLElement;
  const schedPill = document.getElementById('sched') as HTMLElement;
  const rendPill = document.getElementById('rend') as HTMLElement;

  async function post(path: string, okText: string): Promise<void> {
    const result = await context.request(path, { method: 'POST' });
    if (result.ok) context.notify(okText);
    else context.notify(errorMessage(result.body, '命令失败'), true);
  }

  btnPause.addEventListener('click', () => void post('/api/control/pause', '已暂停调度'));
  btnResume.addEventListener('click', () => void post('/api/control/resume', '已恢复调度'));
  btnStop.addEventListener('click', () => {
    if (window.confirm('紧急停止将清空待播队列并终止当前表演,保持暂停直至手动恢复。继续?')) {
      void post('/api/control/stop', '已紧急停止');
    }
  });

  context.onState((state) => {
    runPill.textContent = `run:${state.runId.slice(0, 12)}`;
    schedPill.textContent = state.paused ? '调度:已暂停' : '调度:运行中';
    schedPill.className = `pill ${state.paused ? 'bad' : 'ok'}`;
    const lease = state.renderers.leaseHolderRendererId ? `(租约 ${state.renderers.leaseHolderRendererId})` : '';
    rendPill.textContent = `播放端:${state.renderers.count} ${lease}`;
  });
}
