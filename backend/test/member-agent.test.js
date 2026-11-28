import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { saveAccount } from '../src/lib/accounts.js';
import { getDockerForHost } from '../src/services/docker-hosts.js';
import { scanProjects } from '../src/services/scanner.js';
import db, { setSetting, setProjectPreference } from '../src/lib/db.js';
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
const _admin = { cookie: setup.headers['set-cookie'].split(';')[0] };
const grant = { hostId: 'local', projectId: project.id };
let operator = saveAccount({ username: 'operator', password: 'test-operator-password', role: 'operator', grants: [grant] }, 'admin');
const _viewer = saveAccount({ username: 'viewer', password: 'test-viewer-password', role: 'viewer', grants: [grant] }, 'admin');
async function login(username, password) { const result = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } }); assert.equal(result.statusCode, 200, result.body); return { cookie: result.headers['set-cookie'].split(';')[0] }; }
const op = await login('operator', 'test-operator-password'), view = await login('viewer', 'test-viewer-password');

const originalFetch = globalThis.fetch;
setSetting('ai.api_key', 'member-fixture-key'); setSetting('ai.base_url', 'http://member-model.test/v1');
let requested = 'compose.ps', captured = [];
function reply(payload) { return new Response('data: ' + JSON.stringify(payload) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }); }
globalThis.fetch = async (url, init) => {
 if (!String(url).startsWith('http://member-model.test')) return originalFetch(url, init);
 const body = JSON.parse(init.body); captured.push(body);
 const used = body.messages.some(m => m.role === 'tool');
 return reply({ choices: [{ delta: used ? { content: '诊断完成' } : { tool_calls: [{ index: 0, id: 'member-call', type: 'function', function: { name: requested, arguments: JSON.stringify(requested === 'compose.ps' ? {} : { containerId }) } }] }, finish_reason: used ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
};
const prefix = '/api/v1/team/agent/runs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function read(id, headers = op) { const response = await app.inject({ url: prefix + '/' + id, headers }); assert.equal(response.statusCode, 200, response.body); return response.json().run; }
async function until(id, condition, headers = op) { for (let i=0;i<150;i++) { const run = await read(id, headers); if (condition(run)) return run; await pause(20); } throw new Error('member run timeout'); }
async function start(headers = op, projectId = project.id) { const response = await app.inject({ method: 'POST', url: prefix, headers, payload: { hostId: 'local', projectId, message: '分析服务并按需重启' } }); return response; }
test('member Agent: isolated context, tools and ownership; no other project or global memory reaches model', async () => {
 db.prepare("INSERT INTO ai_memories(memory_key,value) VALUES('global','GLOBAL_PRIVATE_CANARY')").run();
 requested = 'compose.ps'; captured = [];
 const response = await start(); assert.equal(response.statusCode, 200, response.body); const run = await until(response.json().run.id, r => r.status === 'completed');
 assert.ok(captured.length >= 2); assert.doesNotMatch(JSON.stringify(captured), /GLOBAL_PRIVATE_CANARY|team-1|server.inspect|memory.search/);
 assert.ok(captured[0].tools.length <= 5); assert.equal(captured[0].max_tokens, 4096); assert.ok(run.checkpoint.budget.used > 0);
 assert.equal((await app.inject({ url: prefix + '/' + run.id, headers: view })).statusCode, 404);
 assert.equal((await start(op, other.id)).statusCode, 403);
});
test('member Agent: viewer injection cannot execute a write and visible catalog is readonly', async () => {
 requested = 'compose.restart'; captured = []; const before = writes;
 const response = await start(view); assert.equal(response.statusCode, 200, response.body); await until(response.json().run.id, r => r.status === 'completed', view);
 assert.equal(writes, before); assert.deepEqual(captured[0].tools.map(t=>t.function.name), ['compose.ps','compose.logs']);
});
test('member Agent: exact approval executes only owned container; global/macro tools are denied', async () => {
 requested = 'compose.restart'; const before = writes;
 const response = await start(); const run = await until(response.json().run.id, r => r.status === 'waiting_approval'); assert.equal(writes, before);
 const body = { executionId: run.approval.executionId, toolCallId: run.approval.toolCallId, approved: true };
 assert.equal((await app.inject({ method: 'POST', url: prefix+'/'+run.id+'/approve', headers: view, payload: body })).statusCode, 404);
 assert.equal((await app.inject({ method: 'POST', url: prefix+'/'+run.id+'/approve', headers: op, payload: body })).statusCode, 200);
 await until(run.id, r => r.status === 'completed'); assert.equal(writes, before+1);
 requested = 'macro.rollback'; const blocked = await start(); await until(blocked.json().run.id, r=>r.status==='completed'); assert.equal(writes, before+1);
});
test('member Agent: revocation invalidates waiting approval and resume without replay', async () => {
 requested = 'compose.restart'; const before = writes; const response = await start(); await until(response.json().run.id, r=>r.status==='waiting_approval');
 operator = saveAccount({ ...operator, grants: [] }, 'admin'); await pause(100); assert.equal(writes, before);
 assert.equal((await app.inject({ url: prefix+'/'+response.json().run.id, headers: op })).statusCode, 401);
 const fresh = await login('operator','test-operator-password'); assert.equal((await app.inject({ method: 'POST', url: prefix+'/'+response.json().run.id+'/resume', headers:fresh, payload: {revision:0} })).statusCode, 403);
});
test.after(async () => { globalThis.fetch = originalFetch; await app.close(); docker.listContainers = originalList; docker.getContainer = originalGet; });
