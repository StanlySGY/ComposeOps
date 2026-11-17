import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-container-management-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
const { default: Fastify } = await import('fastify');
const { default: projectRoutes } = await import('../src/routes/projects.js');
const { getActivityDocker } = await import('../src/services/docker-hosts.js');
const { invalidateScanCache, scanProjects } = await import('../src/services/scanner.js');
const { setProjectPreference } = await import('../src/lib/db.js');

const projectName = 'container-management-test';
const workingDir = path.join(tempDir, 'stack');
const composeFile = path.join(workingDir, 'compose.yml');
fs.mkdirSync(workingDir);
fs.writeFileSync(composeFile, 'services: { web: { image: nginx }, worker: { image: alpine } }');

function composeRow(id, service, state = 'exited') {
  return {
    Id: id, Names: [`/${id}`], Image: service, ImageID: `sha256:${id}`, State: state,
    Status: state, Created: 1, Ports: [], Mounts: [],
    Labels: {
      'com.docker.compose.project': projectName,
      'com.docker.compose.project.working_dir': workingDir,
      'com.docker.compose.project.config_files': composeFile,
      'com.docker.compose.service': service,
    },
  };
}

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('standalone endpoint lists only containers without Compose project labels', async (t) => {
  const docker = getActivityDocker();
  t.mock.method(docker, 'listContainers', async () => [
    { Id: 'standalone-container-0001', Names: ['/standalone'], Image: 'redis:alpine', State: 'exited', Status: 'Exited', Labels: {}, Ports: [], Mounts: [] },
    composeRow('compose-web-container-0001', 'web'),
  ]);
  invalidateScanCache();
  const app = Fastify();
  await app.register(projectRoutes, { prefix: '/projects' });
  try {
    const response = await app.inject({ method: 'GET', url: '/projects/standalone-containers' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().containers.length, 1);
    assert.equal(response.json().containers[0].id, 'standalone-container-0001');
    assert.equal(response.json().hostId, 'local');
  } finally { await app.close(); }
});

test('standalone lifecycle action verifies host and refuses Compose-owned containers', async (t) => {
  const docker = getActivityDocker();
  let state = 'exited';
  t.mock.method(docker, 'getContainer', (_id) => ({
    async inspect() {
      return {
        Name: '/standalone',
        Config: { Labels: {} },
        State: { Status: state },
      };
    },
    async start() { state = 'running'; },
    async stop() { state = 'exited'; },
    async restart() { state = 'running'; },
  }));
  const app = Fastify();
  await app.register(projectRoutes, { prefix: '/projects' });
  try {
    const response = await app.inject({
      method: 'POST', url: '/projects/standalone-containers/standalone-container-0001/actions',
      payload: { action: 'start', expectedHostId: 'local' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().state, 'running');
    const wrongHost = await app.inject({
      method: 'POST', url: '/projects/standalone-containers/standalone-container-0001/actions',
      payload: { action: 'stop', expectedHostId: 'other-node' },
    });
    assert.equal(wrongHost.statusCode, 409);
    assert.equal(state, 'running');
  } finally { await app.close(); }
});

test('Compose service action targets every replica with the exact service label', async (t) => {
  const docker = getActivityDocker();
  const states = new Map([
    ['compose-web-container-0001', 'exited'],
    ['compose-web-container-0002', 'exited'],
    ['compose-worker-container-0001', 'exited'],
  ]);
  t.mock.method(docker, 'listContainers', async () => [
    composeRow('compose-web-container-0001', 'web'),
    composeRow('compose-web-container-0002', 'web'),
    composeRow('compose-worker-container-0001', 'worker'),
  ]);
  t.mock.method(docker, 'getContainer', (id) => ({
    async inspect() {
      const service = id.includes('worker') ? 'worker' : 'web';
      return {
        Name: `/${id}`,
        Config: { Labels: { 'com.docker.compose.project': projectName, 'com.docker.compose.service': service } },
        State: { Status: states.get(id) },
      };
    },
    async start() { states.set(id, 'running'); },
    async stop() { states.set(id, 'exited'); },
    async restart() { states.set(id, 'running'); },
  }));
  invalidateScanCache();
  const [project] = await scanProjects();
  setProjectPreference(project.id, { managed: true });
  invalidateScanCache();
  const app = Fastify();
  await app.register(projectRoutes, { prefix: '/projects' });
  try {
    const response = await app.inject({
      method: 'POST', url: `/projects/${project.id}/services/web/actions`,
      payload: { action: 'start' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().replicas.length, 2);
    assert.equal(response.json().replicas.every((item) => item.ok), true);
    assert.equal(states.get('compose-worker-container-0001'), 'exited');
  } finally { await app.close(); invalidateScanCache(); }
});
