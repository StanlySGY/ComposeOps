import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import cronRoutes from '../src/routes/cron.js';
import { withProjectOperationLock } from '../src/services/project-operation-lock.js';
import { resolveScheduledProject } from '../src/services/scheduled-project-scope.js';
import { runDbDump } from '../src/services/db-dumper.js';
import { registerMaintenanceTools } from '../src/services/tools/maintenance-tools.js';
import { getDockerForHost, setActiveHost, upsertHost, deleteHost, getHost, hostConnectionRevision } from '../src/services/docker-hosts.js';
import { scanProjects, invalidateScanCache } from '../src/services/scanner.js';
import { setProjectPreference } from '../src/lib/db.js';
import { createJob, updateJob, deleteJob, runJobNow, listHistory } from '../src/services/cron-scheduler.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'cron-project-'));
  await writeFile(path.join(root, 'compose.yml'), 'services: {}\nvolumes: {}\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const docker = getDockerForHost('local');
  t.mock.method(docker, 'info', async () => ({ ID: 'fixture-engine' }));
  t.mock.method(docker, 'listContainers', async () => [{ Id: 'fixture', Names: ['/fixture'], State: 'running', Labels: {
    'com.docker.compose.project': 'fixture', 'com.docker.compose.project.working_dir': root,
    'com.docker.compose.project.config_files': path.join(root, 'compose.yml'),
  } }]);
  const [project] = await scanProjects('local');
  setProjectPreference(project.id, { managed: true, mountEnabled: true });
  return { project, docker, root };
}
async function job(t, input) {
  const saved = await createJob({ name: '项目限定计划', type: 'volume-backup', cron: '0 0 * * *', enabled: false, ...input });
  t.after(() => deleteJob(saved.id)); return saved;
}
test.beforeEach(() => { setActiveHost('local'); invalidateScanCache(); });
test.afterEach(() => { setActiveHost('local'); invalidateScanCache(); });

test('指定项目的定时计划必须保存项目范围，不得静默变成全节点计划', async t => {
  const { project } = await fixture(t);
  const saved = await job(t, { scope: 'project', projectId: project.id, hostId: 'local', connectionRevision: hostConnectionRevision('local') });
  assert.equal(saved.scope, 'project'); assert.equal(saved.target.projectId, project.id);
  assert.equal(saved.target.engineId, 'fixture-engine');
});

test('不存在或未纳管的项目不能创建计划，也不能忽略项目ID后扩大范围', async t => {
  const { project } = await fixture(t);
  await assert.rejects(createJob({ name: '拒绝无效项目', type: 'pull-images', cron: '0 0 * * *', scope: 'project', hostId: 'local', projectId: 'missing' }));
  setProjectPreference(project.id, { managed: false });
  await assert.rejects(createJob({ name: '拒绝未纳管', type: 'volume-backup', cron: '0 0 * * *', scope: 'project', hostId: 'local', projectId: project.id }));
});

test('项目计划的扫描与执行仅访问固定节点，无关离线节点不会阻止或扩大范围', async t => {
  const { project, docker } = await fixture(t);
  const host = upsertHost({ name: '无关离线节点', type: 'tcp', host: '127.0.0.1', port: 9 });
  t.after(() => { if (getHost(host.id)) deleteHost(host.id); });
  const unrelated = t.mock.method(getDockerForHost(host.id), 'listContainers', async () => { throw new Error('必须不被访问'); });
  t.mock.method(docker, 'listVolumes', async () => ({ Volumes: [] }));
  const saved = await job(t, { projectId: project.id, hostId: 'local' });
  setActiveHost(host.id);
  assert.equal((await resolveScheduledProject(saved.target, saved.type)).id, project.id);
  await assert.rejects(runJobNow(saved.id), /没有找到可备份的命名卷/);
  assert.equal(unrelated.mock.callCount(), 0);
  const entry = (await listHistory()).find(item => item.jobId === saved.id);
  assert.equal(entry.scope, 'project'); assert.equal(entry.projectId, project.id); assert.equal(entry.hostId, 'local');
});

test('等待项目锁期间撤销纳管，拿到锁后必须重新验证并拒绝执行', async t => {
  const { project, docker } = await fixture(t), saved = await job(t, { projectId: project.id, hostId: 'local' });
  const volumes = t.mock.method(docker, 'listVolumes', async () => ({ Volumes: [] }));
  let release, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = withProjectOperationLock(project.id, async () => { enter(); await new Promise(resolve => { release = resolve; }); });
  await entered;
  const pending = runJobNow(saved.id);
  setProjectPreference(project.id, { managed: false }); release(); await held;
  await assert.rejects(pending, { statusCode: 403 }); assert.equal(volumes.mock.callCount(), 0);
});

test('Engine变化后既不能执行，也不能通过改名或启用偷偷绑定新服务器', async t => {
  const { project, docker } = await fixture(t), saved = await job(t, { projectId: project.id, hostId: 'local' });
  t.mock.method(docker, 'info', async () => ({ ID: 'replacement-engine' }));
  await assert.rejects(runJobNow(saved.id), { statusCode: 409 });
  await assert.rejects(updateJob(saved.id, { enabled: true }), { statusCode: 409 });
  await assert.rejects(updateJob(saved.id, { scope: 'project', projectId: project.id, hostId: 'local' }), { statusCode: 409 });
  const renamed = await updateJob(saved.id, { name: '仅改名', cron: '0 1 * * *' });
  assert.equal(renamed.target.engineId, 'fixture-engine'); assert.equal(renamed.scope, 'project');
});

test('范围冲突和不支持项目的任务类型拒绝保存，原记录保持', async t => {
  const { project } = await fixture(t), saved = await job(t, { projectId: project.id, hostId: 'local' });
  for (const type of ['inspection', 'images-check', 'prune-safe']) {
    await assert.rejects(updateJob(saved.id, { type }), /不支持限定项目/);
  }
  await assert.rejects(createJob({ name: '范围冲突', type: 'pull-images', cron: '0 0 * * *', scope: 'all', projectId: project.id }), /不一致/);
  const retained = await updateJob(saved.id, { cron: '0 2 * * *' });
  assert.equal(retained.type, 'volume-backup'); assert.equal(retained.target.projectId, project.id);
});

test('HTTP创建与编辑保留项目范围，未纳管项目返回403且不生成全节点任务', async t => {
  const { project } = await fixture(t), app = Fastify();
  await app.register(cronRoutes, { prefix: '/cron' }); t.after(() => app.close());
  const created = await app.inject({ method: 'POST', url: '/cron', payload: { name: 'API项目计划', type: 'volume-backup', cron: '0 0 * * *', enabled: false, scope: 'project', projectId: project.id, hostId: 'local' } });
  assert.equal(created.statusCode, 200); const saved = created.json(); t.after(() => deleteJob(saved.id));
  assert.equal(saved.scope, 'project'); assert.equal(saved.target.projectId, project.id);
  const edited = await app.inject({ method: 'PUT', url: '/cron/' + saved.id, payload: { name: '改名不改范围', enabled: false, scope: 'project' } });
  assert.equal(edited.statusCode, 200); assert.deepEqual(edited.json().target, saved.target);
  setProjectPreference(project.id, { managed: false });
  const denied = await app.inject({ method: 'POST', url: '/cron', payload: { name: '拒绝无权限', type: 'volume-backup', cron: '0 0 * * *', scope: 'project', projectId: project.id, hostId: 'local' } });
  assert.equal(denied.statusCode, 403);
});

test('数据库dump在exec创建后权限失效也不能启动命令', async t => {
  const { project, docker } = await fixture(t);
  const start = t.mock.fn(async () => { throw new Error('不得启动dump'); });
  let revoked = false;
  t.mock.method(docker, 'getContainer', () => ({ exec: async () => { revoked = true; return { start }; } }));
  await assert.rejects(runDbDump({ ...project, managed: true, containers: [{ id: 'db', name: 'db', image: 'redis:7' }] }, 'db', {
    download: false, beforeEffect: async () => { if (revoked) throw new Error('项目权限已撤销'); },
  }), /权限已撤销/);
  assert.equal(start.mock.callCount(), 0);
});

test('Agent创建项目计划保留范围参数，缺少节点修订时明确拒绝', async t => {
  const { project } = await fixture(t); let tool;
  registerMaintenanceTools({ registerTool(name, definition) { if (name === 'cron.create') tool = definition; return this; } });
  const input = { name: 'Agent项目计划', type: 'volume-backup', cron: '0 0 * * *', scope: 'project', projectId: project.id, hostId: 'local' };
  await assert.rejects(tool.execute(input), { statusCode: 409 });
  const saved = await tool.execute({ ...input, connectionRevision: hostConnectionRevision('local') });
  t.after(() => deleteJob(saved.id)); assert.equal(saved.scope, 'project'); assert.equal(saved.target.projectId, project.id);
});
