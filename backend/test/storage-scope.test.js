import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import docker from '../src/services/docker.js';
import { getSystemStorageDf, pruneStorage } from '../src/services/docker-storage.js';
import { getDockerUsage } from '../src/services/maintenance.js';
import { getStorageStats } from '../src/services/cost-analysis.js';
import { readDockerDiskUsage, invalidateDiskUsage } from '../src/services/docker-disk-usage.js';
import { storageHostScope } from '../src/services/storage-host-scope.js';
import { upsertHost, deleteHost, setActiveHost, getDockerForHost } from '../src/services/docker-hosts.js';
import opsRoutes from '../src/routes/ops.js';
import personalRoutes from '../src/routes/personal.js';
const empty = { Images: [], Containers: [], Volumes: [], BuildCache: [], LayersSize: 0 };
const scope = () => { const s = storageHostScope(); return { expectedHostId: s.hostId, hostRevision: s.hostRevision }; };
function fake(t, client = docker) {
  const calls = [];
  for (const name of ['pruneImages', 'pruneContainers', 'pruneVolumes']) {
    t.mock.method(client, name, async options => { calls.push({ name, options }); return { SpaceReclaimed: 1048576 }; });
  }
  t.mock.method(client.modem, 'dial', (options, callback) => {
    assert.equal(options.path, '/build/prune?'); calls.push({ name: 'pruneBuilder', options: options.options }); callback(null, { SpaceReclaimed: 1048576 });
  });
  t.mock.method(client, 'version', async () => ({ ApiVersion: '1.52' }));
  return calls;
}
function remote(t) {
  const host = upsertHost({ name: 'storage-scope-test', type: 'tcp', host: '127.0.0.1', port: 9 });
  t.after(() => { setActiveHost('local'); deleteHost(host.id); });
  return host;
}

test('所有批量入口要求确认和节点修订；无效模式或旧范围不调用Docker', async t => {
  const calls = fake(t); const app = Fastify();
  await app.register(opsRoutes, { prefix: '/ops' }); await app.register(personalRoutes, { prefix: '/personal' });
  t.after(() => app.close());
  for (const [url, payload, status] of [
    ['/ops/storage/prune', { mode: 'safe', confirm: 'PRUNE' }, 409],
    ['/ops/storage/prune', { mode: 'nonsense', confirm: 'PRUNE', ...scope() }, 400],
    ['/ops/storage/prune', { mode: 'safe', ...scope() }, 400],
    ['/ops/storage/prune', { mode: 'safe', confirm: 'PRUNE', ...scope(), hostRevision: 'stale' }, 409],
    ['/personal/maintenance/prune', { confirmation: 'PRUNE' }, 409],
    ['/personal/maintenance/prune', { confirmation: 'PRUNE', options: { containers: true }, ...scope() }, 400],
  ]) assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, status);
  assert.equal(calls.length, 0);
  const result = await app.inject({ method: 'POST', url: '/personal/maintenance/prune', payload: { confirmation: 'PRUNE', ...scope() } });
  assert.equal(result.statusCode, 200); assert.deepEqual(calls.map(c => c.name), ['pruneImages', 'pruneBuilder']);
  assert.deepEqual(calls[0].options.filters, { dangling: ['true'] });
});

test('安全和定时清理保留退出容器和卷；深度选项不额外删镜像', async t => {
  const calls = fake(t);
  for (const mode of ['safe', 'scheduled']) {
    await pruneStorage(mode, scope()); assert.deepEqual(calls.splice(0).map(c => c.name), ['pruneImages', 'pruneBuilder']);
  }
  await pruneStorage('all', scope());
  assert.deepEqual(calls.map(c => c.name), ['pruneBuilder', 'pruneVolumes']);
  assert.deepEqual(calls[0].options, { all: true }); assert.deepEqual(calls[1].options, { filters: { all: ['false'] } });
});

test('旧Docker无法保证匿名卷范围时在任何删除前拒绝', async t => {
  const calls = fake(t); t.mock.method(docker, 'version', async () => ({ ApiVersion: '1.41' }));
  await assert.rejects(pruneStorage('all', scope()), { statusCode: 409 }); assert.equal(calls.length, 0);
});

test('节点切走再切回也使旧确认过期，同ID连接修改同样拒绝', async t => {
  const host = remote(t); const localCalls = fake(t); const previous = scope();
  setActiveHost(host.id); setActiveHost('local');
  await assert.rejects(pruneStorage('safe', previous), { statusCode: 409 }); assert.equal(localCalls.length, 0);
  setActiveHost(host.id); const old = scope(); upsertHost({ ...host, port: 10 });
  await assert.rejects(pruneStorage('safe', old), { statusCode: 409 });
});

test('执行中换节点停止后续步骤并保留已释放量；重复清理不并发启动', async t => {
  const host = remote(t); const calls = fake(t); let release;
  t.mock.method(docker, 'pruneImages', () => new Promise(resolve => { release = resolve; }));
  const first = pruneStorage('safe', scope());
  await assert.rejects(pruneStorage('safe', scope()), { statusCode: 409 });
  setActiveHost(host.id); release({ SpaceReclaimed: 42 });
  await assert.rejects(first, error => error.statusCode === 409 && error.partialReclaimed.images === 42);
  assert.equal(calls.length, 0);
});

test('设置、维护、成本均读取目标Engine且共享层聚合一致，清理后成本缓存失效', async t => {
  const host = remote(t); setActiveHost(host.id); const client = getDockerForHost(host.id); fake(t, client);
  let calls = 0;
  t.mock.method(docker, 'df', () => { throw new Error('不得读取本机'); });
  t.mock.method(client, 'df', async () => { calls++; return { ...empty, LayersSize: 9999,
    ImageUsage: { TotalSize: calls * 1048576, Reclaimable: 10, TotalCount: 2, ActiveCount: 1 } }; });
  const [settings, usage, cost] = await Promise.all([getSystemStorageDf(), getDockerUsage(), getStorageStats()]);
  assert.equal(calls, 1); assert.equal(settings.hostId, host.id); assert.equal(settings.disk, null);
  assert.equal(settings.images.total, usage.images.total); assert.equal(cost.images.sizeMB, 1);
  await pruneStorage('safe', scope());
  assert.equal((await getStorageStats()).images.sizeMB, 2); assert.equal(calls, 2);
});

test('不合作扫描也受期限限制，迟到结果不覆盖新快照', async t => {
  invalidateDiskUsage('local'); t.after(() => invalidateDiskUsage('local'));
  let release, calls = 0;
  t.mock.method(docker, 'df', async () => { calls++; return calls === 1 ? new Promise(resolve => { release = resolve; }) : { ...empty, LayersSize: 2 }; });
  await assert.rejects(readDockerDiskUsage('local', { timeoutMs: 20 }), { statusCode: 503 });
  assert.equal((await readDockerDiskUsage('local', { timeoutMs: 20 })).LayersSize, 2);
  release({ ...empty, LayersSize: 99 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await readDockerDiskUsage('local', { timeoutMs: 20 })).LayersSize, 2); assert.equal(calls, 2);
});

test('设置读取失败或节点变化拒绝空成功快照', async t => {
  invalidateDiskUsage('local'); t.after(() => invalidateDiskUsage('local'));
  t.mock.method(docker, 'df', async () => { throw new Error('unavailable'); });
  await assert.rejects(getSystemStorageDf(), { statusCode: 503 });
  const host = remote(t);
  t.mock.method(docker, 'df', async () => { setActiveHost(host.id); return empty; });
  await assert.rejects(getSystemStorageDf(), { statusCode: 409 });
});

test('真实Docker客户端传输保留缓存all参数，不依赖缺失或丢参数的方法', async t => {
  const { createServer } = await import('node:http'); const urls = [];
  const server = createServer((req, res) => { urls.push(new URL(req.url, 'http://fixture')); res.setHeader('Content-Type', 'application/json'); res.end('{"SpaceReclaimed":1}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = upsertHost({ name: 'builder-wire', type: 'tcp', host: '127.0.0.1', port: server.address().port });
  t.after(async () => { setActiveHost('local'); deleteHost(host.id); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  setActiveHost(host.id);
  await pruneStorage('safe', scope()); await pruneStorage('builder', scope());
  const builds = urls.filter(url => url.pathname === '/build/prune');
  assert.equal(builds.length, 2); assert.equal(builds[0].searchParams.get('all'), 'false'); assert.equal(builds[1].searchParams.get('all'), 'true');
  assert.ok(!urls.some(url => url.pathname === '/containers/prune'));
});

test('Agent预览与清理工具、清理宏保持同一节点确认且始终要求critical审批', async t => {
  const { registerMaintenanceTools } = await import('../src/services/tools/maintenance-tools.js');
  const { MACRO_TOOLS, expandMacro } = await import('../src/services/agent-tool-categories.js');
  const tools = new Map(), registry = { registerTool(name, config) { tools.set(name, config); return this; } };
  registerMaintenanceTools(registry); const calls = fake(t);
  invalidateDiskUsage('local'); t.after(() => invalidateDiskUsage('local'));
  t.mock.method(docker, 'df', async () => empty);
  const preview = await tools.get('maintenance.inspect').execute();
  const clean = tools.get('maintenance.clean');
  assert.equal(clean.confirmationRequired, true); assert.equal(clean.requiredPermission, 'admin');
  await assert.rejects(clean.execute({ scope: 'images' }), { statusCode: 409 });
  const params = { expectedHostId: preview.hostId, hostRevision: preview.hostRevision, includeVolumes: true };
  const steps = expandMacro('macro.full_cleanup', params);
  assert.equal(MACRO_TOOLS['macro.full_cleanup'].risk, 'critical');
  assert.equal(steps.length, 3);
  for (const step of steps) {
    assert.equal(step.params.expectedHostId, preview.hostId); assert.equal(step.params.hostRevision, preview.hostRevision);
  }
  await clean.execute({ scope: 'images', ...params }); assert.equal(calls.length, 1);
  const other = remote(t); setActiveHost(other.id);
  await assert.rejects(clean.execute({ scope: 'volumes', ...params }), { statusCode: 409 }); assert.equal(calls.length, 1);
});

test('成本报告与公开API保留聚合镜像大小、四类总量和估算标记', async t => {
  const { getCostAnalysisReport } = await import('../src/services/cost-analysis.js');
  const { default: costRoutes } = await import('../src/routes/cost-analysis.js');
  const host = remote(t); setActiveHost(host.id); const client = getDockerForHost(host.id);
  t.mock.method(client, 'listContainers', async () => []);
  t.mock.method(client, 'listImages', async () => [{ Id: 'image-a', RepoTags: ['fixture:a'], Size: 100 * 1048576 }, { Id: 'image-b', RepoTags: ['fixture:b'], Size: 100 * 1048576 }]);
  t.mock.method(client, 'df', async () => ({ ...empty, LayersSize: 120 * 1048576,
    ImageUsage: { TotalSize: 120 * 1048576, Reclaimable: 50 * 1048576, TotalCount: 2 },
    ContainerUsage: { TotalSize: 2 * 1048576, Reclaimable: 1 * 1048576, TotalCount: 1 },
    VolumeUsage: { TotalSize: 3 * 1048576, Reclaimable: 2 * 1048576, TotalCount: 1 },
    BuildCacheUsage: { TotalSize: 5 * 1048576, Reclaimable: 4 * 1048576, TotalCount: 1 },
  }));
  const report = await getCostAnalysisReport();
  assert.equal(report.summary.totalImagesMB, 120); assert.equal(report.summary.storageTotalMB, 130); assert.equal(report.summary.reclaimableMB, 57);
  const app = Fastify(); await app.register(costRoutes); t.after(() => app.close());
  const response = await app.inject('/report'); assert.equal(response.statusCode, 200);
  assert.equal(response.json().storage.estimated, false); assert.equal(response.json().storage.volumes.reclaimableMB, 2);
});


test('定时普通与深度清理也使用已捕获的节点范围，均保留容器和卷', async t => {
  const { default: db } = await import('../src/lib/db.js');
  db.prepare('INSERT OR REPLACE INTO cron_state(id,payload) VALUES(1,?)').run(JSON.stringify({ jobs: [], history: [] }));
  const { createJob, runJobNow, deleteJob } = await import('../src/services/cron-scheduler.js');
  const calls = fake(t);
  for (const type of ['prune-safe', 'prune-all']) {
    const job = await createJob({ name: 'isolated-' + type, type, cron: '0 0 * * *', enabled: false });
    try { await runJobNow(job.id); } finally { await deleteJob(job.id); }
    assert.deepEqual(calls.splice(0).map(c => c.name), ['pruneImages', 'pruneBuilder']);
  }
});
