// P1 第三批:真实 DeepSeek 模型端到端验证(经本地 SSH 隧道)。
// 读取项目根 .env.local 的模型配置,自启隔离服务,预置 llm.provider=deepseek,
// 发送真实弹幕,确认模型产出回复、动作白名单生效、token 用量上报。
// 前置:先运行 node scripts/start-model-tunnel.mjs 保持隧道。
// 用法:node scripts/e2e-deepseek-live.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

function readEnv() {
  const file = path.join(root, '.env.local');
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function main() {
  const cfg = readEnv();
  check('.env.local 含模型配置', Boolean(cfg.DEEPSEEK_BASE_URL && cfg.DEEPSEEK_MODEL), JSON.stringify({ url: cfg.DEEPSEEK_BASE_URL, model: cfg.DEEPSEEK_MODEL }));

  // 先确认隧道就绪
  let models;
  try {
    const res = await fetch(`${cfg.DEEPSEEK_BASE_URL.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(5000) });
    models = await res.json();
  } catch (err) {
    console.log(`模型端点不可达:${String(err)}。请先运行 node scripts/start-model-tunnel.mjs`);
    return false;
  }
  const ids = (models.data ?? []).map((m) => m.id);
  check('模型列表可达', ids.length > 0, JSON.stringify(ids));
  check('配置模型在列表中', ids.includes(cfg.DEEPSEEK_MODEL), `配置=${cfg.DEEPSEEK_MODEL} 列表=${ids.join(',')}`);

  const tempRoot = fs.realpathSync(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(tempRoot, 'whaletalk-ds-live-'));
  if (path.dirname(fixture) !== tempRoot) throw new Error('测试目录不在系统临时目录下');
  process.once('exit', () => fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5 }));
  const dataDir = path.join(fixture, 'data');
  const settingsDir = path.join(dataDir, 'config');
  fs.mkdirSync(settingsDir, { recursive: true });
  // 预置:provider=deepseek,tts=fixed-local(聚焦 LLM 验证,不联网合成)。
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
    formatVersion: 1, savedVersion: 1,
    settings: { llm: { provider: 'deepseek' }, tts: { provider: 'fixed-local', voice: 'zh-CN-XiaoxiaoNeural' } },
  }));

  let app;
  try {
    const env = {
      WHALETALK_DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', PLATFORM: 'mock',
      DEEPSEEK_API_KEY: cfg.DEEPSEEK_API_KEY || 'EMPTY',
      DEEPSEEK_BASE_URL: cfg.DEEPSEEK_BASE_URL,
      DEEPSEEK_MODEL: cfg.DEEPSEEK_MODEL,
      DEEPSEEK_THINKING: cfg.DEEPSEEK_THINKING || 'disabled',
    };
    const { createApp } = await tsImport('../src/server/app.ts', import.meta.url);
    app = await createApp({ env });
    const base = app.urls.base;
    const token = new URL(app.urls.control).hash.slice(1);
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const cfgRes = await (await fetch(`${base}/api/llm/config`, { headers: auth })).json();
    check('服务生效来源为 deepseek', cfgRes.active === 'deepseek' && cfgRes.configured === true, JSON.stringify(cfgRes));

    // 直接用预览接口打真实模型(避免 TTS 干扰),核对回复与用量
    const started = Date.now();
    const previewRes = await fetch(`${base}/api/llm/preview`, {
      method: 'POST', headers: auth, body: JSON.stringify({ text: '用一句话夸夸大肥鱼' }),
      signal: AbortSignal.timeout(30000),
    });
    const preview = await previewRes.json();
    check('真实模型预览返回成功', previewRes.status === 200, JSON.stringify(preview));
    check('回复来源标记为 deepseek', preview.provider === 'deepseek', JSON.stringify(preview));
    check('回复文本非空', typeof preview.say === 'string' && preview.say.trim().length > 0, JSON.stringify(preview));
    check('上报 token 用量', typeof preview.usage?.totalTokens === 'number' && preview.usage.totalTokens > 0, JSON.stringify(preview.usage));
    console.log(`模型回复:${preview.say}`);
    console.log(`动作:${preview.action ?? 'null'} 情绪:${preview.emotion ?? '-'} 耗时:${preview.elapsedMs}ms token:${preview.usage?.totalTokens ?? 0}`);

    // 白名单校验:即使模型建议动作,also 必须来自角色清单
    const whitelistRes = await (await fetch(`${base}/api/llm/preview`, {
      method: 'POST', headers: auth, body: JSON.stringify({ text: '请做一个后空翻这种不存在的动作' }), signal: AbortSignal.timeout(30000),
    })).json();
    const allowed = ['idle', 'wave', 'think', 'talk', 'eat', 'dance', 'gift', 'celebrate'];
    check('动作始终在白名单内', whitelistRes.action === null || allowed.includes(whitelistRes.action), JSON.stringify(whitelistRes.action));

    // 完整弹幕链路:确认 interaction 记录 deepseek 来源与 token
    const mockRes = await (await fetch(`${base}/api/mock/events`, {
      method: 'POST', headers: auth, body: JSON.stringify({ type: 'chat', text: '你觉得直播间的大家可爱吗', userId: 'live-dsv4', userName: '实测员' }),
    })).json();
    check('真实弹幕入队成功', mockRes.enqueue?.accepted === true, JSON.stringify(mockRes));
    let snap;
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      const s = await (await fetch(`${base}/api/state`, { headers: auth })).json();
      if (s.metrics?.last?.provider === 'deepseek') { snap = s; break; }
    }
    check('完整链路记录 deepseek 来源', Boolean(snap), '未等到 deepseek 来源的 metrics');
    check('累计 token > 0', (snap?.metrics?.totals?.totalTokens ?? 0) > 0, JSON.stringify(snap?.metrics?.totals));

    console.log(`\n真实模型端到端:${passed} 通过,${failed} 失败`);
    return failed === 0;
  } finally {
    await app?.close();
  }
}

process.exitCode = (await main()) ? 0 : 1;
