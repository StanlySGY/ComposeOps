import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const dir = mkdtempSync(path.join(os.tmpdir(), 'sre-next-routes-')); process.env.DB_PATH = path.join(dir, 'db.sqlite'); process.env.DISABLE_BACKGROUND_JOBS = '1'; process.env.SERVE_FRONTEND = '0';
const { default: db } = await import('../src/lib/db.js');
const { buildApp } = await import('../src/app.js');
const { setPassword } = await import('../src/lib/auth.js');
const { rotatePlatformMonitorToken } = await import('../src/services/sre-platform.js');
let app, headers;
test.before(async () => { app = await buildApp({ logger: false }); setPassword('isolated-sre-next-password'); const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'isolated-sre-next-password' }, headers: { origin: 'http://localhost', host: 'localhost' } }); headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'http://localhost', host: 'localhost' }; });
test.after(async () => { await app.close(); await import('../src/services/workflow-engine.js'); await new Promise(resolve => setImmediate(resolve)); db.close(); rmSync(dir, { recursive: true, force: true }); });
test('新管理路由都需要会话，监测令牌不能访问管理 API', async () => {
  const { token } = rotatePlatformMonitorToken();
  for (const url of ['/api/v1/sre/business-recovery', '/api/v1/sre/onboarding', '/api/v1/sre/releases', '/api/v1/sre/telemetry/credentials', '/api/v1/sre/platform', '/api/v1/sre/diagnosis/evaluations']) {
    assert.equal((await app.inject({ url })).statusCode, 401, url);
    assert.equal((await app.inject({ url, headers: { authorization: 'Bearer ' + token } })).statusCode, 401, url);
    assert.equal((await app.inject({ url, headers })).statusCode, 200, url);
  }
});
test('外源修改请求被拒绝，所有新操作校验请求体', async () => {
  for (const url of ['/api/v1/sre/business-recovery/plans', '/api/v1/sre/onboarding', '/api/v1/sre/releases/review', '/api/v1/sre/telemetry/credentials']) {
    assert.equal((await app.inject({ method: 'POST', url, payload: {}, headers: { ...headers, origin: 'https://foreign.example' } })).statusCode, 403, url);
    assert.equal((await app.inject({ method: 'POST', url, payload: {}, headers })).statusCode, 400, url);
  }
});
test('恢复、发布与接入执行都要求对应确认语义，不接受空确认', async () => {
  for (const url of ['/api/v1/sre/business-recovery/plans/missing/run', '/api/v1/sre/business-recovery/plans/missing/backup', '/api/v1/sre/releases/missing/approve', '/api/v1/sre/onboarding/missing/apply']) {
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: {} })).statusCode, 400, url);
  }
});
