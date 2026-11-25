// 点歌任务面板浏览器实测(P3 增强):真实 headless Edge 打开控制台,核对
// GET /api/singing/jobs 的页面呈现——空态、缓存成片就绪(含试听 <audio>)、
// 最新在前、失败原因、轮询不重建试听元素、无凭据时停轮询。
// 用法: node scripts/singing-panel-e2e.mjs [port]
// 隔离实例 + 预置成片缓存(点歌即命中,不跑 90 秒真实管线);
// 失败用例走真实取歌步骤(查无此歌),依赖 B 站搜索可达。

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startTestServer, stopTestServer } from './lib/test-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 3793);
const base = `http://127.0.0.1:${port}`;
const debugPort = 9336;
const PROFILE_TAG = 'singingpanel';
const TITLE = '篇章 张韶涵 MV';
// 成片缓存文件名(镜像 src/server/modules/singing/cache.ts 的 songCacheId):
// sha1(规范化标题 + '\n' + 影响成片的设置指纹) 前 12 位十六进制
const FINGERPRINT = '0.4|24|310|-6|24|0.3|0.33|0.25';
const normalized = TITLE.trim().toLowerCase().replace(/\s+/g, ' ');
const cacheId = `song-${crypto.createHash('sha1').update(`${normalized}\n${FINGERPRINT}`, 'utf8').digest('hex').slice(0, 12)}.mp3`;

const edgeCandidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const edgePath = edgeCandidates.find((p) => fs.existsSync(p));
if (!edgePath) throw new Error('未找到 Edge');

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

let edgePid = null;
function killEdgeTree() {
  // taskkill /T 在部分环境杀不干净 Chromium 进程树,再按本脚本专用 profile 过滤兜底;
  // 只匹配本脚本的 profile,不动操作者自己的 Edge 与其它 e2e 的实例。
  if (edgePid !== null) {
    try { spawnSync('taskkill', ['/F', '/T', '/PID', String(edgePid)], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\" | " +
      `Where-Object { $_.CommandLine -match 'edge-profile-${PROFILE_TAG}' } | ` +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'], { stdio: 'ignore' });
  } catch { /* ignore */ }
}

/** 页面内面板快照(文本经 textContent 读取,等价于操作者看到的文字)。 */
const SNAPSHOT = `(() => ({
  enabled: document.getElementById('singing-enabled').textContent,
  active: document.getElementById('singing-active').textContent,
  note: document.getElementById('singing-note').textContent,
  jobs: [...document.querySelectorAll('#singing-list li.job')].map((li) => ({
    stage: li.querySelector('.job-head .tag').textContent,
    tags: [...li.querySelectorAll('.job-head .tag')].map((t) => t.textContent),
    title: li.querySelector('.job-title').textContent,
    source: li.querySelector('.job-body .muted')?.textContent ?? null,
    error: li.querySelector('.job-error')?.textContent ?? null,
    hasAudio: li.querySelector('audio') !== null,
    audioSrc: li.querySelector('audio')?.getAttribute('src') ?? null,
    audioControls: li.querySelector('audio')?.controls ?? null,
  })),
  placeholder: document.querySelector('#singing-list > li.muted')?.textContent ?? null,
}))()`;

async function http(pathname, init) {
  const response = await fetch(`${base}${pathname}`, init);
  let body = null;
  try { body = await response.json(); } catch { /* ignore */ }
  return { status: response.status, body };
}

async function main() {
  // 预置成片缓存:优先复用既有冒烟留下的真实成片,没有则放一个占位文件
  //(<audio preload="none"> 不主动拉取,地址可达性用 HEAD 核对)。
  const dataDir = path.join(root, 'data', `.singing-panel-${Date.now()}`);
  const audioDir = path.join(dataDir, 'cache', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const real = fs.readdirSync(path.join(root, 'data'))
    .filter((n) => n.startsWith('.singing-smoke-'))
    .map((n) => path.join(root, 'data', n, 'cache', 'audio', cacheId))
    .find((p) => fs.existsSync(p));
  if (real === undefined) fs.writeFileSync(path.join(audioDir, cacheId), Buffer.alloc(4096));
  else fs.copyFileSync(real, path.join(audioDir, cacheId));
  console.log(`隔离实例端口 ${port},数据目录 ${dataDir},预置成片 ${cacheId}(${real === undefined ? '占位' : '真实成片'})`);

  const server = await startTestServer({
    port,
    extraEnv: {
      PLATFORM: 'mock',
      WHALETALK_DATA_DIR: dataDir,
      // 已存在的环境变量(含空值)优先于 .env.local:显式清空,确保实例完全离线
      DEEPSEEK_API_KEY: '',
      BILIBILI_OPEN_APP_ID: '',
      BILIBILI_OPEN_ACCESS_KEY_ID: '',
      BILIBILI_OPEN_ACCESS_KEY_SECRET: '',
      BILIBILI_OPEN_CODE: '',
    },
  });
  let ws = null;
  try {
    const healthy = await server.waitHealthy(30_000);
    check('隔离实例就绪', healthy);
    if (!healthy) throw new Error('隔离实例未就绪');

    const access = JSON.parse(fs.readFileSync(path.join(dataDir, 'access.json'), 'utf8'));
    const controlAuth = { 'content-type': 'application/json', authorization: `Bearer ${access.control}` };
    const postSong = (text, userId) => http('/api/mock/events', {
      method: 'POST', headers: controlAuth,
      body: JSON.stringify({ type: 'chat', text, userId, userName: '面板实测员' }),
    });

    const edge = spawn(edgePath, [
      '--headless', '--disable-gpu', '--no-sandbox',
      `--user-data-dir=${root}\\.tools\\edge-profile-${PROFILE_TAG}`,
      '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-port=${debugPort}`,
      '--window-size=1280,1400',
      `${base}/control#${access.control}`,
    ], { stdio: 'ignore' });
    edgePid = edge.pid;

    let target = null;
    for (let i = 0; i < 40 && target === null; i += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
        target = list.find((t) => t.type === 'page' && t.url.includes('/control'))?.webSocketDebuggerUrl ?? null;
      } catch { /* retry */ }
      if (target === null) await sleep(250);
    }
    if (target === null) throw new Error('CDP 目标页未找到');
    ws = new WebSocket(target, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

    let seq = 0;
    const pending = new Map();
    const exceptions = [];
    const consoleErrors = [];
    let jobsRequests = 0;
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
        return;
      }
      if (msg.method === 'Network.requestWillBeSent' && String(msg.params?.request?.url ?? '').includes('/api/singing/jobs')) jobsRequests += 1;
      if (msg.method === 'Runtime.exceptionThrown') exceptions.push(JSON.stringify(msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text ?? ''));
      if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') consoleErrors.push(String(msg.params?.entry?.text ?? ''));
    });
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(`页面异常: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? '')}`);
      return r.result?.result?.value;
    };
    const waitFor = async (expression, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if ((await evaluate(expression)) === true) return true;
        if (Date.now() > deadline) return false;
        await sleep(200);
      }
    };
    const snapshot = () => evaluate(SNAPSHOT);

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Network.enable');

    // 1. 初始:面板取到空快照
    const ready = await waitFor(`document.querySelectorAll('#singing-list li').length > 0`, 10_000);
    const initial = await snapshot();
    check('面板初始:唱歌已开启、在途 0 / 2、空态提示', ready
      && initial.enabled === '唱歌:已开启' && initial.active === '在途 0 / 2'
      && initial.placeholder === '暂无点歌任务' && initial.jobs.length === 0, JSON.stringify(initial));

    // 2. 点一首已有成片的歌(缓存命中):面板出现已就绪任务与试听元素
    const cachedReq = await postSong(`点歌 ${TITLE}`, 'panel-cached');
    check('缓存成片点歌被受理', cachedReq.status === 200 && cachedReq.body?.enqueue?.accepted === true, JSON.stringify(cachedReq.body));
    const appeared = await waitFor(`document.querySelectorAll('#singing-list li.job').length === 1`, 10_000);
    const one = await snapshot();
    const job = one.jobs[0] ?? {};
    check('面板显示已就绪任务(缓存成片标记,无来源行)', appeared && job.stage === '已就绪' && job.tags.includes('缓存成片')
      && job.title === TITLE && job.error === null && job.source === null && one.placeholder === null, JSON.stringify(one));
    check('就绪任务带试听 <audio>,地址为预置成片', job.hasAudio === true && job.audioControls === true && job.audioSrc === `/media/audio/${cacheId}`, JSON.stringify(job));
    const head = await evaluate(`(async () => {
      const r = await fetch(document.querySelector('#singing-list audio').getAttribute('src'), { method: 'HEAD' });
      return { status: r.status, ranges: r.headers.get('accept-ranges'), type: r.headers.get('content-type'), length: r.headers.get('content-length') };
    })()`);
    check('成片地址可在页面内读取(HEAD 200,支持 Range)', head.status === 200 && head.ranges === 'bytes' && head.type === 'audio/mpeg' && Number(head.length) > 0, JSON.stringify(head));
    check('列表为空态后占位行已移除', await evaluate(`document.querySelector('#singing-list > li.muted') === null`));
    // 记住当前试听元素:后续轮询/重排必须是同一个节点(重建会打断播放)
    await evaluate(`window.__panelAudio = document.querySelector('#singing-list audio'); true`);

    // 3. 再点一首查无此歌的:新任务排最前,制作中阶段可见,最终显示失败原因
    const badTitle = `查无此歌qzx${Date.now() % 100000} wvkwxyz`;
    const badReq = await postSong(`点歌 ${badTitle}`, 'panel-bad');
    check('查无此歌的点歌被受理(失败发生在制作阶段)', badReq.status === 200 && badReq.body?.enqueue?.accepted === true, JSON.stringify(badReq.body));
    await waitFor(`document.querySelectorAll('#singing-list li.job').length === 2`, 10_000);
    const inFlight = await snapshot();
    console.log(`新任务首屏阶段: ${inFlight.jobs.map((j) => `${j.title.slice(0, 6)}…=${j.stage}`).join(', ')};在途:${inFlight.active}`);
    const sameAudio = await evaluate(`window.__panelAudio === document.querySelector('#singing-list audio') && window.__panelAudio.isConnected && window.__panelAudio.getAttribute('src') === '/media/audio/${cacheId}'`);
    await sleep(2500); // 跨多次轮询再核对一次
    const stillSame = await evaluate(`window.__panelAudio === document.querySelector('#singing-list audio') && window.__panelAudio.isConnected`);
    check('轮询与列表重排不重建正在展示的试听元素', sameAudio === true && stillSame === true, `首次=${sameAudio} 2.5s 后=${stillSame}`);

    const settled = await waitFor(`document.querySelector('#singing-list li.job .job-error') !== null`, 60_000);
    const final = await snapshot();
    const first = final.jobs[0] ?? {};
    const second = final.jobs[1] ?? {};
    check('最新任务排在最前,先前任务保留在后', final.jobs.length === 2 && first.title === badTitle && second.title === TITLE && second.hasAudio === true, JSON.stringify(final.jobs.map((j) => [j.title, j.stage])));
    check('失败任务展示失败原因(中文说明在前)且无试听元素', settled && first.stage === '失败'
      && typeof first.error === 'string' && first.error.startsWith('取歌失败(') && first.hasAudio === false
      && second.error === null, JSON.stringify(first));
    check('在途数回落为 0', final.active === '在途 0 / 2', final.active);
    check('面板无读取错误提示', final.note === '', final.note);

    // 截图留档(面板区块)
    const rect = await evaluate(`(() => { const r = document.getElementById('sec-singing').getBoundingClientRect(); return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height }; })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...rect, scale: 1 } });
    fs.mkdirSync(path.join(root, '.tools'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tools', 'singing-panel-e2e.png'), Buffer.from(shot.result?.data ?? '', 'base64'));

    check('面板脚本无未捕获异常、无渲染失败日志', exceptions.length === 0 && !consoleErrors.some((t) => t.includes('singing jobs view render failed')), JSON.stringify({ exceptions, consoleErrors }));

    // 4. 无凭据打开控制台:提示凭据无效并停止轮询(4 秒内不再发请求)
    jobsRequests = 0;
    await send('Page.navigate', { url: `${base}/control` });
    const stopped = await waitFor(`(document.getElementById('singing-note')?.textContent ?? '').includes('凭据无效')`, 10_000);
    const afterFirst = jobsRequests;
    await sleep(4000);
    check('无凭据:提示凭据无效且停止轮询', stopped && afterFirst === 1 && jobsRequests === 1, `提示=${stopped} 首次后请求=${afterFirst} 4 秒后请求=${jobsRequests}`);
    const noCred = await snapshot();
    check('无凭据:面板保持未就绪占位,不显示任务', noCred.jobs.length === 0 && noCred.enabled === '唱歌:-', JSON.stringify(noCred));
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    killEdgeTree();
    try { stopTestServer(port); } catch (err) { console.log(`WARN 停止隔离实例失败: ${String(err.message ?? err)}`); }
    // 释放预置数据目录(服务停止后文件句柄可能短暂占用,带重试)
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* 临时目录 */ }
  }
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('面板 E2E 失败:', err);
  killEdgeTree();
  try { stopTestServer(port); } catch { /* ignore */ }
  process.exit(1);
});
