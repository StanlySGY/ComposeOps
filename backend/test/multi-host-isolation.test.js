import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { PassThrough } from 'node:stream';
import { scanProjects, invalidateScanCache } from '../src/services/scanner.js';
import { getDockerForHost, setActiveHost, upsertHost, deleteHost } from '../src/services/docker-hosts.js';
import db, { setProjectPreference, addOperation, listOperations, getProjectPreference, addContainerStateEvent } from '../src/lib/db.js';
import { getStateUptime } from '../src/services/state-history.js';
import { collectAllMetrics } from '../src/services/metrics-collector.js';
import { subscribeContainerEvents } from '../src/services/container-events.js';
import { prepareProjectAction } from '../src/services/project-action-runner.js';
import { withProjectOperationLock } from '../src/services/project-operation-lock.js';

const row = { Id: 'same-container', Names: ['/web'], State: 'running', Labels: {
  'com.docker.compose.project': 'same-project', 'com.docker.compose.project.working_dir': '/same/path',
} };
const remote = upsertHost({ name: '第二节点', type: 'tcp', host: '127.0.0.1', port: 1 });
test.after(() => { setActiveHost('local'); deleteHost(remote.id); });
test.beforeEach(() => { setActiveHost('local'); invalidateScanCache(); });

test('同路径同名项目偏好、操作、状态和指标按节点隔离', async t => {
  for (const id of ['local', remote.id]) {
    const docker = getDockerForHost(id);
    t.mock.method(docker, 'listContainers', async () => [row]);
    t.mock.method(docker, 'getContainer', () => ({ stats: async () => ({ memory_stats: { usage: id === 'local' ? 100 : 700, limit: 1000 } }) }));
  }
  const [a] = await scanProjects('local');
  const [b] = await scanProjects(remote.id);
  assert.notEqual(a.id, b.id);
  assert.equal('password' in a, false);
  setProjectPreference(a.id, { managed: true, note: '本地' });
  assert.equal(getProjectPreference(b.id).managed, 0);
  setProjectPreference(b.id, { managed: true, note: '远端' });
  assert.equal(getProjectPreference(a.id).note, '本地');
  for (const [project, action] of [[a, 'start'], [b, 'die']]) {
    addOperation({ projectId: project.id, projectName: project.projectName, action, status: 'success' });
    addContainerStateEvent({ projectId: project.id, containerId: row.Id, hostId: project.hostId, action, timestamp: 100 });
  }
  assert.ok(listOperations(100).some(operation => operation.projectId === b.id));
  const uptime = getStateUptime({ since: 100, until: 200 });
  assert.equal(uptime.containers.length, 2);
  assert.equal(uptime.containers.find(item => item.hostId === 'local').upSeconds, 100);
  assert.equal(uptime.containers.find(item => item.hostId === remote.id).downSeconds, 100);
  const result = await collectAllMetrics();
  assert.equal(result.collected, 2);
  const metrics = db.prepare("SELECT host_id, value FROM container_metrics WHERE metric_type = 'memory' ORDER BY value").all();
  assert.deepEqual(metrics.map(item => item.value), [10, 70]);
  assert.equal(new Set(metrics.map(item => item.host_id)).size, 2);
});

test('两节点事件同时推送，切换界面不会终止任一事件流', async t => {
  const streams = new Map();
  for (const id of ['local', remote.id]) {
    const docker = getDockerForHost(id);
    t.mock.method(docker, 'listContainers', async () => [row]);
    const stream = new PassThrough(); streams.set(id, stream);
    t.mock.method(docker, 'getEvents', async () => stream);
    const [project] = await scanProjects(id);
    setProjectPreference(project.id, { managed: true });
  }
  const events = [];
  const unsubscribe = subscribeContainerEvents(event => events.push(event));
  t.after(unsubscribe);
  await settle();
  setActiveHost(remote.id);
  for (const stream of streams.values()) stream.write(JSON.stringify({ Type: 'container', Action: 'start', Actor: { ID: row.Id, Attributes: row.Labels } }) + '\n');
  for (let i = 0; i < 20 && events.length < 2; i++) await settle();
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map(event => event.hostId)).size, 2);
  for (const stream of streams.values()) assert.equal(stream.destroyed, false);
});

test('容器 inspect 期间切节点会阻止随后写操作', async t => {
  let inspected;
  let writes = 0;
  t.mock.method(getDockerForHost('local'), 'listContainers', async () => [{ ...row, State: 'exited' }]);
  t.mock.method(getDockerForHost('local'), 'getContainer', () => ({ inspect: () => new Promise(resolve => { inspected = resolve; }), start: async () => { writes++; } }));
  const [project] = await scanProjects();
  const action = await prepareProjectAction({ ...project, managed: true, mountEnabled: false }, 'up');
  const result = action.run();
  await settle();
  setActiveHost(remote.id);
  inspected({ State: { Status: 'exited' } });
  await assert.rejects(result, /宿主已变更/);
  assert.equal(writes, 0);
});

test('SQLite 租约拒绝其它执行者，过期后可恢复且支持重入', async () => {
  db.prepare('INSERT INTO project_operation_leases VALUES(?, ?, ?)').run('lease-test', 'another-process', Date.now() + 60000);
  await assert.rejects(withProjectOperationLock('lease-test', () => assert.fail('不得执行')), /正在执行/);
  db.prepare('UPDATE project_operation_leases SET expires_at = 0 WHERE project_id = ?').run('lease-test');
  assert.equal(await withProjectOperationLock('lease-test', () => withProjectOperationLock('lease-test', () => 42)), 42);
  assert.equal(db.prepare('SELECT * FROM project_operation_leases WHERE project_id = ?').get('lease-test'), undefined);
});

test('真实独立进程不能穿透当前项目租约', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const moduleUrl = new URL('../src/services/project-operation-lock.js', import.meta.url).href;
  await withProjectOperationLock('cross-process', async () => {
    const source = `import { withProjectOperationLock } from ${JSON.stringify(moduleUrl)};
try { await withProjectOperationLock('cross-process', () => {}); process.exitCode = 1; } catch (e) { if (e.code !== 'PROJECT_BUSY') throw e; console.log('blocked'); }`;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { env: process.env });
    assert.match(result.stdout, /blocked/);
  });
});

test('远端失联不影响面板健康，全部节点指标接口保留来源', async t => {
  const { buildApp } = await import('../src/app.js');
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  t.mock.method(getDockerForHost('local'), 'ping', async () => 'OK');
  t.mock.method(getDockerForHost(remote.id), 'ping', async () => { throw new Error('offline'); });
  setActiveHost(remote.id);
  const health = await app.inject({ url: '/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().status, 'ok');
  assert.equal(health.json().hosts.find(host => host.id === remote.id).ok, false);
  for (const id of ['local', remote.id]) {
    const docker = getDockerForHost(id);
    t.mock.method(docker, 'listContainers', async () => [row]);
    t.mock.method(docker, 'getContainer', () => ({ stats: async () => ({}) }));
  }
  const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { password: 'isolated-multi-host-test' } });
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  const response = await app.inject({ url: '/api/v1/system/metrics?hostId=all', headers: { cookie } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().containers.length, 2);
  assert.equal(new Set(response.json().containers.map(item => item.hostId)).size, 2);
});
