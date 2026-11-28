import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import db, { getAsset, upsertAsset, listAssets } from '../src/lib/db.js';
import { getDockerForHost, upsertHost, deleteHost, getHost, setActiveHost } from '../src/services/docker-hosts.js';
import { invalidateScanCache } from '../src/services/scanner.js';
import { syncAssets } from '../src/services/cmdb.js';
import cmdbRoutes from '../src/routes/cmdb.js';
const row = (name = 'synthetic') => ({ Id: `container-${name}`, Names: ['/' + name], State: 'running', Image: 'synthetic:1', Labels: {
  'com.docker.compose.project': name, 'com.docker.compose.project.working_dir': '/isolated-fixture',
}, Mounts: [{ Type: 'volume', Name: 'fixture-volume' }] });
function fake(t, hostId = 'local') {
  const docker = getDockerForHost(hostId);
  t.mock.method(docker, 'listContainers', async () => [row()]);
  t.mock.method(docker, 'listVolumes', async () => ({ Volumes: [{ Name: 'fixture-volume', Driver: 'local' }], Warnings: [] }));
  t.mock.method(docker, 'listNetworks', async () => [{ Id: 'fixture-network', Name: 'fixture-network' }]);
  return docker;
}
function remote(t) {
  const host = upsertHost({ name: '隔离验收节点', type: 'tcp', host: '127.0.0.1', port: 9 });
  t.after(() => { setActiveHost('local'); if (getHost(host.id)) deleteHost(host.id); });
  return host;
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
test.beforeEach(() => { setActiveHost('local'); invalidateScanCache(); db.prepare('DELETE FROM assets').run(); });
test.afterEach(invalidateScanCache);

for (const resource of ['listContainers', 'listVolumes', 'listNetworks']) test(`同步 ${resource} 失败不能伪报空成功，也不改动既有资产`, async t => {
  const docker = fake(t); upsertAsset({ id: 'host:local', kind: 'host', name: '保留原记录', status: 'unknown' });
  t.mock.method(docker, resource, async () => { throw new Error('http://user:private-fixture-secret@invalid'); });
  await assert.rejects(syncAssets(), error => error.statusCode === 502 && !error.message.includes('private-fixture-secret'));
  assert.equal(listAssets().length, 1); assert.equal(getAsset('host:local').name, '保留原记录');
});

test('扫描期间切换活动节点仍只读取固定来源的卷和网络', async t => {
  const host = remote(t), local = fake(t), other = fake(t, host.id), pending = deferred(); let otherReads = 0;
  t.mock.method(local, 'listContainers', () => pending.promise);
  t.mock.method(other, 'listVolumes', async () => { otherReads++; return { Volumes: [{ Name: 'wrong-node-volume' }] }; });
  t.mock.method(other, 'listNetworks', async () => { otherReads++; return []; });
  const sync = syncAssets(); setActiveHost(host.id); pending.resolve([row()]); await sync;
  assert.equal(otherReads, 0); assert.equal(getAsset('volume:local:wrong-node-volume'), null);
  assert.ok(getAsset('volume:local:fixture-volume')); assert.equal(getAsset('container:container-synthetic').hostId, 'local');
});

test('卷读取期间修改连接配置使整次同步失败，不能保存旧连接快照', async t => {
  const host = remote(t); setActiveHost(host.id); const docker = fake(t, host.id), pending = deferred();
  let started; const ready = new Promise(r => { started = r; });
  t.mock.method(docker, 'listVolumes', () => { started(); return pending.promise; });
  const sync = syncAssets(); const outcome = assert.rejects(sync, { statusCode: 409 });
  await ready; upsertHost({ ...host, port: 10 }); pending.resolve({ Volumes: [] }); await outcome;
  assert.deepEqual(listAssets(), []);
});

test('不完整卷清单 Warnings 必须报告失败，不能替换完整资产清单', async t => {
  const docker = fake(t);
  t.mock.method(docker, 'listVolumes', async () => ({ Volumes: [], Warnings: ['private-fixture-secret driver unavailable'] }));
  await assert.rejects(syncAssets(), error => error.statusCode === 502 && !error.message.includes('private-fixture-secret'));
  assert.deepEqual(listAssets(), []);
});

test('失联卷读取有总期限并取消 transport，迟到完成不能写入', async t => {
  const docker = fake(t), pending = deferred(); let signal;
  t.mock.method(docker, 'listVolumes', options => { signal = options?.abortSignal; return pending.promise; });
  const sync = syncAssets({ timeoutMs: 25 });
  const outcome = await Promise.race([sync.then(() => 'success', e => e), new Promise(r => setTimeout(() => r('no deadline'), 200))]);
  pending.resolve({ Volumes: [{ Name: 'late-volume' }] }); await sync.catch(() => {});
  assert.equal(outcome.statusCode, 504); assert.equal(signal?.aborted, true); assert.deepEqual(listAssets(), []);
});

test('落库中途失败原子回滚，不留下半份同步资产与关系', async t => {
  fake(t); upsertAsset({ id: 'host:local', kind: 'host', name: '原记录' });
  db.exec("CREATE TEMP TRIGGER reject_cmdb_volume BEFORE INSERT ON assets WHEN NEW.kind = 'volume' BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END");
  t.after(() => db.exec('DROP TRIGGER IF EXISTS reject_cmdb_volume'));
  await assert.rejects(syncAssets(), /synthetic storage failure/);
  assert.equal(listAssets().length, 1); assert.equal(getAsset('host:local').name, '原记录');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM asset_relations').get().n, 0);
});

test('同步失败 API 返回真实错误并记录失败审计，没有成功审计', async t => {
  const docker = fake(t); t.mock.method(docker, 'listNetworks', async () => { throw new Error('private-fixture-secret'); });
  const start = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM operation_history').get().id;
  const app = Fastify(); await app.register(cmdbRoutes, { prefix: '/cmdb' }); t.after(() => app.close());
  const res = await app.inject({ method: 'POST', url: '/cmdb/assets/sync' });
  assert.equal(res.statusCode, 502); assert.ok(!res.body.includes('private-fixture-secret'));
  const events = db.prepare("SELECT status, detail FROM operation_history WHERE id > ? AND action = 'cmdb.sync'").all(start);
  assert.equal(events.length, 1); assert.equal(events[0].status, 'failed'); assert.ok(!events[0].detail.includes('private-fixture-secret'));
});

test('有效空节点正常同步，不把 null Volumes 当作读取失败', async t => {
  const docker = fake(t); t.mock.method(docker, 'listContainers', async () => []);
  t.mock.method(docker, 'listVolumes', async () => ({ Volumes: null, Warnings: null })); t.mock.method(docker, 'listNetworks', async () => []);
  const result = await syncAssets(); assert.equal(result.projects, 0); assert.equal(result.volumes, 0); assert.equal(result.networks, 0);
  assert.ok(getAsset('host:local'));
});

test('同一节点并发同步复用完整快照，避免迟到旧扫描覆盖新结果', async t => {
  const docker = fake(t), pending = deferred(); let reads = 0;
  t.mock.method(docker, 'listVolumes', () => { reads++; return pending.promise; });
  const first = syncAssets(), second = syncAssets(); await new Promise(resolve => setImmediate(resolve));
  pending.resolve({ Volumes: [{ Name: 'shared-volume' }] });
  const results = await Promise.all([first, second]); assert.equal(reads, 1); assert.deepEqual(results[0], results[1]);
  assert.ok(getAsset('volume:local:shared-volume'));
});

test('不同节点同步独立进行且同名卷分别归属对应节点', async t => {
  const host = remote(t), local = fake(t), other = fake(t, host.id), a = deferred(), b = deferred();
  t.mock.method(local, 'listVolumes', () => a.promise); t.mock.method(other, 'listVolumes', () => b.promise);
  t.mock.method(other, 'listContainers', async () => [row('remote')]);
  const first = syncAssets(); setActiveHost(host.id); const second = syncAssets();
  b.resolve({ Volumes: [{ Name: 'shared-name', Driver: 'remote-driver' }] }); await second;
  assert.equal(getAsset(`volume:${host.id}:shared-name`).properties.driver, 'remote-driver');
  a.resolve({ Volumes: [{ Name: 'shared-name', Driver: 'local-driver' }] }); await first;
  assert.equal(getAsset('volume:local:shared-name').properties.driver, 'local-driver');
  assert.equal(getAsset(`volume:${host.id}:shared-name`).properties.driver, 'remote-driver');
});

test('连接修订更新后不复用旧在途同步，旧清理不删除新请求的归属', async t => {
  const host = remote(t); setActiveHost(host.id); const oldClient = fake(t, host.id), old = deferred(), fresh = deferred();
  let start; const ready = new Promise(r => { start = r; });
  t.mock.method(oldClient, 'listVolumes', () => { start(); return old.promise; });
  const first = syncAssets(); const failed = assert.rejects(first, { statusCode: 409 }); await ready;
  upsertHost({ ...host, port: 10 }); const newClient = fake(t, host.id); let calls = 0;
  t.mock.method(newClient, 'listVolumes', () => { calls++; return fresh.promise; });
  const second = syncAssets(); old.resolve({ Volumes: [{ Name: 'obsolete' }] }); await failed;
  const third = syncAssets(); fresh.resolve({ Volumes: [{ Name: 'current' }] }); await Promise.all([second, third]);
  assert.equal(calls, 1); assert.equal(getAsset(`volume:${host.id}:obsolete`), null); assert.ok(getAsset(`volume:${host.id}:current`));
});
