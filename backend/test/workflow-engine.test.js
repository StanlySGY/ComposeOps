import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-workflow-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const {
  createDefinition, updateDefinition, listDefinitions, getDefinition, removeDefinition,
  startWorkflow, getInstance, approveInstance, cancelInstance, evaluateCondition,
} = await import('../src/services/workflow-engine.js');

test('workflow: 条件表达式正确解析根上下文与字面量', () => {
  assert.equal(evaluateCondition('context.verified == true', { verified: true }), true);
  assert.equal(evaluateCondition('context.retryCount >= 2', { retryCount: 3 }), true);
  assert.equal(evaluateCondition('service == "api"', { service: 'api' }), true);
  assert.equal(evaluateCondition('context.verified == false', { verified: true }), false);
});

test('workflow: 创建定义并校验节点', () => {
  const definition = createDefinition({
    name: '故障处理',
    description: '自动诊断与审批',
    nodes: [
      { id: 'trigger', type: 'trigger', config: {} },
      { id: 'agent', type: 'agent', config: { prompt: '分析日志' } },
      { id: 'approval', type: 'approval', config: {} },
      { id: 'action', type: 'action', config: { action: 'restart' } },
    ],
  });
  assert.ok(definition.id);
  assert.equal(definition.nodes.length, 4);
  assert.ok(listDefinitions().some((d) => d.id === definition.id));
});

test('workflow: 非法节点类型被拒绝', () => {
  assert.throws(() => createDefinition({ name: 'bad', nodes: [{ id: 'x', type: 'unknown' }] }), /未知节点类型/);
});

test('workflow: 启动实例,审批前停在 waiting_approval', async () => {
  const definition = createDefinition({
    name: '审批流',
    nodes: [
      { id: 'trigger', type: 'trigger', config: {} },
      { id: 'approval', type: 'approval', config: {} },
      { id: 'action', type: 'action', config: { action: 'deploy' } },
    ],
  });
  const instance = startWorkflow(definition.id, { project: 'web' });
  assert.ok(instance.id);
  // 等待异步执行到 approval 节点
  await new Promise((resolve) => setTimeout(resolve, 50));
  const pending = getInstance(instance.id);
  assert.equal(pending.status, 'waiting_approval');
  assert.ok(pending.steps.some((step) => step.nodeType === 'approval' && step.status === 'waiting_approval'));
});

test('workflow: 审批通过后继续执行到完成', async () => {
  const definition = createDefinition({
    name: '审批流2',
    nodes: [
      { id: 'trigger', type: 'trigger', config: {} },
      { id: 'approval', type: 'approval', config: {} },
      { id: 'verify', type: 'verify', config: {} },
    ],
  });
  const instance = startWorkflow(definition.id, {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  const pending = getInstance(instance.id);
  assert.equal(pending.status, 'waiting_approval');

  const approved = approveInstance(instance.id, { approved: true, note: '同意' });
  assert.equal(approved.status, 'running');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const done = getInstance(instance.id);
  assert.equal(done.status, 'success');
  assert.ok(done.steps.some((step) => step.nodeType === 'verify' && step.status === 'success'));
});

test('workflow: 等待审批期间工作流定义变化时拒绝旧意图授权', async () => {
  const definition = createDefinition({
    name: '审批意图冻结',
    nodes: [
      { id: 'trigger', type: 'trigger', config: {} },
      { id: 'approval', type: 'approval', config: {} },
      { id: 'action', type: 'action', config: { action: 'restart', projectId: 'project-a' } },
    ],
  });
  const instance = startWorkflow(definition.id, {});
  await new Promise((resolve) => setTimeout(resolve, 60));

  const pending = getInstance(instance.id);
  assert.equal(pending.status, 'waiting_approval');
  assert.deepEqual(pending.context.pendingApprovalIntent.actionIntent, {
    actionNodeId: 'action', action: 'restart', projectId: 'project-a',
  });
  const approvalStep = pending.steps.find((step) => step.nodeId === 'approval');
  assert.deepEqual(approvalStep.output.approvalIntent, pending.context.pendingApprovalIntent);

  updateDefinition(definition.id, {
    nodes: [
      { id: 'trigger', type: 'trigger', config: {} },
      { id: 'approval', type: 'approval', config: {} },
      { id: 'action', type: 'action', config: { action: 'stop', projectId: 'project-b' } },
    ],
  });

  assert.throws(
    () => approveInstance(instance.id, { approved: true, note: '旧动作审批' }),
    (error) => error.statusCode === 409 && error.code === 'WORKFLOW_APPROVAL_STALE',
  );
  const stillPending = getInstance(instance.id);
  assert.equal(stillPending.status, 'waiting_approval');
  assert.equal(stillPending.context.workflowApprovals, undefined);
  assert.equal(stillPending.steps.some((step) => step.nodeType === 'action'), false);
  cancelInstance(instance.id);
});

test('workflow: 拒绝审批则取消', async () => {
  const definition = createDefinition({
    name: '审批流3',
    nodes: [
      { id: 'trigger', type: 'trigger', config: {} },
      { id: 'approval', type: 'approval', config: {} },
    ],
  });
  const instance = startWorkflow(definition.id, {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  const cancelled = approveInstance(instance.id, { approved: false });
  assert.equal(cancelled.status, 'cancelled');
});

test('workflow: condition true 分支只执行可达节点', async () => {
  const definition = createDefinition({
    name: '条件真分支',
    nodes: [
      { id: 'trigger', type: 'trigger', next: 'condition', config: {} },
      { id: 'condition', type: 'condition', onTrue: 'true-node', onFalse: 'false-node', config: { expression: 'context.enabled == true' } },
      { id: 'false-node', type: 'verify', next: 'end', config: {} },
      { id: 'true-node', type: 'verify', next: 'end', config: {} },
      { id: 'end', type: 'trigger', config: {} },
    ],
  });
  const instance = startWorkflow(definition.id, { enabled: true });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const done = getInstance(instance.id);
  assert.equal(done.status, 'success');
  assert.ok(done.steps.some((step) => step.nodeId === 'true-node' && step.status === 'success'));
  assert.equal(done.steps.some((step) => step.nodeId === 'false-node'), false);
});

test('workflow: condition false 分支只执行可达节点', async () => {
  const definition = createDefinition({
    name: '条件假分支',
    nodes: [
      { id: 'trigger', type: 'trigger', next: 'condition', config: {} },
      { id: 'condition', type: 'condition', onTrue: 'true-node', onFalse: 'false-node', config: { expression: 'context.enabled == true' } },
      { id: 'true-node', type: 'verify', next: 'end', config: {} },
      { id: 'false-node', type: 'verify', next: 'end', config: {} },
      { id: 'end', type: 'trigger', config: {} },
    ],
  });
  const instance = startWorkflow(definition.id, { enabled: false });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const done = getInstance(instance.id);
  assert.equal(done.status, 'success');
  assert.ok(done.steps.some((step) => step.nodeId === 'false-node' && step.status === 'success'));
  assert.equal(done.steps.some((step) => step.nodeId === 'true-node'), false);
});

test('workflow: 取消后异步执行不得覆盖为 success', async () => {
  const definition = createDefinition({
    name: '立即取消',
    nodes: [
      { id: 'trigger', type: 'trigger', config: {} },
      { id: 'verify', type: 'verify', config: {} },
    ],
  });
  const instance = startWorkflow(definition.id, {});
  const cancelled = cancelInstance(instance.id);
  assert.equal(cancelled.status, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(getInstance(instance.id).status, 'cancelled');
});

test('workflow: 运行时循环失败且不改写此前成功步骤', async () => {
  const definition = createDefinition({
    name: '循环流',
    nodes: [
      { id: 'start', type: 'trigger', next: 'loop', config: {} },
      { id: 'loop', type: 'trigger', next: 'loop', config: {} },
    ],
  });
  const instance = startWorkflow(definition.id, {});
  await new Promise((resolve) => setTimeout(resolve, 80));
  const failed = getInstance(instance.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.steps.find((step) => step.nodeId === 'start')?.status, 'success');
  assert.equal(failed.steps.find((step) => step.nodeId === 'loop')?.status, 'success');
});

test('workflow: 拒绝重复节点 ID 与循环跳转', () => {
  assert.throws(() => createDefinition({
    name: '重复节点',
    nodes: [{ id: 'same', type: 'trigger', config: {} }, { id: 'same', type: 'trigger', config: {} }],
  }), /节点 ID 重复/);
  assert.throws(() => createDefinition({
    name: '无效跳转',
    nodes: [{ id: 'a', type: 'trigger', next: 'missing', config: {} }],
  }), /跳转目标不存在/);
});

test('workflow: 删除定义', () => {
  const definition = createDefinition({ name: '待删', nodes: [{ id: 't', type: 'trigger', config: {} }] });
  assert.ok(removeDefinition(definition.id));
  assert.equal(getDefinition(definition.id), null);
});

test('workflow: agent 节点接入 Agent 引擎(未配置 API Key 时优雅失败)', async () => {
  const definition = createDefinition({
    name: 'Agent分析流',
    nodes: [
      { id: 'trigger', type: 'trigger', config: {} },
      { id: 'agent', type: 'agent', config: { prompt: '分析当前项目状态' } },
    ],
  });
  const instance = startWorkflow(definition.id, {});
  // Agent initialization reads runtime context asynchronously; a fixed 500 ms
  // races cold startup when builds/browser tests are using the same machine.
  const deadline = Date.now() + 5000;
  let done = getInstance(instance.id);
  while (['running', 'pending'].includes(done.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    done = getInstance(instance.id);
  }
  // 未配置 AI API Key 时,agent 节点应优雅失败(而非崩溃),工作流标记为 failed。
  assert.equal(done.status, 'failed');
  const agentStep = done.steps.find((step) => step.nodeType === 'agent');
  assert.ok(agentStep);
  assert.equal(agentStep.status, 'failed');
});

test('workflow: Action 节点没有后端一次性审批凭证时必须失败关闭', async () => {
  const definition = createDefinition({
    name: '缺少审批的 Action',
    nodes: [
      { id: 'trigger', type: 'trigger', config: {} },
      { id: 'action', type: 'action', config: { action: 'restart', projectId: 'missing-managed-project' } },
    ],
  });
  const instance = startWorkflow(definition.id, {});
  await new Promise((resolve) => setTimeout(resolve, 80));
  const done = getInstance(instance.id);
  assert.equal(done.status, 'failed');
  assert.match(done.result.error, /缺少匹配且未使用的人工审批/);
  assert.equal(done.steps.some((step) => step.nodeId === 'action'), false);
});

test('workflow: 重复幂等键只创建一个工作流实例', async () => {
  const definition = createDefinition({
    name: '幂等启动',
    nodes: [
      { id: 'trigger', type: 'trigger', config: {} },
      { id: 'verify', type: 'verify', config: {} },
    ],
  });
  const idempotencyKey = 'workflow-test:stable-key';
  const first = startWorkflow(definition.id, {}, { idempotencyKey });
  const replay = startWorkflow(definition.id, {}, { idempotencyKey });
  assert.equal(replay.id, first.id);
  assert.equal(replay.replayed, true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(getInstance(first.id).status, 'success');
});

test('workflow: event trigger 必须明确指定事件类型，cron trigger 必须填写合法表达式', () => {
  assert.throws(
    () => createDefinition({ name: 'Catch all forbidden', triggerType: 'event', triggerConfig: {}, nodes: [] }),
    /明确指定 eventTypes/,
  );
  assert.throws(
    () => createDefinition({ name: 'Cron missing', triggerType: 'cron', triggerConfig: {}, nodes: [] }),
    /填写 Cron 表达式/,
  );
  assert.throws(
    () => createDefinition({ name: 'Cron invalid', triggerType: 'cron', triggerConfig: { cron: 'not cron' }, nodes: [] }),
    /cron|字段|Cron/,
  );
});
