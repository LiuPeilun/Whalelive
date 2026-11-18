// 环境实测①:HMR 实际源码热替换(ROADMAP 待办)。
// 前置:服务以 dev 模式运行(tsx watch),外部已启动 headless Edge(调试端口 9339、
// 独立 profile),并打开 /overlay。
// 流程:记录原文 → 修改 overlay/index.html(标题+静态标记,可逆)→ 断言热更新生效、
// 业务链路可用(动作播放并回待机 + 服务端终态)、还原生效、服务 runId 不变。
// 还原使用单一 finally 逻辑:正常与异常退出都恢复原始字节;若文件内容既不是测试
// 改动也不是原文(并发编辑),不覆盖并告警(WT-P0-014)。
// 调试:E2E_HMR_SIMULATE_FAILURE=1 在改动生效后人为抛错,用于验证异常退出同样还原。
// 用法:node scripts/e2e-hmr.mjs [port]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? process.env.PORT ?? 3210);
const base = `http://127.0.0.1:${port}`;
const access = JSON.parse(fs.readFileSync(path.join(root, 'data', 'access.json'), 'utf8'));
const overlayHtmlPath = path.join(root, 'src', 'web', 'overlay', 'index.html');
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

// ---- 单一还原逻辑(正常 finally 与异常路径共用,WT-P0-014)----
const originalHtml = fs.readFileSync(overlayHtmlPath, 'utf8');
const mutatedHtml = originalHtml
  .replaceAll('<title>WhaleTalk 播放页</title>', '<title>WhaleTalk 播放页(HMR)</title>')
  .replaceAll('<div id="caption"></div>', '<div id="caption"></div><div id="hmr-marker" style="position:fixed;top:4px;right:4px;width:6px;height:6px;"></div>');
let mutationWritten = false;
function restoreSource() {
  if (!mutationWritten) return;
  const current = fs.readFileSync(overlayHtmlPath, 'utf8');
  if (current === originalHtml) return; // 已还原(或从未生效)
  if (current !== mutatedHtml) {
    // 内容既不是测试改动也不是原文:视为并发编辑,不覆盖
    console.warn('WARN: overlay/index.html 在测试期间被外部修改,保留当前内容不自动还原');
    return;
  }
  fs.writeFileSync(overlayHtmlPath, originalHtml, 'utf8');
  mutationWritten = false;
}

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9339/json')).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('/overlay'));
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('CDP 目标页未找到');
}

async function main() {
  const target = await findTarget();
  const ws = new WebSocket(target, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  let seq = 0;
  const pending = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    return r.result?.result?.value;
  };
  const screenshot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(root, '.tools', name), Buffer.from(r.result.data, 'base64'));
    console.log(`截图 .tools/${name}`);
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(5000); // 等待认证、登记、租约与待机起播

  try {
    const runIdBefore = (await http('/api/health')).body.runId;
    check('标记锚点存在于页面源码', originalHtml.includes('<title>WhaleTalk 播放页</title>'), 'title');

    const baselineProbe = await evaluate('window.__wtWs ?? null');
    console.log('基线 probe:', JSON.stringify(baselineProbe));
    await screenshot('e2e-hmr-before.png');

    // 可逆变更:标题加 HMR 标记 + 新增静态标记元素
    fs.writeFileSync(overlayHtmlPath, mutatedHtml, 'utf8');
    mutationWritten = true;
    console.log('已修改 overlay/index.html(标题 + 静态标记元素)…');

    // 等待热更新生效:页面标题变化且静态标记元素出现(index.html 变更为整页重载)
    let hotSeen = false;
    const hotDeadline = Date.now() + 15_000;
    let hotDetail = '';
    for (;;) {
      await sleep(500);
      hotDetail = JSON.stringify({ title: await evaluate('document.title'), marker: await evaluate(`document.getElementById('hmr-marker') !== null`) });
      if (hotDetail.includes('HMR') && hotDetail.includes('"marker":true')) { hotSeen = true; break; }
      if (Date.now() > hotDeadline) break;
    }
    check('HMR 热替换生效(标题与静态标记元素已更新)', hotSeen, hotDetail);
    await screenshot('e2e-hmr-after.png');

    // 整页重载后业务连接恢复可用(探针 connected 即重载后重连成功)
    const probeAfter = await evaluate('window.__wtWs ?? null');
    console.log('热更新后 probe:', JSON.stringify(probeAfter));
    check('热更新(整页重载)后业务 WS 恢复 connected', probeAfter?.status === 'connected', JSON.stringify(probeAfter));

    // 失败模拟:改动已生效、断言已通过,此处抛错验证异常退出同样还原(WT-P0-014)
    if (process.env.E2E_HMR_SIMULATE_FAILURE === '1') {
      throw new Error('E2E_HMR_SIMULATE_FAILURE:模拟中途失败');
    }

    // 业务链路存活:动作播放 → 回到可见循环待机 → 服务端会话完成(WT-P0-014 断言补全)
    await http('/api/mock/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${access.control}` },
      body: JSON.stringify({ type: 'chat', text: '挥挥手', userId: `hmr-${Date.now()}`, userName: '热更新员' }),
    });
    let sawWave = false;
    let backToIdle = false;
    const waveDeadline = Date.now() + 25_000;
    for (;;) {
      await sleep(500);
      const v = await evaluate(`(() => {
        const v = document.querySelector('#videos video:not(.hidden)');
        return v ? { src: v.src.split('/').pop(), loop: v.loop, paused: v.paused } : null;
      })()`);
      if (v?.src === 'wave.webm') sawWave = true;
      if (sawWave && v?.src === 'idle.webm' && v.loop === true && v.paused === false) { backToIdle = true; break; }
      if (Date.now() > waveDeadline) break;
    }
    check('热更新后动作播放并回到循环待机', sawWave && backToIdle, `sawWave=${sawWave} backToIdle=${backToIdle}`);
    const settledState = await http('/api/state', { headers: { authorization: `Bearer ${access.control}` } });
    check('服务端会话终态完成(current 为空)', settledState.body?.current === null, JSON.stringify(settledState.body?.current));

    // 还原文件,等待回滚生效
    restoreSource();
    console.log('已还原 overlay/index.html …');
    let restored = false;
    const restoreDeadline = Date.now() + 15_000;
    for (;;) {
      await sleep(500);
      const title = await evaluate('document.title');
      const marker = await evaluate(`document.getElementById('hmr-marker') !== null`);
      if (title === 'WhaleTalk 播放页' && marker === false) { restored = true; break; }
      if (Date.now() > restoreDeadline) break;
    }
    check('还原后页面回到原始状态', restored, `title=${JSON.stringify(await evaluate('document.title'))}`);
    const probeRestored = await evaluate('window.__wtWs ?? null');
    check('还原后业务 WS 仍为 connected', probeRestored?.status === 'connected', JSON.stringify(probeRestored));

    // 服务未被页面文件变更重启(tsx watch 只监听服务端源码)
    const runIdAfter = (await http('/api/health')).body.runId;
    check('服务 runId 全程未变(页面变更不重启服务)', runIdAfter === runIdBefore, `${runIdBefore} → ${runIdAfter}`);
  } finally {
    // 单一还原出口:正常结束、断言失败、异常退出都恢复原始内容(WT-P0-014)
    restoreSource();
    ws.close();
  }

  console.log(`\nHMR 实测:${passed} 通过,${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  restoreSource(); // main 在 finally 之前抛出(如 CDP 连接失败)时的兜底
  console.error('HMR 实测失败:', err);
  process.exit(1);
});
