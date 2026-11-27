import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'image-check-lifecycle-'));
process.env.DB_PATH = path.join(root, 'test.db');
const { getActivityDocker } = await import('../src/services/docker-hosts.js');
const { getProjectUpdates, clearImageUpdateCache, upgradeProject } = await import('../src/services/image-updater.js');
const imageId = 'sha256:' + 'a'.repeat(64);
const remoteId = 'sha256:' + 'b'.repeat(64);
const manifest = (id = imageId) => Response.json({ schemaVersion: 2, config: { digest: id } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, count = 6) {
  const folder = await mkdtemp(path.join(root, 'project-'));
  const file = path.join(folder, 'compose.yml');
  const services = Array.from({ length: count }, (_, i) => 'app' + i);
  await writeFile(file, JSON.stringify({ services: Object.fromEntries(services.map(service => [service, { image: `registry.example.com/test/${service}:latest` }])) }));
  const project = { id: folder, projectName: 'lifecycle', workingDir: folder, mounted: true, managed: true, editable: true, composeFiles: [file] };
  const docker = getActivityDocker();
  t.mock.method(docker, 'listContainers', async () => services.map(service => ({ Id: service, ImageID: imageId, Labels: {
    'com.docker.compose.project': project.projectName, 'com.docker.compose.project.working_dir': folder, 'com.docker.compose.service': service,
  } })));
  t.mock.method(docker, 'getImage', () => ({ inspect: async () => ({ Id: imageId, Os: 'linux', Architecture: 'amd64' }) }));
  clearImageUpdateCache();
  // Keep test deadlines alive even when a deliberately broken transport has no handles.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => { clearInterval(keepAlive); clearImageUpdateCache(); });
  return { project, docker, services };
}

test('镜像检测并发最多三个服务，完成次序不改变服务顺序并复用本地镜像检查', async t => {
  const { project, docker, services } = await fixture(t);
  let active = 0, peak = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 30)); return manifest(); }
    finally { active--; }
  });
  const result = await getProjectUpdates(project);
  assert.equal(peak, 3);
  assert.deepEqual(result.images.map(i => i.service), services);
  assert.ok(result.images.every(i => i.status === 'current'));
  assert.equal(result.incomplete, false);
  assert.equal(docker.getImage.mock.callCount(), 1);
});

test('总期限保留确认结果，超时和排队服务明确失败，迟到结果不能改写缓存', async t => {
  const { project, services } = await fixture(t);
  const pending = deferred();
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(options.signal);
    return String(url).includes('/app0/') ? manifest(remoteId) : pending.promise;
  });
  const result = await getProjectUpdates(project, { timeoutMs: 750 });
  assert.deepEqual(result.images.map(i => i.service), services);
  assert.equal(result.images[0].status, 'updated');
  assert.equal(result.images[0].hasUpdate, true);
  assert.ok(result.images.slice(1).every(i => i.status === 'failed' && !i.hasUpdate && !i.reachable && /期限/.test(i.error)));
  assert.equal(result.incomplete, true);
  assert.equal(result.hasUpdate, true);
  assert.equal(requests.length, 4, 'deadline must not start queued registry checks');
  assert.ok(requests.every(signal => signal.aborted));
  const before = JSON.stringify(result);
  pending.resolve(manifest());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(result), before);
  assert.equal(JSON.stringify(await getProjectUpdates(project)), before);
  assert.equal(requests.length, 4, 'incomplete results have a short reusable cache');
});

test('调用方取消仍为取消，不能缓存成部分成功或继续发起排队检查', async t => {
  const { project } = await fixture(t);
  const started = deferred(), pending = deferred(), controller = new AbortController();
  const request = t.mock.method(globalThis, 'fetch', () => { started.resolve(); return pending.promise; });
  const check = getProjectUpdates(project, { signal: controller.signal });
  await started.promise;
  controller.abort();
  await assert.rejects(check, { name: 'AbortError' });
  const calls = request.mock.callCount();
  pending.resolve(manifest());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(request.mock.callCount(), calls);
  request.mock.mockImplementation(async () => manifest());
  const result = await getProjectUpdates(project);
  assert.equal(result.incomplete, false);
  assert.ok(request.mock.callCount() > calls, 'cancelled checks must not populate cache');
});

test('Docker 容器列表停滞有总期限，迟到列表不能继续触发读取', async t => {
  const { project, docker } = await fixture(t, 1);
  const pending = deferred(); let signal;
  docker.listContainers.mock.mockImplementation(options => { signal = options.abortSignal; return pending.promise; });
  const request = t.mock.method(globalThis, 'fetch', async () => manifest());
  await assert.rejects(getProjectUpdates(project, { timeoutMs: 50 }), { name: 'TimeoutError' });
  assert.equal(signal.aborted, true);
  pending.resolve([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(request.mock.callCount(), 0);
  assert.equal(docker.getImage.mock.callCount(), 0);
});

test('本地镜像检查停滞也返回明确失败，不假设默认平台再访问仓库', async t => {
  const { project, docker } = await fixture(t, 1);
  docker.getImage.mock.mockImplementation(() => ({ inspect: () => new Promise(() => {}) }));
  const request = t.mock.method(globalThis, 'fetch', async () => manifest());
  const result = await getProjectUpdates(project, { timeoutMs: 750 });
  assert.equal(result.images[0].status, 'failed');
  assert.equal(result.hasUpdate, false);
  assert.equal(request.mock.callCount(), 0);
});

test('无法确认更新的服务不能通过升级预检', async t => {
  const { project } = await fixture(t, 1);
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('timeout', 'TimeoutError'); });
  await assert.rejects(upgradeProject(project, { services: ['app0'] }), { statusCode: 409 });
});

test.after(async () => {
  const { default: db } = await import('../src/lib/db.js');
  db.close();
  await rm(root, { recursive: true, force: true });
});
