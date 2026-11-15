// WT-P0-007 协议级验证:租约到期后服务端立即结算归属表演并补发停止,
// 下一项在租约失效前已排入,自动推进时以新派发身份(空租约)回执并被接受,
// 模拟页面续租失败后重新取得租约;旧回执保持失效。结束后恢复原用户设置。
// 用法:先启动服务,再执行 node scripts/lease-lost-e2e.mjs [port]

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

async function http(pathname, init) {
  const response = await fetch(`${base}${pathname}`, init);
  let body = null;
  try { body = await response.json(); } catch { /* ignore */ }
  return { status: response.status, body };
}

// 恢复调度并等待遗留任务自愈清空(NO_RENDERER 3 秒 / 预加载超时 8 秒)
await http('/api/control/resume', { method: 'POST', headers: { authorization: `Bearer ${access.control}` } });
{
  const deadline = Date.now() + 25_000;
  for (;;) {
    const s = await http('/api/state', { headers: { authorization: `Bearer ${access.control}` } });
    if (s.body.current === null && s.body.queue?.length === 0) break;
    if (Date.now() > deadline) {
      console.log('WARN: 遗留任务未在 25 秒内清空,继续执行');
      break;
    }
    await sleep(500);
  }
}

// 读取原设置并临时收紧租约(ttl 3000 / 续租 1000,处于现有校验范围)
const original = await http('/api/settings', { headers: { authorization: `Bearer ${access.control}` } });
const originalVersion = original.body.savedVersion;
const originalSettings = original.body.user;
const tightened = JSON.parse(JSON.stringify(originalSettings));
tightened.lease = { ttlMs: 3000, renewIntervalMs: 1000 };
const tightenResult = await http('/api/settings', {
  method: 'PUT',
  headers: controlAuth,
  body: JSON.stringify({ expectedVersion: originalVersion, settings: tightened }),
});
check('临时租约设置生效', tightenResult.status === 200, JSON.stringify(tightenResult.body));

// ---------- 播放端模拟:认证 → 登记 → 租约 → 表演回执(绑定派发身份)→ 续租失败处理 ----------
const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
const received = [];
let assignedRendererId = null;
let pageLeaseId = null; // 页面当前持有的租约
let currentDispatchLeaseId = null; // 当前表演派发时的租约快照(回执与停止的归属依据,WT-P0-007)
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

let renewTimer = null;
function startRenewLoop(leaseIdForRenew, renewIntervalMs) {
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = setInterval(() => {
    if (pageLeaseId === leaseIdForRenew) socket.send(JSON.stringify({ kind: 'lease-renew', leaseId: leaseIdForRenew }));
  }, renewIntervalMs);
}
function stopRenewLoop() {
  if (renewTimer) {
    clearInterval(renewTimer);
    renewTimer = null;
  }
}

socket.on('message', (data) => {
  const msg = JSON.parse(String(data));
  received.push(msg);
  if (msg.kind === 'performance') {
    // 像真实播放页一样回执所有派发,租约使用派发身份快照(WT-P0-007)
    const dispatch = msg.dispatch;
    currentDispatchLeaseId = dispatch.leaseId;
    const sendReport = (status) => socket.send(JSON.stringify({
      kind: 'playback-report',
      report: { runId: dispatch.runId, leaseId: currentDispatchLeaseId, performanceId: dispatch.performance.id, rendererId: assignedRendererId, track: 'animation', status, at: Date.now() },
    }));
    sendReport('ready');
    sendReport('started');
    if (dispatch.performance.action !== 'dance') {
      // 非 dance 的派发(自动推进/遗留表演)按真实页面行为自愈结束
      setTimeout(() => sendReport('ended'), 300);
    }
  }
  if (msg.kind === 'lease-result' && msg.ok === false) {
    // 续租失败:失效租约=pageLeaseId;按派发身份过滤,空租约/新租约派发的表演继续播放
    const lostLeaseId = pageLeaseId;
    pageLeaseId = null;
    stopRenewLoop();
    const affected = currentDispatchLeaseId !== null && currentDispatchLeaseId === lostLeaseId;
    console.log(`续租失败(${msg.code}):失效租约=${lostLeaseId ?? '-'} 当前表演派发身份=${currentDispatchLeaseId ?? '-'} → ${affected ? '停止归属表演' : '不停止(派发身份已更新)'}`);
    void requestLeaseWithRetry().then((r) => {
      if (r?.ok) {
        pageLeaseId = r.leaseId;
        startRenewLoop(r.leaseId, 1000);
      }
    });
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

async function waitForIdle(maxMs = 12_000) {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const st = await http('/api/state', { headers: { authorization: `Bearer ${access.control}` } });
    if (st.body.current === null || Date.now() > deadline) return st;
    await sleep(300);
  }
}

// ---------- 场景执行 ----------
const authOk = await waitFor((m) => (m.kind === 'auth-result' ? m : undefined), 5000);
check('播放端认证成功', authOk?.ok === true, JSON.stringify(authOk));
socket.send(JSON.stringify({ kind: 'renderer-register' }));
const registered = await waitFor((m) => (m.kind === 'renderer-registered' ? m : undefined), 5000);
assignedRendererId = registered?.rendererId ?? null;
const lease1 = await requestLeaseWithRetry();
check('取得初始租约', lease1?.ok === true, JSON.stringify(lease1));
if (lease1?.ok) {
  pageLeaseId = lease1.leaseId;
  startRenewLoop(lease1.leaseId, 1000);
}

// dance 派发并回执(绑定派发身份)
await submitChat('大肥鱼跳个舞', 'lease-dance');
const dance = await waitFor((m) => (m.kind === 'performance' && m.dispatch.performance.action === 'dance' ? m : undefined), 8000);
check('dance 已派发且携带租约', dance?.dispatch?.leaseId != null, JSON.stringify(dance?.dispatch?.leaseId));
const dancePerformanceId = dance?.dispatch?.performance?.id ?? null;

// 模拟页面本地截止看门狗(ttl+1500ms):按派发身份过滤,仅停止归属表演,并重新申请租约
setTimeout(() => {
  const lostLeaseId = pageLeaseId;
  if (lostLeaseId === null) return;
  pageLeaseId = null;
  stopRenewLoop();
  const affected = currentDispatchLeaseId !== null && currentDispatchLeaseId === lostLeaseId;
  console.log(`本地看门狗触发:失效租约=${lostLeaseId} 当前表演派发身份=${currentDispatchLeaseId ?? '-'} → ${affected ? '停止归属表演' : '不停止(派发身份已更新)'}`);
  void requestLeaseWithRetry().then((r) => {
    if (r?.ok) {
      pageLeaseId = r.leaseId;
      startRenewLoop(r.leaseId, 1000);
    }
  });
}, 3000 + 1500);

// wave 在租约失效之前入队(审核要求的顺序:自动推进的真实空窗)
const waveSubmit = await submitChat('挥挥手', 'lease-wave');
check('wave 在租约失效前入队', waveSubmit !== null, JSON.stringify(waveSubmit?.body));

// 停止续租(模拟页面 renew 被拦截):等待租约回收 → dance LEASE_LOST + stop 下发
stopRenewLoop();
const stopMsg = await waitFor((m) => (m.kind === 'stop' && m.performanceId === dancePerformanceId ? m : undefined), 10000);
check('租约到期后服务端下发 stop(WT-P0-007)', stopMsg !== undefined, '等待 stop 超时');

// 自动推进:wave 派发,携带新派发身份(空租约)
const wave = await waitFor((m) => (m.kind === 'performance' && m.dispatch.performance.action === 'wave' ? m : undefined), 10000);
check('wave 自动推进且派发身份为空租约(WT-P0-007)', wave?.dispatch?.leaseId === null, JSON.stringify(wave?.dispatch?.leaseId));

// wave 以派发身份回执,正常完成(不再依赖旧租约或预加载看门狗)
const stateAfter = await waitForIdle(8000);
check('wave 回执按派发身份被接受并完成(WT-P0-007)', stateAfter.body.current === null, JSON.stringify(stateAfter.body.current));

// 页面续租失败链路已在消息处理中发生;确认页面重新取得租约
const reacquired = await waitFor((m) => (m.kind === 'lease-result' && m.ok === true && m.leaseId !== lease1?.leaseId ? m : undefined), 8000);
check('页面续租失败后重新取得新租约', reacquired?.ok === true, JSON.stringify(reacquired));

// 旧会话的迟到回执保持失效:发送后服务仍正常响应
if (dance) {
  socket.send(JSON.stringify({
    kind: 'playback-report',
    report: { runId: dance.dispatch.runId, leaseId: dance.dispatch.leaseId, performanceId: dancePerformanceId, rendererId: assignedRendererId, track: 'animation', status: 'ended', at: Date.now() },
  }));
  socket.send(JSON.stringify({ kind: 'ping' }));
  const pong = await waitFor((m) => (m.kind === 'pong' ? m : undefined), 4000, received.length);
  check('迟到回执被忽略,服务保持可用(WT-P0-007)', pong !== undefined, '未收到 pong');
}

stopRenewLoop();
socket.close();

// 恢复原用户设置
const fresh = await http('/api/settings', { headers: { authorization: `Bearer ${access.control}` } });
const restore = await http('/api/settings', {
  method: 'PUT',
  headers: controlAuth,
  body: JSON.stringify({ expectedVersion: fresh.body.savedVersion, settings: originalSettings }),
});
check('原租约设置已恢复', restore.status === 200, JSON.stringify(restore.body));

console.log(`\n租约失效验证:${passed} 通过,${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
