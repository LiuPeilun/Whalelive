import type { ControlContext } from '../main.js';
import { clear, el, errorMessage } from '../../shared/dom.js';
import type { SingingJobsView, SongJobStage, SongJobView } from '../../../shared/singing.js';
import { createSingingPoller } from './singing-poller.js';

// 点歌任务面板:GET /api/singing/jobs 的只读展示(阶段 / 成片试听 / 失败原因)。
// 标题来自观众弹幕、来源标题来自 B 站、失败原因含子进程输出——一律经文本节点写入。

const STAGE_LABELS: Record<SongJobStage, string> = {
  queued: '排队中',
  fetching: '搜歌下载',
  separating: '人声分离',
  analyzing: '音高分析',
  converting: '换声中',
  cancelling: '取消中',
  ready: '已就绪',
  failed: '失败',
};

const STAGE_TONE: Record<SongJobStage, '' | 'ok' | 'warn' | 'err'> = {
  queued: '', fetching: '', separating: '', analyzing: '', converting: '',
  cancelling: 'warn', ready: 'ok', failed: 'err',
};

const STEP_FAILURES: Record<string, string> = {
  fetch: '取歌失败(B站搜歌、下载或切片)',
  separate: '人声分离失败',
  analyze: '音高分析失败',
  convert: '换声失败',
};

/** 成片被缓存淘汰后的提示(任务结果保留,试听资源已不在)。 */
const EXPIRED_NOTE = '成片缓存已被淘汰,重新点歌即可再生成';

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? text;
}

function lastLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return lines[lines.length - 1] ?? text;
}

/** 失败原因 → 面向操作者的一行说明(完整原文由 failureDetail 放入悬停提示)。
 *  管线步骤失败的输出是 Python traceback,异常信息在最后一行;其余错误取首行。 */
export function describeFailure(error: string): string {
  if (error === 'cancelled') return '已取消(紧急停止中止了制作)';
  if (error.startsWith('queue-full')) {
    const detail = error.slice('queue-full:'.length).trim();
    return `成片已做好,但待播队列已满,没能排入播放${detail === '' ? '' : `(${detail})`}`;
  }
  const step = /^([a-z]+): /.exec(error);
  if (step === null) return firstLine(error);
  const essence = lastLine(error.slice(step[0].length));
  const label = STEP_FAILURES[step[1] ?? ''];
  return label === undefined ? essence : `${label}:${essence}`;
}

/** 失败原文(去掉步骤名前缀),供悬停查看完整信息。 */
export function failureDetail(error: string): string {
  return error.replace(/^[a-z]+: /, '');
}

/** 在途任务显示已用时长,已结束任务显示总耗时。 */
export function elapsedLabel(job: Pick<SongJobView, 'stage' | 'startedAt' | 'updatedAt'>, nowMs: number): string {
  const ended = job.stage === 'ready' || job.stage === 'failed';
  const ms = Math.max(0, (ended ? job.updatedAt : nowMs) - job.startedAt);
  return `${ended ? '耗时' : '已用'} ${Math.floor(ms / 1000)} 秒`;
}

/** f0 自适应移调(半音数);缓存成片的移调值未知,不展示。 */
export function keyLabel(key: number): string {
  if (key > 0) return `升调 ${key} 半音`;
  if (key < 0) return `降调 ${-key} 半音`;
  return '原调';
}

function isJobsView(body: unknown): body is SingingJobsView {
  return typeof body === 'object' && body !== null && Array.isArray((body as SingingJobsView).jobs);
}

type Entry = {
  li: HTMLLIElement;
  head: HTMLElement;
  elapsed: HTMLElement;
  body: HTMLElement;
  audio: HTMLAudioElement | null;
  signature: string;
};

export function mountSingingView(context: ControlContext): void {
  const list = document.getElementById('singing-list') as HTMLUListElement;
  const enabledTag = document.getElementById('singing-enabled') as HTMLElement;
  const activeTag = document.getElementById('singing-active') as HTMLElement;
  const note = document.getElementById('singing-note') as HTMLElement;
  const placeholder = el('li', { className: 'muted', textContent: '暂无点歌任务' });
  const entries = new Map<string, Entry>();
  let hasActive = false;

  // 按 jobId 复用行节点:取数期间只更新变化的任务,已就绪任务的试听 <audio> 不被重建
  function render(view: SingingJobsView): void {
    const nowMs = Date.now();
    enabledTag.textContent = view.enabled ? '唱歌:已开启' : '唱歌:已关闭';
    enabledTag.className = `tag ${view.enabled ? 'ok' : 'err'}`;
    activeTag.textContent = `在途 ${view.active} / ${view.maxActive}`;

    if (view.jobs.length === 0) {
      placeholder.remove();
      for (const entry of entries.values()) discard(entry);
      entries.clear();
      list.append(placeholder);
      return;
    }
    placeholder.remove();
    const seen = new Set<string>();
    view.jobs.forEach((job, index) => {
      seen.add(job.jobId);
      let entry = entries.get(job.jobId);
      if (entry === undefined) {
        const head = el('div', { className: 'job-head' });
        const elapsed = el('span', { className: 'muted' });
        const body = el('div', { className: 'job-body' });
        entry = { li: el('li', { className: 'job' }, [head, elapsed, body]), head, elapsed, body, audio: null, signature: '' };
        entries.set(job.jobId, entry);
      }
      const signature = JSON.stringify(job);
      if (signature !== entry.signature) {
        entry.signature = signature;
        clear(entry.head);
        entry.head.append(
          el('span', { className: STAGE_TONE[job.stage] === '' ? 'tag' : `tag ${STAGE_TONE[job.stage]}`, textContent: STAGE_LABELS[job.stage] }),
          ...(job.cached ? [el('span', { className: 'tag', textContent: '缓存成片' })] : []),
          el('span', { className: 'job-title', textContent: job.title }),
          ...(job.key === null ? [] : [el('span', { className: 'tag', textContent: keyLabel(job.key) })]),
        );
        clear(entry.body);
        entry.body.append(
          ...(job.chosenTitle === null ? [] : [el('div', { className: 'muted', textContent: `来源:${job.chosenTitle}` })]),
          ...(job.stage === 'failed'
            ? [el('div', { className: 'job-error mono', textContent: describeFailure(job.error ?? '未知原因'), title: failureDetail(job.error ?? '未知原因') })]
            : []),
          // WT-P3-029:成片已被缓存淘汰时任务结果保留,如实反映试听资源当前不可用
          ...(job.stage === 'ready' && job.audioAvailable === false
            ? [el('div', { className: 'muted job-expired', textContent: EXPIRED_NOTE })]
            : []),
        );
        const audioUrl = job.audioUrl;
        const audioUsable = job.stage === 'ready' && audioUrl !== null && job.audioAvailable !== false;
        if (audioUsable && entry.audio === null) {
          // 成片地址由服务端按缓存文件名生成(/media/audio/song-<hash>.mp3),不经观众输入
          const audio = document.createElement('audio');
          audio.controls = true;
          audio.preload = 'none';
          audio.src = audioUrl;
          entry.audio = audio;
          entry.li.append(audio);
        }
        if (!audioUsable && entry.audio !== null) {
          // 成片淘汰:停止并移除指向已失效地址的试听元素
          entry.audio.pause();
          entry.audio.remove();
          entry.audio = null;
        }
      }
      entry.elapsed.textContent = elapsedLabel(job, nowMs);
      // 服务端已按开始时间倒序(最新在前);仅位置不符时移动,不打断正在播放的试听
      if (list.children[index] !== entry.li) list.insertBefore(entry.li, list.children[index] ?? null);
    });
    for (const [jobId, entry] of entries) {
      if (seen.has(jobId)) continue;
      entries.delete(jobId);
      discard(entry);
    }
  }

  function discard(entry: Entry): void {
    entry.audio?.pause(); // 脱离文档的 <audio> 不会自行停声
    entry.li.remove();
  }

  const poller = createSingingPoller({
    request: () => context.request('/api/singing/jobs', { method: 'GET' }),
    onData(body) {
      if (!isJobsView(body)) {
        note.textContent = '点歌任务数据格式异常,稍后重试';
        return;
      }
      note.textContent = '';
      render(body);
      hasActive = body.active > 0;
    },
    onFailure(response) {
      // 凭据失效不会自行恢复(需用新链接重开页面):停止轮询,避免反复弹错
      if (response !== null && (response.status === 401 || response.status === 403)) {
        note.textContent = '凭据无效,点歌任务已停止刷新:请用服务启动时输出的控制台链接重新打开本页。';
        if (response.status === 403) context.notify(errorMessage(response.body, '读取点歌任务失败'), true);
        return 'stop';
      }
      note.textContent = '读取点歌任务失败,正在自动重试…';
      return 'continue';
    },
    isActive: () => hasActive,
  });
  // 任何状态推送都可能伴随新点歌(确认入队即推送):立即刷新,不等轮询周期
  context.onState(() => poller.refresh());
  // 后台标签页的定时器会被浏览器节流,回到页面时立即取数
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poller.refresh();
  });
  poller.refresh();
}
