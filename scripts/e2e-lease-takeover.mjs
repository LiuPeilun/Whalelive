// WT-P0-007 浏览器级验证:第二播放页首次申请被拒后,页面按受控退避重试;
// 旧持有者退出释放租约后,第二页自动接管并完成新互动(下一任务成功终态)。
// 前置:外部已启动两个 headless Edge(9337=profile-A 持有者,9338=profile-B 接管者)。
// 用法:node scripts/e2e-lease-takeover.mjs [port]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? process.env.PORT ?? 3210);
const base = `http://127.0.0.1:${port}`;
const access = JSON.parse(fs.readFileSync(path.join(root, 'data', 'access.json'), 'utf8'));
const controlAuth = { authorization: `Bearer ${access.control}`, 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function http(pathname, init) {
  const response = await fetch(`${base}${pathname}`, init);
  let body = null;
  try { body = await response.json(); } catch { /* ignore */ }
  return { status: response.status, body };
}

async function waitFor(predicate, maxMs = 20_000, what = '') {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const value = await predicate();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) return undefined;
    await sleep(400);
  }
}

function killEdgeByProfile(tag) {
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | ` +
    `Where-Object { $_.CommandLine -match 'edge-profile-${tag}' } | ` +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'], { stdio: 'ignore' });
}

// ---------- 场景 ----------
// 1. 等待两个播放页(A/B)登记
const twoRenderers = await waitFor(async () => {
  const s = await http('/api/state', { headers: { authorization: `Bearer ${access.control}` } });
  return s.body.renderers.count === 2 ? s.body.renderers : undefined;
}, 25_000);
check('两个播放页已登记', twoRenderers !== undefined, JSON.stringify(twoRenderers));

const holderBefore = twoRenderers?.leaseHolderRendererId ?? null;
const pendingRendererId = twoRenderers?.primaryRendererId ?? null;
check('A 持有租约', holderBefore !== null, `holder=${holderBefore}`);

// 2. B 首次申请被拒(LEASE_HELD):服务端拒绝日志 + 租约未被 B 抢走
await sleep(3000); // B 的登记与首次申请已完成
const logFile = fs.readdirSync(path.join(root, 'data', 'logs')).sort().at(-1);
const logText = fs.readFileSync(path.join(root, 'data', 'logs', logFile ?? ''), 'utf8');
const deniedForPending = logText.includes(`ws.lease-denied`) && logText.split('ws.lease-denied').some((seg) => seg.includes(pendingRendererId ?? '\u0000'));
check('B 首次申请被拒(LEASE_HELD 日志)', deniedForPending, '未找到拒绝日志');
const holderStillA = await waitFor(async () => {
  const s = await http('/api/state', { headers: { authorization: `Bearer ${access.control}` } });
  return s.body.renderers.leaseHolderRendererId === holderBefore ? s.body.renderers : undefined;
}, 8000);
check('A 存续期间租约未被 B 抢走', holderStillA !== undefined, JSON.stringify(holderStillA?.leaseHolderRendererId));

// 3. A 退出释放租约 → B 按退避重试自动接管
console.log('关闭持有者 A …');
killEdgeByProfile('leaseholder');
const takeover = await waitFor(async () => {
  const s = await http('/api/state', { headers: { authorization: `Bearer ${access.control}` } });
  const holder = s.body.renderers.leaseHolderRendererId;
  return holder !== null && holder !== holderBefore ? s.body.renderers : undefined;
}, 25_000);
check('B 自动接管租约(WT-P0-007 播放权恢复)', takeover !== undefined, JSON.stringify(await http('/api/state', { headers: { authorization: `Bearer ${access.control}` } }).then((r) => r.body.renderers)));

// 4. 新互动在新租约下正常完成(下一任务成功终态)
await http('/api/mock/events', {
  method: 'POST',
  headers: controlAuth,
  body: JSON.stringify({ type: 'chat', text: '挥挥手', userId: `takeover-${Date.now()}`, userName: '接管员' }),
});
const settled = await waitFor(async () => {
  const s = await http('/api/state', { headers: { authorization: `Bearer ${access.control}` } });
  return s.body.current === null ? s.body : undefined;
}, 15_000);
check('接管后的新互动正常完成', settled !== undefined, JSON.stringify(settled?.playback));

// 5. 清理 B
killEdgeByProfile('leasetaker');
check('清理完成', true);

console.log(`\n租约接管验证:${passed} 通过,${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
