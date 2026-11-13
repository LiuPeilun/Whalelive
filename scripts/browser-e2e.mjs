// 真实浏览器端到端验证:驱动无头 Edge 打开 overlay,提交弹幕,观察动画播放与会话完成。
// 用法:先启动服务,再执行 node scripts/browser-e2e.mjs
// 依赖 Edge(路径见下)与 npm 依赖 ws(CDP 协议)。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 3210);
const access = JSON.parse(fs.readFileSync(path.join(root, 'data', 'access.json'), 'utf8'));
const overlayUrl = `http://127.0.0.1:${port}/overlay#${access.playback}`;

const edgeCandidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const edgePath = edgeCandidates.find((p) => fs.existsSync(p));
if (!edgePath) throw new Error('未找到 Edge');

const debugPort = 9333;
const edge = spawn(edgePath, [
  '--headless', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${debugPort}`,
  '--window-size=760,560',
  overlayUrl,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('/overlay'));
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('CDP 目标页未找到');
}

async function main() {
  const target = await findTarget();
  const ws = new WebSocket(target, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

  let seq = 0;
  const pending = new Map();
  const events = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method !== undefined && events.has(msg.method)) {
      for (const cb of events.get(msg.method)) cb(msg.params);
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
    const file = path.join(root, '.tools', name);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    console.log(`截图 ${file}`);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(2500); // 等待认证、登记、租约与待机视频起播

  const idleState = await evaluate(`(() => {
    const v = document.querySelector('#videos video:not(.hidden)');
    return v ? { src: v.src.split('/').pop(), currentTime: v.currentTime, paused: v.paused, readyState: v.readyState } : null;
  })()`);
  console.log('待机视频状态:', JSON.stringify(idleState));
  await screenshot('e2e-idle.png');

  // 提交"跳个舞"(用 node fetch,避免控制台中文编码问题)
  const chat = await fetch(`http://127.0.0.1:${port}/api/mock/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${access.control}` },
    body: JSON.stringify({ type: 'chat', text: '大肥鱼跳个舞', userId: 'e2e', userName: '端到端员' }),
  }).then((r) => r.json());
  console.log('弹幕提交:', JSON.stringify(chat));

  // 轮询表演状态:字幕出现 → dance 视频 started → ended → 回待机
  let sawDance = false;
  let sawCaption = false;
  let danceEnded = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const snap = await evaluate(`(() => {
      const v = document.querySelector('#videos video:not(.hidden)');
      const cap = document.getElementById('caption');
      return {
        src: v ? v.src.split('/').pop() : null,
        t: v ? v.currentTime : -1,
        dur: v ? v.duration : -1,
        cap: cap && cap.style.display !== 'none' ? cap.textContent : null,
        ph: document.getElementById('placeholder').style.display,
      };
    })()`);
    if (snap.src === 'dance.webm') sawDance = true;
    if (snap.cap) sawCaption = true;
    if (i === 2 || i === 5) await screenshot(`e2e-dance-${i}.png`);
    if (sawDance && snap.src !== 'dance.webm' && snap.src === 'idle.webm') { danceEnded = true; break; }
  }
  console.log(`dance 播放=${sawDance} 字幕=${sawCaption} 播完回待机=${danceEnded}`);

  await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { authorization: `Bearer ${access.control}` } })
    .then((r) => r.json())
    .then((s) => console.log(`服务端:current=${s.current ? s.current.action : '空闲'} playback=${s.playback.status} renderers=${s.renderers.count}`));

  ws.close();
  edge.kill();
  const ok = sawDance && sawCaption && danceEnded;
  console.log(ok ? '浏览器端到端:通过' : '浏览器端到端:未完全通过');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E 失败:', err);
  edge.kill();
  process.exit(1);
});
