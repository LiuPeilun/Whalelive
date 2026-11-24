// 唱歌管线冒烟(P3):隔离实例(mock 平台) + mock 点歌弹幕 → 真实管线
// (B站搜歌 → Demucs 分离 → 测 f0 → RVC 换声) → 成片落盘 → 二次点歌缓存命中。
// 用法: node scripts/singing-smoke.mjs [port]
// 真实管线约 90 秒 + 首次冷启动;整脚本上限 6 分钟。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logFileFor, startTestServer, stopTestServer } from './lib/test-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 3721);
const base = `http://127.0.0.1:${port}`;
const logFile = logFileFor(port);
// 数据目录放项目内(data/ 已忽略):%TEMP% 对 RVC runtime 的 python.exe 有写入拦截(实测 PermissionError)
const dataDir = path.join(root, 'data', `.singing-smoke-${Date.now()}`);

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

async function main() {
  console.log(`隔离实例端口 ${port},数据目录 ${dataDir}`);
  const server = await startTestServer({
    port,
    extraEnv: {
      PLATFORM: 'mock',
      WHALETALK_DATA_DIR: dataDir,
      DEEPSEEK_API_KEY: '',
      BILI_OPEN_APP_ID: '',
      BILI_OPEN_APP_SECRET: '',
    },
  });
  try {
    const healthy = await server.waitHealthy(30_000);
    check('隔离实例就绪', healthy);

    const access = JSON.parse(fs.readFileSync(path.join(dataDir, 'access.json'), 'utf8'));
    const controlAuth = { authorization: `Bearer ${access.control}` };

    // 1. 点歌弹幕(mock):应被 singing 拦截并入队确认回复
    const req = await http('/api/mock/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...controlAuth },
      body: JSON.stringify({ type: 'chat', text: '点歌 篇章 张韶涵 MV', userId: 'smoke', userName: '冒烟员' }),
    });
    check('点歌弹幕被接受', req.status === 200 && req.body?.enqueue?.accepted === true, JSON.stringify(req.body));

    // 2. 等真实管线跑完(日志出现 singing.job-ready;上限 300 秒)
    let readyLog = '';
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      readyLog = tailLog();
      if (readyLog.includes('singing.job-ready')) break;
      if (readyLog.includes('singing.job-failed')) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    check('管线完成(job-ready)', readyLog.includes('singing.job-ready'),
      readyLog.includes('singing.job-failed') ? '见 job-failed 日志' : '超时 300s');

    // 3. 成片文件落盘(确定性命名,paths.audioCacheDir=dataDir/cache/audio)
    const cacheDir = path.join(dataDir, 'cache', 'audio');
    const songs = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((n) => /^song-[0-9a-f]{12}\.mp3$/.test(n)) : [];
    check('成片 mp3 落盘', songs.length === 1, JSON.stringify(songs));
    if (songs.length === 1) {
      const size = fs.statSync(path.join(cacheDir, songs[0])).size;
      check('成片体积合理(>50KB)', size > 50_000, `${size} bytes`);
    }

    // 4. 二次点同一首:缓存命中(cache-hit 日志)+ 第二个 song 条目入队
    const again = await http('/api/mock/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...controlAuth },
      body: JSON.stringify({ type: 'chat', text: '点歌 篇章 张韶涵 MV', userId: 'smoke2', userName: '冒烟员二' }),
    });
    check('二次点歌被接受', again.status === 200 && again.body?.enqueue?.accepted === true, JSON.stringify(again.body));
    await new Promise((r) => setTimeout(r, 2000));
    check('二次点歌缓存命中', tailLog().includes('singing.cache-hit'));
    const enqueuedCount = (tailLog().match(/interaction\.song-enqueued/g) ?? []).length;
    check('两个 song 条目入队', enqueuedCount === 2, `enqueued=${enqueuedCount}`);
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
