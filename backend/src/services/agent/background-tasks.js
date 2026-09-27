/**
 * 后台任务管理器(借鉴 EnsoCode src/agent/backgroundTasks.ts):
 * compose.up/pull 等长操作可 background=true 转入后台,工具立即返回 taskId;
 * 产出写入环形缓冲(200KB 尾部)。完成后的任务通过 task.output 读取,
 * 或在同会话后续轮次的工具结果前以 <background-task-update> 搭车注入,
 * 让 Agent 不必干等长构建/拉取。
 *
 * run(onOutput, onChild) 由调用方组装(通常是 prepareProjectAction(...).run),
 * 管理器不关心子进程细节;stop 通过 onChild 捕获的句柄发 SIGTERM→5s→SIGKILL。
 */

const RING_LIMIT = 200 * 1024;
const OUTPUT_TAIL = 20000;
const MAX_TASKS = 10;
const TASK_TTL_MS = 60 * 60 * 1000; // 已完成任务读取后保留 1 小时供回看

const tasks = new Map();
let seq = 0;

function tail(text, limit = RING_LIMIT) {
  return String(text || '').slice(-limit);
}

function pushOutput(task, chunk) {
  task.output = tail(`${task.output}${chunk}`);
  task.outputBytes = task.output.length;
}

function summarize(task) {
  return {
    id: task.id,
    sessionId: task.sessionId,
    label: task.label,
    projectId: task.projectId,
    status: task.status,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    exitCode: task.exitCode,
    error: task.error || '',
    outputBytes: task.outputBytes || 0,
  };
}

/**
 * 启动后台任务并立即返回 taskId。run(onOutput, onChild) 返回 Promise,
 * 管理器不 await 调用方;完成/失败状态由 Promise 结算。
 */
export function createBackgroundTask({ sessionId = 0, projectId = null, label = '', run }) {
  if (typeof run !== 'function') throw Object.assign(new Error('后台任务缺少执行函数'), { statusCode: 400 });
  if (listBackgroundTasks(0).filter((item) => item.status === 'running').length >= MAX_TASKS) {
    throw Object.assign(new Error(`后台任务过多(同时上限 ${MAX_TASKS}),请先等待完成或用 task.stop 终止`), { statusCode: 429 });
  }
  seq += 1;
  const task = {
    id: `task-${Date.now()}-${seq}`,
    sessionId: Number(sessionId) || 0,
    projectId: projectId || null,
    label: String(label || 'background task').slice(0, 200),
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    error: '',
    output: '',
    outputBytes: 0,
    consumed: false,
    child: null,
  };
  tasks.set(task.id, task);
  Promise.resolve()
    .then(() => run((chunk) => pushOutput(task, chunk), (child) => { task.child = child; }))
    .then((result) => {
      const stopped = task.status === 'stopped';
      if (!stopped) task.status = 'completed';
      task.exitCode = Number(result?.exitCode ?? result ?? 0);
      if (result?.output) pushOutput(task, `\n${result.output}`);
    })
    .catch((error) => {
      if (task.status === 'stopped') return;
      task.status = 'failed';
      task.error = String(error?.message || error).slice(0, 2000);
      pushOutput(task, `\n[error] ${task.error}`);
    })
    .finally(() => {
      task.finishedAt = new Date().toISOString();
      if (!task.child) task.child = null;
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
}

/** 列出任务;sessionId 为 0/null 时列出全部(管理视图)。 */
export function listBackgroundTasks(sessionId = null) {
  pruneExpired();
  const list = [...tasks.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const filtered = sessionId ? list.filter((task) => task.sessionId === Number(sessionId)) : list;
  return filtered.map(summarize);
}

export function getBackgroundTask(taskId) {
  return tasks.get(String(taskId || '')) || null;
}

/**
 * 读取任务输出;任务仍在运行且 waitMs>0 时阻塞等待完成(500ms 轮询,
 * 上限 300s)。读走完成后标记 consumed,搭车通知不再重复。
 */
export async function waitForTaskOutput(taskId, waitMs = 0) {
  const task = getBackgroundTask(taskId);
  if (!task) throw Object.assign(new Error(`后台任务不存在:${taskId}`), { statusCode: 404 });
  const deadline = Date.now() + Math.min(Math.max(Number(waitMs) || 0, 0), 300000);
  while (task.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const stillRunning = task.status === 'running';
  if (!stillRunning) task.consumed = true;
  return { ...summarize(task), output: task.output.slice(-OUTPUT_TAIL), stillRunning };
}

/**
 * 终止任务:SIGTERM → 5s → SIGKILL(compose 模式为真子进程);
 * workspace 模式的句柄是"断流伪停止"(kill 即断开 exec 流);
 * containers 模式无句柄(dockerode API 调用),killed=false,动作自然结束。
 * 返回 { stopped, killed },而非布尔值。
 */
export function stopBackgroundTask(taskId) {
  const task = getBackgroundTask(taskId);
  if (!task) throw Object.assign(new Error(`后台任务不存在:${taskId}`), { statusCode: 404 });
  if (task.status !== 'running') return { stopped: false, killed: false, note: '任务已结束,无需终止' };
  task.status = 'stopped';
  task.finishedAt = new Date().toISOString();
  const child = task.child;
  task.child = null;
  if (child && typeof child.kill === 'function' && child.exitCode === null && !child.killed) {
    child.kill('SIGTERM');
    setTimeout(() => {
      try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* 子进程可能已自行退出。 */ }
    }, 5000).unref?.();
    return { stopped: true, killed: true };
  }
  return {
    stopped: true,
    killed: false,
    note: '已标记终止;该执行方式不提供进程句柄,正在进行的系统调用会自然结束,不会再有输出。',
  };
}

/**
 * 汲取该会话已完成但未消费的任务通知(搭车注入用),返回多行文本;
 * 无新通知返回 ''。返回即消费,同一任务不会重复提醒。
 */
export function drainTaskNotifications(sessionId) {
  pruneExpired();
  const lines = [];
  for (const task of tasks.values()) {
    if (Number(sessionId) === 0 || task.sessionId !== Number(sessionId)) continue;
    if (task.status === 'running' || task.consumed) continue;
    task.consumed = true;
    const statusText = task.status === 'completed' ? '完成' : task.status === 'failed' ? '失败' : '已终止';
    const exitPart = task.exitCode != null ? `exit=${task.exitCode}` : '';
    const preview = task.output.trim().slice(-400).replace(/\s+/g, ' ');
    lines.push(`- [后台任务${statusText}] ${task.label}(${task.id}${exitPart ? `,${exitPart}` : ''})${preview ? `\n  输出尾部:${preview}` : ''}${task.error ? `\n  错误:${task.error.slice(0, 200)}` : ''}`);
  }
  return lines.join('\n');
}

/** 仅供测试:清空全部任务。 */
export function resetBackgroundTasks() {
  for (const task of tasks.values()) {
    if (task.status === 'running' && task.child?.kill) {
      try { task.child.kill('SIGKILL'); } catch { /* 停止竞态下子进程可能已退出。 */ }
    }
  }
  tasks.clear();
  seq = 0;
}
