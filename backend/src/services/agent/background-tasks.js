/**
 * 持久化 Agent 后台任务管理器。
 * SQLite 保存任务事实，内存只保存当前进程的执行句柄/Promise；进程重启后不盲目重放
 * 已经开始的 Docker 副作用，统一标记 outcome_unknown 并要求核对真实环境。
 */
import { EventEmitter } from 'node:events';
import {
  clearAgentBackgroundTasks,
  createAgentBackgroundTask,
  getAgentBackgroundTask as readAgentBackgroundTask,
  listAgentBackgroundTasks as readAgentBackgroundTasks,
  markAgentBackgroundTasksUnknown,
  updateAgentBackgroundTask,
} from '../../lib/db.js';
import { redactSecrets } from '../../lib/secret-redactor.js';

const RING_LIMIT = 200 * 1024;
const OUTPUT_TAIL = 20000;
const MAX_TASKS = 10;
const MAX_RETAINED_TASKS = 100;
const TASK_TTL_MS = 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 10000;

const tasks = new Map(); // taskId -> live execution only
const emitter = new EventEmitter();

function tailUtf8(text, limit = RING_LIMIT) {
  const buffer = Buffer.from(String(text || ''), 'utf8');
  if (buffer.length <= limit) return buffer.toString('utf8');
  let start = buffer.length - limit;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString('utf8');
}

function pushOutput(task, chunk) {
  const safe = redactSecrets(String(chunk ?? ''));
  task.output = tailUtf8(`${task.output}${safe}`);
  task.outputBytes = Buffer.byteLength(task.output, 'utf8');
  task.dirtyOutput = true;
}

function summary(task) {
  return {
    id: task.id,
    sessionId: task.sessionId,
    projectId: task.projectId,
    hostId: task.hostId || null,
    taskType: task.taskType,
    label: task.label,
    status: task.status,
    startedAt: task.startedAt,
    heartbeatAt: task.heartbeatAt,
    finishedAt: task.finishedAt,
    exitCode: task.exitCode,
    error: task.error || '',
    outputBytes: task.outputBytes || 0,
    attempt: task.attempt || 1,
    consumed: !!task.consumed,
  };
}

function emit(task, event) {
  const payload = { taskId: task.id, event, task: summary(task) };
  for (const listener of emitter.listeners('task:update')) {
    try { listener(payload); } catch { /* 单个 UI 订阅者不得影响任务结算。 */ }
  }
}

function persist(task, patch = {}) {
  if (patch.status !== undefined) task.status = patch.status;
  if (patch.error !== undefined) task.error = String(patch.error || '').slice(0, 2000);
  if (patch.exitCode !== undefined) task.exitCode = patch.exitCode;
  if (patch.result !== undefined) task.result = patch.result || {};
  if (patch.consumed !== undefined) task.consumed = !!patch.consumed;
  if (patch.startedAt !== undefined) task.startedAt = patch.startedAt;
  if (patch.finishedAt !== undefined) task.finishedAt = patch.finishedAt;
  task.heartbeatAt = patch.heartbeatAt || new Date().toISOString();
  updateAgentBackgroundTask(task.id, {
    status: task.status,
    output: task.output,
    outputBytes: task.outputBytes,
    exitCode: task.exitCode,
    error: task.error,
    result: task.result,
    consumed: task.consumed,
    attempt: task.attempt,
    startedAt: task.startedAt,
    heartbeatAt: task.heartbeatAt,
    finishedAt: task.finishedAt,
  });
}

function toRuntimeTask(row) {
  if (!row) return null;
  return {
    ...row,
    outputBytes: Number(row.outputBytes) || Buffer.byteLength(row.output || '', 'utf8'),
    child: null,
    settled: null,
    resolveSettled: null,
    flushTimer: null,
    heartbeatTimer: null,
    dirtyOutput: false,
    result: row.result || {},
  };
}

function flushOutput(task) {
  if (!task.dirtyOutput) return;
  task.dirtyOutput = false;
  persist(task, { heartbeatAt: new Date().toISOString() });
}

function stopTimers(task) {
  if (task.flushTimer) clearInterval(task.flushTimer);
  if (task.heartbeatTimer) clearInterval(task.heartbeatTimer);
  task.flushTimer = null;
  task.heartbeatTimer = null;
}

function notifyTerminal(task) {
  emit(task, 'settled');
  // 同时落入事件中心：用户不必重新打开原 Agent 会话才能看到后台任务结果。
  void import('../event-center.js').then(({ recordEvent }) => recordEvent({
    eventType: 'agent_task',
    source: 'agent_task',
    title: `后台任务${task.status === 'completed' ? '完成' : task.status === 'failed' ? '失败' : '需要核对'} · ${task.label}`,
    detail: task.error || `任务 ${task.id} · exit=${task.exitCode ?? 'unknown'}`,
    severity: task.status === 'completed' ? 'info' : 'warning',
    status: task.status === 'completed' ? 'resolved' : 'open',
    payload: { taskId: task.id, projectId: task.projectId, taskType: task.taskType, status: task.status },
  })).catch(() => {});
}

/**
 * 初始化时恢复持久化状态。运行中的操作无法从闭包恢复，故失败关闭为 outcome_unknown；
 * queued 任务尚未开始副作用，可由调用方在确认项目/宿主仍可用后显式重新入队。
 */
export function initializeBackgroundTasks() {
  return markAgentBackgroundTasksUnknown();
}

/** 启动后台任务。idempotencyKey 命中已有任务时只返回原 ID，不重复执行副作用。 */
export function createBackgroundTask({ id, sessionId = 0, projectId = null, hostId = null, taskType = 'agent', label = '', idempotencyKey = null, run }) {
  if (typeof run !== 'function') throw Object.assign(new Error('后台任务缺少执行函数'), { statusCode: 400 });
  const activeCount = readAgentBackgroundTasks({ limit: 500 }).filter((item) => ['queued', 'running', 'stopping'].includes(item.status)).length;
  if (activeCount >= MAX_TASKS) {
    throw Object.assign(new Error(`后台任务过多(同时上限 ${MAX_TASKS})，请先等待完成或用 task.stop 终止`), { statusCode: 429 });
  }

  let record;
  const existingById = id ? readAgentBackgroundTask(id) : null;
  if (existingById) {
    if (existingById.status !== 'queued') return existingById.id;
    record = existingById;
  } else {
    record = createAgentBackgroundTask({ id, sessionId, projectId, hostId, taskType, label, idempotencyKey });
    if (record.replayed) return record.id;
  }

  const task = toRuntimeTask(record);
  task.status = 'running';
  task.startedAt = task.startedAt || new Date().toISOString();
  task.error = '';
  task.child = null;
  task.settled = new Promise((resolve) => { task.resolveSettled = resolve; });
  tasks.set(task.id, task);
  persist(task, { status: 'running', startedAt: task.startedAt });
  emit(task, 'started');

  task.flushTimer = setInterval(() => flushOutput(task), FLUSH_INTERVAL_MS);
  task.flushTimer.unref?.();
  task.heartbeatTimer = setInterval(() => persist(task), HEARTBEAT_INTERVAL_MS);
  task.heartbeatTimer.unref?.();

  Promise.resolve()
    .then(() => run((chunk) => { if (['running', 'stopping'].includes(task.status)) pushOutput(task, chunk); }, (child) => { task.child = child; }))
    .then((result) => {
      const exitCode = Number(result?.exitCode ?? result ?? 0);
      task.exitCode = Number.isFinite(exitCode) ? exitCode : 1;
      task.result = result && typeof result === 'object' ? result : { exitCode: task.exitCode };
      if (task.status === 'stopping') {
        task.status = 'outcome_unknown';
        task.error = '已请求终止，但执行环境未提供可验证的进程终止结果；请核对 Docker 实际状态。';
      } else {
        task.status = task.exitCode === 0 ? 'completed' : 'failed';
        if (result?.output) pushOutput(task, `\n${result.output}`);
      }
    })
    .catch((error) => {
      if (task.status !== 'stopping') {
        task.status = 'failed';
        task.error = String(error?.message || error).slice(0, 2000);
        pushOutput(task, `\n[error] ${task.error}`);
      } else {
        task.status = 'outcome_unknown';
        task.error = `终止过程中发生异常：${String(error?.message || error).slice(0, 1500)}；请核对 Docker 实际状态。`;
      }
    })
    .finally(() => {
      stopTimers(task);
      task.finishedAt = new Date().toISOString();
      task.child = null;
      flushOutput(task);
      persist(task, { finishedAt: task.finishedAt });
      emit(task, 'settled');
      task.resolveSettled?.();
      notifyTerminal(task);
      pruneExpired();
    });
  return task.id;
}

function pruneExpired() {
  const now = Date.now();
  for (const [id, task] of tasks) {
    if (task.status !== 'running' && task.consumed && task.finishedAt && now - Date.parse(task.finishedAt) > TASK_TTL_MS) {
      tasks.delete(id);
    }
  }
  const terminal = readAgentBackgroundTasks({ limit: 500 })
    .filter((task) => ['completed', 'failed', 'stopped', 'outcome_unknown'].includes(task.status))
    .sort((a, b) => Date.parse(a.finishedAt || a.createdAt) - Date.parse(b.finishedAt || b.createdAt));
  while (terminal.length > MAX_RETAINED_TASKS) {
    const oldest = terminal.shift();
    if (oldest) {
      tasks.delete(oldest.id);
      updateAgentBackgroundTask(oldest.id, { consumed: true });
    }
  }
}

/** 列出持久化任务；sessionId 为 0/null 时列出全部(单用户管理视图)。 */
export function listBackgroundTasks(sessionId = null) {
  pruneExpired();
  return readAgentBackgroundTasks({ sessionId: sessionId ? Number(sessionId) : null, limit: MAX_RETAINED_TASKS }).map((task) => ({
    id: task.id,
    sessionId: task.sessionId,
    projectId: task.projectId,
    hostId: task.hostId,
    taskType: task.taskType,
    label: task.label,
    status: task.status,
    startedAt: task.startedAt,
    heartbeatAt: task.heartbeatAt,
    finishedAt: task.finishedAt,
    exitCode: task.exitCode,
    error: task.error,
    outputBytes: task.outputBytes,
    attempt: task.attempt,
    consumed: task.consumed,
  }));
}

export function getBackgroundTask(taskId) {
  const live = tasks.get(String(taskId || ''));
  if (live) return live;
  return toRuntimeTask(readAgentBackgroundTask(taskId));
}

/** 读取任务输出；对跨重启 outcome_unknown 不等待，也不伪造仍在运行的本地 Promise。 */
export async function waitForTaskOutput(taskId, waitMs = 0, { consume = true } = {}) {
  const task = getBackgroundTask(taskId);
  if (!task) throw Object.assign(new Error(`后台任务不存在:${taskId}`), { statusCode: 404 });
  const boundedWait = Math.min(Math.max(Number(waitMs) || 0, 0), 300000);
  if (task.status === 'running' && task.settled && boundedWait > 0) {
    let timer;
    try {
      await Promise.race([
        task.settled,
        new Promise((resolve) => { timer = setTimeout(resolve, boundedWait); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const latest = readAgentBackgroundTask(taskId) || task;
  const stillRunning = ['queued', 'running', 'stopping'].includes(latest.status);
  if (!stillRunning && consume) updateAgentBackgroundTask(taskId, { consumed: true });
  return {
    id: latest.id,
    sessionId: latest.sessionId,
    projectId: latest.projectId,
    hostId: latest.hostId,
    taskType: latest.taskType,
    label: latest.label,
    status: latest.status,
    startedAt: latest.startedAt,
    heartbeatAt: latest.heartbeatAt,
    finishedAt: latest.finishedAt,
    exitCode: latest.exitCode,
    error: latest.error || '',
    outputBytes: latest.outputBytes || 0,
    output: String(latest.output || '').slice(-OUTPUT_TAIL),
    stillRunning,
    result: latest.result || {},
  };
}

/** 取消请求只表示请求已发出；无可杀进程句柄时绝不谎称任务已终止。 */
export function stopBackgroundTask(taskId) {
  const task = getBackgroundTask(taskId);
  if (!task) throw Object.assign(new Error(`后台任务不存在:${taskId}`), { statusCode: 404 });
  if (!['running', 'queued'].includes(task.status)) return { stopped: false, killed: false, note: '任务已结束或需要核对，不能直接终止' };
  if (task.status === 'queued') {
    task.status = 'stopped';
    task.finishedAt = new Date().toISOString();
    persist(task, { status: 'stopped', finishedAt: task.finishedAt });
    emit(task, 'stopped');
    return { stopped: true, killed: false, queued: true };
  }
  task.status = 'stopping';
  persist(task, { status: 'stopping' });
  const child = task.child;
  if (child && typeof child.kill === 'function' && child.exitCode === null && !child.killed) {
    child.kill('SIGTERM');
    setTimeout(() => {
      try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* 子进程可能已退出。 */ }
    }, 5000).unref?.();
    emit(task, 'stop_requested');
    return { stopped: true, killed: true, pendingVerification: true };
  }
  emit(task, 'stop_requested');
  return {
    stopped: true,
    killed: false,
    pendingVerification: true,
    note: '已记录终止请求，但该执行方式不提供可终止的进程句柄；任务结算后会标记为 outcome_unknown，请核对 Docker 实际状态。',
  };
}

/** 汲取会话完成通知；返回即消费，避免多轮重复注入。 */
export function drainTaskNotifications(sessionId) {
  if (!Number(sessionId)) return '';
  const pending = readAgentBackgroundTasks({ sessionId: Number(sessionId), limit: MAX_RETAINED_TASKS })
    .filter((task) => !task.consumed && ['completed', 'failed', 'stopped', 'outcome_unknown'].includes(task.status));
  const lines = [];
  for (const task of pending) {
    updateAgentBackgroundTask(task.id, { consumed: true });
    const statusText = task.status === 'completed' ? '完成' : task.status === 'failed' ? '失败' : task.status === 'outcome_unknown' ? '结果待核对' : '已终止';
    const preview = String(task.output || '').trim().slice(-400).replace(/\s+/g, ' ');
    lines.push(`- [后台任务${statusText}] ${task.label}(${task.id}${task.exitCode != null ? `,exit=${task.exitCode}` : ''})${preview ? `\n  输出尾部:${preview}` : ''}${task.error ? `\n  错误:${task.error.slice(0, 200)}` : ''}`);
  }
  return lines.join('\n');
}

export function subscribeBackgroundTaskEvents(listener) {
  emitter.on('task:update', listener);
  return () => emitter.off('task:update', listener);
}

/** 仅供隔离测试：清空当前运行句柄与持久任务记录。 */
export function resetBackgroundTasks() {
  for (const task of tasks.values()) {
    stopTimers(task);
    if (task.status === 'running' && task.child?.kill) {
      try { task.child.kill('SIGKILL'); } catch { /* 退出竞态 */ }
    }
  }
  tasks.clear();
  clearAgentBackgroundTasks();
}
