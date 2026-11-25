// 唱歌管线冒烟(P3):隔离实例(mock 平台) + mock 点歌弹幕 → 真实管线
// (B站搜歌 → Demucs 分离 → 测 f0 → RVC 换声) → 成片落盘 → 二次点歌缓存命中。
// 同时验证控制台点歌面板的数据源 GET /api/singing/jobs:阶段推进、成片字段、
// 缓存标记、失败原因(另发一个查无此歌的点歌,走真实取歌失败路径)。
// 用法: node scripts/singing-smoke.mjs [port]
// 真实管线约 90 秒 + 首次冷启动;整脚本上限 6 分钟。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logFileFor, startTestServer, stopTestServer } from './lib/test-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 3721);
const base = `http://127.0.0.1:${port}`;
const logFile = logFileFor(port);
// 数据目录放项目内(data/ 已忽略):%TEMP% 对 RVC runtime 的 python.exe 有写入拦截(实测 PermissionError)
const dataDir = path.join(root, 'data', `.singing-smoke-${Date.now()}`);
const TITLE = '篇章 张韶涵 MV';

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

function tailLog() {
  try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`隔离实例端口 ${port},数据目录 ${dataDir}`);
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
  try {
    const healthy = await server.waitHealthy(30_000);
    check('隔离实例就绪', healthy);

    const access = JSON.parse(fs.readFileSync(path.join(dataDir, 'access.json'), 'utf8'));
    const controlAuth = { authorization: `Bearer ${access.control}` };
    const jobsView = async () => http('/api/singing/jobs', { headers: controlAuth });
    const jobOf = (view, title) => (Array.isArray(view.body?.jobs) ? view.body.jobs.find((j) => j.title === title) ?? null : null);
    const postSong = async (text, userId, userName) => http('/api/mock/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...controlAuth },
      body: JSON.stringify({ type: 'chat', text, userId, userName }),
    });

    // 0. 点歌面板数据源:鉴权矩阵与初始空快照
    const anonymous = await http('/api/singing/jobs');
    check('点歌面板快照无凭据被拒(401)', anonymous.status === 401, `status=${anonymous.status}`);
    const playbackCred = await http('/api/singing/jobs', { headers: { authorization: `Bearer ${access.playback}` } });
    check('点歌面板快照播放端凭据被拒(401)', playbackCred.status === 401, `status=${playbackCred.status}`);
    const initial = await jobsView();
    check('点歌面板初始快照:已开启、无在途、无任务',
      initial.status === 200 && initial.body?.enabled === true && initial.body?.active === 0 && Array.isArray(initial.body?.jobs) && initial.body.jobs.length === 0,
      JSON.stringify(initial.body));

    // 1. 点歌弹幕(mock):应被 singing 拦截并入队确认回复
    const req = await postSong(`点歌 ${TITLE}`, 'smoke', '冒烟员');
    check('点歌弹幕被接受', req.status === 200 && req.body?.enqueue?.accepted === true, JSON.stringify(req.body));

    // 2. 等真实管线跑完:轮询面板快照并记录阶段序列;日志 job-ready / job-failed 兜底判断
    const observed = [];
    let lastJob = null;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const view = await jobsView();
      lastJob = jobOf(view, TITLE);
      if (lastJob && observed[observed.length - 1] !== lastJob.stage) observed.push(lastJob.stage);
      if (lastJob && (lastJob.stage === 'ready' || lastJob.stage === 'failed')) break;
      if (tailLog().includes('singing.job-failed')) break;
      await sleep(1000);
    }
    const readyLog = tailLog();
    check('管线完成(job-ready)', readyLog.includes('singing.job-ready'),
      readyLog.includes('singing.job-failed') ? '见 job-failed 日志' : '超时 300s');
    check('面板快照:任务到达已就绪', lastJob?.stage === 'ready', lastJob ? `stage=${lastJob.stage} error=${lastJob.error ?? ''}` : '任务未出现在面板快照');
    console.log(`阶段序列: ${observed.join(' → ')}`);
    check('面板快照:阶段随管线推进(不再全程停在排队中)', observed.length >= 2, observed.join(' → '));
    check('面板快照:成片地址、移调值与来源标题齐全',
      typeof lastJob?.audioUrl === 'string' && /^\/media\/audio\/song-[0-9a-f]{12}\.mp3$/.test(lastJob.audioUrl)
        && Number.isInteger(lastJob.key) && typeof lastJob.chosenTitle === 'string' && lastJob.chosenTitle !== ''
        && lastJob.cached === false && lastJob.error === null,
      JSON.stringify(lastJob));

    // 3. 成片文件落盘(确定性命名,paths.audioCacheDir=dataDir/cache/audio)
    const cacheDir = path.join(dataDir, 'cache', 'audio');
    const songs = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((n) => /^song-[0-9a-f]{12}\.mp3$/.test(n)) : [];
    check('成片 mp3 落盘', songs.length === 1, JSON.stringify(songs));
    if (songs.length === 1) {
      const size = fs.statSync(path.join(cacheDir, songs[0])).size;
      check('成片体积合理(>50KB)', size > 50_000, `${size} bytes`);
    }

    // 4. 二次点同一首:缓存命中(cache-hit 日志)+ 第二个 song 条目入队
    const again = await postSong(`点歌 ${TITLE}`, 'smoke2', '冒烟员二');
    check('二次点歌被接受', again.status === 200 && again.body?.enqueue?.accepted === true, JSON.stringify(again.body));
    await sleep(2000);
    check('二次点歌缓存命中', tailLog().includes('singing.cache-hit'));
    const enqueuedCount = (tailLog().match(/interaction\.song-enqueued/g) ?? []).length;
    check('两个 song 条目入队', enqueuedCount === 2, `enqueued=${enqueuedCount}`);
    const afterSecond = await jobsView();
    const cachedJob = jobOf(afterSecond, TITLE);
    check('面板快照:二次点歌任务标记缓存成片,成片地址与首次一致',
      cachedJob?.stage === 'ready' && cachedJob?.cached === true && cachedJob?.audioUrl === lastJob?.audioUrl && cachedJob?.key === null,
      JSON.stringify(cachedJob));
    check('面板快照:在途数归零', afterSecond.body?.active === 0 && afterSecond.body?.maxActive >= 1,
      JSON.stringify({ active: afterSecond.body?.active, maxActive: afterSecond.body?.maxActive }));

    // 5. 查无此歌的点歌:真实取歌失败 → 面板快照给出失败原因且无成片
    const badTitle = `查无此歌qzx${Date.now() % 100000} wvkwxyz`;
    const bad = await postSong(`点歌 ${badTitle}`, 'smoke3', '冒烟员三');
    check('查无此歌的点歌被受理(失败发生在制作阶段)', bad.status === 200 && bad.body?.enqueue?.accepted === true, JSON.stringify(bad.body));
    let badJob = null;
    const badDeadline = Date.now() + 90_000;
    while (Date.now() < badDeadline) {
      badJob = jobOf(await jobsView(), badTitle);
      if (badJob && (badJob.stage === 'failed' || badJob.stage === 'ready')) break;
      await sleep(1000);
    }
    check('面板快照:失败任务给出取歌失败原因且无成片',
      badJob?.stage === 'failed' && typeof badJob.error === 'string' && badJob.error.startsWith('fetch:') && badJob.audioUrl === null && badJob.key === null,
      JSON.stringify(badJob));
  } finally {
    stopTestServer(port);
  }
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  try { stopTestServer(port); } catch { /* ignore */ }
  process.exit(1);
});
