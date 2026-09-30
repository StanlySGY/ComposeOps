import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-scanner-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
const { getActivityDocker, setActiveHost, upsertHost } = await import('../src/services/docker-hosts.js');
const { scanProjects, invalidateScanCache } = await import('../src/services/scanner.js');
const { setProjectPreference } = await import('../src/lib/db.js');
const { prepareProjectAction } = await import('../src/services/project-action-runner.js');
const local = getActivityDocker();
const remoteHost = upsertHost({ name: '扫描测试', type: 'tcp', host: '127.0.0.1', port: 1 });
const row = name => ({ Id: name, Names: [`/${name}`], State: 'running', Labels: {
  'com.docker.compose.project': name,
  'com.docker.compose.project.working_dir': tempDir,
  'com.docker.compose.project.config_files': path.join(tempDir, 'compose.yaml'),
} });
fs.writeFileSync(path.join(tempDir, 'compose.yaml'), 'services: {}');
test.beforeEach(() => { setActiveHost('local'); invalidateScanCache(); });
test.afterEach(() => { setActiveHost('local'); invalidateScanCache(); });
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('切换节点不复用旧扫描,旧请求保留原节点访问类型且不覆盖当前缓存', async t => {
  let finishLocal;
  t.mock.method(local, 'listContainers', () => new Promise(resolve => { finishLocal = resolve; }));
  const oldRequest = scanProjects();
  setActiveHost(remoteHost.id);
  const remote = getActivityDocker();
  let remoteCalls = 0;
  t.mock.method(remote, 'listContainers', async () => { remoteCalls++; return [row('remote')]; });
  const newRequest = scanProjects();
  finishLocal([row('local')]);
  const [oldResult, newResult] = await Promise.all([oldRequest, newRequest]);
  assert.equal(newResult[0].projectName, 'remote');
  assert.equal(newResult[0].mountState, 'remote_api_only');
  assert.equal(oldResult[0].mountState, 'ready');
  assert.equal((await scanProjects())[0].projectName, 'remote');
  assert.equal(remoteCalls, 1);
});

test('失效前的扫描不能复活缓存或清除新的在途请求', async t => {
  const finishes = [];
  t.mock.method(local, 'listContainers', () => new Promise(resolve => finishes.push(resolve)));
  const stale = scanProjects();
  invalidateScanCache();
  const fresh = scanProjects();
  finishes[0]([row('stale')]);
  await stale;
  const shared = scanProjects();
  finishes[1]([row('fresh')]);
  assert.equal((await fresh)[0].projectName, 'fresh');
  assert.equal((await shared)[0].projectName, 'fresh');
  assert.equal(finishes.length, 2);
  assert.equal((await scanProjects())[0].projectName, 'fresh');
});

test('缓存与并发调用返回独立快照,调用方修改容器不污染后续读取', async t => {
  t.mock.method(local, 'listContainers', async () => [row('test')]);
  const [first, second] = await Promise.all([scanProjects(), scanProjects()]);
  first[0].containers[0].name = 'changed';
  assert.equal(second[0].containers[0].name, 'test');
  const cached = await scanProjects();
  assert.equal(cached[0].containers[0].name, 'test');
});

test('纳管、目录权限及备注变更立即生效,不等待 Docker 扫描缓存过期', async t => {
  const list = t.mock.method(local, 'listContainers', async () => [row('preferences')]);
  const [project] = await scanProjects();
  setProjectPreference(project.id, { managed: true, mountEnabled: true, note: '新备注' });
  let current = (await scanProjects())[0];
  assert.equal(current.managed, true);
  assert.equal(current.editable, true);
  assert.equal(current.note, '新备注');
  setProjectPreference(project.id, { managed: false });
  current = (await scanProjects())[0];
  assert.equal(current.managed, false);
  assert.equal(current.editable, false);
  assert.equal(list.mock.callCount(), 1);
});

test('项目操作完成后立即读取真实容器状态', async t => {
  let state = 'exited';
  t.mock.method(local, 'listContainers', async () => [{ ...row('action'), State: state }]);
  t.mock.method(local, 'getContainer', () => ({
    inspect: async () => ({ State: { Status: state } }),
    start: async () => { state = 'running'; },
  }));
  const [project] = await scanProjects();
  assert.equal(project.status, 'stopped');
  const prepared = await prepareProjectAction({ ...project, managed: true, mountEnabled: false }, 'up');
  assert.equal(await prepared.run(), 0);
  assert.equal((await scanProjects())[0].status, 'running');
});
