import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-api-boundaries-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.SERVE_FRONTEND = '0';
const { buildApp } = await import('../src/app.js');
const { getActivityDocker } = await import('../src/services/docker-hosts.js');
const { invalidateScanCache } = await import('../src/services/scanner.js');
const { composeProjectId } = await import('../src/services/project-id.js');
const { setPassword } = await import('../src/lib/auth.js');
const { getAgent } = await import('../src/services/agent.js');
const app = await buildApp({ logger: false });
const docker = getActivityDocker();
await app.ready();
setPassword('isolated-api-test-password');
let cookie = '';
test.before(async () => {
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://localhost:3001', host: 'localhost:3001' }, payload: { password: 'isolated-api-test-password' } });
  assert.equal(login.statusCode, 200);
  cookie = String(login.headers['set-cookie']).split(';', 1)[0];
});
test.after(async () => { await app.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
const headers = () => ({ cookie, origin: 'http://localhost:3001', host: 'localhost:3001' });

test('API boundary: volume backup and compose routes reject unauthenticated requests', async () => {
  for (const [method, url] of [['GET','/api/v1/ops/storage/volume-volumes?projectId=not-a-real-project'],['GET','/api/v1/ops/storage/volume-backups'],['POST','/api/v1/ops/storage/volume-backups/1/verify'],['PUT','/api/v1/projects/not-a-real-project/compose']]) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 401, method + ' ' + url);
    assert.equal(response.json().error, 'unauthorized');
  }
});

test('API boundary: missing project returns stable 404 without Docker side effects', async (t) => {
  t.mock.method(docker, 'listContainers', async () => []);
  const volume = await app.inject({ method: 'GET', url: '/api/v1/ops/storage/volume-volumes?projectId=not-a-real-project', headers: headers() });
  assert.equal(volume.statusCode, 404); assert.equal(volume.json().error, 'project_not_found');
  const compose = await app.inject({ method: 'PUT', url: '/api/v1/projects/not-a-real-project/compose', headers: headers(), payload: { content: 'services: {}', expectedContent: 'services: {}' } });
  assert.equal(compose.statusCode, 404); assert.equal(compose.json().error, 'project_not_found');
});

test('API boundary: volume-backup ID schema rejects zero and non-numeric IDs', async () => {
  for (const id of ['0', 'not-a-number']) {
    const response = await app.inject({ method: 'POST', url: '/api/v1/ops/storage/volume-backups/' + id + '/verify', headers: headers() });
    assert.equal(response.statusCode, 400); assert.equal(response.json().error, 'validation_failed');
  }
});

test('API boundary: invalid YAML and stale Compose writes are rejected; successful save can be rolled back', async (t) => {
  const projectDir = path.join(tempDir, 'isolated-compose-project'); fs.mkdirSync(projectDir, { recursive: true });
  const composeFile = path.join(projectDir, 'docker-compose.yml');
  const original = 'services:\n  web:\n    image: nginx:stable\n'; fs.writeFileSync(composeFile, original, 'utf8');
  const projectName = 'isolated-api-boundary-project'; const projectId = composeProjectId(projectDir, projectName);
  const container = { Id: 'isolated-api-boundary-container', Names: ['/isolated-api-boundary-web'], State: 'running', Status: 'Up', Image: 'nginx:stable', Created: 1, Ports: [], Labels: { 'com.docker.compose.project': projectName, 'com.docker.compose.project.working_dir': projectDir, 'com.docker.compose.project.config_files': composeFile, 'myops.owner': 'api-test' } };
  t.mock.method(docker, 'listContainers', async () => [container]); invalidateScanCache();
  const management = await app.inject({ method: 'PUT', url: '/api/v1/projects/management', headers: headers(), payload: { projectIds: [projectId], mountProjectIds: [projectId] } });
  assert.equal(management.statusCode, 200, management.body); invalidateScanCache();
  const invalid = await app.inject({ method: 'PUT', url: '/api/v1/projects/' + projectId + '/compose', headers: headers(), payload: { content: 'services: [', expectedContent: original } });
  assert.equal(invalid.statusCode, 422, invalid.body); assert.equal(fs.readFileSync(composeFile, 'utf8'), original);
  const stale = await app.inject({ method: 'PUT', url: '/api/v1/projects/' + projectId + '/compose', headers: headers(), payload: { content: 'services:\n  web:\n    image: nginx:latest\n', expectedContent: 'stale version' } });
  assert.equal(stale.statusCode, 409, stale.body); assert.match(stale.json().message, /其他操作修改/); assert.equal(fs.readFileSync(composeFile, 'utf8'), original);
  const changed = 'services: { web: { image: nginx:alpine } }';
  const saved = await app.inject({ method: 'PUT', url: '/api/v1/projects/' + projectId + '/compose', headers: headers(), payload: { content: changed, expectedContent: original } });
  assert.equal(saved.statusCode, 200, saved.body); assert.equal(fs.readFileSync(composeFile, 'utf8'), changed);
  const backups = await app.inject({ method: 'GET', url: '/api/v1/projects/' + projectId + '/backups', headers: headers() });
  assert.equal(backups.statusCode, 200, backups.body); const listedBackup = backups.json().backups[0]; assert.ok(listedBackup);
  const backupResponse = await app.inject({ method: 'GET', url: '/api/v1/projects/' + projectId + '/backups/' + listedBackup.id, headers: headers() });
  assert.equal(backupResponse.statusCode, 200, backupResponse.body); const backup = backupResponse.json(); assert.equal(backup.content, original);
  const restored = await app.inject({ method: 'POST', url: '/api/v1/projects/' + projectId + '/backups/' + backup.id + '/restore', headers: headers() });
  assert.equal(restored.statusCode, 200, restored.body); assert.equal(restored.json().ok, true); assert.equal(fs.readFileSync(composeFile, 'utf8'), original);
});

test('API boundary: unknown backup records fail closed across restore, verify, delete, and download', async () => {
  const cases = [['POST','/api/v1/ops/storage/volume-backups/987654321/restore','volume_restore_failed'],['POST','/api/v1/ops/storage/volume-backups/987654321/verify','volume_verify_failed'],['DELETE','/api/v1/ops/storage/volume-backups/987654321','volume_backup_delete_failed'],['GET','/api/v1/ops/storage/volume-backups/987654321/download','volume_backup_download_failed']];
  for (const [method,url,error] of cases) { const response = await app.inject({ method, url, headers: headers() }); assert.equal(response.statusCode, 404); assert.equal(response.json().error, error); }
});

test('Agent approval API validates inputs, forwards approve/reject, and rejects expired executions', async (t) => {
  const invalid = await app.inject({ method: 'POST', url: '/api/v1/ai/agent/approve', headers: headers(), payload: { executionId: 'missing-execution', approved: true } });
  assert.equal(invalid.statusCode, 400); assert.equal(invalid.json().error, 'validation_failed');
  const agent = getAgent(); const decisions = [];
  t.mock.method(agent, 'approveToolCall', (executionId, toolCallId, approved, input, remember) => { decisions.push({ executionId, toolCallId, approved, input, remember }); return executionId !== 'expired-execution'; });
  for (const approved of [true, false]) { const response = await app.inject({ method: 'POST', url: '/api/v1/ai/agent/approve', headers: headers(), payload: { executionId: 'isolated-execution', toolCallId: 'isolated-call-' + approved, approved } }); assert.equal(response.statusCode, 200, response.body); }
  assert.deepEqual(decisions.map((item) => item.approved), [true, false]);
  const expired = await app.inject({ method: 'POST', url: '/api/v1/ai/agent/approve', headers: headers(), payload: { executionId: 'expired-execution', toolCallId: 'isolated-call-expired', approved: true } });
  assert.equal(expired.statusCode, 404); assert.equal(expired.json().error, 'execution_not_found');
});

test('Workflow API: approval resumes a waiting instance; rejection cancels it', async () => {
  async function waiting(name) {
    const created = await app.inject({ method: 'POST', url: '/api/v1/workflows/definitions', headers: headers(), payload: { name, triggerType: 'manual', nodes: [{ id: 'human-gate', type: 'approval' }] } });
    assert.equal(created.statusCode, 201, created.body); const defId = created.json().definition.id;
    const started = await app.inject({ method: 'POST', url: '/api/v1/workflows/definitions/' + defId + '/run', headers: headers(), payload: { context: { testRun: true } } });
    assert.equal(started.statusCode, 200, started.body); const id = started.json().instance.id; let state;
    for (let i = 0; i < 30; i += 1) { const result = await app.inject({ method: 'GET', url: '/api/v1/workflows/instances/' + id, headers: headers() }); state = result.json().instance; if (state.status === 'waiting_approval') break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.equal(state.status, 'waiting_approval', JSON.stringify(state)); return id;
  }
  const acceptedId = await waiting('isolated-approval-accept');
  const accepted = await app.inject({ method: 'POST', url: '/api/v1/workflows/instances/' + acceptedId + '/approve', headers: headers(), payload: { approved: true, note: 'test approved' } });
  assert.equal(accepted.statusCode, 200, accepted.body);
  let acceptedState;
  for (let i = 0; i < 30; i += 1) { const response = await app.inject({ method: 'GET', url: '/api/v1/workflows/instances/' + acceptedId, headers: headers() }); acceptedState = response.json().instance; if (acceptedState.status === 'success') break; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.equal(acceptedState.status, 'success', JSON.stringify(acceptedState)); assert.equal(acceptedState.steps[0].status, 'success'); assert.equal(acceptedState.steps[0].output.note, 'test approved');
  const duplicate = await app.inject({ method: 'POST', url: '/api/v1/workflows/instances/' + acceptedId + '/approve', headers: headers(), payload: { approved: true } }); assert.equal(duplicate.statusCode, 400);
  const rejectedId = await waiting('isolated-approval-reject');
  const rejected = await app.inject({ method: 'POST', url: '/api/v1/workflows/instances/' + rejectedId + '/approve', headers: headers(), payload: { approved: false, note: 'test rejected' } });
  assert.equal(rejected.statusCode, 200, rejected.body); assert.equal(rejected.json().instance.status, 'cancelled');
  const current = await app.inject({ method: 'GET', url: '/api/v1/workflows/instances/' + rejectedId, headers: headers() }); assert.equal(current.json().instance.status, 'cancelled');
});

test('API boundary: workflow approval of nonexistent instance returns 4xx', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/v1/workflows/instances/not-a-real-instance/approve', headers: headers(), payload: { approved: true, note: 'isolated test' } });
  assert.ok(response.statusCode >= 400 && response.statusCode < 500, response.body);
});
