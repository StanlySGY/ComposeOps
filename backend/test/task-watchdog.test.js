import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import test from 'node:test';

const db = await import('../src/lib/db.js');
const { createDefinition, getInstance } = await import('../src/services/workflow-engine.js');
const { runTaskWatchdogOnce, markInterruptedAgentPlansUnknown } = await import('../src/services/task-watchdog.js');const { initializeBackgroundTasks } = await import('../src/services/agent/background-tasks.js');

test('startup recovery marks interrupted Agent execution plans outcome_unknown without replay', () => {
  const planId = db.createAgentPlan(77, 'stale plan', { steps: [{ tool: 'compose.restart' }] });
  db.updateAgentPlan(planId, { status: 'executing', progressStage: 'Tool Loop 执行中' });
  const pendingId = db.createAgentPlan(77, 'awaiting approval', { steps: [] });
  db.updateAgentPlan(pendingId, { status: 'pending_confirmation' });

  const marked = markInterruptedAgentPlansUnknown();
  assert.ok(marked.includes(planId));
  assert.equal(db.getAgentPlan(planId).status, 'outcome_unknown');
  assert.match(db.getAgentPlan(planId).progress_stage, /结果待核对/);
  assert.equal(db.getAgentPlan(pendingId).status, 'pending_confirmation');
});

test('task watchdog marks a stale Agent background task outcome_unknown without replay', () => {
  const task = db.createAgentBackgroundTask({
    id: 'agt-watchdog-stale',
    sessionId: 7,
    projectId: 'project-a',
    hostId: 'host-a',
    taskType: 'compose.up',
    label: 'stale compose up',
  });
  const stale = '2026-11-01T00:00:00.000Z';
  db.updateAgentBackgroundTask(task.id, { status: 'running', startedAt: stale, heartbeatAt: stale });

  const result = runTaskWatchdogOnce({
    now: Date.parse('2026-11-02T00:00:00.000Z'),
    staleMs: 30000,
  });

  assert.equal(result.tasksMarkedUnknown, 1);
  const saved = db.getAgentBackgroundTask(task.id);
  assert.equal(saved.status, 'outcome_unknown');
  assert.match(saved.error, /不会重放 Docker 副作用/);
});

test('startup recovery fails queued tasks that never started and preserves unknown outcomes for running tasks', () => {
  const queued = db.createAgentBackgroundTask({ id: 'agt-startup-queued', taskType: 'compose.up', label: 'queued deploy' });
  const running = db.createAgentBackgroundTask({ id: 'agt-startup-running', taskType: 'compose.restart', label: 'running restart' });
  db.updateAgentBackgroundTask(running.id, { status: 'running' });
  const recovered = initializeBackgroundTasks();
  assert.ok(recovered.includes(queued.id) && recovered.includes(running.id));
  assert.equal(db.getAgentBackgroundTask(queued.id).status, 'failed');
  assert.match(db.getAgentBackgroundTask(queued.id).error, /尚未开始执行/);
  assert.equal(db.getAgentBackgroundTask(running.id).status, 'outcome_unknown');
  assert.match(db.getAgentBackgroundTask(running.id).error, /核对 Docker 实际状态/);
});

test('task watchdog marks a stale running workflow and current step outcome_unknown', () => {
  const definition = createDefinition({
    name: 'Watchdog workflow',
    nodes: [{ id: 'trigger', type: 'trigger', config: {} }],
  });
  const instance = db.createWorkflowInstance({
    definitionId: definition.id,
    name: definition.name,
    status: 'running',
    context: {},
  });
  const stepId = db.addWorkflowStep({
    instanceId: instance.id,
    nodeId: 'action',
    nodeType: 'action',
    status: 'running',
    input: { action: 'restart' },
  });
  const stale = '2026-11-01T00:00:00.000Z';
  db.updateWorkflowInstance(instance.id, {
    currentNode: 'action',
    startedAt: stale,
    heartbeatAt: stale,
  });

  const result = runTaskWatchdogOnce({
    now: Date.parse('2026-11-02T00:00:00.000Z'),
    staleMs: 30000,
  });

  assert.equal(result.workflowsMarkedUnknown, 1);
  assert.equal(getInstance(instance.id).status, 'outcome_unknown');
  const step = db.getWorkflowInstance(instance.id).steps.find((item) => item.id === stepId);
  assert.equal(step.status, 'outcome_unknown');
});

test('task watchdog leaves fresh heartbeat tasks alone', () => {
  const task = db.createAgentBackgroundTask({
    id: 'agt-watchdog-fresh',
    taskType: 'compose.pull',
    label: 'fresh compose pull',
  });
  const now = Date.parse('2026-11-02T00:00:00.000Z');
  db.updateAgentBackgroundTask(task.id, {
    status: 'running',
    startedAt: new Date(now - 10000).toISOString(),
    heartbeatAt: new Date(now - 10000).toISOString(),
  });

  const result = runTaskWatchdogOnce({ now, staleMs: 30000 });
  assert.equal(result.tasksMarkedUnknown, 0);
  assert.equal(db.getAgentBackgroundTask(task.id).status, 'running');
});
