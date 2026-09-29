import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-agent-usage-route-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { buildApp } = await import('../src/app.js');
const { createAgentPlan, recordAgentFeedback, recordAiUsage } = await import('../src/lib/db.js');
const app = await buildApp({ logger: false });
await app.ready();

test.after(async () => {
  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('agent usage routes: authenticated summary and feedback samples are readable', async () => {
  recordAiUsage({ sessionId: 42, model: 'route-test-model', usage: { prompt_tokens: 8, completion_tokens: 3 } });
  const planId = createAgentPlan(42, '查看失败样本', { steps: [] });
  recordAgentFeedback(planId, 1, '需要补充证据');

  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin: 'http://localhost:3001', host: 'localhost:3001' },
    payload: { password: 'agent-usage-route-password' },
  });
  assert.equal(setup.statusCode, 200);
  const cookie = String(setup.headers['set-cookie']).split(';', 1)[0];
  const headers = { cookie, origin: 'http://localhost:3001', host: 'localhost:3001' };

  const usage = await app.inject({ method: 'GET', url: '/api/v1/ai/agent/usage?days=1', headers });
  assert.equal(usage.statusCode, 200);
  assert.deepEqual(usage.json().totals, {
    calls: 1,
    sessions: 1,
    prompt_tokens: 8,
    completion_tokens: 3,
    total_tokens: 11,
  });

  const feedback = await app.inject({ method: 'GET', url: '/api/v1/ai/agent/feedback?limit=10', headers });
  assert.equal(feedback.statusCode, 200);
  assert.equal(feedback.json().feedback[0].id, planId);
  assert.equal(feedback.json().feedback[0].rating, 1);
});
