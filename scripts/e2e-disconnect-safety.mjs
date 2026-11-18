// WT-P1-004 断线转交安全窗实测(服务端真实 close 路径):
// A(持有租约,模拟播放中) → A 硬断(服务端 unregister 触发) → B 立即申请
// → 应被拒(旧端未确认停声,安全窗 800ms) → 窗口过后再申请 → 授予。
// 对照:显式释放(lease-release,B 发送前 A 已确认停声)应零等待接管。
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

async function main() {
  // 场景一:断线(未确认停声)→ 安全窗内拒绝,窗口过后授予
  const a = await openClient();
  a.socket.send(JSON.stringify({ kind: 'renderer-register' }));
  await a.next((m) => m.kind === 'renderer-registered');
  const leaseA = await requestLease(a);
  check('A 取得租约', leaseA.ok === true, JSON.stringify(leaseA));

  const b = await openClient();
  b.socket.send(JSON.stringify({ kind: 'renderer-register' }));
  await b.next((m) => m.kind === 'renderer-registered');

  // A 硬断:服务端 close → unregister → 记录安全期限
  a.socket.terminate();
  await sleep(150); // 让服务端处理 close

  const t0 = Date.now();
  const immediate = await requestLease(b);
  const waited = Date.now() - t0;
  check('断线后安全窗内新端被拒', immediate.ok === false && immediate.code === 'LEASE_HELD', JSON.stringify(immediate));

  // 等到安全窗过后(takeoverSafetyMs=800,已过 ~150ms)再申请
  await sleep(Math.max(0, 900 - waited));
  const granted = await requestLease(b);
  check('安全时刻后新端取得租约', granted.ok === true, JSON.stringify(granted));

  // 场景二:显式释放(已确认停声)→ 零等待接管
  b.socket.send(JSON.stringify({ kind: 'lease-release', leaseId: granted.leaseId }));
  await sleep(100);
  const c = await openClient();
  c.socket.send(JSON.stringify({ kind: 'renderer-register' }));
  await c.next((m) => m.kind === 'renderer-registered');
  const fast = await requestLease(c);
  check('显式释放后新端零等待接管', fast.ok === true, JSON.stringify(fast));

  for (const cl of [b, c]) cl.socket.close();
  console.log(failures === 0 ? '断线安全窗实测:全部通过' : `断线安全窗实测:${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('实测异常:', e.message); process.exit(1); });
