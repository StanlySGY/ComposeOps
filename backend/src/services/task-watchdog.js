import {
  getWorkflowInstance,
  listWorkflowInstances,
  listAgentBackgroundTasks,
  updateAgentBackgroundTask,
  updateWorkflowInstanceIfStatus,
  updateWorkflowStep,
} from '../lib/db.js';

const DEFAULT_STALE_MS = 90000;
const DEFAULT_INTERVAL_MS = 30000;
let timer = null;
let running = false;

function toMillis(value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Task Watchdog only marks stalled side effects as outcome_unknown.
 * It never replays an operation whose Docker-side completion cannot be proven.
 */
export function runTaskWatchdogOnce({ now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const threshold = Math.max(1000, Number(staleMs) || DEFAULT_STALE_MS);
  if (!Number.isFinite(nowMs)) throw new Error('invalid watchdog clock');
  const nowIso = new Date(nowMs).toISOString();
  let tasksMarkedUnknown = 0;
  let workflowsMarkedUnknown = 0;

  for (const task of listAgentBackgroundTasks({ limit: 500 })) {
    if (!['running', 'stopping'].includes(task.status)) continue;
    const heartbeat = toMillis(task.heartbeatAt || task.startedAt || task.createdAt, nowMs);
    if (nowMs - heartbeat < threshold) continue;
    const updated = updateAgentBackgroundTask(task.id, {
      status: 'outcome_unknown',
      error: '任务心跳超时；Watchdog 不会重放 Docker 副作用，请核对目标 Host/项目的实际状态。',
      finishedAt: nowIso,
      heartbeatAt: nowIso,
    });
    if (updated) {
      tasksMarkedUnknown += 1;
      void import('./event-center.js').then(({ recordEvent }) => recordEvent({
        eventType: 'agent_task',
        source: 'watchdog',
        title: '后台任务心跳超时 · ' + task.label,
        detail: '任务 ' + task.id + ' 已标记结果待核对。',
        severity: 'warning',
        status: 'open',
        payload: { taskId: task.id, projectId: task.projectId, hostId: task.hostId, taskType: task.taskType },
      })).catch((error) => console.warn('[task-watchdog] task event write failed:', error.message));
    }
  }

  for (const listed of listWorkflowInstances({ status: 'running', limit: 200 })) {
    const heartbeat = toMillis(listed.heartbeatAt || listed.startedAt || listed.createdAt, nowMs);
    if (nowMs - heartbeat < threshold) continue;
    const instance = getWorkflowInstance(listed.id);
    if (!instance) continue;
    const currentStep = (instance.steps || []).find((step) => step.status === 'running');
    if (currentStep) {
      updateWorkflowStep(currentStep.id, {
        status: 'outcome_unknown',
        error: '工作流节点心跳超时；请核对外部副作用，不会自动重放。',
        finishedAt: nowIso,
      });
    }
    const changed = updateWorkflowInstanceIfStatus(instance.id, ['running'], {
      status: 'outcome_unknown',
      result: { outcomeUnknown: true, reason: 'watchdog_stale_heartbeat', currentNode: instance.currentNode || null },
      finishedAt: nowIso,
      heartbeatAt: nowIso,
    });
    if (!changed) continue;
    workflowsMarkedUnknown += 1;
    void import('./event-center.js').then(({ recordEvent }) => recordEvent({
      eventType: 'workflow',
      source: 'watchdog',
      title: '工作流心跳超时 · ' + instance.name,
      detail: '实例 ' + instance.id + ' 已标记结果待核对。',
      severity: 'warning',
      status: 'open',
      payload: { instanceId: instance.id, definitionId: instance.definitionId, currentNode: instance.currentNode || null },
    })).catch((error) => console.warn('[task-watchdog] workflow event write failed:', error.message));
  }

  return { tasksMarkedUnknown, workflowsMarkedUnknown, checkedAt: nowIso, staleMs: threshold };
}

async function tick() {
  if (running) return;
  running = true;
  try { runTaskWatchdogOnce(); }
  catch (error) { console.error('[task-watchdog] sweep failed:', error.message); }
  finally { running = false; }
}

export function startTaskWatchdog({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (timer || process.env.DISABLE_BACKGROUND_JOBS === '1') return;
  const interval = Math.max(5000, Math.min(Number(intervalMs) || DEFAULT_INTERVAL_MS, 300000));
  timer = setInterval(() => { void tick(); }, interval);
  timer.unref?.();
  setTimeout(() => { void tick(); }, Math.min(15000, interval)).unref?.();
}

export function stopTaskWatchdog() {
  if (timer) clearInterval(timer);
  timer = null;
}
