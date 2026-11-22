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
  let leaseId = null;
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
          leaseId = msg.leaseId;
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
        const sendReport = (track, status) => socket.send(JSON.stringify({
          kind: 'playback-report',
          report: { runId: dispatch.runId, leaseId: dispatch.leaseId, performanceId: dispatch.performance.id, rendererId, track, status, at: Date.now() },
        }));
        sendReport('animation', 'ready');
        sendReport('animation', 'started');
        setTimeout(() => sendReport('animation', 'ended'), 150);
        // P1:带音频的表演需回报音频轨道,会话才完成
        if (dispatch.performance.audioUrl) {
          sendReport('audio', 'ready');
          sendReport('audio', 'started');
          setTimeout(() => sendReport('audio', 'ended'), 250);
        }
        sawCurrent = false; // 等待状态推送:先见到 current,再见到 current 为空
        return undefined;
      }
      if (msg.kind === 'state') {
        if (msg.state.current !== null) {
          sawCurrent = true;
          return undefined;
        }
        if (sawCurrent) {
          // 清理对齐新的转交条件:显式释放(停止确认)即时清零安全期限,
          // 下一轮冒烟的全链路租约申请无需等待上一轮留下的窗口
          if (leaseId && rendererId) socket.send(JSON.stringify({ kind: 'lease-release', leaseId }));
          return 'completed';
        }
      }
      return undefined;
    },
    25_000,
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

// 7b. 付费礼物经同一 HTTP 入口进入大额档(WT-P2-010 终版口径):
//     检查在自建的完全离线实例上执行——PLATFORM=mock + 清空外部凭据(不触发真实平台启动,
//     即使 .env.local 配置了开放平台)+ 独立临时数据目录(不吃日常配置/阈值/角色包,凭据自有);
//     未就绪(端口碰撞等)即终止本次检查并清理子进程,绝不向占用端口的既有服务发送任何请求。
//     目标服务(含日常 3210)全程不被触碰,操作者的暂停/紧急停止不受影响。
{
  const os = await import('node:os');
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'whaletalk-tier-'));
  const dataDir = path.join(fixture, 'data');
  const tierPort = 32700 + Math.floor(Math.random() * 300);
  const { startTestServer, stopTestServer } = await import('./lib/test-server.mjs');
  let started = null;
  let healthy = false;
  try {
    started = await startTestServer({
      port: tierPort,
      extraEnv: {
        WHALETALK_DATA_DIR: dataDir,
        PLATFORM: 'mock',
        DEEPSEEK_API_KEY: '',
        DEEPSEEK_BASE_URL: '',
        BILIBILI_OPEN_APP_ID: '',
        BILIBILI_OPEN_CODE: '',
      },
    });
    healthy = await started.waitHealthy();
    check('档位检查离线实例就绪', healthy === true, healthy ? `port=${tierPort}` : `port=${tierPort} 未就绪(端口碰撞等),本次检查终止且未向该端口发送任何请求`);
    if (healthy) {
      // 自有凭据:离线实例在临时数据目录生成 access.json
      const tierAccess = JSON.parse(fs.readFileSync(path.join(dataDir, 'access.json'), 'utf8'));
      const tierAuth = { authorization: `Bearer ${tierAccess.control}` };
      const tierBase = `http://127.0.0.1:${tierPort}`;
      await fetch(`${tierBase}/api/control/pause`, { method: 'POST', headers: tierAuth });
      const paid = await fetch(`${tierBase}/api/mock/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...tierAuth },
        body: JSON.stringify({ type: 'gift', userId: 'smoke-paid-15', userName: '冒烟付费观众十五元', gift: { id: 'rocket', name: '火箭', quantity: 1, paidYuan: 15 } }),
      });
      const paidBody = await paid.json().catch(() => null);
      check('付费礼物事件被接收', paid.status === 200 && paidBody?.ingest === 'accepted', JSON.stringify(paidBody));
      const deadline = Date.now() + 5000;
      let tiered = false;
      let detail = '超时未见优先级 80 条目';
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const state = await (await fetch(`${tierBase}/api/state`, { headers: tierAuth })).json();
        // 状态视图提供 sayPreview(前 30 字符);唯一昵称位于答谢文案开头,足以精确定位
        const hit = (state?.queue?.items ?? []).find((i) => i.priority === 80 && typeof i.sayPreview === 'string' && i.sayPreview.includes('冒烟付费观众十五元'));
        if (hit) {
          tiered = true;
          detail = JSON.stringify({ priority: hit.priority, sayPreview: hit.sayPreview });
          break;
        }
      }
      check('付费礼物进入大额答谢档(优先级 80,以唯一文案定位)', tiered, detail);
    }
  } finally {
    // 只清理自建实例与临时目录;目标服务的暂停/队列状态不受本检查影响
    if (started !== null) {
      try { stopTestServer(tierPort); } catch (err) { console.log(`WARN 离线实例清理失败 port=${tierPort}: ${String(err.message ?? err)}`); }
    }
    try { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5 }); } catch { /* 临时目录 */ }
  }
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
