import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRun, getRun, patchRun, runEffects, runDurableEffect, resolveRunEffect, recoverAgentRuns } from '../src/services/agent/run-store.js';
import { startAgentRun, resumeAgentRun, stopAgentRun } from '../src/services/agent/runs.js';
import { createAiSession, DB_PATH } from '../src/lib/db.js';
const context = () => ({ sessionId: createAiSession(), hostId: 'local', initiator: 'admin' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };

test('durable: completed effects are never replayed after process restart', async () => {
  const run = createRun('测试写入', context()); let writes = 0;
  assert.deepEqual(await runDurableEffect(run.id, 'config.write', { hostId: 'local', value: 'first' }, async () => { writes++; return { version: 1 }; }), { version: 1 });
  const script = `const { runDurableEffect, recoverAgentRuns, patchRun } = await import('./backend/src/services/agent/run-store.js'); recoverAgentRuns(); patchRun(${JSON.stringify(run.id)}, {status:'running'}); const result = await runDurableEffect(${JSON.stringify(run.id)}, 'config.write', {hostId:'local',value:'first'}, async () => { throw new Error('MUST NOT EXECUTE'); }); console.log('RESULT='+JSON.stringify(result));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('../..', import.meta.url), env: { ...process.env, DB_PATH }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /RESULT={"version":1}/); assert.equal(writes, 1);
  patchRun(run.id, { status: 'completed' });
});
test('durable: unknown effects block every write until evidence is recorded, recovery expires approvals', async () => {
  const run = createRun('中断写入', context());
  await assert.rejects(runDurableEffect(run.id, 'config.write', { a: 1 }, async () => { throw new Error('ECONNRESET after side effect'); }));
  await assert.rejects(runDurableEffect(run.id, 'compose.restart', {}, async () => assert.fail('no execution')), /未知/);
  patchRun(run.id, { status: 'waiting_approval', approval: { toolCallId: 'old' } }); recoverAgentRuns();
  assert.equal(getRun(run.id).status, 'needs_reconciliation'); assert.equal(getRun(run.id).approval, null);
  const effect = runEffects(run.id)[0];
  assert.throws(() => resolveRunEffect(run.id, effect.id, { outcome: 'applied', evidence: 'ok' }, 'admin'), /证据/);
  resolveRunEffect(run.id, effect.id, { outcome: 'applied', evidence: '检查 local 配置版本和哈希，已确认原操作生效。' }, 'admin');
  patchRun(run.id, { status: 'running' });
  assert.equal((await runDurableEffect(run.id, 'config.write', { a: 1 }, async () => assert.fail('no replay'))).manuallyReconciled, true);
  patchRun(run.id, { status: 'completed' });
});
test('durable: fingerprints distinguish secret values without storing secrets', async () => {
  const run = createRun('保存配置', context()); let writes = 0;
  for (const token of ['sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbb']) await runDurableEffect(run.id, 'env.set', { TOKEN: token }, async () => { writes++; return { ok: true }; });
  assert.equal(writes, 2); const effects = runEffects(run.id); assert.equal(effects.length, 2); assert.notEqual(effects[0].fingerprint, effects[1].fingerprint); assert.doesNotMatch(JSON.stringify(effects), /sk-aaaa|sk-bbbb/);
  patchRun(run.id, { status: 'completed' });
});
test('durable: detached listeners do not cancel work; session conflicts are rejected', async () => {
  const release = deferred(), began = deferred(); const ctx = context();
  const agent = { async executeWithLoop(message, context, emit) { began.resolve(); await release.promise; emit({ type: 'done', content: '完成' }); return { success: true, finalContent: '完成' }; } };
  const events = []; const task = startAgentRun('长任务', ctx, 'admin', event => events.push(event), agent); await began.promise;
  assert.throws(() => startAgentRun('冲突', ctx, 'admin', null, agent), /已有运行/);
  task.detach(); release.resolve(); await task.finished;
  assert.equal(getRun(task.run.id).status, 'completed'); assert.equal(events.some(e => e.type === 'done'), false);
});
test('durable: explicit stop, revision check and two interleaved executions stay isolated', async () => {
  const one = deferred(), two = deferred(); let calls = 0;
  const agent = { async executeWithLoop(message, context, emit, signal) {
    const latch = ++calls === 1 ? one : two;
    await Promise.race([latch.promise, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
    return { success: !signal.aborted, interrupted: signal.aborted, finalContent: message };
  } };
  const a = startAgentRun('A', context(), 'admin', null, agent), b = startAgentRun('B', context(), 'admin', null, agent);
  await new Promise(resolve => setImmediate(resolve)); stopAgentRun(a.run.id); two.resolve(); await Promise.all([a.finished, b.finished]);
  assert.equal(getRun(a.run.id).status, 'interrupted'); assert.equal(getRun(b.run.id).status, 'completed');
  assert.throws(() => resumeAgentRun(a.run.id, -1, null, agent), /变化/);
  assert.notDeepEqual(getRun(a.run.id).planIds, getRun(b.run.id).planIds);
});
test('durable: persistence failure prevents dispatch under full storage', async () => {
  const { default: db } = await import('../src/lib/db.js'); const run = createRun('空间不足', context());
  db.exec("CREATE TEMP TRIGGER fail_effect_storage BEFORE INSERT ON agent_run_effects BEGIN SELECT RAISE(ABORT,'SQLITE_FULL: injected storage exhaustion'); END");
  try { await assert.rejects(runDurableEffect(run.id, 'compose.up', {}, async () => assert.fail('must never mutate without durable intent')), /SQLITE_FULL/); }
  finally { db.exec('DROP TRIGGER fail_effect_storage'); patchRun(run.id, { status: 'failed' }); }
});

test('durable: a read-only query is not cached as a write and remains available during reconciliation', async () => {
  const { OperationsAgent } = await import('../src/services/agent/engine.js');
  const agent = new OperationsAgent(), run = createRun('核对', context()); let reads = 0;
  agent.tools.set('group.list', { ...agent.getTool('group.list'), execute: async () => ({ count: ++reads }) });
  await assert.rejects(runDurableEffect(run.id, 'write', {}, async () => { throw new Error('unknown'); }));
  const first = await agent.executeTool('group.list', {}, { durableRunId: run.id, hostId: 'local' });
  const second = await agent.executeTool('group.list', {}, { durableRunId: run.id, hostId: 'local' });
  assert.equal(first.result.count, 1); assert.equal(second.result.count, 2); assert.equal(runEffects(run.id).length, 1); patchRun(run.id, { status: 'needs_reconciliation' });
});

test('durable: nonzero command result is uncertain and cannot be replayed', async () => {
  const run = createRun('部分操作失败', context());
  await runDurableEffect(run.id, 'compose.up', {}, async () => ({ exitCode: 1, output: 'one started, one failed' }));
  assert.equal(runEffects(run.id)[0].status, 'unknown');
  await assert.rejects(runDurableEffect(run.id, 'compose.up', {}, async () => assert.fail('must not replay')), /未知/);
  patchRun(run.id, { status: 'needs_reconciliation' });
});
test('durable: resumed background effects refresh their persistent outcome before any dispatch', async () => {
  const { createAgentBackgroundTask, updateAgentBackgroundTask } = await import('../src/lib/db.js');
  const { refreshRunState } = await import('../src/services/agent/run-store.js');
  const ctx = context(), run = createRun('后台启动', ctx);
  const task = createAgentBackgroundTask({ sessionId: ctx.sessionId, projectId: 'p', hostId: 'local', taskType: 'compose.up', label: 'test' });
  await runDurableEffect(run.id, 'compose.up', { background: true }, async () => ({ background: true, taskId: task.id }));
  patchRun(run.id, { status: 'completed' });
  assert.equal(refreshRunState(run.id).status, 'awaiting_results');
  updateAgentBackgroundTask(task.id, { status: 'outcome_unknown' });
  assert.equal(refreshRunState(run.id).status, 'needs_reconciliation');
  assert.throws(() => resumeAgentRun(run.id, getRun(run.id).revision), /未知/);
  updateAgentBackgroundTask(task.id, { status: 'completed', exitCode: 0 });
  const refreshed = refreshRunState(run.id); assert.equal(runEffects(run.id)[0].result.taskStatus, 'completed');
  patchRun(refreshed.id, { status: 'interrupted' });
  let prompt;
  const resumed = resumeAgentRun(run.id, getRun(run.id).revision, null, { async executeWithLoop(message, ctx, emit) { prompt = message; emit({ type: 'done', usage: { total_tokens: 11 } }); return { success: true }; } });
  await resumed.finished; assert.match(prompt, /completed/); assert.equal(getRun(run.id).result.usage.totalCount, 11);
});

test('durable: revoking owner admin role aborts live execution and blocks further writes or resume', async () => {
  const { saveAccount } = await import('../src/lib/accounts.js');
  const owner = saveAccount({ username: 'durableowner', role: 'admin', password: 'durable-owner-password', grants: [] }, 'admin');
  const ready = deferred(); let writes = 0;
  const agent = { async executeWithLoop(message, context, emit, signal) {
    ready.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await assert.rejects(runDurableEffect(context.durableRunId, 'group.save', {}, async () => { writes++; }), /管理员权限/);
    return { success: false, interrupted: true };
  } };
  const task = startAgentRun('撤权测试', context(), owner.id, null, agent); await ready.promise;
  saveAccount({ ...owner, role: 'viewer', grants: [] }, 'admin'); await task.finished;
  assert.equal(writes, 0); assert.equal(getRun(task.run.id).status, 'interrupted');
  assert.throws(() => resumeAgentRun(task.run.id, getRun(task.run.id).revision), /管理员权限/);
});

test('legacy Agent tool entry rechecks named administrator after preflight', async () => {
  const { saveAccount } = await import('../src/lib/accounts.js');
  const { OperationsAgent } = await import('../src/services/agent/engine.js');
  const owner = saveAccount({ username: 'legacyowner', role: 'admin', password: 'legacy-owner-password', grants: [] }, 'admin');
  saveAccount({ ...owner, role: 'viewer', grants: [] }, 'admin');
  const agent = new OperationsAgent();
  await assert.rejects(agent.executeTool('group.save', { name: 'must-not-create' }, { authorizationAccountId: owner.id }), /权限已撤销/);
});
