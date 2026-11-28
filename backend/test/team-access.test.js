import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { saveAccount, accountById, assertProjectGrant, authenticateAccount } from '../src/lib/accounts.js';
import { getDockerForHost } from '../src/services/docker-hosts.js';
import { scanProjects } from '../src/services/scanner.js';
import { setProjectPreference } from '../src/lib/db.js';
process.env.SERVE_FRONTEND = '0';
const docker = getDockerForHost('local');
const originalList = docker.listContainers;
const originalGet = docker.getContainer;
const containerId = 'a'.repeat(64), otherId = 'b'.repeat(64);
let writes = 0, running = true;
docker.listContainers = async () => [containerId, otherId].map((id,i) => ({ Id: id, Names: ['/team-' + i], State: 'running', Status: 'Up', Image: 'fixture:latest', Labels: { 'com.docker.compose.project': 'team-' + i, 'com.docker.compose.service': 'web', 'com.docker.compose.project.working_dir': '/synthetic/team-' + i }, HostConfig: {}, Ports: [] }));
docker.getContainer = id => ({ inspect: async () => ({ Id: id, Config: { Labels: { 'com.docker.compose.project': id === containerId ? 'team-0' : 'team-1' } }, State: { Running: running, Status: running ? 'running' : 'exited' } }), start: async () => { writes++; running = true; }, stop: async () => { writes++; running = false; }, restart: async () => { writes++; running = true; }, logs: async () => Buffer.from('API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa\nordinary log') });
const [project, other] = await scanProjects('local');
setProjectPreference(project.id, { managed: true }); setProjectPreference(other.id, { managed: true });
const app = await buildApp({ logger: false });
const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { password: 'test-admin-password' } });
const admin = { cookie: setup.headers['set-cookie'].split(';')[0] };
const grant = { hostId: 'local', projectId: project.id };
let operator = saveAccount({ username: 'operator', password: 'test-operator-password', role: 'operator', grants: [grant] }, 'admin');
const viewer = saveAccount({ username: 'viewer', password: 'test-viewer-password', role: 'viewer', grants: [grant] }, 'admin');
async function login(username, password) { const result = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } }); assert.equal(result.statusCode, 200, result.body); return { cookie: result.headers['set-cookie'].split(';')[0] }; }
const op = await login('operator', 'test-operator-password'), view = await login('viewer', 'test-viewer-password');
const actionUrl = (p = project.id, c = containerId, host = 'local') => '/api/v1/team/projects/' + host + '/' + encodeURIComponent(p) + '/containers/' + c + '/action';

test('team: legacy administrator survives migration; named users receive separate identities', async () => {
  for (const [headers, id] of [[admin, 'admin'], [op, operator.id], [view, viewer.id]]) { const res = await app.inject({ url: '/api/v1/auth/status', headers }); assert.equal(res.json().principal.id, id); }
  assert.equal(authenticateAccount('missing-user', 'test-viewer-password'), null);
});
test('team: every global API and websocket is denied to members, including Agent and credentials', async () => {
  for (const url of ['/api/v1/services/', '/api/v1/projects', '/api/v1/hosts', '/api/v1/ai/history', '/api/v1/system/ai-config', '/api/v1/ai/agent/tasks', '/api/v1/ai/agent/sessions/1/runs', '/ws/exec', '/ws/events', '/api/v1/new-future-route']) {
    const res = await app.inject({ url, headers: op }); assert.equal(res.statusCode, 403, url + ': ' + res.body);
  }
  for (const url of ['/api/v1/team/accounts', '/api/v1/team/catalog', '/api/v1/team/audit']) assert.equal((await app.inject({ url, headers: op })).statusCode, 403);
  assert.equal((await app.inject({ url: '/health', headers: op })).json().hosts, undefined);
});
test('team: list omits unauthorized projects and secrets; direct id tampering is rejected', async () => {
  const list = await app.inject({ url: '/api/v1/team/projects', headers: op }); assert.equal(list.statusCode, 200); assert.equal(list.json().projects.length, 1); assert.equal(list.json().projects[0].id, project.id); assert.doesNotMatch(list.body, /workingDir|composeFile|team-1/);
  for (const url of [actionUrl(other.id, otherId), actionUrl(project.id, otherId), actionUrl(project.id, containerId, 'different-host')]) {
    const response = await app.inject({ method: 'POST', url, headers: op, payload: { action: 'restart', confirmContainerId: url.includes(otherId) ? otherId : containerId } }); assert.ok([403,404].includes(response.statusCode), response.body);
  }
  assert.equal(writes, 0);
});
test('team: viewers cannot mutate, operators require exact target confirmation, action postcondition is reported', async () => {
  assert.equal((await app.inject({ method: 'POST', url: actionUrl(), headers: view, payload: { action: 'restart', confirmContainerId: containerId } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: actionUrl(), headers: op, payload: { action: 'restart', confirmContainerId: 'wrong' } })).statusCode, 400);
  const result = await app.inject({ method: 'POST', url: actionUrl(), headers: op, payload: { action: 'stop', confirmContainerId: containerId } }); assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().ok, true); assert.equal(writes, 1); assert.equal(running, false);
  const logs = await app.inject({ url: actionUrl().replace('/action', '/logs'), headers: view }); assert.equal(logs.statusCode, 200, logs.body); assert.match(logs.body, /ordinary log/); assert.doesNotMatch(logs.body, /sk-aaaa/);
});
test('team: passwords and grants are not mass assignable via auth; origin checks still apply', async () => {
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/team/accounts', headers: { ...admin, origin: 'https://attacker.example' }, payload: { username: 'attacker', role: 'admin', grants: [], password: 'test-attacker-password' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: op, payload: { currentPassword: 'test-admin-password', nextPassword: 'replacement-password' } })).statusCode, 400);
  assert.ok(authenticateAccount('operator', 'test-operator-password'));
});
test('team: revoking grants invalidates existing sessions and stale principals; stale saves cannot restore grants', async () => {
  const old = operator;
  operator = saveAccount({ ...operator, role: 'viewer', grants: [], enabled: true }, 'admin');
  assert.equal((await app.inject({ url: '/api/v1/team/projects', headers: op })).statusCode, 401);
  assert.throws(() => assertProjectGrant(old, 'local', project.id, true), /权限/);
  assert.throws(() => saveAccount({ ...old, grants: [grant] }, 'admin'), /已被更新/);
  const fresh = await login('operator', 'test-operator-password'); assert.deepEqual((await app.inject({ url: '/api/v1/team/projects', headers: fresh })).json().projects, []);
  saveAccount({ ...operator, enabled: false }, 'admin'); assert.equal(authenticateAccount('operator', 'test-operator-password'), null); assert.equal(accountById(operator.id).enabled, false);
});
test.after(async () => { await app.close(); docker.listContainers = originalList; docker.getContainer = originalGet; });
