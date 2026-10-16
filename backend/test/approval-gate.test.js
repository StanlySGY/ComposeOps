import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovalGate, persistentPolicyMaySkipConfirmation } from '../src/services/agent/approval-gate.js';

test('approval gate: persistent allow can only bypass low/medium standalone tools', () => {
  assert.equal(persistentPolicyMaySkipConfirmation('allow', 'low'), true);
  assert.equal(persistentPolicyMaySkipConfirmation('allow', 'medium'), true);
  assert.equal(persistentPolicyMaySkipConfirmation('allow', 'high'), false);
  assert.equal(persistentPolicyMaySkipConfirmation('allow', 'critical'), false);
  assert.equal(persistentPolicyMaySkipConfirmation('deny', 'low'), false);
  assert.equal(persistentPolicyMaySkipConfirmation('no_match', 'low'), false);
  assert.equal(persistentPolicyMaySkipConfirmation('allow', 'low', true), false, '宏整体不能因为 allow 规则跳过确认');
  assert.equal(persistentPolicyMaySkipConfirmation('allow', 'low', false, true), false, '工具元数据明确要求确认时，持久 allow 也不能跳过');
});

test('approval gate: critical confirmation cannot be bypassed by session remember or full mode', () => {
  const gate = new ApprovalGate();
  assert.equal(gate.setMode('session-a', 'full'), true);
  assert.equal(gate.allowForSession('session-a', 'compose.stop', { projectId: 'p1' }, 'tool', 'low'), true);
  assert.equal(gate.needsConfirmation('session-a', 'compose.stop', { projectId: 'p1' }, 'critical', false), true);
  assert.equal(gate.allowForSession('session-a', 'compose.stop', { projectId: 'p1' }, 'tool', 'critical'), false);
});
