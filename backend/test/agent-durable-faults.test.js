import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createAiSession } from '../src/lib/db.js';
import { requestWithAiChannels } from '../src/services/ai-channels.js';
import { OperationsAgent } from '../src/services/agent/engine.js';
import { startAgentRun } from '../src/services/agent/runs.js';
import { runEffects } from '../src/services/agent/run-store.js';
import { upsertHost, deleteHost } from '../src/services/docker-hosts.js';
const cases = [];
test('fault: actual stalled HTTP model request times out and detached run records failure without writes', async () => {
  let received = false;
  const server = createServer(() => { received = true; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const started = Date.now(), keeper = setTimeout(() => {}, 5000);
  try {
    const agent = { async executeWithLoop() {
      return requestWithAiChannels({ channels: [{ id: 'timeout', name: 'timeout', model: 'fixture', apiKey: 'fake', baseUrl: `http://127.0.0.1:${server.address().port}`, firstTokenTimeoutMs: 200 }], totalTimeoutMs: 250, failoverEnabled: false }, options => fetch(options.baseUrl, { signal: options.signal }));
    } };
    const task = startAgentRun('模型超时验收', { sessionId: createAiSession(), hostId: 'local' }, 'admin', null, agent);
    const done = await task.finished;
    assert.equal(received, true); assert.equal(done.status, 'failed'); assert.equal(runEffects(task.run.id).length, 0); assert.ok(Date.now() - started < 5000);
    cases.push({ id: 'stalled-model-http', passed: true, durationMs: Date.now() - started, status: done.status, writes: 0, usage: null });
  } finally { clearTimeout(keeper); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('fault: offline Docker node rejects real Agent preflight without persisting a write intent', async () => {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const host = upsertHost({ name: 'offline acceptance', type: 'tcp', host: '127.0.0.1', port });
  const started = Date.now(), engine = new OperationsAgent();
  try {
    const agent = { async executeWithLoop(_message, context) { return engine.executeTool('compose.restart', { hostId: host.id, projectId: 'unreachable-project' }, context); } };
    const task = startAgentRun('离线节点验收', { sessionId: createAiSession(), hostId: host.id }, 'admin', null, agent);
    const done = await task.finished;
    assert.equal(done.status, 'failed'); assert.equal(runEffects(task.run.id).length, 0);
    cases.push({ id: 'offline-docker-node', passed: true, durationMs: Date.now() - started, status: done.status, writes: 0, usage: null });
  } finally { deleteHost(host.id); }
});
test.after(() => { if (process.env.FAULT_REPORT) fs.writeFileSync(process.env.FAULT_REPORT, JSON.stringify({ scope: 'local HTTP timeout and offline Docker; no production model or resources', cases }, null, 2)); });
