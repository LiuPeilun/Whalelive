// P1 第三批端到端:零配置启动、模型配置状态、回复预览降级与阶段耗时统计。
// 脚本自启隔离服务(临时数据目录,不设 DEEPSEEK_API_KEY),不触碰调用者日常实例。
// 用法:node scripts/e2e-llm.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS ${name}`); }
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 预置测试实例为离线语音:标称离线的检查不得调用在线 Edge TTS(WT-P1-024)。 */
function prepareOfflineTts(dataDir) {
  const dir = path.join(dataDir, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    formatVersion: 1,
    savedVersion: 1,
    settings: { tts: { provider: 'fixed-local', voice: 'zh-CN-XiaoxiaoNeural' } },
  }));
}

async function main() {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(tempRoot, 'whaletalk-llm-'));
  if (path.dirname(fixture) !== tempRoot) throw new Error('测试目录不在系统临时目录下');
  const dataDir = path.join(fixture, 'data');
  process.once('exit', () => fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5 }));
  let app;
  try {
    // 显式清空模型密钥,模拟零配置环境;语音固定为离线罐头,不触网。
    prepareOfflineTts(dataDir);
    const env = { WHALETALK_DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', PLATFORM: 'mock', DEEPSEEK_API_KEY: '' };
    const { createApp } = await tsImport('../src/server/app.ts', import.meta.url);
    app = await createApp({ env });
    const base = app.urls.base;
    const token = new URL(app.urls.control).hash.slice(1);
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const get = async (p) => {
      const r = await fetch(`${base}${p}`, { headers: auth, signal: AbortSignal.timeout(5000) });
      return { status: r.status, body: await r.json() };
    };
    const post = async (p, body) => {
      const r = await fetch(`${base}${p}`, { method: 'POST', headers: auth, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      return { status: r.status, body: await r.json() };
    };

    // 1. 零配置启动:健康检查正常
    const health = await get('/api/health');
    check('零配置服务启动且健康检查正常', health.status === 200 && health.body.ok === true, JSON.stringify(health.body));

    // 2. 配置状态:provider=fixed-local,密钥未配置,不含密钥字段
    const cfg = await get('/api/llm/config');
    check('配置状态可读且密钥未配置', cfg.status === 200 && cfg.body.configured === false && cfg.body.active === 'fixed-local', JSON.stringify(cfg.body));
    check('配置状态不泄漏密钥', !JSON.stringify(cfg.body).includes('sk-'), JSON.stringify(cfg.body));

    // 3. 回复预览:零配置走固定回复,带来源与耗时
    const preview = await post('/api/llm/preview', { text: '大家晚上好' });
    check('回复预览返回成功', preview.status === 200, JSON.stringify(preview.body));
    check('预览来源为 fixed-local 且含耗时', preview.body?.provider === 'fixed-local' && typeof preview.body?.elapsedMs === 'number', JSON.stringify(preview.body));
    check('预览文本非空', typeof preview.body?.say === 'string' && preview.body.say.length > 0, JSON.stringify(preview.body));

    // 4. 预览参数校验
    const badPreview = await post('/api/llm/preview', { text: '' });
    check('空文本预览被拒绝(400)', badPreview.status === 400, JSON.stringify(badPreview.body));

    // 5. 模拟弹幕走完整链路,状态快照出现 metrics
    const mock = await post('/api/mock/events', { type: 'chat', text: '随便聊聊', userId: 'llm-e2e', userName: '统计员' });
    check('模拟弹幕入队成功', mock.status === 200 && mock.body?.enqueue?.accepted === true, JSON.stringify(mock.body));
    let snapshot = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const s = await get('/api/state');
      if (s.body?.metrics?.last) { snapshot = s.body; break; }
    }
    check('状态快照包含耗时与用量统计', snapshot !== null, '未等到 metrics.last');
    check('统计含阶段耗时字段', snapshot && ['queueWaitMs', 'generationMs', 'synthesisMs', 'playbackMs', 'totalMs'].every((k) => k in snapshot.metrics.last), JSON.stringify(snapshot?.metrics?.last));
    check('统计来源为 rule 或 fixed-local', snapshot && ['rule', 'fixed-local', 'fallback'].includes(snapshot.metrics.last.provider), JSON.stringify(snapshot?.metrics?.last));

    console.log(`\n零配置场景:${passed} 通过,${failed} 失败`);
    return failed === 0;
  } finally {
    await app?.close();
  }
}

/** 假 Key 场景:本地假模型端点验证 env 配置贯通(填 Key 后自动生效)。 */
async function runWithFakeKey() {
  // 本地假模型服务:返回合法短回复 JSON 与 token 用量,记录是否收到 Bearer 与系统提示。
  let sawAuth = false;
  let sawSystem = false;
  let modelRequests = 0;
  const fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      sawAuth = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ');
      const body = JSON.parse(raw || '{}');
      sawSystem = Array.isArray(body.messages) && body.messages.some((m) => m.role === 'system');
      modelRequests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (modelRequests === 1) {
        // 第 1 次(预览):合法回复
        res.end(JSON.stringify({
          choices: [{ message: { content: '{"say":"今晚吃什么好呀","action":null,"emotion":"happy"}' } }],
          usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
        }));
      } else {
        // 第 2 次起(直播弹幕,WT-P1-022):非法 JSON + usage——保底内容但用量保留
        res.end(JSON.stringify({
          choices: [{ message: { content: '不是 JSON 的输出' } }],
          usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
        }));
      }
    });
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const fakePort = fake.address().port;

  const tempRoot = fs.realpathSync(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(tempRoot, 'whaletalk-llm-key-'));
  if (path.dirname(fixture) !== tempRoot) throw new Error('测试目录不在系统临时目录下');
  const dataDir = path.join(fixture, 'data');
  process.once('exit', () => fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5 }));
  let app;
  try {
    // 预置设置:provider=deepseek;env 提供假 Key 与本地端点。
    const settingsDir = path.join(dataDir, 'config');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
      formatVersion: 1, savedVersion: 1,
      // 语音固定离线:本场景只验证模型配置贯通,不依赖在线 Edge TTS(WT-P1-024)
      settings: { llm: { provider: 'deepseek' }, tts: { provider: 'fixed-local', voice: 'zh-CN-XiaoxiaoNeural' } },
    }));
    const env = {
      WHALETALK_DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', PLATFORM: 'mock',
      DEEPSEEK_API_KEY: 'sk-fake-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${fakePort}`,
    };
    const { createApp } = await tsImport('../src/server/app.ts', import.meta.url);
    app = await createApp({ env });
    const base = app.urls.base;
    const token = new URL(app.urls.control).hash.slice(1);
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const cfg = await (await fetch(`${base}/api/llm/config`, { headers: auth })).json();
    check('假 Key 场景:密钥已配置且生效来源为 deepseek', cfg.configured === true && cfg.active === 'deepseek', JSON.stringify(cfg));

    const preview = await (await fetch(`${base}/api/llm/preview`, {
      method: 'POST', headers: auth, body: JSON.stringify({ text: '吃啥' }),
    })).json();
    check('假 Key 场景:预览走模型并解析回复', preview.provider === 'deepseek' && preview.say === '今晚吃什么好呀', JSON.stringify(preview));
    check('假 Key 场景:上报 token 用量', preview.usage?.totalTokens === 32, JSON.stringify(preview.usage));
    check('假 Key 场景:请求带 Bearer 与系统提示', sawAuth && sawSystem, `auth=${sawAuth} system=${sawSystem}`);

    // WT-P1-022 直播入口复验:上游返回非法 JSON + 32 token → 保底内容、
    // 来源标记 fallback、累计用量增加 32(非法回复不丢已发生的用量)。
    const api = async (method, pathname, body) => await (await fetch(`${base}${pathname}`, {
      method, headers: { ...auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })).json();
    const totalsBefore = (await api('GET', '/api/state')).metrics.totals.totalTokens;
    const bad = await api('POST', '/api/mock/events', { type: 'chat', text: '触发非法回复', userId: 'llm-e2e-bad', userName: '统计员' });
    check('非法回复场景:弹幕入队成功', bad?.enqueue?.accepted === true, JSON.stringify(bad));
    let badSnap = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const s2 = await api('GET', '/api/state');
      if (s2.metrics?.last?.provider === 'fallback') { badSnap = s2; break; }
    }
    check('非法回复场景:来源标记 fallback(WT-P1-021)', badSnap !== null, '未等到 fallback');
    if (badSnap) {
      const totalsAfter = (await api('GET', '/api/state')).metrics.totals.totalTokens;
      check('非法回复场景:累计用量增加 32(WT-P1-022)', totalsAfter - totalsBefore === 32, `before=${totalsBefore} after=${totalsAfter}`);
    }

    return failed === 0;
  } finally {
    await app?.close();
    await new Promise((resolve) => fake.close(resolve));
  }
}

/** 预览诊断场景:选了 DeepSeek 但缺 Key,控制台应能看到具体原因(WT-P1-021)。 */
async function runDiagnostics() {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(tempRoot, 'whaletalk-llm-diag-'));
  if (path.dirname(fixture) !== tempRoot) throw new Error('测试目录不在系统临时目录下');
  const dataDir = path.join(fixture, 'data');
  process.once('exit', () => fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5 }));
  const settingsDir = path.join(dataDir, 'config');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
    formatVersion: 1, savedVersion: 1,
    settings: { llm: { provider: 'deepseek' }, tts: { provider: 'fixed-local', voice: 'zh-CN-XiaoxiaoNeural' } },
  }));
  let app;
  try {
    const env = { WHALETALK_DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', PLATFORM: 'mock', DEEPSEEK_API_KEY: '' };
    const { createApp } = await tsImport('../src/server/app.ts', import.meta.url);
    app = await createApp({ env });
    const base = app.urls.base;
    const token = new URL(app.urls.control).hash.slice(1);
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const cfg = await (await fetch(`${base}/api/llm/config`, { headers: auth })).json();
    check('诊断场景:配置暴露缺 Key 回退原因', cfg.fallbackReason === 'DEEPSEEK_KEY_MISSING', JSON.stringify(cfg));
    const res = await fetch(`${base}/api/llm/preview`, { method: 'POST', headers: auth, body: JSON.stringify({ text: '测试' }) });
    const body = await res.json();
    check('诊断场景:缺 Key 预览返回 502', res.status === 502, JSON.stringify({ status: res.status, body }));
    check('诊断场景:缺 Key 预览返回 LLM_UNAVAILABLE', body?.code === 'LLM_UNAVAILABLE', JSON.stringify(body));
    return failed === 0;
  } finally {
    await app?.close();
  }
}

const zeroOk = await main();
const keyOk = await runWithFakeKey();
const diagOk = await runDiagnostics();
console.log(`\nP1 第三批端到端:${failed === 0 && zeroOk && keyOk && diagOk ? '全部通过' : `${failed} 失败`}`);
process.exitCode = (zeroOk && keyOk && diagOk && failed === 0) ? 0 : 1;
