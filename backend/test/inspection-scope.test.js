import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInspection, predictCapacity, saveInspectionSchedule, getInspectionSchedule } from '../src/services/inspection.js';
import { getDockerForHost, getHost, upsertHost, deleteHost, setActiveHost, hostConnectionRevision } from '../src/services/docker-hosts.js';
import { collectInfrastructure } from '../src/services/infrastructure.js';
import db, { addInspection, addVolumeBackup, getInspection, listDiskSamples, setSetting } from '../src/lib/db.js';

const info = { ID: 'inspection-fixture', Name: 'inspection-host', KernelVersion: 'fixture', NCPU: 2, MemTotal: 1000 };
const empty = { Images: [], Containers: [], Volumes: [], BuildCache: [], LayersSize: 0 };
function remote(t) {
  const host = upsertHost({ name: '隔离巡检节点', type: 'tcp', host: '127.0.0.1', port: 9 });
  setActiveHost(host.id);
  t.after(() => { setActiveHost('local'); if (getHost(host.id)) deleteHost(host.id); });
  const docker = getDockerForHost(host.id);
  t.mock.method(docker, 'listContainers', async () => []); t.mock.method(docker, 'info', async () => info); t.mock.method(docker, 'df', async () => empty);
  return { host, docker };
}

test('只有Docker API的远端巡检保留未知，不能用本机磁盘内存或其它项目备份得出健康结论', async t => {
  const { host } = remote(t);
  addVolumeBackup({ projectId: 'some-other-node-project', projectName: 'other', volume: 'fixture', file: '/not-a-real-backup', host: 'local' });
  const report = await runInspection();
  assert.equal(report.hostId, host.id); assert.equal(report.hostName, host.name);
  assert.equal(report.stats.host.memoryUsed, null); assert.equal(report.stats.host.memoryPercent, null); assert.equal(report.stats.disk, null);
  assert.equal(report.stats.backups.count, 0); assert.equal(report.stats.assessment.complete, false);
  assert.equal(report.predictions[0].status, 'unknown'); assert.equal(report.score, null); assert.equal(report.grade, 'incomplete');
  assert.ok(!report.summary.includes('null%')); assert.ok(!report.summary.includes('NaN'));
  const stored = getInspection(report.id); assert.equal(stored.score, null); assert.equal(stored.hostId, host.id);
});

test('巡检执行中的活动节点切换不会混合数据或重定向既定目标', async t => {
  const { host, docker } = remote(t); let release;
  t.mock.method(docker, 'info', () => new Promise(resolve => { release = resolve; }));
  const operation = runInspection({ persist: false }); await new Promise(resolve => setImmediate(resolve));
  setActiveHost('local'); release(info);
  const report = await operation;
  assert.equal(report.hostId, host.id); assert.equal(report.stats.scope.engineId, info.ID); assert.equal(report.stats.host.hostname, info.Name);
});

test('连接配置变更或删除节点时，拒绝将迟到结果写入巡检记录', async t => {
  for (const mode of ['edit', 'delete']) await t.test(mode, async t => {
    const { host, docker } = remote(t); let release;
    t.mock.method(docker, 'info', () => new Promise(resolve => { release = resolve; }));
    const count = db.prepare('SELECT COUNT(*) AS n FROM inspections').get().n;
    const operation = runInspection(); await new Promise(resolve => setImmediate(resolve));
    if (mode === 'edit') upsertHost({ ...host, port: 10 }); else { setActiveHost('local'); deleteHost(host.id); }
    release(info); await assert.rejects(operation, { statusCode: 409 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inspections').get().n, count);
  });
});

test('不合作的列表读取到期后给出不完整报告，不伪造整体评分', async t => {
  const { docker } = remote(t);
  t.mock.method(docker, 'listContainers', () => new Promise(() => {}));
  const start = Date.now(), report = await runInspection({ persist: false, timeoutMs: 30 });
  assert.ok(Date.now() - start < 1000); assert.equal(report.stats.coverage.projects, false);
  assert.equal(report.score, null); assert.equal(report.stats.assessment.complete, false);
});

test('容量预测只使用同节点、连接、Engine和文件系统样本，不接入旧的无归属数据', () => {
  const scope = { hostId: 'scope-a', connectionRevision: 'v1', engineId: 'engine-a', diskKey: '8:1:ext4:/' };
  const add = (used, variation) => addInspection({ diskUsed: used, diskTotal: 1000, stats: variation === null ? {} : { scope: { ...scope, ...variation } } });
  add(100, {}); add(200, { hostId: 'scope-b' }); add(300, { connectionRevision: 'v2' });
  add(400, { engineId: 'engine-b' }); add(500, { diskKey: '8:2:ext4:/data' }); add(600, null);
  assert.deepEqual(listDiskSamples(30, scope).map(row => row.diskUsed), [100]);
  const resized = predictCapacity([{ diskUsed: 100, diskTotal: 1000 }, { diskUsed: 200, diskTotal: 1000 }, { diskUsed: 300, diskTotal: 1000 }], { used: 350, total: 2000, free: 1650 });
  assert.equal(resized[0].status, 'unknown');
});

test('身份验证后的宿主内存和磁盘进入报告，实际严重问题仍明确标记', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inspection-host-'));
  const original = process.env.HOST_METRICS_FILE; process.env.HOST_METRICS_FILE = path.join(directory, 'host.json');
  t.after(async () => { if (original === undefined) delete process.env.HOST_METRICS_FILE; else process.env.HOST_METRICS_FILE = original; await rm(directory, { recursive: true, force: true }); });
  const docker = getDockerForHost('local');
  t.mock.method(docker, 'info', async () => info); t.mock.method(docker, 'listContainers', async () => []); t.mock.method(docker, 'df', async () => empty);
  await writeFile(process.env.HOST_METRICS_FILE, JSON.stringify({ sampledAt: Date.now(), hostname: info.Name, kernel: info.KernelVersion, bootId: 'fixture', uptime: 10,
    cpu: { total: 100, idle: 80, cores: 2 }, loadavg: [0.1, 0.2, 0.3], memory: { total: 1000, available: 50 }, network: [], diskCounters: [],
    filesystems: [{ device: '8:1', type: 'ext4', mountpoint: '/', aliases: ['/'], total: 1000, used: 900, free: 100, percent: 90 }] }));
  await collectInfrastructure();
  const report = await runInspection({ persist: false, hostId: 'local' });
  assert.equal(report.stats.scope.connectionRevision, hostConnectionRevision('local'));
  assert.equal(report.stats.host.memoryUsed, 950); assert.equal(report.stats.disk.used, 900);
  assert.equal(report.stats.assessment.complete, true); assert.equal(report.grade, 'critical');
  assert.ok(report.score < 80); assert.ok(report.findings.some(item => item.id === 'host:memory'));
});

test('容器详情在限定并发内读取，失败和超过80个上限的未检查项明确影响覆盖率', async t => {
  const { docker } = remote(t); let active = 0, maximum = 0;
  t.mock.method(docker, 'listContainers', async () => Array.from({ length: 85 }, (_, i) => ({ Id: `c${i}`, Names: [`/c${i}`], State: 'running', Labels: { 'com.docker.compose.project': 'scope', 'com.docker.compose.project.working_dir': '/fixture' } })));
  t.mock.method(docker, 'getContainer', () => ({ inspect: async () => { maximum = Math.max(maximum, ++active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return { State: { OOMKilled: false }, RestartCount: 0 }; } }));
  const report = await runInspection({ persist: false });
  assert.ok(maximum <= 6); assert.equal(report.stats.containers.inspected, 80); assert.equal(report.stats.containers.total, 85);
  assert.equal(report.stats.coverage.containerDetails, false); assert.equal(report.score, null);
});

test('自动巡检固定保存目标，活动节点切换不改计划，连接修改后须重新确认', async t => {
  const { host } = remote(t), revision = hostConnectionRevision(host.id);
  t.after(() => saveInspectionSchedule({ enabled: false }));
  const saved = saveInspectionSchedule({ enabled: true, hostId: host.id, connectionRevision: revision, intervalHours: 6 });
  assert.equal(saved.target.hostId, host.id); assert.equal(saved.lastRunAt, 0); assert.ok(saved.scheduleFromAt > 0);
  setActiveHost('local'); assert.equal(getInspectionSchedule().target.hostId, host.id); assert.equal(getInspectionSchedule().enabled, true);
  upsertHost({ ...host, password: 'isolated-credential-change' });
  assert.notEqual(hostConnectionRevision(host.id), revision); assert.equal(getInspectionSchedule().enabled, false);
  assert.match(getInspectionSchedule().targetError, /配置已变化/);
  await assert.rejects(Promise.resolve().then(() => saveInspectionSchedule({ enabled: true })), { statusCode: 409 });
  const rebound = saveInspectionSchedule({ enabled: true, hostId: host.id, connectionRevision: hostConnectionRevision(host.id) });
  assert.equal(rebound.enabled, true); assert.equal(rebound.target.hostId, host.id);
});

test('无目标的旧自动巡检保持配置记录但不能继续跟随活动节点执行', () => {
  setSetting('inspection.auto_enabled', '1'); setSetting('inspection.auto_target', 'null');
  const schedule = getInspectionSchedule();
  assert.equal(schedule.configured, true); assert.equal(schedule.enabled, false); assert.match(schedule.targetError, /尚未绑定/);
  assert.throws(() => saveInspectionSchedule({ enabled: true }), { statusCode: 409 });
  assert.equal(getInspectionSchedule().target, null);
  saveInspectionSchedule({ enabled: false });
});
