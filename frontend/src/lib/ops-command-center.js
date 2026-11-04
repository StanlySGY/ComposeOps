// ComposeOps autonomous operations command-center data normalization helpers.
export function safeJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : fallback; } catch { return fallback; }
}

export function timestampValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (!value) return 0;
  const input = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(input) ? input.replace(' ', 'T') + 'Z' : input;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeTaskStatus(status) {
  const value = String(status || 'pending').toLowerCase();
  if (['waiting_approval', 'pending_confirmation'].includes(value)) return 'waiting_approval';
  if (value === 'outcome_unknown') return value;
  if (['failed', 'interrupted'].includes(value)) return 'failed';
  if (['success', 'completed'].includes(value)) return 'success';
  if (['pending', 'queued', 'running', 'stopping'].includes(value)) return value === 'pending' ? 'pending' : 'running';
  if (['cancelled', 'canceled', 'stopped'].includes(value)) return 'cancelled';
  return value;
}

function baseTask({ id, source, sourceId, title, subtitle = '', status, createdAt, updatedAt, projectId = null, projectName = '', sessionId = null, payload = {} }) {
  return {
    id: source + ':' + (sourceId ?? id),
    source, sourceId: String(sourceId ?? id), title: String(title || '未命名任务'), subtitle: String(subtitle || ''),
    status: normalizeTaskStatus(status), createdAt: createdAt || null, updatedAt: updatedAt || createdAt || null,
    createdMs: timestampValue(createdAt), updatedMs: timestampValue(updatedAt || createdAt),
    projectId: projectId ? String(projectId) : null, projectName: String(projectName || ''),
    sessionId: sessionId == null ? null : String(sessionId), payload,
  };
}

export function normalizeAgentPlan(plan) {
  const planJson = safeJson(plan?.plan_json ?? plan?.planJson);
  return {
    ...baseTask({
      id: plan?.id, source: 'agent-plan', sourceId: plan?.id,
      title: plan?.user_message ?? plan?.userMessage ?? 'Agent 执行计划',
      subtitle: plan?.progress_stage ?? plan?.progressStage ?? (planJson.role ? 'Worker · ' + planJson.role : 'Agent 执行'),
      status: plan?.status,
      createdAt: plan?.created_at ?? plan?.createdAt,
      updatedAt: plan?.updated_at ?? plan?.updatedAt ?? plan?.executed_at ?? plan?.executedAt,
      projectId: plan?.project_id ?? plan?.projectId, sessionId: plan?.session_id ?? plan?.sessionId, payload: plan,
    }),
    role: planJson.role || 'planner', progress: Number(plan?.progress_percent ?? plan?.progressPercent) || 0, sourceLabel: 'Agent 计划',
  };
}

export function normalizeBackgroundTask(task) {
  return {
    ...baseTask({
      id: task?.id, source: 'agent-task', sourceId: task?.id, title: task?.label || task?.taskType || 'Agent 后台任务',
      subtitle: [task?.projectId, task?.hostId].filter(Boolean).join(' · '), status: task?.status,
      createdAt: task?.startedAt || task?.createdAt, updatedAt: task?.finishedAt || task?.heartbeatAt || task?.startedAt,
      projectId: task?.projectId, sessionId: task?.sessionId, payload: task,
    }),
    sourceLabel: 'Agent 后台任务',
  };
}

export function normalizeWorkflowInstance(instance) {
  const approval = instance?.context?.pendingApprovalIntent;
  const action = approval?.actionIntent;
  return {
    ...baseTask({
      id: instance?.id, source: 'workflow', sourceId: instance?.id, title: instance?.name || '工作流运行',
      subtitle: instance?.currentNode ? '当前节点 · ' + instance.currentNode : '工作流实例', status: instance?.status,
      createdAt: instance?.createdAt, updatedAt: instance?.finishedAt || instance?.heartbeatAt || instance?.startedAt || instance?.createdAt,
      payload: instance,
    }),
    approvalSummary: action ? (action.action || '待执行操作') + ' · ' + (action.projectId || '当前项目') : '',
    sourceLabel: '工作流',
  };
}

export function normalizeBatchJob(job) {
  return {
    ...baseTask({
      id: job?.id, source: 'batch-job', sourceId: job?.id,
      title: ({ up: '批量启动项目', restart: '批量重启项目', stop: '批量停止项目', pull: '批量拉取镜像', ps: '批量检查状态' })[job?.action] || '批量运维任务',
      subtitle: (Number(job?.completed) || 0) + ' / ' + (Number(job?.total) || 0) + ' 个项目', status: job?.status,
      createdAt: job?.createdAt, updatedAt: job?.finishedAt || job?.startedAt || job?.createdAt, payload: job,
    }),
    progress: job?.total ? Math.round((Number(job.completed) / Number(job.total)) * 100) : 0, sourceLabel: '批量任务',
  };
}

export function buildUnifiedTasks({ plans = [], backgroundTasks = [], workflows = [], jobs = [] } = {}) {
  return [...plans.map(normalizeAgentPlan), ...backgroundTasks.map(normalizeBackgroundTask), ...workflows.map(normalizeWorkflowInstance), ...jobs.map(normalizeBatchJob)]
    .sort((a, b) => b.updatedMs - a.updatedMs || b.createdMs - a.createdMs);
}

export function taskMatchesFilter(task, { tab = 'all', status = 'all', source = 'all', query = '' } = {}) {
  if (tab === 'approvals' && task.status !== 'waiting_approval') return false;
  if (tab === 'review' && !['outcome_unknown', 'failed'].includes(task.status)) return false;
  if (tab === 'active' && !['pending', 'running'].includes(task.status)) return false;
  if (status !== 'all' && task.status !== status) return false;
  if (source !== 'all' && task.source !== source) return false;
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) return true;
  return [task.title, task.subtitle, task.sourceId, task.projectName, task.projectId, task.sourceLabel, task.role]
    .some((value) => String(value || '').toLocaleLowerCase().includes(needle));
}

export function taskStatusLabel(status) {
  return ({ pending: '待执行', running: '执行中', waiting_approval: '待审批', outcome_unknown: '结果待核对', failed: '失败', success: '已完成', cancelled: '已取消' })[normalizeTaskStatus(status)] || String(status || '未知');
}

export function taskStatusTone(status) {
  return ({ pending: 'neutral', running: 'info', waiting_approval: 'warning', outcome_unknown: 'warning', failed: 'danger', success: 'success', cancelled: 'neutral' })[normalizeTaskStatus(status)] || 'neutral';
}

export function auditEventLabel(eventType) {
  return ({
    policy_decision: '权限策略判定', approval_requested: '请求人工审批', approval_decision: '人工审批结果',
    execution_started: '工具开始执行', execution_completed: '工具执行完成', execution_blocked: '执行被阻止',
    postcondition_completed: '后置验证完成', postcondition_failed: '后置验证失败',
  })[eventType] || String(eventType || 'Agent 事件');
}

export function eventMatchesTask(event, task) {
  if (!event || !task) return false;
  const payload = event.payload || {};
  if (task.source === 'workflow') return String(payload.instanceId || '') === task.sourceId
    || String(payload.workflowInstanceId || '') === task.sourceId
    || String(task.payload?.triggerEventId || '') === String(event.id);
  if (task.source === 'agent-plan') return String(payload.planId || '') === task.sourceId
    || (task.sessionId && String(payload.sessionId || '') === task.sessionId);
  if (task.source === 'agent-task') return String(payload.taskId || '') === task.sourceId;
  if (task.source === 'batch-job') return String(payload.jobId || '') === task.sourceId;
  return false;
}

export function buildTaskTimeline(task, { events = [], operations = [], audits = [], workflowDetail = null, taskDetail = null, jobDetail = null, executions = [] } = {}) {
  const timeline = [];
  const add = (item) => {
    if (!item?.at) return;
    timeline.push({ ...item, ms: timestampValue(item.at), id: String(item.id || item.kind + ':' + timeline.length) });
  };
  if (task?.createdAt) add({ id: task.id + ':created', kind: 'created', label: '记录创建', detail: task.sourceLabel, at: task.createdAt, tone: 'neutral' });
  if (task?.source === 'workflow' && workflowDetail?.steps) for (const step of workflowDetail.steps) {
    add({ id: 'workflow-step:' + step.id, kind: 'workflow-step', label: step.nodeId || step.nodeType || '工作流步骤',
      detail: step.error || step.nodeType || step.status, at: step.finishedAt || step.startedAt,
      tone: step.status === 'failed' || step.status === 'outcome_unknown' ? 'danger' : step.status === 'success' ? 'success' : 'info' });
  }
  if (task?.source === 'agent-plan') {
    for (const execution of executions) add({
      id: 'agent-execution:' + execution.id, kind: 'agent-execution',
      label: execution.tool_name || execution.toolName || 'Agent 工具调用',
      detail: execution.error || execution.status || execution.confirmation_status || '',
      at: execution.finished_at || execution.created_at || execution.started_at,
      tone: execution.status === 'failed' || execution.status === 'blocked' ? 'danger' : execution.status === 'success' ? 'success' : 'info',
    });
    for (const audit of audits.filter((entry) => String(entry.planId) === task.sourceId)) add({
      id: audit.id, kind: 'audit', label: auditEventLabel(audit.eventType),
      detail: [audit.toolName, audit.decision, audit.reason].filter(Boolean).join(' · '), at: audit.createdAt,
      tone: ['blocked', 'denied', 'failed'].includes(audit.decision) ? 'danger' : ['execution_completed', 'postcondition_completed'].includes(audit.eventType) ? 'success' : 'info',
    });
  }
  for (const event of events.filter((entry) => eventMatchesTask(entry, task))) add({
    id: 'event:' + event.id, kind: 'event', label: event.title || '关联事件', detail: event.detail || event.source, at: event.createdAt,
    tone: event.severity === 'danger' ? 'danger' : 'warning',
  });
  for (const operation of operations) {
    const matchesProject = task?.projectId && String(operation.projectId || '') === task.projectId;
    const matchesName = task?.projectName && String(operation.projectName || '') === task.projectName;
    if (matchesProject || matchesName) add({
      id: 'operation:' + operation.id, kind: 'operation', label: operation.action, detail: operation.detail || operation.status,
      at: operation.createdAt, tone: operation.status === 'failed' ? 'danger' : 'success',
    });
  }
  if (taskDetail?.startedAt && taskDetail.startedAt !== task?.createdAt) add({ id: task.id + ':started', kind: 'started', label: '后台任务启动', detail: taskDetail.taskType || '', at: taskDetail.startedAt, tone: 'info' });
  if (taskDetail?.finishedAt) add({ id: task.id + ':finished', kind: 'finished', label: '后台任务结束', detail: taskDetail.error || ('退出码 ' + (taskDetail.exitCode ?? '—')), at: taskDetail.finishedAt, tone: taskDetail.status === 'failed' || taskDetail.status === 'outcome_unknown' ? 'danger' : 'success' });
  if (jobDetail?.items) for (const item of jobDetail.items) add({
    id: 'job-item:' + item.id, kind: 'job-item', label: item.projectName || '项目执行',
    detail: item.error || (typeof item.output === 'string' ? item.output.slice(-240) : '') || item.status,
    at: item.finishedAt || item.startedAt || jobDetail.createdAt,
    tone: item.status === 'failed' || item.status === 'interrupted' ? 'danger' : item.status === 'success' ? 'success' : 'info',
  });
  return timeline.sort((a, b) => b.ms - a.ms);
}

export function pendingAgentApprovals(audits = []) {
  const grouped = new Map();
  for (const event of audits) {
    if (!event.executionId) continue;
    const current = grouped.get(event.executionId) || [];
    current.push(event);
    grouped.set(event.executionId, current);
  }
  const pending = [];
  for (const [executionId, entries] of grouped) {
    const sorted = entries.slice().sort((a, b) => timestampValue(a.createdAt) - timestampValue(b.createdAt));
    const requested = sorted.filter((entry) => entry.eventType === 'approval_requested').at(-1);
    const decision = sorted.filter((entry) => entry.eventType === 'approval_decision').at(-1);
    const completedAfterRequest = sorted.some((entry) => ['execution_completed', 'execution_blocked'].includes(entry.eventType)
      && timestampValue(entry.createdAt) >= timestampValue(requested?.createdAt));
    if (requested && !decision && !completedAfterRequest) pending.push({ executionId, planId: requested.planId, event: requested });
  }
  return pending;
}
