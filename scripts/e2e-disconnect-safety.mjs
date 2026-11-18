// WT-P1-004 断线转交安全窗实测(服务端真实 close 路径):
// 场景一:A(持有租约,模拟播放中) → A 硬断(服务端 unregister 触发) → B 立即申请
//   → 应被拒(安全期限=旧租约剩余生命+安全窗,关闭事件延迟超过固定安全窗也不再同播)
//   → 窗口过后再申请 → 授予。
// 场景二:断线端重连登记后补发旧租约释放(真实停止确认) → 新端立即接管。
// 场景三:显式释放(lease-release,发送前 A 已确认停声)应零等待接管。
// 前置:服务运行中。用法:node scripts/e2e-disconnect-safety.mjs [port]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? process.env.PORT ?? 3210);
const access = JSON.parse(fs.readFileSync(path.join(root, 'data', 'access.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}`);
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function openClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
    const waiters = [];
    const handlers = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      for (const h of [...handlers]) h(msg);
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ kind: 'auth', protocolVersion: 1, role: 'playback', credential: access.playback }));
    });
    ws.on('error', reject);
    const api = {
      socket: ws,
      next(predicate, timeoutMs = 8000) {
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('等消息超时')), timeoutMs);
          const h = (msg) => {
            if (!predicate || predicate(msg)) {
              clearTimeout(timer);
              handlers.splice(handlers.indexOf(h), 1);
              res(msg);
            }
          };
          handlers.push(h);
        });
      },
    };
    // 等 auth-result
    api.next((m) => m.kind === 'auth-result').then((m) => {
      if (m.ok === false) reject(new Error(`auth 失败: ${JSON.stringify(m)}`));
      else resolve(api);
    }).catch(reject);
  });
}

async function requestLease(api) {
  api.socket.send(JSON.stringify({ kind: 'lease-request' }));
  return api.next((m) => m.kind === 'lease-result');
}

async function registerClient() {
  const api = await openClient();
  api.socket.send(JSON.stringify({ kind: 'renderer-register' }));
  await api.next((m) => m.kind === 'renderer-registered');
  return api;
}

async function main() {
  // 场景一:断线(未确认停声)→ 安全期限(剩余租约+安全窗)内拒绝,期限过后授予
  const a = await registerClient();
  const leaseA = await requestLease(a);
  check('A 取得租约', leaseA.ok === true, JSON.stringify(leaseA));

  const b = await registerClient();

  // A 硬断:服务端 close → unregister → 安全期限 = 旧租约截止 + 800ms
  a.socket.terminate();
  await sleep(150); // 让服务端处理 close

  const immediate = await requestLease(b);
  const held = immediate.ok === false && immediate.code === 'LEASE_HELD';
  check('断线后安全期限内新端被拒', held, JSON.stringify(immediate));
  // 剩余租约应计入等待(ttl 15000,断线即剩 ~15s,而非固定 800ms)
  if (held) check('等待覆盖旧租约剩余生命(≥10s)', immediate.retryAfterMs >= 10_000, `retryAfterMs=${immediate.retryAfterMs}`);

  // 等到安全期限过后再申请(按服务端返回的 retryAfterMs 推进)
  if (held) await sleep(immediate.retryAfterMs + 300);
  const granted = await requestLease(b);
  check('安全期限后新端取得租约', granted.ok === true, JSON.stringify(granted));

  // 场景二:断线端重连登记后补发旧租约释放(停止确认)→ 新端立即接管
  b.socket.send(JSON.stringify({ kind: 'lease-release', leaseId: granted.leaseId }));
  await sleep(100);
  const a2 = await registerClient();
  const leaseA2 = await requestLease(a2);
  check('A2 重新取得租约', leaseA2.ok === true, JSON.stringify(leaseA2));
  const oldLeaseId = leaseA2.ok ? leaseA2.leaseId : '';
  a2.socket.terminate();
  await sleep(150);
  const c = await registerClient();
  const denied = await requestLease(c);
  check('A2 断线后新端先被拒', denied.ok === false, JSON.stringify(denied));
  // A2 重连(新连接)登记后补发断线前租约的释放 → 安全期限提前解除
  const a3 = await registerClient();
  a3.socket.send(JSON.stringify({ kind: 'lease-release', leaseId: oldLeaseId }));
  await sleep(150);
  const fastAfterConfirm = await requestLease(c);
  check('断线端重连补发释放后新端立即接管', fastAfterConfirm.ok === true, JSON.stringify(fastAfterConfirm));

  // 场景三:显式释放(已确认停声)→ 零等待接管
  c.socket.send(JSON.stringify({ kind: 'lease-release', leaseId: fastAfterConfirm.ok ? fastAfterConfirm.leaseId : '' }));
  await sleep(100);
  const d = await registerClient();
  const fast = await requestLease(d);
  check('显式释放后新端零等待接管', fast.ok === true, JSON.stringify(fast));

  for (const cl of [b, c, d, a3]) cl.socket.close();
  console.log(failures === 0 ? '断线安全窗实测:全部通过' : `断线安全窗实测:${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('实测异常:', e.message); process.exit(1); });
