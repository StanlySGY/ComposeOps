import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import projectRoutes from '../src/routes/projects.js';
import opsRoutes from '../src/routes/ops.js';
import db from '../src/lib/db.js';
import { getDockerForHost, upsertHost, deleteHost, getHost, hostConnectionRevision } from '../src/services/docker-hosts.js';
import { scanProjects, scanAllProjects, scanProjectInventory, invalidateScanCache } from '../src/services/scanner.js';
import { createJob, runJobNow, deleteJob, listHistory } from '../src/services/cron-scheduler.js';
import { checkAllUpdates } from '../src/services/image-updater.js';
import { runInspection } from '../src/services/inspection.js';
import { createIncidentObserver } from '../src/services/incident-observer.js';

const row = name => ({ Id: name, Names: ['/' + name], State: 'running', Labels: {
  'com.docker.compose.project': name, 'com.docker.compose.project.working_dir': '/isolated-fixture',
} });
function remote(t) {
  const host = upsertHost({ name: '不可达节点', type: 'tcp', host: '127.0.0.1', port: 9 });
  t.after(() => { if (getHost(host.id)) deleteHost(host.id); });
  return host;
}
function partial(t) {
  const host = remote(t);
  t.mock.method(getDockerForHost('local'), 'listContainers', async () => [row('known-project')]);
  t.mock.method(getDockerForHost(host.id), 'listContainers', async () => { throw new Error('http://user:private-token@fixture.invalid unreachable'); });
  return host;
}
test.beforeEach(invalidateScanCache);
test.afterEach(invalidateScanCache);

test('不可达节点和有效空节点不同，失败不会写入空缓存，恢复后可重新读取', async t => {
  const docker = getDockerForHost('local'); let calls = 0;
  t.mock.method(docker, 'listContainers', async () => { if (++calls === 1) throw new Error('private backend detail'); return []; });
  await assert.rejects(scanProjects(), error => error.statusCode === 502 && !error.message.includes('private'));
  assert.deepEqual(await scanProjects(), []); assert.equal(calls, 2);
});

test('服务列表API读取失败明确返回502，不能伪报没有服务', async t => {
  t.mock.method(getDockerForHost('local'), 'listContainers', async () => { throw new Error('private backend detail'); });
  const app = Fastify(); await app.register(projectRoutes, { prefix: '/projects' }); t.after(() => app.close());
  const result = await app.inject('/projects');
  assert.equal(result.statusCode, 502); assert.ok(!result.body.includes('private backend detail'));
  assert.ok(!Object.hasOwn(result.json(), 'projects'));
});

test('全节点清单保留成功节点并明确失败范围；要求完整的调用必须失败', async t => {
  const host = partial(t), inventory = await scanProjectInventory();
  assert.equal(inventory.complete, false); assert.equal(inventory.scannedHosts, 1); assert.equal(inventory.totalHosts, 2);
  assert.equal(inventory.projects[0].projectName, 'known-project'); assert.equal(inventory.nodeErrors[0].hostId, host.id);
  assert.ok(!JSON.stringify(inventory).includes('private-token'));
  await assert.rejects(scanAllProjects(), error => error.statusCode === 503 && error.nodeErrors[0].hostId === host.id);
});

test('节点扫描有总期限，失联不会持续占住后续请求或缓存', async t => {
  const docker = getDockerForHost('local'); let signal;
  t.mock.method(docker, 'listContainers', opts => { signal = opts.abortSignal; return new Promise(() => {}); });
  const start = Date.now(); await assert.rejects(scanProjects('local', { timeoutMs: 30 }), { statusCode: 504 });
  assert.ok(Date.now() - start < 1000); assert.equal(signal.aborted, true);
  t.mock.method(docker, 'listContainers', async () => [row('recovered')]);
  assert.equal((await scanProjects())[0].projectName, 'recovered');
});

test('共享扫描的一个调用方取消，不取消另一个调用方，也不接受取消方的迟到结果', async t => {
  let release, transportSignal;
  t.mock.method(getDockerForHost('local'), 'listContainers', opts => { transportSignal = opts.abortSignal; return new Promise(resolve => { release = resolve; }); });
  const controller = new AbortController(), cancelled = scanProjects('local', { signal: controller.signal }), kept = scanProjects();
  controller.abort(new Error('caller stopped'));
  await assert.rejects(cancelled, /caller stopped/); assert.equal(transportSignal.aborted, false);
  release([row('shared')]); assert.equal((await kept)[0].projectName, 'shared');
});

test('扫描中修改节点连接拒绝迟到结果，新修订不复用原缓存', async t => {
  const host = remote(t), docker = getDockerForHost(host.id); let release;
  t.mock.method(docker, 'listContainers', () => new Promise(resolve => { release = resolve; }));
  const pending = scanProjects(host.id), revision = hostConnectionRevision(host.id);
  upsertHost({ ...host, port: 10 }); assert.notEqual(hostConnectionRevision(host.id), revision);
  release([row('stale')]); await assert.rejects(pending, { statusCode: 409 });
  t.mock.method(getDockerForHost(host.id), 'listContainers', async () => [row('fresh')]);
  assert.equal((await scanProjects(host.id))[0].projectName, 'fresh');
});

test('全节点扫描最多4并发，期限后未开始的节点也必须标记未完成', async t => {
  const hosts = [{ id: 'local' }, ...Array.from({ length: 6 }, () => remote(t))]; let active = 0, maximum = 0, calls = 0;
  for (const host of hosts) t.mock.method(getDockerForHost(host.id), 'listContainers', () => { calls++; maximum = Math.max(maximum, ++active); return new Promise(() => {}); });
  const start = Date.now(), result = await scanProjectInventory({ timeoutMs: 40 });
  assert.ok(Date.now() - start < 1000); assert.ok(maximum <= 4); assert.ok(calls <= 4);
  assert.equal(result.nodes.length, 7); assert.equal(result.nodeErrors.length, 7); assert.equal(result.complete, false);
});

test('全节点定时拉取不把遗漏节点记录成成功，也不会启动已发现节点的变更', async t => {
  partial(t); const job = await createJob({ name: '隔离计划', type: 'pull-images', cron: '0 0 * * *', enabled: false });
  t.after(() => deleteJob(job.id));
  await assert.rejects(runJobNow(job.id), { statusCode: 503 });
  assert.equal((await listHistory()).find(item => item.jobId === job.id).status, 'failed');
});

test('全局镜像检查返回覆盖缺口；定时检查不能记录完整成功', async t => {
  const host = partial(t), result = await checkAllUpdates();
  assert.equal(result.complete, false); assert.equal(result.nodeErrors[0].hostId, host.id);
  const job = await createJob({ name: '隔离镜像检查', type: 'images-check', cron: '0 0 * * *', enabled: false });
  t.after(() => deleteJob(job.id)); await assert.rejects(runJobNow(job.id), /未完整完成/);
  assert.equal((await listHistory()).find(item => item.jobId === job.id).status, 'failed');
});

test('全局雷达HTTP保留部分结果，同时将操作审计记录为未完成', async t => {
  const host = partial(t), app = Fastify(); await app.register(opsRoutes, { prefix: '/ops' }); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/ops/updates/check-all' });
  assert.equal(response.statusCode, 200); assert.equal(response.json().complete, false);
  assert.equal(response.json().nodeErrors[0].hostId, host.id);
  const operation = db.prepare("SELECT status,detail FROM operation_history WHERE action='images.radar' ORDER BY id DESC LIMIT 1").get();
  assert.equal(operation.status, 'failed'); assert.match(operation.detail, /不完整/);
});

test('真实列表失败时巡检标记项目覆盖缺失，不能将异常当作零容器', async t => {
  const host = partial(t), docker = getDockerForHost(host.id);
  t.mock.method(docker, 'info', async () => ({ ID: 'fixture', Name: 'fixture' }));
  t.mock.method(docker, 'df', async () => ({ Images: [], Containers: [], LayersSize: 0 }));
  const report = await runInspection({ hostId: host.id, persist: false });
  assert.equal(report.stats.coverage.projects, false); assert.equal(report.stats.coverage.containerDetails, false);
  assert.equal(report.score, null); assert.ok(report.findings.some(item => item.id === 'scan:failed'));
});

test('值守仍能处理可达范围，但将节点遗漏记录为采集失败', async () => {
  const nodeErrors = [{ hostId: 'missing', hostName: '未完成节点', message: '项目列表读取失败' }];
  const observer = createIncidentObserver({ scan: async () => ({ projects: [], nodeErrors, complete: false }), probeRunner: { runOnce: async () => {} } });
  const status = await observer.runOnce(); await observer.stop();
  assert.equal(status.failures, 1); assert.deepEqual(status.nodeErrors, nodeErrors);
});
