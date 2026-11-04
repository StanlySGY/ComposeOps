import { describe, expect, it } from 'vitest';
import {
  buildTaskTimeline,
  buildUnifiedTasks,
  eventMatchesTask,
  normalizeAgentPlan,
  normalizeTaskStatus,
  pendingAgentApprovals,
  taskMatchesFilter,
  timestampValue,
} from '../src/lib/ops-command-center.js';

describe('Autonomous Ops unified task model', () => {
  it('normalizes legacy Agent plan fields and outcome-unknown state without retry semantics', () => {
    const task = normalizeAgentPlan({
      id: 'plan-1',
      user_message: '只读检查项目状态',
      plan_json: JSON.stringify({ role: 'validator' }),
      status: 'outcome_unknown',
      session_id: 42,
      created_at: '2026-11-04 10:00:00',
    });
    expect(task).toMatchObject({
      id: 'agent-plan:plan-1',
      source: 'agent-plan',
      title: '只读检查项目状态',
      role: 'validator',
      status: 'outcome_unknown',
      sessionId: '42',
    });
    expect(normalizeTaskStatus('running')).toBe('running');
    expect(normalizeTaskStatus('waiting_approval')).toBe('waiting_approval');
  });

  it('merges existing sources and orders them by last activity', () => {
    const tasks = buildUnifiedTasks({
      plans: [{ id: 'p', user_message: 'Agent 检查', plan_json: '{"role":"planner"}', status: 'success', created_at: '2026-11-04 09:00:00' }],
      backgroundTasks: [{ id: 't', label: '后台拉取', status: 'running', startedAt: '2026-11-04T11:00:00Z' }],
      workflows: [{ id: 'w', name: '发布流程', status: 'waiting_approval', createdAt: '2026-11-04 10:00:00' }],
      jobs: [{ id: 'j', action: 'pull', status: 'success', createdAt: '2026-11-04 08:00:00', finishedAt: '2026-11-04 08:30:00' }],
    });
    expect(tasks.map((task) => task.source)).toEqual(['agent-task', 'workflow', 'agent-plan', 'batch-job']);
    expect(tasks[1].status).toBe('waiting_approval');
  });

  it('filters by source, canonical status, tab and searchable fields', () => {
    const task = normalizeAgentPlan({
      id: 'plan-2',
      user_message: '修复 content-factory 数据库',
      plan_json: '{"role":"executor"}',
      status: 'outcome_unknown',
      project_id: 'cf-1',
      created_at: '2026-11-04 10:00:00',
    });
    expect(taskMatchesFilter(task, { tab: 'review' })).toBe(true);
    expect(taskMatchesFilter(task, { status: 'failed' })).toBe(false);
    expect(taskMatchesFilter(task, { source: 'agent-plan', query: 'content-factory' })).toBe(true);
    expect(taskMatchesFilter(task, { tab: 'approvals' })).toBe(false);
    expect(taskMatchesFilter({ ...task, status: 'failed' }, { tab: 'review' })).toBe(true);
  });

  it('only joins events by explicit source identifiers, never by timestamp proximity', () => {
    const task = {
      id: 'workflow:w1', source: 'workflow', sourceId: 'w1', payload: { id: 'w1' }, createdAt: '2026-11-04 10:00:00',
      sourceLabel: '工作流', status: 'success',
    };
    expect(eventMatchesTask({ id: 1, payload: { instanceId: 'w1' } }, task)).toBe(true);
    expect(eventMatchesTask({ id: 2, payload: { instanceId: 'other' } }, task)).toBe(false);
    const timeline = buildTaskTimeline(task, {
      events: [
        { id: 1, payload: { instanceId: 'w1' }, title: '同一实例事件', createdAt: '2026-11-04 10:02:00' },
        { id: 2, payload: { instanceId: 'other' }, title: '无关事件', createdAt: '2026-11-04 10:02:01' },
      ],
      workflowDetail: { steps: [{ id: 11, nodeId: 'approval', nodeType: 'approval', status: 'success', startedAt: '2026-11-04 10:00:30', finishedAt: '2026-11-04 10:01:00' }] },
    });
    expect(timeline.map((entry) => entry.label)).toContain('同一实例事件');
    expect(timeline.map((entry) => entry.label)).not.toContain('无关事件');
    expect(timeline.map((entry) => entry.label)).toContain('approval');
  });

  it('associates project operations only when explicit project identity matches', () => {
    const task = { id: 'agent-plan:p', source: 'agent-plan', sourceId: 'p', projectId: 'cf-1', createdAt: '2026-11-04 10:00:00', sourceLabel: 'Agent 计划' };
    const timeline = buildTaskTimeline(task, {
      operations: [
        { id: 1, projectId: 'cf-1', action: 'restart', createdAt: '2026-11-04 10:01:00' },
        { id: 2, projectId: 'other', action: 'stop', createdAt: '2026-11-04 10:01:01' },
      ],
    });
    expect(timeline.map((entry) => entry.label)).toContain('restart');
    expect(timeline.map((entry) => entry.label)).not.toContain('stop');
  });

  it('keeps an approval pending only until an explicit decision or execution result is recorded', () => {
    const audits = [
      { executionId: 'e1', planId: 'p1', eventType: 'approval_requested', createdAt: '2026-11-04 10:00:00' },
      { executionId: 'e2', planId: 'p2', eventType: 'approval_requested', createdAt: '2026-11-04 10:00:00' },
      { executionId: 'e2', planId: 'p2', eventType: 'approval_decision', decision: 'approved', createdAt: '2026-11-04 10:01:00' },
      { executionId: 'e3', planId: 'p3', eventType: 'approval_requested', createdAt: '2026-11-04 10:00:00' },
      { executionId: 'e3', planId: 'p3', eventType: 'execution_completed', createdAt: '2026-11-04 10:01:00' },
    ];
    expect(pendingAgentApprovals(audits).map((item) => item.executionId)).toEqual(['e1']);
  });

  it('parses SQLite timestamps and Unix seconds consistently', () => {
    expect(timestampValue('2026-11-04 10:00:00')).toBe(Date.parse('2026-11-04T10:00:00Z'));
    expect(timestampValue(1793786400)).toBe(1793786400000);
  });
});
