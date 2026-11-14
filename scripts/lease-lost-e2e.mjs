// WT-P0-007 协议级验证:租约到期后服务端立即结算归属表演并补发停止,
// 队列继续调度,重新取得播放权后下一表演可执行,旧回执保持失效。
// 用法:先启动服务,再执行 node scripts/lease-lost-e2e.mjs [port]
// 会临时修改租约设置(ttl 3000 / 续租 1000),结束后恢复原用户设置。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? process.env.PORT ?? 3210);
const base = `http://127.0.0.1:${port}`;
const access = JSON.parse(fs.readFileSync(path.join(root, 'data', 'access.json'), 'utf8'));
const controlAuth = { authorization: `Bearer ${access.control}`, 'content-type': 'application/json' };

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requestLeaseWithRetry(maxMs = 12000) {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const mark = received.length; // 只匹配本次请求之后的新 lease-result,避免命中旧租约消息
    socket.send(JSON.stringify({ kind: 'lease-request' }));
    const r = await waitFor((m) => (m.kind === 'lease-result' ? m : undefined), 3000, mark);
    if (r?.ok) return r;
    if (Date.now() > deadline) return r ?? null;
  }
}

async function http(pathname, init) {
  const response = await fetch(`${base}${pathname}`, init);
  let body = null;
  try { body = await response.json(); } catch { /* ignore */ }
  return { status: response.status, body };
}

// 恢复调度(此前端到端可能留下暂停态),并等待遗留任务自愈清空:
// 其他脚本遗留的礼物感谢/未回执表演会挡住本场景的派发时序;
// 无渲染端(NO_RENDERER 3 秒)或预加载超时(8 秒)后服务端自行结算。
await http('/api/control/resume', { method: 'POST', headers: { authorization: `Bearer ${access.control}` } });
{
  const deadline = Date.now() + 25_000;
  for (;;) {
    const s = await http('/api/state', { headers: { authorization: `Bearer ${access.control}` } });
    if (s.body.current === null && s.body.queue?.length === 0) break;
    if (Date.now() > deadline) {
      console.log(`WARN: 遗留任务未在 25 秒内清空(current=${JSON.stringify(s.body.current)}),继续执行`);
      break;
    }
    await sleep(500);
  }
}
const original = await http('/api/settings', { headers: { authorization: `Bearer ${access.control}` } });
const originalVersion = original.body.savedVersion;
const originalSettings = original.body.user;

// 临时收紧租约:ttl 3000 / 续租 1000(处于现有校验范围)
const tightened = JSON.parse(JSON.stringify(originalSettings));
tightened.lease = { ttlMs: 3000, renewIntervalMs: 1000 };
const tightenResult = await http('/api/settings', {
  method: 'PUT',
  headers: controlAuth,
  body: JSON.stringify({ expectedVersion: originalVersion, settings: tightened }),
});
check('临时租约设置生效', tightenResult.status === 200, JSON.stringify(tightenResult.body));

// 播放端:认证 → 登记 → 取租约 → 接收 dance → 回 ready/started → 停止续租
const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
const received = [];
let assignedRendererId = null; // 服务端分配,回执必须携带
const waiters = [];

function waitFor(predicate, timeoutMs, fromIndex = 0) {
  return new Promise((resolve) => {
    const existing = received.slice(fromIndex).find(predicate);
    if (existing !== undefined) {
      resolve(existing);
      return;
    }
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    waiters.push({ predicate, resolve: (value) => { clearTimeout(timer); resolve(value); }, timer });
  });
}

let dancePerformanceId = null; // 由 dance 派发回调登记:该表演不自动结束,等待租约失效

socket.on('message', (data) => {
  const msg = JSON.parse(String(data));
  received.push(msg);
  if (msg.kind === 'performance') {
    // 像真实播放页一样对所有派发回执;非 dance 的遗留表演 300ms 内自愈结束,
    // dance 保持进行中以便观察租约失效(WT-P0-007 场景)。
    const dispatch = msg.dispatch;
    const sendReport = (status) => socket.send(JSON.stringify({
      kind: 'playback-report',
      report: { runId: dispatch.runId, leaseId: dispatch.leaseId, performanceId: dispatch.performance.id, rendererId: assignedRendererId, track: 'animation', status, at: Date.now() },
    }));
    sendReport('ready');
    sendReport('started');
    if (dispatch.performance.action !== 'dance') {
      setTimeout(() => sendReport('ended'), 300);
    } else if (dancePerformanceId === null) {
      dancePerformanceId = dispatch.performance.id;
    }
  }
  for (const w of [...waiters]) {
    if (w.predicate(msg) !== undefined) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    }
  }
});

socket.on('open', () => {
  socket.send(JSON.stringify({ kind: 'auth', protocolVersion: 1, role: 'playback', credential: access.playback }));
});

async function submitChat(text, userId) {
  // 同用户 10 秒冷却会拒绝重复提交,尝试改用唯一用户 ID 重试
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await http('/api/mock/events', {
      method: 'POST',
      headers: controlAuth,
      body: JSON.stringify({ type: 'chat', text, userId: `${userId}-${Date.now()}-${attempt}`, userName: `租约员-${userId}` }),
    });
    if (r.status === 200 && r.body?.ingest === 'accepted' && r.body?.enqueue?.accepted !== false) return r;
    await sleep(1200);
  }
  return null;
}

// 1. 认证结果与租约
const authOk = await waitFor((m) => (m.kind === 'auth-result' ? m : undefined), 5000);
check('播放端认证成功', authOk?.ok === true, JSON.stringify(authOk));
socket.send(JSON.stringify({ kind: 'renderer-register' }));
const registered = await waitFor((m) => (m.kind === 'renderer-registered' ? m : undefined), 5000);
assignedRendererId = registered?.rendererId ?? null;
const lease1 = await requestLeaseWithRetry();
check('取得初始租约', lease1?.ok === true, JSON.stringify(lease1));

// 2. 派发 dance,回 ready/started,然后停止续租
const danceSubmit = await submitChat('大肥鱼跳个舞', 'lease-dance');
check('dance 事件入队', danceSubmit !== null, JSON.stringify(danceSubmit?.body));
const dance = await waitFor((m) => (m.kind === 'performance' && m.dispatch.performance.action === 'dance' ? m : undefined), 8000);
check('dance 已派发且携带租约', dance?.dispatch?.leaseId != null, JSON.stringify(dance?.dispatch?.leaseId));

// 3. 不续租:等待服务端租约回收 → stop 下发 + 会话结算
const stopMsg = await waitFor((m) => (m.kind === 'stop' && m.performanceId === dancePerformanceId ? m : undefined), 10000);
check('租约到期后服务端下发 stop(WT-P0-007)', stopMsg !== undefined, '等待 stop 超时');
// 轮询等待:遗留礼物等表演会紧随其后自愈派发并结算,断言“最终不被阻塞”而非瞬时快照
const leaseLostLog = await (async () => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const st = await http('/api/state', { headers: { authorization: `Bearer ${access.control}` } });
    if (st.body.current === null || Date.now() > deadline) return st;
    await sleep(300);
  }
})();
check('会话已结束,队列不被阻塞', leaseLostLog.body.current === null, JSON.stringify(leaseLostLog.body.current));

// 4. 重新取得播放权(服务端此刻已空闲),再派发下一表演:派发携带新租约
const lease2 = await requestLeaseWithRetry();
check('重新取得新租约', lease2?.ok === true, JSON.stringify(lease2));

// 5. 队列未被旧会话阻塞:下一表演立即派发并以新租约完成
const waveSubmit = await submitChat('挥挥手', 'lease-wave');
check('wave 事件入队', waveSubmit !== null, JSON.stringify(waveSubmit?.body));
const wave = await waitFor((m) => (m.kind === 'performance' && m.dispatch.performance.action === 'wave' ? m : undefined), 8000);
check('下一表演(wave)被继续调度(WT-P0-007)', wave !== undefined, '等待 wave 派发超时');
if (wave && lease2?.ok) {
  // 通用回执已随派发上报;轮询等待服务端结算
  const stateAfter = await (async () => {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const st = await http('/api/state', { headers: { authorization: `Bearer ${access.control}` } });
      if (st.body.current === null || Date.now() > deadline) return st;
      await sleep(300);
    }
  })();
  check('新租约下的 wave 会话正常完成', stateAfter.body.current === null, JSON.stringify(stateAfter.body.current));
}

// 6. 旧会话的迟到回执保持失效:发送后服务仍正常响应
if (dance) {
  socket.send(JSON.stringify({
    kind: 'playback-report',
    report: { runId: dance.dispatch.runId, leaseId: dance.dispatch.leaseId, performanceId: dancePerformanceId, rendererId: assignedRendererId, track: 'animation', status: 'ended', at: Date.now() },
  }));
  socket.send(JSON.stringify({ kind: 'ping' }));
  const pong = await waitFor((m) => (m.kind === 'pong' ? m : undefined), 4000);
  check('迟到回执被忽略,服务保持可用(WT-P0-007)', pong !== undefined, '未收到 pong');
}

socket.close();

// 7. 恢复原用户设置
const fresh = await http('/api/settings', { headers: { authorization: `Bearer ${access.control}` } });
const restore = await http('/api/settings', {
  method: 'PUT',
  headers: controlAuth,
  body: JSON.stringify({ expectedVersion: fresh.body.savedVersion, settings: originalSettings }),
});
check('原租约设置已恢复', restore.status === 200, JSON.stringify(restore.body));

console.log(`\n租约失效验证:${passed} 通过,${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
