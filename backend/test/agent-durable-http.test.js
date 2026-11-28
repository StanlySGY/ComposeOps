import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { getAgent } from '../src/services/agent/engine.js';
import { getRun } from '../src/services/agent/run-store.js';
import { createAiSession, clearAiSession } from '../src/lib/db.js';
import { saveAccount } from '../src/lib/accounts.js';
process.env.SERVE_FRONTEND = '0';
const app = await buildApp({ logger: false });
const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { password: 'durable-http-password' } });
const cookie = setup.headers['set-cookie'].split(';')[0], base = await app.listen({ port: 0, host: '127.0.0.1' });
const agent = getAgent(), original = agent.executeWithLoop;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition) { for (let i = 0; i < 100; i++) { const value = condition(); if (value) return value; await wait(20); } throw new Error('Timed out'); }
async function open(sessionId) {
  const abort = new AbortController(); const response = await fetch(base + '/api/v1/ai/agent/execute-stream', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, message: '持久任务验收', durable: true, webSearchEnabled: false }), signal: abort.signal });
  assert.equal(response.status, 200); const reader = response.body.getReader(); let text = '';
  while (!text.includes('"runId"')) { const { value, done } = await reader.read(); assert.equal(done, false); text += new TextDecoder().decode(value); }
  const id = /"runId":"([^"]+)"/.exec(text)[1]; return { abort, reader, id };
}
test('HTTP: disconnect preserves task, refreshed approval resolves original plan and records result', async () => {
  let permissionResolved = false;
  agent.executeWithLoop = async (message, context, emit, signal) => {
    emit({ type: 'confirmation_required', tool: 'group.save', params: { name: '演示' }, executionId: context.planId, toolCallId: 'pending-call', risk: 'medium' });
    const result = await agent._waitForApproval(context.planId, 'pending-call', signal); permissionResolved = result.approved;
    emit({ type: 'tool_executing', tool: 'group.save' }); emit({ type: 'done', content: '已完成' }); return { success: result.approved, finalContent: '已完成' };
  };
  const sessionId = createAiSession(), connection = await open(sessionId); connection.abort.abort(); await connection.reader.cancel().catch(() => {});
  const run = await until(() => getRun(connection.id)?.approval && getRun(connection.id)); assert.equal(run.status, 'waiting_approval');
  assert.throws(() => clearAiSession(sessionId), /持久任务/);
  const reconnect = await app.inject({ url: '/api/v1/ai/agent/runs/' + run.id, headers: { cookie } }); assert.equal(reconnect.json().run.approval.toolCallId, 'pending-call');
  const response = await app.inject({ method: 'POST', url: '/api/v1/ai/agent/approve', headers: { cookie }, payload: { executionId: run.approval.executionId, toolCallId: 'pending-call', approved: true } });
  assert.equal(response.statusCode, 200, response.body); await until(() => getRun(run.id)?.status === 'completed'); assert.equal(permissionResolved, true);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/ai/agent/approve', headers: { cookie }, payload: { executionId: run.approval.executionId, toolCallId: 'pending-call', approved: true } })).statusCode, 404);
});
test('HTTP: explicit stop aborts pending approval, cannot silently detach', async () => {
  const connection = await open(createAiSession()); await until(() => getRun(connection.id)?.approval);
  const stopped = await app.inject({ method: 'POST', url: `/api/v1/ai/agent/runs/${connection.id}/stop`, headers: { cookie }, payload: {} }); assert.equal(stopped.statusCode, 200);
  await until(() => getRun(connection.id)?.status === 'interrupted'); connection.abort.abort(); await connection.reader.cancel().catch(() => {});
});
test('HTTP: existing administrator WebSocket is closed immediately when role revoked', async () => {
  const user = saveAccount({ username: 'namedadmin', password: 'durable-admin-password', role: 'admin', grants: [] }, 'admin');
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: user.username, password: 'durable-admin-password' } });
  const socket = await app.injectWS('/ws/events', { headers: { cookie: login.headers['set-cookie'].split(';')[0] } });
  const closed = new Promise(resolve => socket.once('close', resolve)); saveAccount({ ...user, role: 'viewer', grants: [] }, 'admin'); await closed;
  assert.equal(socket.readyState, 3);
});
test.after(async () => { agent.executeWithLoop = original; await app.close(); });
