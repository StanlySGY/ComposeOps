import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-inspection-routes-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { buildApp } = await import('../src/app.js');

const app = await buildApp({ logger: false });
await app.ready();

test.after(async () => {
  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const authHeaders = { origin: 'http://localhost:3001', host: 'localhost:3001' };

async function login() {
  const setup = await app.inject({ method: 'GET', url: '/api/v1/auth/status' });
  const body = setup.json();
  if (body.setupRequired) {
    await app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers: authHeaders, payload: { password: 'test-pass-123' } });
  }
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: authHeaders, payload: { password: 'test-pass-123' } });
  const raw = login.headers['set-cookie'];
  const cookie = String(Array.isArray(raw) ? raw[0] : raw || '').split(';')[0];
  return cookie;
}

function auth(cookie) {
  return { cookie };
}

test('inspection: 未登录访问被拒绝', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/v1/ops/inspection/overview' });
  assert.equal(response.statusCode, 401);
});

test('inspection: 概览返回最新报告与调度配置', async () => {
  const cookie = await login();
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/ops/inspection/overview?limit=5',
    headers: auth(cookie),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.ok(body.gradeLabels);
  assert.ok(body.schedule && typeof body.schedule.enabled === 'boolean');
  assert.ok(Array.isArray(body.reports));
  // 报告历史项不含 findings 明细(列表接口刻意去掉),latest 带完整结构。
  if (body.latest) {
    assert.ok(Array.isArray(body.latest.findings));
    assert.ok('score' in body.latest);
    assert.deepEqual(Object.keys(body.latest.counts).sort(), ['critical', 'info', 'warning']);
    assert.ok(Object.values(body.latest.counts).every((value) => Number.isInteger(value) && value >= 0));
  }
});

test('notifications: 测试接口明确返回 skipped,不伪报发送成功', async () => {
  const cookie = await login();
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/personal/notifications/test',
    headers: { ...authHeaders, ...auth(cookie) },
    payload: { enabled: false },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, false);
  assert.equal(response.json().skipped, true);
  assert.match(response.json().message, /未发送/);
});

test('inspection: 执行巡检并写入报告(移除前保持数据最小)', async () => {
  const cookie = await login();
  const run = await app.inject({
    method: 'POST',
    url: '/api/v1/ops/inspection/run',
    headers: { ...authHeaders, ...auth(cookie) },
    payload: {},
  });
  assert.equal(run.statusCode, 200);
  const report = run.json().report;
  assert.ok(report && typeof report === 'object');
  assert.ok('score' in report && report.score >= 0 && report.score <= 100);
  assert.ok(Array.isArray(report.findings));
  assert.ok(report.id >= 0 || report.id != null);

  // 单份报告全文可读,内容与概览一致
  const detail = await app.inject({
    method: 'GET',
    url: `/api/v1/ops/inspection/reports/${report.id}`,
    headers: auth(cookie),
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().report.id, report.id);
  assert.deepEqual(detail.json().report.summary, report.summary);

  // 列表里出现这条记录
  const list = await app.inject({
    method: 'GET',
    url: '/api/v1/ops/inspection/reports?limit=10',
    headers: auth(cookie),
  });
  const reports = list.json().reports;
  assert.ok(reports.length >= 1);
  assert.ok(reports[0].id === report.id);
  // 列表项刻意不返回 findings
  assert.ok(!('findings' in reports[0]));
});

test('inspection: 调度配置可读写且被 clamp', async () => {
  const cookie = await login();
  const put = await app.inject({
    method: 'PUT',
    url: '/api/v1/ops/inspection/schedule',
    headers: { ...authHeaders, ...auth(cookie) },
    payload: { enabled: true, intervalHours: 48 },
  });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().schedule.enabled, true);
  assert.equal(put.json().schedule.intervalHours, 48);

  const overview = await app.inject({
    method: 'GET',
    url: '/api/v1/ops/inspection/overview',
    headers: auth(cookie),
  });
  assert.equal(overview.json().schedule.enabled, true);
  assert.equal(overview.json().schedule.intervalHours, 48);

  // 越界间隔被 clamp 到 168
  const overflow = await app.inject({
    method: 'PUT',
    url: '/api/v1/ops/inspection/schedule',
    headers: { ...authHeaders, ...auth(cookie) },
    payload: { intervalHours: 9999 },
  });
  assert.equal(overflow.json().schedule.intervalHours, 168);
});

test('inspection: 清理历史报告', async () => {
  const cookie = await login();
  const prune = await app.inject({
    method: 'POST',
    url: '/api/v1/ops/inspection/prune',
    headers: { ...authHeaders, ...auth(cookie) },
    payload: { days: 7 },
  });
  assert.equal(prune.statusCode, 200);
  assert.equal(typeof prune.json().removed, 'number');
});

test('inspection: 不存在报告返回 404', async () => {
  const cookie = await login();
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/ops/inspection/reports/99999999',
    headers: auth(cookie),
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, 'inspection_not_found');
});
