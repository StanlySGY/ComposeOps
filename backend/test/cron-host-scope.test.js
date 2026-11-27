import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import db from '../src/lib/db.js';
import { createJob, updateJob, deleteJob, runJobNow, listJobs, listHistory } from '../src/services/cron-scheduler.js';
import { getActiveHostId, getDockerForHost, getHost, upsertHost, deleteHost, setActiveHost, hostConnectionRevision } from '../src/services/docker-hosts.js';
import { assessRisk } from '../src/services/agent-tools.js';

db.prepare('INSERT OR REPLACE INTO cron_state(id,payload) VALUES(1,?)').run(JSON.stringify({ jobs: [{ id: 'legacy', name: '旧清理', type: 'prune-safe', cron: '0 0 * * *', enabled: true, createdAt: Date.now() }], history: [] }));
function fake(t, id) {
  const docker = getDockerForHost(id), calls = [];
  t.mock.method(docker, 'info', async () => ({ ID: `engine-${id}` }));
  t.mock.method(docker, 'pruneImages', async () => { calls.push('images'); return { SpaceReclaimed: 1 }; });
  t.mock.method(docker.modem, 'dial', (opts, done) => { assert.equal(opts.path, '/build/prune?'); calls.push('builder'); done(null, { SpaceReclaimed: 2 }); });
  t.mock.method(docker, 'pruneContainers', () => { throw new Error('不得清理容器'); });
  t.mock.method(docker, 'pruneVolumes', () => { throw new Error('不得清理数据卷'); });
  return { docker, calls };
}
function remote(t) {
  const host = upsertHost({ name: '计划目标', type: 'tcp', host: '127.0.0.1', port: 9 });
  t.after(() => { setActiveHost('local'); if (getHost(host.id)) deleteHost(host.id); });
  return host;
}
async function job(t, input = {}) {
  const result = await createJob({ name: '隔离计划', type: 'prune-safe', cron: '0 0 * * *', enabled: false, ...input });
  t.after(() => deleteJob(result.id)); return result;
}

test('旧节点型任务保留记录与原启用意图，但暂停至明确绑定目标', async () => {
  const legacy = (await listJobs()).find(item => item.id === 'legacy');
  assert.equal(legacy.enabled, false); assert.equal(legacy.wasEnabledBeforeTargetBinding, true);
  assert.match(legacy.targetError, /尚未绑定/); assert.equal(legacy.nextRunAt, null);
  await assert.rejects(updateJob(legacy.id, { enabled: true }), { statusCode: 409 });
  await assert.rejects(runJobNow(legacy.id), { statusCode: 409 });
});

test('保存的清理节点不随工作节点切换，任务历史保留实际节点', async t => {
  setActiveHost('local'); const host = remote(t), local = fake(t, 'local'), other = fake(t, host.id);
  const saved = await job(t); assert.equal(saved.target.hostId, 'local'); assert.equal(saved.target.engineId, 'engine-local');
  setActiveHost(host.id); await runJobNow(saved.id);
  assert.deepEqual(local.calls, ['images', 'builder']); assert.deepEqual(other.calls, []); assert.equal(getActiveHostId(), host.id);
  assert.equal((await listHistory()).find(item => item.jobId === saved.id).hostId, 'local');
});

test('执行期间切换活动节点继续固定原目标，修改目标连接则停止后续阶段并记录失败', async t => {
  const host = remote(t), remoteClient = fake(t, host.id), local = fake(t, 'local');
  const saved = await job(t, { hostId: host.id, connectionRevision: hostConnectionRevision(host.id) });
  t.mock.method(remoteClient.docker, 'pruneImages', async () => { setActiveHost('local'); remoteClient.calls.push('images'); return { SpaceReclaimed: 1 }; });
  setActiveHost(host.id); await runJobNow(saved.id); assert.deepEqual(remoteClient.calls, ['images', 'builder']); assert.deepEqual(local.calls, []);
  remoteClient.calls.length = 0;
  t.mock.method(remoteClient.docker, 'pruneImages', async () => { upsertHost({ ...host, port: 10 }); remoteClient.calls.push('images'); return { SpaceReclaimed: 5 }; });
  await assert.rejects(runJobNow(saved.id), error => error.statusCode === 409 && error.partialReclaimed.images === 5);
  assert.deepEqual(remoteClient.calls, ['images']);
  assert.equal((await listHistory()).find(item => item.jobId === saved.id).status, 'failed');
});

test('同连接下Engine身份改变也必须拒绝清理，不把重新连接当成原来的服务器', async t => {
  const host = remote(t), client = fake(t, host.id), saved = await job(t, { hostId: host.id });
  t.mock.method(client.docker, 'info', async () => ({ ID: 'replacement-engine' }));
  await assert.rejects(runJobNow(saved.id), { statusCode: 409 }); assert.deepEqual(client.calls, []);
});

test('执行中的任务不可修改或删除；修改失败不产生部分写入', async t => {
  const host = remote(t), client = fake(t, host.id), saved = await job(t, { hostId: host.id });
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  t.mock.method(client.docker, 'pruneImages', () => { entered(); return new Promise(resolve => { release = resolve; }); });
  const run = runJobNow(saved.id); await started;
  await assert.rejects(updateJob(saved.id, { name: '不能保存', hostId: 'local' }), { statusCode: 409 });
  await assert.rejects(deleteJob(saved.id), { statusCode: 409 });
  release({ SpaceReclaimed: 0 }); await run;
  await assert.rejects(updateJob(saved.id, { name: '不能部分保存', hostId: 'missing' }), { statusCode: 409 });
  assert.equal((await listJobs()).find(item => item.id === saved.id).name, saved.name);
});

test('目标身份跨进程读取保持有效，不依赖随机内存确认令牌', async t => {
  const host = remote(t); fake(t, host.id); const saved = await job(t, { hostId: host.id });
  const module = new URL('../src/services/cron-scheduler.js', import.meta.url).href;
  const code = `import {listJobs} from ${JSON.stringify(module)}; const job=(await listJobs()).find(j=>j.id===${JSON.stringify(saved.id)}); console.log(JSON.stringify({target:job.target,error:job.targetError}));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DISABLE_BACKGROUND_JOBS: '1' }, timeout: 15000 });
  const read = JSON.parse(stdout.trim().split('\n').at(-1)); assert.deepEqual(read.target, saved.target); assert.equal(read.error, '');
});

test('定时删除授权按critical审批；只读巡检计划保留原风险等级', () => {
  assert.equal(assessRisk('cron.create', { type: 'prune-safe' }), 'critical');
  assert.equal(assessRisk('cron.create', { type: 'prune-all' }), 'critical');
  assert.equal(assessRisk('cron.create', { type: 'inspection' }), 'medium');
});
