// 环境实测②:重置凭据复测(ROADMAP 待办)。
// 前置:服务已以 `npm run start:reset-access` 运行(旧凭据已撤销,access.json 重新生成)。
// 验证:旧凭据(HTTP 与 WS,control 与 playback 两种作用域)全部被拒;
// 新凭据(HTTP 与 WS)可用。旧凭据值以环境变量 OLD_CONTROL/OLD_PLAYBACK 提供。
// 用法:node scripts/reset-access-verify.mjs [port]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? process.env.PORT ?? 3210);
const base = `http://127.0.0.1:${port}`;
const fresh = JSON.parse(fs.readFileSync(path.join(root, 'data', 'access.json'), 'utf8'));
const OLD_CONTROL = process.env.OLD_CONTROL ?? '';
const OLD_PLAYBACK = process.env.OLD_PLAYBACK ?? '';
if (!OLD_CONTROL || !OLD_PLAYBACK) {
  console.error('缺少旧凭据:请以环境变量 OLD_CONTROL / OLD_PLAYBACK 提供重置前的值(可从旧启动输出或 git 历史恢复)。');
  process.exit(1);
}

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`PASS ${name}`); }
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

async function httpStatus(pathname, cred) {
  try {
    const r = await fetch(`${base}${pathname}`, { headers: { authorization: `Bearer ${cred}` } });
    return r.status;
  } catch {
    return 'down';
  }
}

function wsAuth(credential, role) {
  return new Promise((resolve) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
    const timer = setTimeout(() => { try { s.close(); } catch { /* ignore */ } resolve('timeout'); }, 5000);
    s.on('open', () => s.send(JSON.stringify({ kind: 'auth', protocolVersion: 1, role, credential })));
    s.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.kind === 'auth-result') {
        clearTimeout(timer);
        try { s.close(); } catch { /* ignore */ }
        resolve(m.ok ? 'granted' : `rejected:${m.code}`);
      }
    });
    s.on('error', () => { clearTimeout(timer); resolve('error'); });
  });
}

async function main() {
  const health = await fetch(`${base}/api/health`);
  check('服务运行中(reset-access 模式)', health.status === 200, `status=${health.status}`);

  check('旧 control 凭据 HTTP 被拒(401)', (await httpStatus('/api/state', OLD_CONTROL)) === 401);
  check('旧 playback 凭据 HTTP 被拒(401)', (await httpStatus('/api/state', OLD_PLAYBACK)) === 401);
  check('新 control 凭据 HTTP 可用(200)', (await httpStatus('/api/state', fresh.control)) === 200);

  check('旧 control 凭据 WS 认证被拒', (await wsAuth(OLD_CONTROL, 'control')) === 'rejected:AUTH_REJECTED');
  check('旧 playback 凭据 WS 认证被拒', (await wsAuth(OLD_PLAYBACK, 'playback')) === 'rejected:AUTH_REJECTED');
  check('新 control 凭据 WS 认证成功', (await wsAuth(fresh.control, 'control')) === 'granted');
  check('新 playback 凭据 WS 认证成功', (await wsAuth(fresh.playback, 'playback')) === 'granted');

  console.log(`\nreset-access 复测:${passed} 通过,${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
