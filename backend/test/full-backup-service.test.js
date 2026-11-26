import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { previewFullBackup } from '../src/services/full-backup-plan.js';

const temp = await mkdtemp(path.join(os.tmpdir(), 'composeops-preflight-'));
process.env.DB_PATH = path.join(temp, 'test.db');
const directory = path.join(temp, 'app');
const { mkdir } = await import('node:fs/promises');
await mkdir(directory);
const compose = path.join(directory, 'compose.yaml');
await writeFile(compose, 'services:\n  web:\n    image: example/web:1\n');
const host = { id: 'local', name: '本机', type: 'local' };
const labels = { 'com.docker.compose.project': 'example', 'com.docker.compose.project.working_dir': directory };
const project = { id: 'p1', projectName: 'example', workingDir: directory, composeFiles: [compose], managed: true, mounted: true, mountEnabled: true };
const docker = {
  listContainers: async () => [{ Id: 'c1', Labels: labels }],
  getContainer: () => ({ inspect: async () => ({ Id: 'c1', Image: 'sha256:actual', Config: { Labels: labels }, Mounts: [] }) }),
};
const dependencies = (patch = {}) => ({ getActiveHost: () => host, findProject: async () => project, getDockerForHost: id => { assert.equal(id, 'local'); return docker; }, ...patch });

test('只读取项目配置和容器信息，不创建工作容器', async () => {
  const plan = await previewFullBackup('p1', dependencies());
  assert.equal(plan.resources.find(item => item.kind === 'compose_file').verification, 'readable');
  assert.equal(plan.executionAvailable, false);
});

test('未纳管项目在访问 Docker 前被拒绝', async () => {
  await assert.rejects(previewFullBackup('p1', dependencies({ findProject: async () => ({ ...project, managed: false }), getDockerForHost: () => assert.fail('must not access Docker') })), { statusCode: 403 });
});

test('扫描期间切换节点拒绝混用宿主', async () => {
  let changed = false;
  await assert.rejects(previewFullBackup('p1', dependencies({
    getActiveHost: () => changed ? { id: 'other' } : host,
    findProject: async () => { changed = true; return project; },
    getDockerForHost: () => assert.fail('must not use another host'),
  })), { statusCode: 409 });
});

test('远程节点不读取本机同名文件', async () => {
  const plan = await previewFullBackup('p1', dependencies({ getActiveHost: () => ({ ...host, type: 'ssh' }), readFile: () => assert.fail('must not read local file for remote host') }));
  assert.ok(plan.blockers.some(item => item.code === 'compose_unreadable'));
});

test('拒绝读取逃出项目目录的 Compose 符号链接', async () => {
  const external = path.join(temp, 'external.yaml');
  const linked = path.join(directory, 'linked.yaml');
  await writeFile(external, 'services: {}');
  await symlink(external, linked);
  const plan = await previewFullBackup('p1', dependencies({ findProject: async () => ({ ...project, composeFiles: [linked] }), readFile: () => assert.fail('must not read external file') }));
  assert.ok(plan.blockers.some(item => item.code === 'compose_unreadable'));
});

test('应用注册的预检入口继承全局登录鉴权', async () => {
  const { buildApp } = await import('../src/app.js');
  const app = await buildApp({ logger: false });
  try {
    const response = await app.inject('/api/v1/ops/storage/full-backup-plan?projectId=p1');
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, 'unauthorized');
  } finally { await app.close(); }
});

test.after(async () => {
  const { default: db } = await import('../src/lib/db.js');
  db.close();
  await rm(temp, { recursive: true, force: true });
});
