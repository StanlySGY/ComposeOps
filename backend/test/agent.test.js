import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-agent-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const {
  getAgent,
  validateParams,
  assertPermission,
  RISK_LEVELS,
  AGENT_ROLES,
} = await import('../src/services/agent.js');
const {
  createAgentPlan,
  getAgentPlan,
  updateAgentPlan,
  recordAgentExecution,
  updateAgentExecution,
  listAgentExecutions,
  recordAgentFeedback,
  listAgentFeedback,
  addPerformanceBaseline,
  listPerformanceBaselines,
} = await import('../src/lib/db.js');
const { observeAgentAlertState, readAgentAlertRules } = await import('../src/services/alert-monitor.js');

test('agent: 注册 64 个工具并暴露元数据(含风险等级)', () => {
  const agent = getAgent();
  const tools = agent.listTools();
  assert.equal(tools.length, 64);
  const names = new Set(tools.map((tool) => tool.name));
  for (const expected of [
    'compose.up', 'compose.restart', 'config.edit', 'diagnostic.probe', 'maintenance.clean', 'metrics.query',
    'compose.scale', 'compose.exec', 'config.rollback', 'config.diff', 'environment.get', 'environment.set',
    'network.inspect', 'security.audit', 'volume.mount', 'backup.trigger', 'notification.test', 'cron.create', 'performance.baseline',
    'project.list_managed', 'web.search', 'memory.search', 'memory.save', 'memory.delete', 'memory.sleep', 'config.inspect', 'config.propose', 'server.inspect', 'server.command', 'app.list', 'app.deploy', 'cron.list',
    'inspection.run', 'inspection.status', 'gitops.drift', 'task.list', 'task.output', 'task.stop', 'database.probe',
    'volume.backup', 'volume.restore', 'volume.verify', 'volume.list_backups', 'event.list', 'event.update', 'event.diagnose',
    'skill.list', 'skill.use',
  ]) {
    assert.ok(names.has(expected), `缺少工具 ${expected}`);
  }
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(typeof tool.requiredPermission, 'string');
    assert.equal(typeof tool.confirmationRequired, 'boolean');
    assert.equal(typeof tool.risk, 'string');
  }
  assert.ok(tools.find((tool) => tool.name === 'config.edit').confirmationRequired);
  assert.ok(tools.find((tool) => tool.name === 'compose.logs').confirmationRequired === false);
  assert.equal(tools.find((tool) => tool.name === 'maintenance.clean').risk, 'critical');
  assert.equal(tools.find((tool) => tool.name === 'volume.restore').risk, 'critical');
});

test('agent: 风险等级与多角色元数据可用', () => {
  assert.equal(RISK_LEVELS['maintenance.clean'], 'critical');
  assert.equal(RISK_LEVELS['compose.restart'], 'medium');
  assert.equal(RISK_LEVELS['database.probe'], 'low');
  assert.equal(typeof AGENT_ROLES.planner, 'object');
  assert.deepEqual(AGENT_ROLES.validator.allowedTools.includes('compose.ps'), true);
});

test('agent: 参数校验只拦截必填缺失与数组类型错误', () => {
  const schema = {
    type: 'object',
    properties: { projectId: { type: 'string' }, services: { type: 'array' } },
    required: ['projectId'],
  };
  assert.throws(() => validateParams(schema, {}), /projectId/);
  assert.throws(() => validateParams(schema, { projectId: 'p1', services: 'web' }), /services/);
  assert.doesNotThrow(() => validateParams(schema, { projectId: 'p1', services: ['web'] }));
});

test('agent: 权限门阻止未纳管/不可编辑项目', async () => {
  await assert.doesNotReject(() => assertPermission({ requiredPermission: 'readonly', requiresProject: false }, { project: null }));
  await assert.rejects(
    () => assertPermission({ requiredPermission: 'managed', requiresProject: true }, { project: { managed: false } }),
    /尚未加入管理/,
  );
  await assert.rejects(
    () => assertPermission({ requiredPermission: 'editable', requiresProject: true }, { project: { managed: true, editable: false } }),
    /未启用可编辑/,
  );
  await assert.doesNotReject(() => assertPermission({ requiredPermission: 'editable', requiresProject: true }, { project: { managed: true, editable: true } }));
});

test('agent: 计划与执行记录持久化回环', () => {
  const planId = createAgentPlan(0, '重启服务', { steps: [{ tool: 'compose.restart' }], confirmations: [] });
  assert.ok(planId.startsWith('plan-'));
  assert.equal(getAgentPlan(planId).status, 'pending');
  const updated = updateAgentPlan(planId, { status: 'completed', resultJson: { results: [] } });
  assert.equal(updated.status, 'completed');

  const execId = recordAgentExecution(planId, 'compose.restart', { projectId: 'p1' });
  assert.ok(execId.startsWith('exec-'));
  const done = updateAgentExecution(execId, { status: 'success', result: { ok: true }, durationMs: 12 });
  assert.equal(done.status, 'success');
  assert.equal(listAgentExecutions(planId).length, 1);
});

test('agent: 反馈与性能基线持久化', () => {
  const planId = createAgentPlan(0, '扩容 web 服务', { steps: [{ tool: 'compose.scale' }], confirmations: [] });
  const rated = recordAgentFeedback(planId, 4, '执行符合预期');
  assert.equal(rated.rating, 4);
  assert.equal(rated.feedback_text, '执行符合预期');
  assert.equal(listAgentFeedback(10).some((item) => item.id === planId), true);

  const baselineId = addPerformanceBaseline('基线 A', { capturedAt: new Date().toISOString(), snapshot: [] });
  assert.ok(Number.isInteger(baselineId));
  assert.equal(listPerformanceBaselines(10).some((item) => item.id === baselineId), true);
});

test('agent threshold alerts trigger on a new incident and re-arm only after recovery', () => {
  const rule = { id: 'threshold-debounce-1', projectId: 'project-a', threshold: 80 };
  assert.equal(observeAgentAlertState(rule, 'container-a', 95), false, 'one spike does not trigger an alert');
  assert.equal(observeAgentAlertState(rule, 'container-a', 91), true, 'two consecutive high samples open an incident');
  assert.equal(observeAgentAlertState(rule, 'container-a', 99), false, 'sustained high values do not repeat the alert');
  assert.equal(observeAgentAlertState(rule, 'container-a', 10), false, 'one normal sample does not clear the incident');
  assert.equal(observeAgentAlertState(rule, 'container-a', 99), false, 'one dip cannot re-arm the alert');
  assert.equal(observeAgentAlertState(rule, 'container-a', 10), false);
  assert.equal(observeAgentAlertState(rule, 'container-a', 10), false, 'second normal sample clears the incident');
  assert.equal(observeAgentAlertState(rule, 'container-a', 95), false);
  assert.equal(observeAgentAlertState(rule, 'container-a', 96), true, 'a recovered rule can trigger a new incident');

  const editedRule = { ...rule, threshold: 95 };
  assert.equal(observeAgentAlertState(editedRule, 'container-a', 98), false, 'editing the threshold resets old incident state');
  assert.equal(observeAgentAlertState(editedRule, 'container-a', 99), true, 'the edited rule requires fresh consecutive samples');
});

test('agent threshold alerts isolate containers and ignore invalid samples', () => {
  const rule = { id: 'threshold-debounce-2', projectId: 'project-a', threshold: 5 };
  assert.equal(observeAgentAlertState(rule, 'container-a', 10), false);
  assert.equal(observeAgentAlertState(rule, 'container-a', Number.NaN), false, 'invalid readings do not count');
  assert.equal(observeAgentAlertState(rule, 'container-a', 10), true);
  assert.equal(observeAgentAlertState(rule, 'container-b', 10), false);
  assert.equal(observeAgentAlertState(rule, 'container-b', 10), true, 'containers have independent incident state');
});

test('agent: 告警规则读取与工具 undo 能力', async () => {
  const { setSetting } = await import('../src/lib/db.js');
  setSetting('agent.alert_rules', JSON.stringify([{ id: 'r1', metric: 'cpu' }]));
  const rules = readAgentAlertRules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'r1');

  const agent = getAgent();
  assert.equal(typeof agent.getTool('config.edit').undo, 'function');
  assert.equal(typeof agent.getTool('environment.set').undo, 'function');
  assert.equal(typeof agent.getTool('volume.mount').undo, 'function');
  assert.equal(typeof agent.getTool('alert.create').undo, 'function');
  assert.equal(agent.getTool('compose.ps').undo, undefined);
});
