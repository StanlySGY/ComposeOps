import { randomUUID } from 'node:crypto';
import { createBackgroundJob, getBackgroundJob, updateBackgroundJob, updateBackgroundJobItem, updateDeploymentJob } from '../lib/db.js';
import { emitJobUpdate, subscribeJobEvents } from './job-events.js';
import { redactSecrets, secretStreamHoldbackLength, redactSecretStreamTail } from '../lib/secret-redactor.js';

/** 只持久化身份、阶段与结果；Compose/env 明文留在执行闭包中，不进入任务 DB。 */
export function createDeploymentJob({ action, project, hostId, hostName, execute }) {
  const job = createBackgroundJob({ id: randomUUID(), type: 'project.deploy', action, projects: [project] });
  updateDeploymentJob(job.id, { context: { hostId, hostName, projectId: project.id, projectName: project.projectName, workingDir: project.workingDir } });
  emitJobUpdate(job.id, { event: 'created' });
  setImmediate(() => void runDeploymentJob(job.id, execute));
  return getBackgroundJob(job.id);
}

export async function runDeploymentJob(jobId, execute) {
  const job = getBackgroundJob(jobId);
  if (!job || job.status !== 'queued') return;
  const item = job.items[0];
  let rawOutput = '', output = '', lastFlush = 0, progress = {};
  const emit = event => emitJobUpdate(jobId, { event });
  const flush = () => {
    const hold = secretStreamHoldbackLength(rawOutput);
    output = redactSecrets(hold ? rawOutput.slice(0, -hold) : rawOutput).slice(-20000);
    updateBackgroundJobItem(item.id, { status: 'running', output });
    emit('progress'); lastFlush = Date.now();
  };
  updateBackgroundJob(jobId, 'running', 0);
  updateBackgroundJobItem(item.id, { status: 'running' });
  emit('start');
  let result;
  try {
    result = await execute({
      onOutput: (_type, text) => { rawOutput = (rawOutput + String(text || '')).slice(-40000); if (Date.now() - lastFlush > 250) flush(); },
      onPhase: phase => { progress = { ...progress, ...phase }; updateDeploymentJob(jobId, { result: progress }); emit('progress'); },
    });
    result = { ...progress, ...result, ok: result?.ok !== false };
  } catch (error) {
    result = { ...progress, ok: false, code: 1, message: redactSecrets(error.message),
      projectId: error.projectId || progress.projectId || item.projectId,
      workingDir: error.workingDir || job.context.workingDir,
      directoryCreated: !!error.directoryCreated, filesCreated: !!error.filesCreated,
      outcomeUnknown: error.code === 'STREAM_CLOSED' || error.name === 'AbortError' || error.statusCode === 504,
    };
  }
  output = (redactSecretStreamTail(rawOutput) + '\n' + redactSecrets(result.message || '') + '\n').slice(-20000);
  const status = result.outcomeUnknown ? 'interrupted' : result.ok ? 'success' : 'failed';
  if (result.outcomeUnknown) result.message = '执行结果需核对，远端命令可能仍在执行。请检查项目与容器状态后再决定下一步。';
  updateDeploymentJob(jobId, { result });
  updateBackgroundJobItem(item.id, { status, output, exitCode: result.outcomeUnknown ? null : result.ok ? 0 : 1 });
  updateBackgroundJob(jobId, status, 1);
  emit('done');
}

/** 连接只观察任务；关闭页面不取消后台执行。服务重启标记 interrupted，绝不自动重放。 */
export function streamDeploymentJob(reply, jobId) {
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  let previous = '', closed = false;
  const send = (type, data) => { if (!closed && !reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify({ type, data })}\n\n`); };
  const update = () => {
    const job = getBackgroundJob(jobId);
    if (!job) return;
    const output = job.items[0]?.output || '';
    if (output !== previous) { send('output', output); previous = output; }
    if (job.result?.phase) send('phase', job.result);
    if (!['queued', 'running'].includes(job.status)) {
      send('result', job.result); send('exit', { code: job.status === 'success' ? 0 : 1 });
      cleanup(); reply.raw.end();
    }
  };
  const unsubscribe = subscribeJobEvents(event => { if (event.jobId === jobId) update(); });
  const heartbeat = setInterval(() => send('stdout', ''), 15000);
  heartbeat.unref?.();
  const cleanup = () => { closed = true; clearInterval(heartbeat); unsubscribe(); };
  reply.raw.on('close', cleanup);
  send('job', { jobId, ...getBackgroundJob(jobId)?.context });
  update();
}
