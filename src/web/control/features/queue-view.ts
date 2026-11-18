import type { ControlContext } from '../main.js';
import { clear, el } from '../../shared/dom.js';
import type { DropRecordView } from '../../../shared/protocol.js';

// 队列视图:容量、排队条目、当前任务与丢弃原因,全部来自服务端状态快照。

const REASON_LABELS: Record<string, string> = {
  expired: '已过期',
  'expired-on-arrival': '入队即过期',
  'capacity-evict-chat': '容量满,挤出旧聊天',
  'queue-full': '队列已满',
  'user-cooldown': '用户冷却中',
  'not-actionable': '无可执行内容',
  stopped: '紧急停止清空',
};

export function mountQueueView(context: ControlContext): void {
  const lenTag = document.getElementById('queue-len') as HTMLElement;
  const current = document.getElementById('current') as HTMLElement;
  const list = document.getElementById('queue-list') as HTMLUListElement;
  const dropList = document.getElementById('drop-list') as HTMLUListElement;

  function renderDrops(drops: DropRecordView[]): void {
    clear(dropList);
    if (drops.length === 0) {
      dropList.append(el('li', { className: 'muted', textContent: '暂无丢弃记录' }));
      return;
    }
    for (const drop of [...drops].reverse()) {
      const label = REASON_LABELS[drop.reason] ?? drop.reason;
      const cls = drop.reason === 'stopped' || drop.reason === 'queue-full' ? 'tag err' : 'tag warn';
      dropList.append(
        el('li', {}, [el('span', { className: cls, textContent: label }), el('span', { className: 'mono', textContent: drop.eventId })]),
      );
    }
  }

  context.onState((state) => {
    lenTag.textContent = `${state.queue.length} / ${state.queue.capacity}`;
    if (state.current) {
      const stageLabels: Record<string, string> = {
        waiting: '排队中',
        generating: '生成中',
        synthesizing: '合成中',
        dispatching: '派发中',
        'waiting-playback': '播放中',
      };
      const stage = stageLabels[state.current.stage] ?? state.current.stage;
      current.textContent = `${stage} ${state.current.action}(${state.current.performanceId ?? '-'}) ${state.current.say}`.trim();
    } else {
      current.textContent = state.paused ? '已暂停,等待恢复' : '空闲';
    }
    clear(list);
    if (state.queue.items.length === 0) {
      list.append(el('li', { className: 'muted', textContent: '队列为空' }));
    }
    for (const item of state.queue.items) {
      const waited = Math.max(0, state.serverTime - item.enqueuedAt);
      list.append(
        el('li', {}, [
          el('span', { className: 'tag', textContent: `${item.priority}` }),
          el('span', { className: 'tag', textContent: item.type }),
          el('span', { textContent: item.sayPreview || `动作 ${item.eventId}` }),
          el('span', { className: 'muted', textContent: `等待 ${(waited / 1000).toFixed(1)}s` }),
        ]),
      );
    }
    renderDrops(state.queue.dropped);
  });
}
