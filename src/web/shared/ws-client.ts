import type { ClientRole, WsClientMessage, WsServerMessage } from '../../shared/protocol.js';
import { PROTOCOL_VERSION } from '../../shared/protocol.js';

// 两个页面共用的 WS 客户端:认证握手、断线自动重连与状态回调。
// 凭据来自 URL fragment(不随 HTTP 请求发送),页面关闭时自动释放。
// 重连链必须永不中断:状态回调与构造异常都被捕获并计入探针(window.__wtWs),
// 供断线重连类问题(WT-P0-010)实测观察。连续握手悬挂时自愈重载页面,
// 穿透浏览器 socket 层在服务进程硬杀后可能的整体卡死(见 maybeReloadForStuckSockets)。

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

export type WsClientHandle = {
  send(message: WsClientMessage): boolean;
  close(): void;
};

export function readCredentialFromHash(): string | null {
  const raw = window.location.hash.replace(/^#/, '').trim();
  return raw.length > 0 ? raw : null;
}

export function createWsClient(opts: {
  role: ClientRole;
  credential: string;
  onMessage(message: WsServerMessage): void;
  onStatus(status: WsStatus): void;
}): WsClientHandle {
  let ws: WebSocket | null = null;
  let closedByUser = false;
  let retryMs = 800;
  let reconnects = 0;

  // 页面可观测探针(诊断用,不含敏感信息);events 为最近状态机事件环形缓冲
  const probe = { status: 'connecting' as WsStatus, reconnects: 0, lastError: null as string | null, events: [] as string[] };
  (window as unknown as { __wtWs?: typeof probe }).__wtWs = probe;
  function trace(event: string): void {
    probe.events.push(`${Date.now() % 100000}:${event}`);
    if (probe.events.length > 40) probe.events.shift();
  }

  function send(message: WsClientMessage): boolean {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  let connectSeq = 0; // 连接会话编号:被替换连接的全部事件失效(WT-P0-011)
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null; // 唯一待执行重连
  let connectTimeoutStreak = 0; // 连续握手悬挂次数,成功 open 归零
  let healCycle = 0; // 自愈周期:每次连接成功(open)推进,使上一周期的探测失效(WT-P1-010)

  // 自愈重载:服务进程被硬杀后,Edge/Chromium 对该地址的 WS socket 层可能整体
  // 卡死 —— HTTP 正常、其它端口 WS 立即失败,唯独本地址新 WS 永久 CONNECTING
  // (e2e-reconnect 实测,页面不重载则 65s+ 不恢复)。业务重试无法穿透 socket
  // 层,连续多次握手悬挂时重载页面重建网络栈;凭据在 URL fragment,重载即恢复。
  // 服务真宕机时握手是快速 error(被拒),不会累计悬挂,不会误触发。
  // 重载前先探测文档可用(WT-P1-010):服务/文档暂不可用(5xx 等)时重载会把
  // 页面留在错误文档上,探针与重连能力一并丢失;此时跳过本次,保持原页继续
  // 重试,文档恢复后下一轮自愈条件达成时再重载。
  async function maybeReloadForStuckSockets(): Promise<void> {
    connectTimeoutStreak += 1;
    if (connectTimeoutStreak < 3) return;
    connectTimeoutStreak = 0;
    const cycleAtProbe = healCycle; // 探测属于发起时的悬挂周期
    let docOk = false;
    try {
      const docProbe = await fetch(location.pathname + location.search, { cache: 'no-store' });
      docOk = docProbe.ok;
    } catch {
      docOk = false; // 文档请求失败(服务不可达):同样不重载
    }
    // 探测结果绑定发起时的周期与退出状态(WT-P1-010):悬置期间只要连接成功过
    // (周期已推进),旧探测即作废——即便随后再次断线、新一轮恢复尚未达到重试
    // 阈值,也不得提前刷新,中断页面自身的恢复过程。
    if (closedByUser || healCycle !== cycleAtProbe || probe.status === 'connected' || !docOk) return;
    try {
      const last = Number(sessionStorage.getItem('wtWsReloadAt') ?? '0');
      if (Date.now() - last < 30_000) return; // 防重载风暴:30s 内已重载过则退回纯重试
      sessionStorage.setItem('wtWsReloadAt', String(Date.now()));
    } catch {
      /* sessionStorage 不可用(隐私模式等)仍执行重载 */
    }
    location.reload();
  }

  function scheduleReconnect(): void {
    if (closedByUser) return;
    trace('scheduleReconnect');
    if (reconnectTimer !== null) return; // 同一次失败只进入一次重连调度
    probe.status = 'disconnected';
    probe.reconnects = reconnects;
    try {
      opts.onStatus('disconnected');
    } catch (err) {
      // 回调异常不得中断重连链
      probe.lastError = `onStatus: ${String(err)}`;
    }
    const wait = retryMs;
    retryMs = Math.min(retryMs * 2, 5000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, wait);
  }

  function connect(): void {
    if (closedByUser) return;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const myId = ++connectSeq;
    // 使被替换连接的全部事件失效,并关闭残存 socket(避免同页多业务连接)
    if (ws !== null) {
      const stale = ws;
      stale.onopen = null;
      stale.onmessage = null;
      stale.onerror = null;
      stale.onclose = null;
      try {
        if (stale.readyState !== WebSocket.CLOSED) stale.close();
      } catch {
        /* 忽略 */
      }
      ws = null;
    }
    let socket: WebSocket;
    try {
      probe.status = 'connecting';
      opts.onStatus('connecting');
      socket = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`);
    } catch (err) {
      probe.lastError = `construct: ${String(err)}`;
      scheduleReconnect();
      return;
    }
    ws = socket;
    trace(`connect id=${myId}`);
    // 悬挂守卫:CONNECTING 超过 10 秒(半开网络等)按失败处理并重排;
    // 立即使本连接全部事件失效(含竞态窗口内迟到的 open),浏览器随后的
    // 异步 close 也因代数失效,不会产生第二次调度(WT-P0-011)。
    const guard = setTimeout(() => {
      if (connectSeq !== myId) return;
      if (socket.readyState === WebSocket.CONNECTING) {
        trace(`guard-fire id=${myId} CONNECTING`);
        probe.lastError = 'connecting-timeout';
        reconnects += 1;
        connectSeq += 1; // 失效竞态窗口内迟到的 open/onclose
        try {
          socket.close();
        } catch {
          /* 忽略 */
        }
        void maybeReloadForStuckSockets(); // 异步探测文档,不阻塞本连接的重连调度
        scheduleReconnect();
      }
    }, 10_000);
    socket.onopen = () => {
      clearTimeout(guard);
      trace(`open id=${myId} seq=${connectSeq}`);
      if (connectSeq !== myId) {
        trace(`late-open-close id=${myId}`);
        // 迟到的成功连接属于已被替换的会话:直接关闭,避免同页第二连接
        try {
          socket.close();
        } catch {
          /* 忽略 */
        }
        return;
      }
      retryMs = 800;
      connectTimeoutStreak = 0;
      healCycle += 1; // 连接恢复:上一自愈周期的探测作废(WT-P1-010)
      probe.status = 'connected';
      opts.onStatus('connected');
      send({ kind: 'auth', protocolVersion: PROTOCOL_VERSION, role: opts.role, credential: opts.credential });
    };
    socket.onmessage = (event) => {
      if (connectSeq !== myId) return; // 旧连接消息不更新页面状态(WT-P0-011)
      try {
        opts.onMessage(JSON.parse(String(event.data)) as WsServerMessage);
      } catch (err) {
        // 消息处理异常不得影响连接与后续消息
        probe.lastError = `onMessage: ${String(err)}`;
      }
    };
    socket.onclose = () => {
      clearTimeout(guard);
      trace(`close id=${myId} ready=${socket.readyState}`);
      if (connectSeq !== myId) return; // 守卫已处理(浏览器异步 close 迟到)
      reconnects += 1;
      scheduleReconnect();
    };
    socket.onerror = () => {
      trace(`error id=${myId} ready=${socket.readyState}`);
      if (connectSeq !== myId) return;
      // 仅记录;CONNECTING 状态主动 close() 会吞掉后续 close 事件,
      // 连接失败时浏览器会自行派发 error + close(WT-P0-010 重连链死亡根因)
      probe.lastError = 'socket-error';
    };
  }

  connect();

  return {
    send,
    close() {
      closedByUser = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        ws?.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}

export async function apiFetch(path: string, credential: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  // 仅在确有请求体时声明 JSON Content-Type:空 POST 带 JSON 头会被 Fastify 按
  // 空请求体拒绝(FST_ERR_CTP_EMPTY_JSON_BODY),暂停/恢复/停止均为无体 POST。
  const headers: Record<string, string> = { authorization: `Bearer ${credential}` };
  if (init?.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers ?? {}),
    },
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}
