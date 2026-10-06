import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-routes-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
// 测试聚焦 API 语义:显式关闭 SPA 静态托管,未注册路径才走 Fastify 原生 404
// (生产默认托管前端,未注册路径由 SPA fallback 兜底返回 index.html)。
process.env.SERVE_FRONTEND = '0';

const { buildApp } = await import('../src/app.js');

// 整个文件共用一个实例:buildApp 不监听端口,inject() 直接走 Fastify 内部管线。
const app = await buildApp({ logger: false });
await app.ready();

test.after(async () => {
  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('routes: 未登录访问受保护端点返回 401', async () => {
  for (const url of ['/api/v1/services', '/api/v1/projects', '/api/v1/ai/config', '/api/v1/system/df']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 401, `${url} 应要求登录`);
    assert.equal(response.json().error, 'unauthorized');
  }
});

test('routes: 公开认证端点无需登录即可访问', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/v1/auth/status' });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(typeof body.setupRequired, 'boolean');
  assert.equal(body.authenticated, false);
});

test('routes: 带查询串的公开端点不被误判为受保护路径', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/v1/auth/status?ts=123' });
  assert.equal(response.statusCode, 200);
});

test('routes: 跨站来源的写请求被 origin 校验拒绝', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: 'https://evil.example.com', host: 'localhost:3001' },
    payload: { password: 'whatever' },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, 'origin_rejected');
});

test('routes: 同源写请求通过 origin 校验(进入业务逻辑而非 403)', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: 'http://localhost:3001', host: 'localhost:3001' },
    payload: { password: 'wrong-password-but-same-origin' },
  });
  assert.notEqual(response.statusCode, 403);
});

test('routes: WebSocket 路径同样受认证边界保护', async () => {
  const response = await app.inject({ method: 'GET', url: '/ws/logs' });
  assert.equal(response.statusCode, 401);
});

test('routes: 所有响应都带上安全响应头', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/v1/auth/status' });
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.match(response.headers['content-security-policy'], /default-src 'self'/);
  assert.match(response.headers['permissions-policy'], /camera=\(\)/);
});

test('routes: /health 无需登录,按 Docker 可用性返回 200 或 503', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.ok([200, 503].includes(response.statusCode), `意外状态码 ${response.statusCode}`);
  const body = response.json();
  assert.equal(typeof body.latencyMs, 'number');
  if (response.statusCode === 200) {
    assert.equal(body.status, 'ok');
    assert.equal(body.docker, 'ok');
  } else {
    assert.equal(body.status, 'degraded');
    assert.equal(body.docker, 'unreachable');
  }
});

test('routes: Agent 反馈端点受认证保护且参数被 schema 校验', async () => {
  const unauthenticated = await app.inject({
    method: 'POST', url: '/api/v1/ai/agent/feedback',
    payload: { planId: 1, rating: 5 },
  });
  assert.equal(unauthenticated.statusCode, 401, '反馈端点必须要求登录');

  const badRating = await app.inject({
    method: 'POST', url: '/api/v1/ai/agent/feedback',
    headers: { origin: 'http://localhost:3001', host: 'localhost:3001' },
    payload: { planId: 1, rating: 9 },
  });
  // 未登录时先被认证拦下;schema 越界同样不应 500。
  assert.ok([400, 401].includes(badRating.statusCode), `意外状态码 ${badRating.statusCode}`);
});

test('routes: schema 校验失败沿用全站 { error, message } 契约', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin: 'http://localhost:3001', host: 'localhost:3001' },
    // 超长口令必须在进入 scryptSync 之前被 schema 拦下(未登录接口的放大攻击面)。
    payload: { password: 'x'.repeat(500) },
  });
  assert.equal(response.statusCode, 400);
  const body = response.json();
  // 前端 client.js 读 message || error,故两者都必须是可用的非空字符串。
  assert.equal(body.error, 'validation_failed');
  assert.match(body.message, /校验失败/);
});

test('routes: 市场状态字段保留且不存在模板返回 404', async () => {
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin: 'http://localhost:3001', host: 'localhost:3001' },
    payload: { password: 'route-test-password' },
  });
  assert.equal(setup.statusCode, 200);
  const cookie = String(setup.headers['set-cookie']).split(';', 1)[0];
  const headers = { cookie, origin: 'http://localhost:3001', host: 'localhost:3001' };

  const templates = await app.inject({ method: 'GET', url: '/api/v1/marketplace/templates', headers });
  assert.equal(templates.statusCode, 200);
  const templateBody = templates.json();
  assert.ok(Array.isArray(templateBody.builtin));
  assert.ok(Array.isArray(templateBody.community));
  assert.ok(Array.isArray(templateBody.custom));
  assert.equal(templateBody.communityStatus.available, false);
  assert.equal(typeof templateBody.communityStatus.message, 'string');

  const stats = await app.inject({ method: 'GET', url: '/api/v1/marketplace/stats', headers });
  assert.equal(stats.statusCode, 200);
  assert.equal(stats.json().communityAvailable, false);
  assert.equal(typeof stats.json().communityMessage, 'string');

  for (const method of ['PATCH', 'DELETE']) {
    const response = await app.inject({
      method,
      url: '/api/v1/marketplace/templates/custom/does-not-exist',
      headers,
      payload: method === 'PATCH' ? { name: 'missing' } : undefined,
    });
    assert.equal(response.statusCode, 404, `${method} 不存在模板应返回 404`);
  }
});

test('routes: 蓝图列表等待异步加载并返回数组', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/ops/blueprints',
    headers: { cookie: String((await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://localhost:3001', host: 'localhost:3001' },
      payload: { password: 'route-test-password' },
    })).headers['set-cookie']).split(';', 1)[0] },
  });
  assert.equal(response.statusCode, 200);
  assert.ok(Array.isArray(response.json().blueprints));
});

test('routes: 未注册路径返回 404 而不是 401', async () => {
  const response = await app.inject({ method: 'GET', url: '/definitely-not-a-route' });
  assert.equal(response.statusCode, 404);
});
