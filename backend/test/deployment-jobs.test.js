import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-jobs-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const { createDeploymentJob, streamDeploymentJob, runDeploymentJob } = await import('../src/services/deployment-jobs.js');
const { getBackgroundJob, createBackgroundJob, interruptRunningBackgroundJobs } = await import('../src/lib/db.js');
const { harvestSecretValues } = await import('../src/lib/secret-redactor.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const project = { id: 'test-deploy', projectName: 'demo', workingDir: '/srv/demo' };
async function finished(id) {
  for (let i = 0; i < 100; i++) {
    const job = getBackgroundJob(id);
    if (!['queued', 'running'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('任务未结束');
}
test('创建任务在观察连接断开后继续，结果和脱敏输出可重新读取', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  harvestSecretValues('API_KEY=private-deployment-secret');
  const job = createDeploymentJob({ action: 'compose.create', project, hostId: 'local', hostName: 'Local', execute: async ({ onOutput, onPhase }) => {
    calls++; onPhase({ phase: 'starting', projectId: project.id });
    onOutput('stdout', 'private-deployment-');
    await gate;
    onOutput('stdout', 'secret\ncreated\n');
    return { ok: true, directoryCreated: true, filesCreated: true };
  } });
  const raw = Object.assign(new EventEmitter(), { writeHead() {}, write() {}, end() {} });
  streamDeploymentJob({ raw }, job.id);
  raw.emit('close');
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(getBackgroundJob(job.id).items[0].output, /private-deployment-/);
  release();
  const result = await finished(job.id);
  assert.equal(calls, 1); assert.equal(result.status, 'success');
  assert.equal(result.context.hostId, 'local'); assert.equal(result.result.directoryCreated, true);
  assert.match(result.items[0].output, /REDACTED/); assert.doesNotMatch(JSON.stringify(result), /private-deployment-secret/);
});
test('启动恢复将未完成结果标为未知，不自动重放', async () => {
  createBackgroundJob({ id: 'interrupted-deploy', action: 'source.deploy', type: 'project.deploy', projects: [project] });
  interruptRunningBackgroundJobs();
  const job = getBackgroundJob('interrupted-deploy');
  assert.equal(job.status, 'interrupted'); assert.equal(job.result.outcomeUnknown, true);
  await runDeploymentJob(job.id, () => assert.fail('must not replay'));
});
test('创建前失败保留无副作用状态，超时则标为结果未知', async () => {
  for (const unknown of [false, true]) {
    const job = createDeploymentJob({ action: 'compose.create', project, hostId: 'local', execute: async () => { throw Object.assign(new Error('failed'), { statusCode: unknown ? 504 : 409 }); } });
    const result = await finished(job.id);
    assert.equal(result.result.directoryCreated, false);
    assert.equal(result.result.outcomeUnknown, unknown);
    assert.equal(result.status, unknown ? 'interrupted' : 'failed');
  }
});
