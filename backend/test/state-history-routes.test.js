import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-state-routes-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
// 测试聚焦 API 语义:显式关闭 SPA 静态托管,未注册路径才走 Fastify 原生 404。
process.env.SERVE_FRONTEND = '0';

const { addContainerStateEvent } = await import('../src/lib/db.js');
const { buildApp } = await import('../src/app.js');

const app = await buildApp({ logger: false });
await app.ready();

const login = await app.inject({
  method: 'POST',
  url: '/api/v1/auth/setup',
  headers: { origin: 'http://localhost:3001', host: 'localhost:3001' },
  payload: { password: 'state-route-password' },
});
const cookie = String(login.headers['set-cookie']).split(';', 1)[0];
const headers = { cookie, origin: 'http://localhost:3001', host: 'localhost:3001' };

test.after(async () => {
  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const NOW = Math.floor(Date.now() / 1000);
const PROJECT = 'state-routes-project';

// 读测试的事件全部落在最近 1 天内,末尾的 prune(days=1) 才能只清掉那条超期行。
function seed(containerId, containerName, events, projectId = PROJECT) {
  for (const item of events) {
    addContainerStateEvent({
      containerId,
      containerName,
      projectId,
      projectName: 'state-routes',
      action: item.action,
      healthStatus: item.healthStatus || '',
      exitCode: item.exitCode ?? null,
      execDuration: item.execDuration ?? null,
      timestamp: item.at,
    });
  }
}

seed('c-web', 'web', [
  { action: 'start', at: NOW - 3600 },
  { action: 'die', at: NOW - 1800, exitCode: 137, execDuration: 1800 },
  { action: 'start', at: NOW - 1700 },
]);
seed('c-api', 'api', [{ action: 'die', at: NOW - 600, exitCode: 0, execDuration: 300 }]);
// 最近状态转换早于 7 天窗口,但窗口内无新事件:uptime API 仍应纳入该稳定容器。
seed('c-steady', 'steady', [{ action: 'start', at: NOW - 10 * 86400 }]);
// 超期行:专用项目,便于 prune 后单独确认它已消失
seed('c-expired', 'expired', [{ action: 'die', at: NOW - 10 * 86400, exitCode: 1 }], 'state-routes-expired');

test('状态历史路由: 未登录访问一律 401', async () => {
  for (const url of [
    '/api/v1/state/history',
    '/api/v1/state/containers',
    '/api/v1/state/uptime',
    '/api/v1/state/exits',
  ]) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 401, `${url} 应要求登录`);
    assert.equal(response.json().error, 'unauthorized');
  }
  const prune = await app.inject({ method: 'POST', url: '/api/v1/state/prune', payload: {} });
  assert.equal(prune.statusCode, 401);
});

test('状态历史路由: /history 返回按时间倒序的转换明细', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/state/history?projectId=${PROJECT}&limit=100`,
    headers,
  });
  assert.equal(response.statusCode, 200);
  const { history } = response.json();
  // c-web 3 条 + c-api 1 条 + 窗口外的稳定容器最近状态 1 条
  assert.equal(history.length, 5);
  assert.deepEqual(
    history.map((item) => item.timestamp),
    [...history.map((item) => item.timestamp)].sort((a, b) => b - a)
  );
  // 前端直接读 camelCase 字段,不能退回 snake_case
  assert.deepEqual(
    Object.keys(history[0]).sort(),
    ['action', 'containerId', 'containerName', 'createdAt', 'execDuration', 'exitCode', 'healthStatus', 'id', 'projectId', 'projectName', 'timestamp'].sort()
  );
  assert.equal(history[0].containerId, 'c-api');

  const filtered = await app.inject({
    method: 'GET',
    url: `/api/v1/state/history?projectId=${PROJECT}&containerId=c-web&action=die`,
    headers,
  });
  assert.equal(filtered.statusCode, 200);
  assert.deepEqual(filtered.json().history.map((item) => item.exitCode), [137]);
});

test('状态历史路由: /containers 与 /uptime 给出窗口视图', async () => {
  const containers = await app.inject({
    method: 'GET',
    url: `/api/v1/state/containers?projectId=${PROJECT}&days=7`,
    headers,
  });
  assert.equal(containers.statusCode, 200);
  const list = containers.json().containers;
  // 每个容器只留最近一次转换:超期项目不在 7 天窗口内
  assert.deepEqual(list.map((item) => item.containerId).sort(), ['c-api', 'c-web']);
  assert.equal(list.find((item) => item.containerId === 'c-web').action, 'start');

  const uptime = await app.inject({
    method: 'GET',
    url: `/api/v1/state/uptime?projectId=${PROJECT}&days=7`,
    headers,
  });
  assert.equal(uptime.statusCode, 200);
  const report = uptime.json();
  assert.equal(report.window.seconds, 7 * 86400);
  assert.equal(report.summary.containers, 3);
  assert.equal(report.truncated, false);
  // 可用率必须是 0..100 的数值或 null(不可判定),不能是 NaN/字符串
  for (const item of report.containers) {
    assert.ok(item.availability === null || (item.availability >= 0 && item.availability <= 100), `可用率越界:${item.availability}`);
    assert.equal(typeof item.upSeconds, 'number');
  }
  const web = report.containers.find((item) => item.containerId === 'c-web');
  // c-web 最近一条事件是 start(重启),但退出码必须仍来自那次 137
  assert.equal(web.lastExitCode, 137);
  assert.equal(web.lastExitAt, NOW - 1800);
  assert.equal(web.abnormalExits, 1);
  const steady = report.containers.find((item) => item.containerId === 'c-steady');
  assert.ok(steady, '窗口内无状态变化的稳定容器必须纳入可用率统计');
  assert.equal(steady.availability, 100);
  assert.equal(steady.upSeconds, 7 * 86400);
  assert.equal(steady.lastAction, 'start');
});

test('状态历史路由: /exits 返回退出明细且异常优先', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/state/exits?projectId=${PROJECT}&days=7`,
    headers,
  });
  assert.equal(response.statusCode, 200);
  const { exits, total } = response.json();
  assert.equal(total, 2);
  assert.deepEqual(exits.map((item) => item.containerId), ['c-web', 'c-api']);
  assert.deepEqual(exits.map((item) => item.abnormal), [true, false]);
});

test('状态历史路由: 查询参数越界走全站校验契约', async () => {
  const cases = [
    ['/api/v1/state/history?limit=0', 'limit 下限'],
    ['/api/v1/state/history?limit=1001', 'limit 上限'],
    ['/api/v1/state/history?limit=abc', 'limit 非整数'],
    ['/api/v1/state/containers?days=0', 'days 下限'],
    ['/api/v1/state/containers?days=9999', 'days 上限'],
    ['/api/v1/state/uptime?days=-1', 'days 负数'],
  ];
  for (const [url, label] of cases) {
    const response = await app.inject({ method: 'GET', url, headers });
    assert.equal(response.statusCode, 400, `${label} 应被 schema 拦下:${url}`);
    assert.equal(response.json().error, 'validation_failed');
    assert.match(response.json().message, /校验失败/);
  }

  // 未知参数不是校验错误:Fastify 默认 removeAdditional: true,未声明的键被静默剥掉后放行。
  // 这里钉住该行为,避免以后误以为 additionalProperties: false 能挡脏参数。
  const stripped = await app.inject({ method: 'GET', url: `/api/v1/state/history?projectId=${PROJECT}&bogus=1`, headers });
  assert.equal(stripped.statusCode, 200);
  // 脏参数被剥掉后按 projectId 正常返回,等价于不带 bogus 的同一查询
  assert.equal(stripped.json().history.length, 5);
});

test('状态历史路由: POST /prune 按保留天数清理并回报行数', async () => {
  // 必须带 cookie:onRequest 先查认证再查 origin,匿名请求只会拿到 401 而不是 403
  const rejected = await app.inject({
    method: 'POST',
    url: '/api/v1/state/prune',
    headers: { cookie, origin: 'https://evil.example.com', host: 'localhost:3001' },
    payload: { days: 90 },
  });
  assert.equal(rejected.statusCode, 403, '写请求必须过 origin 校验');
  assert.equal(rejected.json().error, 'origin_rejected');

  // 未知字段会被 removeAdditional 静默剥掉,所以用类型错误才能命中校验契约
  const badBody = await app.inject({
    method: 'POST',
    url: '/api/v1/state/prune',
    headers,
    payload: { days: 'abc' },
  });
  assert.equal(badBody.statusCode, 400);
  assert.equal(badBody.json().error, 'validation_failed');

  const response = await app.inject({ method: 'POST', url: '/api/v1/state/prune', headers, payload: { days: 1 } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  // 10 天前的退出事件与稳定容器基线都应被清掉,窗口内近期事件必须留下
  assert.equal(body.removed, 2);

  const expired = await app.inject({
    method: 'GET',
    url: '/api/v1/state/history?projectId=state-routes-expired',
    headers,
  });
  assert.deepEqual(expired.json().history, []);
  const kept = await app.inject({
    method: 'GET',
    url: `/api/v1/state/history?projectId=${PROJECT}&limit=100`,
    headers,
  });
  assert.equal(kept.json().history.length, 4);
});
