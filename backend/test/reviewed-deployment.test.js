import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-review-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
const executable = path.join(tempDir, 'compose-test');
fs.writeFileSync(executable, '#!/usr/bin/env node\nif (process.argv.includes("config") && !process.argv.includes("--environment")) process.stdout.write(JSON.stringify({services:{web:{image:"nginx:alpine",environment:{PASSWORD:"secret-value"}}}}));\n', { mode: 0o700 });
process.env.COMPOSE_BIN = executable;
const { assertReviewedDeployment, createDeploymentReview, captureDeploymentInputs } = await import('../src/services/reviewed-deployment.js');
const { prepareProjectAction } = await import('../src/services/project-action-runner.js');
const { withProjectOperationLock } = await import('../src/services/project-operation-lock.js');
const file = path.join(tempDir, 'compose.yaml');
const override = path.join(tempDir, 'override.yaml');
const content = 'services: { web: { image: nginx:alpine } }';
const project = { id: 'review-test', projectName: 'review-test', host: { id: 'local', type: 'local' }, mounted: true, managed: true, mountEnabled: true, editable: true, workingDir: tempDir, composeFiles: [file, override] };
const preview = async () => ({ added: [], changed: [], removed: [], restarted: [], portConflicts: [] });
const issue = async (target = project) => ({ reviewToken: (await createDeploymentReview(target, { preview })).token });
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
test.beforeEach(() => {
  fs.writeFileSync(file, content); fs.writeFileSync(override, 'services: { web: { ports: ["8080:80"] } }');
  fs.writeFileSync(path.join(tempDir, '.env'), 'TAG=alpine');
});

test('review only exposes an opaque token and redacted merged configuration', async () => {
  const review = await createDeploymentReview(project, { preview });
  assert.equal(review.fingerprint, undefined);
  assert.ok(!JSON.stringify(review).includes('secret-value'));
  assert.match(review.content, /REDACTED/);
  assert.deepEqual(review.files, [file, override]);
  await assertReviewedDeployment(project, 'up', { reviewToken: review.token });
});
for (const [name, mutate] of [
  ['first file', () => fs.writeFileSync(file, 'services: {}')],
  ['override', () => fs.writeFileSync(override, 'services: { web: { ports: ["9090:80"] } }')],
  ['env', () => fs.writeFileSync(path.join(tempDir, '.env'), 'TAG=stable')],
  ['env removal', () => fs.unlinkSync(path.join(tempDir, '.env'))],
  ['compose removal', () => fs.unlinkSync(override)],
]) test(`${name} change rejects old review`, async () => {
  const review = await issue(); mutate();
  await assert.rejects(assertReviewedDeployment(project, 'up', review));
});
test('file list additions/removals/reordering, project and permissions are bound', async () => {
  const review = await issue();
  for (const changed of [{ composeFiles: [override, file] }, { composeFiles: [file] }, { composeFiles: [file, override, file] }, { id: 'another-project' }, { editable: false }]) {
    await assert.rejects(assertReviewedDeployment({ ...project, ...changed }, 'up', review), { statusCode: 409 });
  }
});
test('host mismatch and host switch during capture both reject', async () => {
  const review = await issue();
  let captures = 0;
  await assert.rejects(assertReviewedDeployment(project, 'up', review, { activeHostId: () => 'remote', capture: async () => { captures++; } }), { statusCode: 409 });
  assert.equal(captures, 0);
  let host = 'local';
  await assert.rejects(assertReviewedDeployment(project, 'up', review, { activeHostId: () => host, capture: async () => { host = 'remote'; return {}; } }), { statusCode: 409 });
});
test('legacy regular actions remain available, incomplete/old reviewed intents fail closed; tokens are one use', async () => {
  await assertReviewedDeployment(project, 'stop', {});
  await assert.rejects(assertReviewedDeployment(project, 'up', { expectedContent: content, expectedHostId: 'local' }), { statusCode: 400 });
  await assert.rejects(assertReviewedDeployment(project, 'up', { reviewToken: 'unknown' }), { statusCode: 409 });
  const review = await issue();
  await assert.rejects(assertReviewedDeployment(project, 'stop', review), { statusCode: 400 });
  await assertReviewedDeployment(project, 'up', review, { consume: true });
  await assert.rejects(assertReviewedDeployment(project, 'up', review), { statusCode: 409 });
});
test('inconsistent input snapshots cannot produce a reviewed token', async () => {
  let call = 0;
  await assert.rejects(createDeploymentReview(project, { preview, capture: async () => ({ fingerprint: String(call++) }) }), { statusCode: 409 });
});
test('effective environment, service env_file and referenced Compose inputs are included', async () => {
  let env = 'TAG=alpine\nIRRELEVANT=one'; let model = { services: { web: { image: 'nginx:alpine', env_file: [{ path: path.join(tempDir, 'runtime.env') }] } } };
  fs.writeFileSync(file, 'include: extra.yaml\nservices: { web: { image: "nginx:${TAG}" } }');
  fs.writeFileSync(path.join(tempDir, 'extra.yaml'), 'services: {}');
  fs.writeFileSync(path.join(tempDir, 'runtime.env'), 'NORMAL=one');
  const io = { read: file => fs.promises.readFile(file, 'utf8'), config: async args => args.includes('--environment') ? env : JSON.stringify(model) };
  const snapshot = () => captureDeploymentInputs(project, { io });
  const first = await snapshot();
  env = 'TAG=alpine\nIRRELEVANT=two';
  assert.equal((await snapshot()).fingerprint, first.fingerprint);
  env = 'TAG=stable'; assert.notEqual((await snapshot()).fingerprint, first.fingerprint);
  env = 'TAG=alpine';
  fs.writeFileSync(path.join(tempDir, 'runtime.env'), 'NORMAL=two'); assert.notEqual((await snapshot()).fingerprint, first.fingerprint);
  fs.writeFileSync(path.join(tempDir, 'runtime.env'), 'NORMAL=one');
  fs.writeFileSync(path.join(tempDir, 'extra.yaml'), '# changed\nservices: {}'); assert.notEqual((await snapshot()).fingerprint, first.fingerprint);
  model = { services: { web: { image: 'nginx:stable' } } }; assert.notEqual((await snapshot()).fingerprint, first.fingerprint);
});
test('queued deployment rechecks under the lock before spawning', async () => {
  const review = await issue();
  let release;
  const occupied = withProjectOperationLock(project.id, () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const prepared = await prepareProjectAction(project, 'up');
  let spawned = false; let checks = 0;
  const queued = prepared.run(() => {}, () => { spawned = true; }, { beforeRun: async () => { checks++; await assertReviewedDeployment(project, 'up', review); } });
  const rejected = assert.rejects(queued, { statusCode: 409 });
  assert.equal(checks, 0);
  fs.writeFileSync(override, 'services: {}'); release(); await occupied; await rejected;
  assert.equal(checks, 1); assert.equal(spawned, false);
});
test('review API issues a token, guards inputs and streams matching deployment', async t => {
  const { default: Fastify } = await import('fastify');
  const { default: projectRoutes } = await import('../src/routes/projects.js');
  const { getActivityDocker } = await import('../src/services/docker-hosts.js');
  const { scanProjects, invalidateScanCache } = await import('../src/services/scanner.js');
  const { setProjectPreference } = await import('../src/lib/db.js');
  t.mock.method(getActivityDocker(), 'listContainers', async () => [{ Id: 'review-fake', Names: ['/review-fake'], State: 'running', Labels: {
    'com.docker.compose.project': 'review-test', 'com.docker.compose.project.working_dir': tempDir,
    'com.docker.compose.project.config_files': [file, override].join(','),
  } }]);
  invalidateScanCache(); const [target] = await scanProjects();
  setProjectPreference(target.id, { managed: true, mountEnabled: true });
  const app = Fastify(); await app.register(projectRoutes, { prefix: '/projects' });
  try {
    const issue = () => app.inject({ method: 'POST', url: `/projects/${target.id}/deployment-review` });
    const result = await issue(); assert.equal(result.statusCode, 200, result.body);
    const url = `/projects/${target.id}/actions`;
    fs.writeFileSync(override, 'services: {}');
    assert.equal((await app.inject({ method: 'POST', url, payload: { action: 'up', reviewToken: result.json().token } })).statusCode, 409);
    const current = await issue();
    const response = await app.inject({ method: 'POST', url, payload: { action: 'up', reviewToken: current.json().token } });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /"type":"exit","data":\{"code":0\}/);
  } finally { await app.close(); invalidateScanCache(); }
});
