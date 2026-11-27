import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-routes-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const { default: routes } = await import('../src/routes/projects.js');
const app = Fastify(); await app.register(routes); await app.ready();
test.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
test('组合文件及 JSON 转义超过默认 1 MiB 仍进入业务校验', async () => {
  for (const composeContent of ['services:\n  web:\n    image: nginx\n#' + 'x'.repeat(700000), 'services:\n  web:\n    image: nginx\n#' + '\t'.repeat(900000)]) {
    const response = await app.inject({ method: 'POST', url: '/create', payload: { projectName: 'demo', rootDir: '/srv', composeContent, envContent: '#' + 'x'.repeat(400000), expectedHostId: 'wrong-node' } });
    assert.equal(response.statusCode, 409, response.body);
    assert.match(response.json().message, /节点已变化/);
  }
});
test('中文超限返回可理解错误，错误 YAML 无文件副作用可重试', async () => {
  for (const [composeContent, status] of [['services:\n  web: {}\n#' + '中'.repeat(350000), 400], ['services: [', 422]]) {
    const response = await app.inject({ method: 'POST', url: '/create', payload: { projectName: 'demo', rootDir: '/srv', composeContent, expectedHostId: 'local' } });
    assert.equal(response.statusCode, status, response.body);
  }
});
test('目录浏览拒绝相对路径、内核目录与过期节点身份', async () => {
  for (const directory of ['relative', '/proc/1', '/sys', '/dev']) {
    const response = await app.inject({ url: '/directories?' + new URLSearchParams({ directory, expectedHostId: 'local' }) });
    assert.ok([400, 403].includes(response.statusCode), response.body);
  }
  const response = await app.inject({ url: '/directories?directory=/srv&expectedHostId=other' });
  assert.equal(response.statusCode, 409);
});

test('指标读取传递取消信号，页面关闭可终止 Docker 请求', async () => {
  const { readContainerStat } = await import('../src/services/stats.js');
  const controller = new AbortController();
  let received;
  const docker = { getContainer: id => ({ stats: options => {
    assert.equal(id, 'test-container'); received = options.abortSignal;
    return new Promise((resolve, reject) => options.abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } }) };
  const result = readContainerStat('test-container', docker, controller.signal);
  controller.abort();
  await assert.rejects(result, /aborted/);
  assert.equal(received, controller.signal);
});

test('项目运行意图 API 严格校验、读取即时生效且保持其它偏好', async t => {
  const { getActivityDocker } = await import('../src/services/docker-hosts.js');
  const { scanProjects, invalidateScanCache } = await import('../src/services/scanner.js');
  t.mock.method(getActivityDocker(), 'listContainers', async () => [{ Id: 'intent-api', Names: ['/intent-api'], State: 'running', Labels: {
    'com.docker.compose.project': 'intent-api', 'com.docker.compose.project.working_dir': '/synthetic-intent-api',
  } }]);
  invalidateScanCache();
  const [project] = await scanProjects();
  const url = '/' + project.id + '/preferences';
  for (const operationalIntent of [true, null, 1, {}, 'invalid']) {
    const response = await app.inject({ method: 'PATCH', url, payload: { operationalIntent } });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'invalid_operational_intent');
  }
  const saved = await app.inject({ method: 'PATCH', url, payload: { operationalIntent: 'maintenance', note: 'keep', favorite: true } });
  assert.equal(saved.statusCode, 200);
  assert.equal((await scanProjects())[0].operationalIntent, 'maintenance');
  await app.inject({ method: 'PATCH', url, payload: { note: 'changed' } });
  const updated = (await scanProjects())[0];
  assert.equal(updated.operationalIntent, 'maintenance');
  assert.equal(updated.favorite, true);
  assert.equal(updated.note, 'changed');
  invalidateScanCache();
});
