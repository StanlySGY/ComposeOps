import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentPolicyGroup,
  updateAgentPolicyGroup,
  deleteAgentPolicyGroup,
  createAgentPolicyRule,
  updateAgentPolicyRule,
  deleteAgentPolicyRule,
  evaluateAgentPolicy,
  listAgentPolicyRules,
  recordAgentAuditEvent,
  listAgentAuditEvents,
  fingerprintAgentParams,
} from '../src/services/agent/policy-store.js';
import { createAgentPlan, recordAgentExecution, listAgentExecutions } from '../src/lib/db.js';

test('agent policy store: deny wins over allow regardless of priority, using exact tool/project/parameter matching', () => {
  const allowGroup = createAgentPolicyGroup({ name: 'policy test allow', description: 'allow set' });
  const denyGroup = createAgentPolicyGroup({ name: 'policy test deny', description: 'deny set' });
  const allow = createAgentPolicyRule({
    groupId: allowGroup.id, name: 'broad non-critical allow', effect: 'allow',
    priority: -1000, toolName: '*', projectId: '*', parameters: {}, reason: 'explicit allow',
  });
  const deny = createAgentPolicyRule({
    groupId: denyGroup.id, name: 'production delete deny', effect: 'deny',
    priority: 1000, toolName: 'volume.delete', projectId: 'prod',
    parameters: { action: 'delete' }, reason: 'production resources are protected',
  });

  assert.equal(evaluateAgentPolicy({
    toolName: 'volume.delete', projectId: 'prod', params: { projectId: 'prod', action: 'delete' },
  }).decision, 'deny', '拒绝优先级应高于更靠前的 allow');
  assert.equal(evaluateAgentPolicy({
    toolName: 'volume.delete', projectId: 'prod', params: { projectId: 'prod', action: 'inspect' },
  }).ruleId, allow.id, '参数子集值不匹配时应继续判断后续规则');
  assert.equal(evaluateAgentPolicy({
    toolName: 'volume.delete', projectId: 'staging', params: { projectId: 'staging', action: 'delete' },
  }).ruleId, allow.id, '项目 ID 必须精确匹配');
  assert.equal(evaluateAgentPolicy({
    toolName: 'compose.ps', projectId: 'prod', params: {},
  }).decision, 'allow');

  updateAgentPolicyRule(deny.id, { enabled: false });
  assert.equal(evaluateAgentPolicy({
    toolName: 'volume.delete', projectId: 'prod', params: { projectId: 'prod', action: 'delete' },
  }).decision, 'allow');
  updateAgentPolicyGroup(allowGroup.id, { enabled: false });
  assert.equal(evaluateAgentPolicy({
    toolName: 'volume.delete', projectId: 'prod', params: { projectId: 'prod', action: 'delete' },
  }).decision, 'no_match', '停用策略组必须一并停用其中的规则');
  assert.equal(listAgentPolicyRules({ groupId: denyGroup.id }).length, 1);
  assert.equal(deleteAgentPolicyRule(deny.id), true);
  assert.equal(deleteAgentPolicyGroup(denyGroup.id), true);
  assert.equal(deleteAgentPolicyGroup(allowGroup.id), true);
});

test('agent policy store: refuses sensitive matcher keys and secret-like values', () => {
  const group = createAgentPolicyGroup({ name: 'policy validation group' });
  assert.throws(() => createAgentPolicyRule({
    groupId: group.id, name: 'secret field', effect: 'deny', parameters: { password: 'secret' },
  }), /敏感字段/);
  assert.throws(() => createAgentPolicyRule({
    groupId: group.id, name: 'secret value', effect: 'deny', parameters: { command: 'sk-ABCDEFGHIJKLMNOPQRSTUV123456' },
  }), /凭据/);
  assert.throws(() => createAgentPolicyRule({
    groupId: group.id, name: 'invalid wildcard', effect: 'deny', toolName: 'compose.*',
  }), /完整工具名/);
  assert.equal(deleteAgentPolicyGroup(group.id), true);
});

test('agent policy store: audit events are append-only, linked to plans and redact sensitive details', () => {
  const planId = createAgentPlan(null, 'policy audit test', { steps: [] }, null, null);
  const firstId = recordAgentAuditEvent({
    planId, eventType: 'policy_decision', actor: 'policy-engine', toolName: 'compose.ps',
    decision: 'deny', reason: 'blocked by policy', parametersHash: 'a'.repeat(64),
    details: { password: 'should-not-be-stored', projectId: 'prod' },
  });
  recordAgentAuditEvent({
    planId, executionId: 'exec-policy-test', eventType: 'execution_blocked',
    actor: 'policy-engine', toolName: 'compose.ps', decision: 'denied', reason: 'blocked by policy',
  });
  const events = listAgentAuditEvents({ planId, limit: 10 });
  assert.equal(events.length, 2);
  assert.equal(events[0].id, firstId);
  assert.equal(events[0].decision, 'deny');
  assert.equal(events[0].parametersHash, 'a'.repeat(64));
  assert.equal(JSON.stringify(events).includes('should-not-be-stored'), false);
  assert.equal(JSON.stringify(events).includes('[REDACTED]'), true);
  assert.equal(listAgentAuditEvents({ executionId: 'exec-policy-test' }).length, 1);
});

test('agent policy store: execution and audit parameter fingerprints use the same canonical serialization', () => {
  const planId = createAgentPlan(null, 'canonical fingerprint test', { steps: [] });
  const params = { zeta: 9, action: 'inspect', nested: { y: true, x: 'ok' } };
  const executionId = recordAgentExecution(planId, 'resource.inspect', params, 'pending');
  const execution = listAgentExecutions(planId).find((item) => item.id === executionId);
  const expected = fingerprintAgentParams(params);
  assert.equal(execution.parameters_hash, expected);

  recordAgentAuditEvent({ planId, executionId, eventType: 'policy_decision', toolName: 'resource.inspect', parametersHash: expected });
  assert.equal(listAgentAuditEvents({ executionId })[0].parametersHash, execution.parameters_hash);
});
