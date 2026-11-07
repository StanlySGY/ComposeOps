import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import Fastify from 'fastify';
import cronRoutes from '../src/routes/cron.js';
import { previewSchedule, validateCron } from '../src/lib/cron-expression.js';
import db from '../src/lib/db.js';
import { createJob, getJob, updateJob, listHistory, listJobs, nextScheduledRun, tick } from '../src/services/cron-scheduler.js';

db.prepare('INSERT OR REPLACE INTO cron_state(id, payload) VALUES (1, ?)').run(JSON.stringify({ jobs: [], history: [] }));

test('Cron 预览拒绝伪合法字段和不可能的日期，并按调度时区返回三个时间', () => {
  for (const expr of ['x y z a b', '60 3 * * *', '1.5 * * * *', '5-1 * * * *', '1,,2 * * * *', '*/0 * * * *', '1-2-3 * * * *']) assert.throws(() => validateCron(expr), /无效/);
  assert.throws(() => previewSchedule('0 3 31 2 *'), /没有匹配/);
  const result = previewSchedule('0 3 * * *', new Date(2026, 10, 7, 1));
  assert.equal(result.nextRuns.length, 3);
  assert.equal(new Date(result.nextRuns[0]).getHours(), 3);
  assert.equal(new Date(result.nextRuns[0]).getDate(), 7);
  assert.ok(result.nextRuns[2] > result.nextRuns[1]);
  assert.equal(result.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test('新任务首次到点执行一次；再次扫描不会重复；重新启用从启用时刻安排', async (t) => {
  let now = new Date(2026, 10, 7, 2, 59, 10).getTime();
  t.mock.method(Date, 'now', () => now);
  const job = await createJob({ name: '隔离调度验收', type: 'images-check', cron: '0 3 * * *' });
  const stored = await getJob(job.id);
  // 故意使用不存在的执行器：真实调度写入失败历史，但绝不访问 Docker、模型或网络。
  stored.type = 'test-without-external-effects';
  const due = new Date(2026, 10, 7, 3).getTime();
  assert.equal(job.nextRunAt, due);
  await tick();
  assert.equal((await listHistory()).length, 0);
  now = due + 5000;
  assert.equal(nextScheduledRun(stored).getTime(), due, '首次运行时间不能随当前时间向后漂移');
  const silence = t.mock.method(console, 'error', () => {});
  await Promise.all([tick(), tick()]);
  await setImmediate();
  assert.equal((await listHistory()).length, 1);
  assert.match((await listHistory())[0].error, /未知任务类型/);
  await tick();
  await setImmediate();
  assert.equal((await listHistory()).length, 1);
  silence.mock.restore();
  await updateJob(job.id, { enabled: false });
  now = new Date(2026, 10, 10, 4).getTime();
  const enabled = await updateJob(job.id, { enabled: true });
  assert.equal(new Date(enabled.nextRunAt).getDate(), 11);
  assert.ok(enabled.nextRunAt > now);
  const before = structuredClone(await getJob(job.id));
  await assert.rejects(updateJob(job.id, { name: '不能部分修改', cron: '60 3 * * *' }), /无效/);
  assert.deepEqual(await getJob(job.id), before);
  await updateJob(job.id, { enabled: false });
});

test('时间预览 API 只读，不创建任务，非法表达式返回可读错误', async () => {
  const app = Fastify();
  await app.register(cronRoutes, { prefix: '/cron' });
  const count = (await listJobs()).length;
  try {
    const response = await app.inject({ method: 'GET', url: '/cron/preview?cron=0%203%20*%20*%20*' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().nextRuns.length, 3);
    const bad = await app.inject({ method: 'GET', url: '/cron/preview?cron=60%203%20*%20*%20*' });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().message, /无效/);
    assert.equal((await listJobs()).length, count);
  } finally { await app.close(); }
});
