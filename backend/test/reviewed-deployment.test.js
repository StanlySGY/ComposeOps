import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-review-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.COMPOSE_BIN = 'true';
const { assertReviewedDeployment } = await import('../src/services/reviewed-deployment.js');
const { prepareProjectAction } = await import('../src/services/project-action-runner.js');
const { withProjectOperationLock } = await import('../src/services/project-operation-lock.js');
const file = path.join(tempDir, 'compose.yaml');
const content = 'services: { web: { image: nginx:alpine } }';
fs.writeFileSync(file, content);
const project = { id: 'review-test', projectName: 'review-test', host: { id: 'local', type: 'local' }, mounted: true, managed: true, mountEnabled: true, editable: true, workingDir: tempDir, composeFiles: [file] };
const review = { expectedHostId: 'local', expectedContent: content };
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
test.beforeEach(() => fs.writeFileSync(file, content));

test('matching reviewed config is accepted; changed file is rejected before execution', async () => {
  await assertReviewedDeployment(project, 'up', review);
  fs.writeFileSync(file, 'services: {}');
  await assert.rejects(assertReviewedDeployment(project, 'up', review), { statusCode: 409 });
});
test('host mismatch and host switch during reading both reject', async () => {
  let readCount = 0;
  const read = async () => { readCount++; return { content }; };
  await assert.rejects(assertReviewedDeployment(project, 'up', review, { activeHostId: () => 'remote', read }), { statusCode: 409 });
  assert.equal(readCount, 0);
  let host = 'local';
  await assert.rejects(assertReviewedDeployment(project, 'up', review, { activeHostId: () => host, read: async () => { host = 'remote'; return { content }; } }), { statusCode: 409 });
});
test('legacy actions remain available; incomplete reviewed intents fail closed', async () => {
  await assertReviewedDeployment(project, 'stop', {});
  await assert.rejects(assertReviewedDeployment(project, 'up', { expectedContent: content }), { statusCode: 400 });
  await assert.rejects(assertReviewedDeployment(project, 'stop', review), { statusCode: 400 });
});
test('review is rechecked within project operation lock before spawning Compose', async () => {
  let release;
  const occupied = withProjectOperationLock(project.id, () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const prepared = await prepareProjectAction(project, 'up');
  let spawned = false;
  let checks = 0;
  const queued = prepared.run(() => {}, () => { spawned = true; }, { beforeRun: async () => { checks++; await assertReviewedDeployment(project, 'up', review); } });
  // Attach rejection handler before releasing the queued operation.
  const rejected = assert.rejects(queued, { statusCode: 409 });
  assert.equal(checks, 0);
  fs.writeFileSync(file, 'services: {}');
  release(); await occupied; await rejected;
  assert.equal(checks, 1); assert.equal(spawned, false);
});

test('reviewed action API preserves review guards and streams matching deployments', async t => {
  const { default: Fastify } = await import('fastify');
  const { default: projectRoutes } = await import('../src/routes/projects.js');
  const { getActivityDocker } = await import('../src/services/docker-hosts.js');
  const { scanProjects, invalidateScanCache } = await import('../src/services/scanner.js');
  const { setProjectPreference } = await import('../src/lib/db.js');
  t.mock.method(getActivityDocker(), 'listContainers', async () => [{ Id: 'review-fake', Names: ['/review-fake'], State: 'running', Labels: {
    'com.docker.compose.project': 'review-test',
    'com.docker.compose.project.working_dir': tempDir,
    'com.docker.compose.project.config_files': file,
  } }]);
  invalidateScanCache();
  const [target] = await scanProjects();
  setProjectPreference(target.id, { managed: true, mountEnabled: true });
  const app = Fastify();
  await app.register(projectRoutes, { prefix: '/projects' });
  try {
    const read = await app.inject({ method: 'GET', url: `/projects/${target.id}/compose` });
    assert.equal(read.statusCode, 200); assert.equal(read.json().hostId, 'local');
    const url = `/projects/${target.id}/actions`;
    for (const bad of [{ ...review, expectedHostId: 'elsewhere' }, { ...review, expectedContent: 'changed' }]) {
      const response = await app.inject({ method: 'POST', url, payload: { action: 'up', ...bad } });
      assert.equal(response.statusCode, 409);
    }
    const response = await app.inject({ method: 'POST', url, payload: { action: 'up', ...review } });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /"type":"exit","data":\{"code":0\}/);
  } finally { await app.close(); invalidateScanCache(); }
});
