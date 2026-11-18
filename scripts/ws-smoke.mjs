// P0 全链路冒烟:HTTP 鉴权、WS 认证握手、渲染端登记、租约、表演派发与回执闭环。
// 用法:先启动服务,再执行 node scripts/ws-smoke.mjs [port]
// 凭据直接读取 data/access.json(本机可信边界内的开发自检)。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? process.env.PORT ?? 3210);
const base = `http://127.0.0.1:${port}`;
const access = JSON.parse(fs.readFileSync(path.join(root, 'data', 'access.json'), 'utf8'));

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

function connectWs() {
  return new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
}

function withSocket(socket, onOpen, handlers, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const done = (value) => {
      try { socket.close(); } catch { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    socket.on('open', () => { onOpen(socket); });
    socket.on('message', (data) => {
      const msg = JSON.parse(String(data));
      const result = handlers(msg, socket);
      if (result !== undefined) {
        clearTimeout(timer);
        done(result);
      }
    });
    socket.on('close', (code) => {
      const result = handlers({ kind: '__closed__', code }, socket);
      if (result !== undefined) {
        clearTimeout(timer);
        done(result);
      }
    });
    socket.on('error', () => {});
  });
}

async function http(pathname, init) {
  const response = await fetch(`${base}${pathname}`, init);
  let body = null;
  try { body = await response.json(); } catch { /* ignore */ }
  return { status: response.status, body };
}

const controlAuth = { authorization: `Bearer ${access.control}` };

// 1. 健康检查
{
  const result = await http('/api/health');
  check('健康检查 200', result.status === 200 && result.body.ok === true, JSON.stringify(result.body));
}

// 2. 控制接口鉴权:无凭据拒绝
{
  const none = await http('/api/state');
  check('无凭据访问 /api/state 被拒(401)', none.status === 401, `status=${none.status}`);
  const playbackCred = await http('/api/state', { headers: { authorization: `Bearer ${access.playback}` } });
  check('播放端凭据访问控制接口被拒(401)', playbackCred.status === 401, `status=${playbackCred.status}`);
  const control = await http('/api/state', { headers: controlAuth });
  check('控制凭据访问 /api/state 通过', control.status === 200 && typeof control.body.runId === 'string');
}

// 3. WS:错误凭据被拒
{
  const outcome = await withSocket(
    connectWs(),
    (socket) => socket.send(JSON.stringify({ kind: 'auth', protocolVersion: 1, role: 'control', credential: 'wrong-token' })),
    (msg) => (msg.kind === 'auth-result' && msg.ok === false ? `rejected:${msg.code}` : undefined),
  );
  check('WS 错误凭据被拒', outcome === 'rejected:AUTH_REJECTED', String(outcome));
}

// 4. WS:协议版本不支持被拒
{
  const outcome = await withSocket(
    connectWs(),
    (socket) => socket.send(JSON.stringify({ kind: 'auth', protocolVersion: 99, role: 'control', credential: access.control })),
    (msg) => (msg.kind === 'auth-result' && msg.ok === false ? `rejected:${msg.code}` : undefined),
  );
  check('WS 协议版本不支持被拒', outcome === 'rejected:PROTOCOL_VERSION_UNSUPPORTED', String(outcome));
}

// 5. WS:跨角色凭据被拒(播放端凭据申请 control 角色)
{
  const outcome = await withSocket(
    connectWs(),
    (socket) => socket.send(JSON.stringify({ kind: 'auth', protocolVersion: 1, role: 'control', credential: access.playback })),
    (msg) => (msg.kind === 'auth-result' && msg.ok === false ? `rejected:${msg.code}` : undefined),
  );
  check('WS 跨角色凭据被拒', outcome === 'rejected:AUTH_REJECTED', String(outcome));
}

// 6. 全链路:播放端认证 → 登记 → 租约 → 弹幕 → 派发 → 回执 → 会话完成
{
  let rendererId = null;
  let sawCurrent = false;
  const outcome = await withSocket(
    connectWs(),
    (socket) => socket.send(JSON.stringify({ kind: 'auth', protocolVersion: 1, role: 'playback', credential: access.playback })),
    (msg, socket) => {
      if (msg.kind === 'auth-result' && msg.ok) {
        socket.send(JSON.stringify({ kind: 'renderer-register' }));
        return undefined;
      }
      if (msg.kind === 'renderer-registered') {
        rendererId = msg.rendererId; // 回执必须使用服务端分配的 rendererId
        socket.send(JSON.stringify({ kind: 'lease-request' }));
        return undefined;
      }
      if (msg.kind === 'lease-result') {
        if (msg.ok) {
          void http('/api/mock/events', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...controlAuth },
            body: JSON.stringify({ type: 'chat', text: '大肥鱼跳个舞', userId: 'smoke', userName: '冒烟员' }),
          });
        } else {
          // 租约被其他播放端持有:稍后重试(与页面行为一致)
          setTimeout(() => socket.send(JSON.stringify({ kind: 'lease-request' })), msg.retryAfterMs ?? 2000);
        }
        return undefined;
      }
      if (msg.kind === 'performance') {
        const dispatch = msg.dispatch;
        const sendReport = (status) => socket.send(JSON.stringify({
          kind: 'playback-report',
          report: { runId: dispatch.runId, leaseId: dispatch.leaseId, performanceId: dispatch.performance.id, rendererId, track: 'animation', status, at: Date.now() },
        }));
        sendReport('ready');
        sendReport('started');
        setTimeout(() => sendReport('ended'), 150);
        sawCurrent = false; // 等待状态推送:先见到 current,再见到 current 为空
        return undefined;
      }
      if (msg.kind === 'state') {
        if (msg.state.current !== null) {
          sawCurrent = true;
          return undefined;
        }
        if (sawCurrent) return 'completed';
      }
      return undefined;
    },
    12_000,
  );
  check('全链路:弹幕 → dance 派发并完成闭环', outcome === 'completed', String(outcome));
  // 等待调度收尾后检查状态
  await new Promise((resolve) => setTimeout(resolve, 500));
  const state = await http('/api/state', { headers: controlAuth });
  check('表演完成后回到空闲', state.body.current === null, JSON.stringify(state.body.current));
  check('队列已清空', state.body.queue.length === 0, `length=${state.body.queue?.length}`);
}

// 7. 事件去重:同 sourceKey 重复投递只处理一次(以服务端响应为准,由 mock 每次生成新 sourceKey,
//    去重路径已由单测覆盖;此处验证接口幂等语义可用)
{
  const first = await http('/api/mock/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...controlAuth },
    body: JSON.stringify({ type: 'gift', userId: 'smoke-gift', gift: { id: 'g1', name: '小心心', quantity: 3 } }),
  });
  check('礼物事件被接收进入合并窗口', first.status === 200 && first.body.ingest === 'accepted', JSON.stringify(first.body));
}

// 8. 媒体:HEAD 与 Range(素材缺失时返回 ASSET_MISSING/404,有素材时在启动后复测)
{
  const head = await fetch(`${base}/media/pets/main/animations/idle.webm`, { method: 'HEAD' });
  check('媒体 HEAD 可达(缺失时 404 ASSET_MISSING)', head.status === 404 || head.status === 200, `status=${head.status}`);
}

// 9. 未知升级路径被拒
{
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws-unknown`, { origin: `http://127.0.0.1:${port}` });
  const outcome = await new Promise((resolve) => {
    socket.on('unexpected-response', (_req, res) => resolve(`http-${res.statusCode}`));
    socket.on('error', () => resolve('error'));
    setTimeout(() => resolve('timeout'), 4000);
  });
  check('未知升级路径被拒绝', outcome === 'http-404', String(outcome));
}

// 10. WS Origin 策略:显式非法来源与 Origin: null 拒绝;回环缺失 Origin 放行至待认证(凭据仍是门槛)
{
  const probe = (origin) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin === undefined ? {} : { origin });
    return new Promise((resolve) => {
      socket.on('unexpected-response', (_req, res) => resolve(`http-${res.statusCode}`));
      socket.on('open', () => resolve('open'));
      socket.on('error', () => resolve('error'));
      setTimeout(() => resolve('timeout'), 4000);
    });
  };
  check('Origin: null 被拒绝', (await probe('null')) === 'http-403');
  check('外部 Origin 被拒绝', (await probe('http://evil.example')) === 'http-403');
  // Node ws 默认不携带 Origin:回环 + 合法 Host → 允许进入待认证
  const missingOrigin = await probe(undefined);
  check('回环缺失 Origin 放行至待认证', missingOrigin === 'open', String(missingOrigin));
}

// 11. 畸形 WS 消息受控处理(WT-P0-002)
{
  const outcome = await withSocket(
    connectWs(),
    (socket) => socket.send(JSON.stringify({ kind: 'auth', protocolVersion: 1, role: 'playback' })), // 缺 credential
    (msg) => (msg.kind === 'auth-result' && msg.ok === false ? `rejected:${msg.code}` : undefined),
  );
  check('缺失凭据的 auth 得到受控拒绝', outcome === 'rejected:AUTH_REJECTED', String(outcome));
}
{
  const outcome = await withSocket(
    connectWs(),
    (socket) => socket.send(JSON.stringify({ kind: 'auth', protocolVersion: 1, role: 'control', credential: access.control })),
    (msg, socket) => {
      if (msg.kind === 'auth-result' && msg.ok) {
        socket.send('null'); // JSON null:修复前会在读取 kind 时抛异常
        socket.send(JSON.stringify({ kind: 'ping' }));
        return undefined;
      }
      if (msg.kind === 'pong') return 'pong-after-null';
      return undefined;
    },
  );
  check('JSON null 消息不致崩溃,后续 ping 仍得到 pong', outcome === 'pong-after-null', String(outcome));
}

// 12. 页面入口重定向保留查询参数(WT-P0-012)
{
  const r = await fetch(`${base}/overlay?blend=screen`, { redirect: 'manual' });
  const loc = r.headers.get('location') ?? '';
  check('/overlay 重定向保留查询参数', r.status === 308 && loc === '/overlay/?blend=screen', `status=${r.status} location=${loc}`);
}

// 13. Vite 文件服务范围(WT-P0-003):运行数据被拒,源码目录可服务
{
  const toFsUrl = (p) => `${base}/@fs/${p.replace(/\\/g, '/')}`;
  const denied = await fetch(toFsUrl(path.join(root, 'data', 'access.json')));
  const deniedSettings = await fetch(toFsUrl(path.join(root, 'data', 'config', 'settings.json')));
  const allowedSource = await fetch(toFsUrl(path.join(root, 'src', 'shared', 'protocol.ts')));
  check('data/access.json 经 /@fs/ 被拒绝', denied.status === 403, `status=${denied.status}`);
  // settings.json 从未保存时文件不存在(Vite 返回 404),存在时被 deny 规则拒绝(403);两者均不可读
  check('data/config/settings.json 经 /@fs/ 不可读', deniedSettings.status === 403 || deniedSettings.status === 404, `status=${deniedSettings.status}`);
  check('src/shared 源码经 /@fs/ 仍可服务', allowedSource.status === 200, `status=${allowedSource.status}`);
}

console.log(`\n冒烟结果:${passed} 通过,${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
