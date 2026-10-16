import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-agent-policy-routes-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { buildApp } = await import('../src/app.js');
const { createAgentPlan } = await import('../src/lib/db.js');
const { recordAgentAuditEvent } = await import('../src/services/agent/policy-store.js');
const app = await buildApp({ logger: false });
await app.ready();

test.after(async () => {
  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('agent policy routes: require authenticated session and support group/rule CRUD + audit read', async () => {
  const plainHeaders = { origin: 'http://localhost:3001', host: 'localhost:3001' };
  const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/ai/agent/policy-groups', headers: plainHeaders });
  assert.equal(unauthorized.statusCode, 401);

  const setup = await app.inject({
    method: 'POST', url: '/api/v1/auth/setup', headers: plainHeaders,
    payload: { password: 'policy-routes-test-password' },
  });
  assert.equal(setup.statusCode, 200);
  const cookie = String(setup.headers['set-cookie']).split(';', 1)[0];
  const headers = { ...plainHeaders, cookie };

  const initial = await app.inject({ method: 'GET', url: '/api/v1/ai/agent/policy-groups', headers });
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json().groups, []);

  const groupResponse = await app.inject({
    method: 'POST', url: '/api/v1/ai/agent/policy-groups', headers,
    payload: { name: 'Route test policies', description: 'route CRUD' },
  });
  assert.equal(groupResponse.statusCode, 200, groupResponse.body);
  const group = groupResponse.json().group;
  assert.equal(group.name, 'Route test policies');
  assert.equal(group.enabled, true);

  const ruleResponse = await app.inject({
    method: 'POST', url: '/api/v1/ai/agent/policy-rules', headers,
    payload: {
      groupId: group.id, name: 'Deny deleting prod', effect: 'deny',
      toolName: 'volume.delete', projectId: 'prod', parameters: { action: 'delete' },
      reason: 'Protect production resources',
    },
  });
  assert.equal(ruleResponse.statusCode, 200, ruleResponse.body);
  const rule = ruleResponse.json().rule;
  assert.equal(rule.effect, 'deny');
  assert.equal(rule.parameters.action, 'delete');

  const invalidRule = await app.inject({
    method: 'POST', url: '/api/v1/ai/agent/policy-rules', headers,
    payload: { groupId: group.id, name: 'Do not store password', effect: 'deny', parameters: { password: 'not-stored' } },
  });
  assert.equal(invalidRule.statusCode, 400);

  const groupDisabled = await app.inject({
    method: 'PATCH', url: `/api/v1/ai/agent/policy-groups/${encodeURIComponent(group.id)}`,
    headers, payload: { enabled: false },
  });
  assert.equal(groupDisabled.statusCode, 200);
  assert.equal(groupDisabled.json().group.enabled, false);

  const planId = createAgentPlan(7, 'audit route test', { steps: [] });
  recordAgentAuditEvent({
    planId, eventType: 'policy_decision', actor: 'policy-engine', toolName: 'volume.delete',
    decision: 'deny', reason: 'Protect production resources',
  });
  const audit = await app.inject({
    method: 'GET', url: `/api/v1/ai/agent/audit-events?planId=${encodeURIComponent(planId)}`, headers,
  });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json().events.length, 1);
  assert.equal(audit.json().events[0].planId, planId);

  const deleteRule = await app.inject({
    method: 'DELETE', url: `/api/v1/ai/agent/policy-rules/${encodeURIComponent(rule.id)}`, headers,
  });
  assert.equal(deleteRule.statusCode, 200);
  const deleteGroup = await app.inject({
    method: 'DELETE', url: `/api/v1/ai/agent/policy-groups/${encodeURIComponent(group.id)}`, headers,
  });
  assert.equal(deleteGroup.statusCode, 200);
});
