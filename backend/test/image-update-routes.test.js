import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Fastify from 'fastify';
import projectRoutes from '../src/routes/projects.js';
import opsRoutes from '../src/routes/ops.js';
import { scanProjects, invalidateScanCache } from '../src/services/scanner.js';
import { getDockerForHost } from '../src/services/docker-hosts.js';
import { clearImageUpdateCache } from '../src/services/image-updater.js';
import { setProjectPreference, setSetting, getSetting } from '../src/lib/db.js';

const imageId = 'sha256:' + 'a'.repeat(64);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'composeops-update-routes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'compose.yml');
  await writeFile(file, 'services:\n  app:\n    image: registry.example.com/test/app:latest\n');
  const docker = getDockerForHost('local');
  t.mock.method(docker, 'listContainers', async () => [{ Id: 'update-api', Names: ['/update-api'], State: 'running', Status: 'Up', ImageID: imageId, Labels: {
    'com.docker.compose.project': 'update-api', 'com.docker.compose.project.working_dir': root, 'com.docker.compose.project.config_files': file, 'com.docker.compose.service': 'app',
  } }]);
  t.mock.method(docker, 'getImage', () => ({ inspect: async () => ({ Id: imageId, Os: 'linux', Architecture: 'amd64' }) }));
  clearImageUpdateCache(); invalidateScanCache();
  t.after(() => { clearImageUpdateCache(); invalidateScanCache(); });
  const [project] = await scanProjects();
  const app = Fastify();
  await app.register(projectRoutes, { prefix: '/projects' });
  await app.register(opsRoutes, { prefix: '/ops' });
  t.after(() => app.close());
  return { app, project, docker, endpoint: `/projects/${project.id}/updates?force=1` };
}

test('镜像检查遵守纳管和目录授权，撤销权限后立即拒绝缓存结果', async t => {
  const { app, project, docker, endpoint } = await fixture(t);
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ config: { digest: imageId } }));
  const hidden = await app.inject({ url: endpoint });
  assert.equal(hidden.statusCode, 403);
  setProjectPreference(project.id, { managed: true, mountEnabled: false });
  assert.equal((await app.inject({ url: endpoint })).statusCode, 403);
  assert.equal(docker.getImage.mock.callCount(), 0);
  assert.equal(request.mock.callCount(), 0);
  setProjectPreference(project.id, { managed: true, mountEnabled: true });
  const allowed = await app.inject({ url: endpoint });
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.equal(allowed.json().images[0].status, 'current');
  setProjectPreference(project.id, { managed: false });
  assert.equal((await app.inject({ url: endpoint.replace('force=1', 'force=0') })).statusCode, 403);
  assert.equal(request.mock.callCount(), 1);
});

for (const all of [false, true]) {
  test(`${all ? '全局' : '项目'}镜像检查 HTTP 断开取消仓库请求，不留下完成记录`, async t => {
    const { app, project, endpoint } = await fixture(t);
    setProjectPreference(project.id, { managed: true, mountEnabled: true });
    setSetting('updates.last_radar_check', 'not-completed');
    let started, stopped;
    const ready = new Promise(resolve => { started = resolve; });
    const aborted = new Promise(resolve => { stopped = resolve; });
    t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { stopped(); reject(signal.reason); }, { once: true });
      started();
    }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const request = http.request({ host: '127.0.0.1', port: app.server.address().port, path: all ? '/ops/updates/check-all' : endpoint, method: all ? 'POST' : 'GET' });
    request.on('error', () => {}); request.end();
    t.after(() => request.destroy());
    const timeout = setTimeout(() => request.destroy(new Error('test deadline')), 3000);
    t.after(() => clearTimeout(timeout));
    await ready;
    request.destroy();
    await aborted;
    assert.equal(getSetting('updates.last_radar_check'), 'not-completed');
  });
}
