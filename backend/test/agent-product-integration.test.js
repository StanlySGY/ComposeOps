import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import db, { setSetting, getSetting, getProjectPreference, getProjectMountEnabled, setProjectPreference, createAgentPlan, recordAgentExecution, updateAgentExecution } from '../src/lib/db.js';
import { OperationsAgent, selectAgentTools, resolveAgentRole } from '../src/services/agent/engine.js';
import { validateParams } from '../src/services/agent/planning.js';
import { withDockerHostScope, getActiveHostId, upsertHost, hostConnectionRevision } from '../src/services/docker-hosts.js';
import { updateManagedProject } from '../src/services/project-management.js';
import { saveProjectGroup } from '../src/services/project-groups.js';
import { durableOperation, listSessionOperations } from '../src/services/agent/operations.js';
import { toPublicAgentEvent } from '../src/lib/agent-public-events.js';
import { createAgentPolicyGroup, createAgentPolicyRule, deleteAgentPolicyGroup } from '../src/services/agent/policy-store.js';

const agent = new OperationsAgent();
const hostA = upsertHost({ name: 'synthetic A', type: 'tcp', host: '127.0.0.1', port: 1 });
const hostB = upsertHost({ name: 'synthetic B', type: 'tcp', host: '127.0.0.1', port: 2 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('nested schema rejects malformed release items, unknown fields, null and empty arrays before execution', () => {
  const schema = agent.getTool('sre.release.review').parameters;
  const row = { profileId: 'profile', image: 'app:v2', migration: 'none', compatibilityNote: '应用代码修改，无数据迁移' };
  const valid = { hostId: 'local', projectId: 'project', services: [row, { ...row, profileId: 'profile2' }] };
  assert.doesNotThrow(() => validateParams(schema, valid));
  for (const services of [[], [row], [row, { ...row, migration: 'irreversible' }], [row, { ...row, compatibilityNote: null }], [row, { ...row, secret: 'no' }], [row, {}]]) {
    assert.throws(() => validateParams(schema, { ...valid, services }));
  }
  assert.throws(() => validateParams(agent.getTool('sre.release.apply').parameters, { hostId: 'local', projectId: 'p', id: 'r', fingerprint: 'a'.repeat(64), allowRollback: false, compatibilityConfirmed: false, confirm: 'APPLY_APPLICATION_RELEASE' }));
  assert.doesNotThrow(() => validateParams(agent.getTool('group.assign').parameters, { hostId: 'local', projectId: 'p', groupId: null }));
});

test('management/release intents expose required tools; read-only roles never gain mutation tools', () => {
  for (const [text, expected] of [
    ['接入公司节点，纳管项目并归组', ['host.list', 'host.save', 'project.discover', 'project.manage', 'group.save', 'group.assign']],
    ['创建健康目标并可靠发布两个服务，失败回退', ['sre.context', 'sre.profile.save', 'sre.release.review', 'sre.release.apply', 'sre.operation']],
    ['备份并做业务恢复演练', ['sre.business.candidates', 'sre.business.plan', 'sre.business.backup', 'sre.business.restore', 'sre.business.list']],
  ]) {
    const visible = new Set(selectAgentTools(agent.listTools(), resolveAgentRole('auto', text), text).map(tool => tool.name));
    for (const name of expected) assert.ok(visible.has(name), `${text}: ${name}`);
  }
  const readonly = selectAgentTools(agent.listTools(), 'validator', '检查节点和发布结果');
  for (const tool of readonly.filter(tool => tool.productDomain)) { assert.equal(tool.readOnly, true); assert.equal(tool.confirmationRequired, false); }
});

test('concurrent executions pin legacy host helpers and preserve initiator/session without changing global host', async () => {
  setSetting('docker.active_host', 'local');
  agent.registerTool('test.noop', { requiredPermission: 'readonly', confirmationRequired: false, parameters: { type: 'object', properties: { hostId: { type: 'string' }, delay: { type: 'number' } } }, execute: async (p, context) => {
    const before = getActiveHostId(); await sleep(p.delay); return { before, after: getActiveHostId(), sessionId: context.sessionId, initiator: context.initiator };
  } });
  const [a, b] = await Promise.all([
    agent.executeTool('test.noop', { hostId: hostA.id, delay: 20 }, { sessionId: 11, initiator: 'user-a' }),
    agent.executeTool('test.noop', { hostId: hostB.id, delay: 5 }, { sessionId: 22, initiator: 'user-b' }),
  ]);
  assert.deepEqual(a.result, { before: hostA.id, after: hostA.id, sessionId: 11, initiator: 'user-a' });
  assert.deepEqual(b.result, { before: hostB.id, after: hostB.id, sessionId: 22, initiator: 'user-b' });
  assert.equal(getSetting('docker.active_host'), 'local'); assert.equal(getActiveHostId(), 'local');
  await assert.rejects(async () => withDockerHostScope('missing-node', () => {}), /不存在/);
});

test('incremental adoption/grouping preserves all other grants and rejects foreign groups atomically', async () => {
  const projects = ['one', 'two'].map(id => ({ id, hostId: hostA.id, projectName: id, mounted: true }));
  setProjectPreference('two', { managed: true, mountEnabled: true });
  setProjectPreference('offline', { managed: true, mountEnabled: true });
  const group = saveProjectGroup({ name: '我的业务' }), pruned = [];
  const deps = { scan: async id => { assert.equal(id, hostA.id); return projects; }, prune: async (ids, hostId) => pruned.push({ ids, hostId }) };
  const result = await updateManagedProject({ hostId: hostA.id, projectId: 'one', managed: true, mountEnabled: true, groupId: group.id }, deps);
  assert.equal(result.managed, 1); assert.equal(result.mountEnabled, true);
  assert.equal(getProjectPreference('two').managed, 1); assert.equal(getProjectPreference('offline').managed, 1);
  assert.deepEqual(new Set(pruned[0].ids), new Set(['one', 'two', 'offline'])); assert.equal(pruned[0].hostId, hostA.id);
  await assert.rejects(updateManagedProject({ hostId: hostA.id, projectId: 'one', managed: false, mountEnabled: false, groupId: 'foreign' }, deps), /分组/);
  assert.equal(getProjectPreference('one').managed, 1); assert.equal(getProjectMountEnabled('one'), true);
  await assert.rejects(updateManagedProject({ hostId: hostB.id, projectId: 'one', managed: true, mountEnabled: false }, { ...deps, scan: async () => projects }), /项目不存在/);
});

test('node tools do not expose or accept passwords and reject stale connection revisions', async () => {
  const stored = upsertHost({ name: 'credential test', type: 'ssh', host: 'example.invalid', password: 'synthetic-secret-only' });
  const result = await agent.executeTool('host.list');
  assert.equal(JSON.stringify(result.result).includes('synthetic-secret-only'), false);
  assert.throws(() => validateParams(agent.getTool('host.save').parameters, { name: 'node', host: 'test', type: 'ssh', password: 'never' }), /不支持/);
  const saved = await agent.executeTool('host.save', { id: stored.id, name: 'changed', host: 'example.invalid', type: 'ssh', expectedRevision: 'stale' });
  assert.equal(saved.success, false); assert.match(saved.error, /版本/);
  assert.ok(hostConnectionRevision(stored.id));
});

test('direct execution still honors persistent deny and does not write the group', async () => {
  const group = createAgentPolicyGroup({ name: 'deny management', enabled: true });
  createAgentPolicyRule({ groupId: group.id, name: 'deny creation', effect: 'deny', toolName: 'group.save' });
  try { await assert.rejects(agent.executeTool('group.save', { name: 'denied' }), /策略拒绝/); }
  finally { deleteAgentPolicyGroup(group.id); }
  assert.equal(db.prepare('SELECT id FROM project_groups WHERE name=?').get('denied'), undefined);
});

test('durable results distinguish submission, unknown, backup verification, rollback and business success', () => {
  assert.equal(durableOperation('change', { status: 'queued' }).verification.status, 'pending');
  assert.equal(durableOperation('change', { status: 'outcome_unknown' }).operation.needsReconciliation, true);
  assert.equal(durableOperation('change', { status: 'rolled_back' }).operation.businessVerified, false);
  assert.equal(durableOperation('business-backup', { status: 'verified' }).operation.businessVerified, false);
  assert.equal(durableOperation('business-run', { status: 'passed', result: { businessRecoveryVerified: true } }).operation.businessVerified, false);
  const result = durableOperation('business-run', { status: 'passed', result: { businessRecoveryVerified: true, rpoMet: true, rtoMet: true, cleanupComplete: true } });
  assert.equal(result.operation.businessVerified, true);
  const publicEvent = toPublicAgentEvent({ type: 'tool_result', tool: 'sre.release.apply', result: { success: true, result: durableOperation('change', { status: 'queued' }), postconditionStatus: 'pending', postconditionReason: '尚未验收' } });
  assert.equal(publicEvent.verification.status, 'pending');
});

test('session operation recovery reads current records, deduplicates and never replays missing work', async () => {
  const id = 'test-release-' + randomUUID(), now = Date.now();
  db.prepare('INSERT INTO sre_changes(id,status,host_id,project_id,profile_id,review_json,created_at,updated_at,expires_at,reviewed_by) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, 'queued', 'local', 'p', 'profile', JSON.stringify({ recipe: 'application-release-v1' }), now, now, now + 60000, 'tester');
  const plan = createAgentPlan(987, 'synthetic', {});
  for (let n = 0; n < 2; n++) {
    const exec = recordAgentExecution(plan, 'sre.release.apply', {}, 'success');
    updateAgentExecution(exec, { result: { operation: { kind: 'change', id, hostId: 'local', projectId: 'p' } } });
  }
  assert.equal(listSessionOperations(987).operations.length, 1); assert.equal(listSessionOperations(123).operations.length, 0);
  db.prepare("UPDATE sre_changes SET status='outcome_unknown' WHERE id=?").run(id);
  assert.equal(listSessionOperations(987).operations[0].operation.needsReconciliation, true);
  const offline = await agent.executeTool('sre.operation', { hostId: 'local', projectId: 'p', id, kind: 'change' });
  assert.equal(offline.success, true); assert.equal(offline.result.operation.needsReconciliation, true);
  db.prepare('DELETE FROM sre_changes WHERE id=?').run(id);
  assert.equal(listSessionOperations(987).operations[0].operation.status, 'unavailable');
});

test('backup-triggered recovery remains visible in the same session after the backup finishes', () => {
  const planId = 'recovery-plan', backupId = 'backup-chain', runId = 'run-chain', now = Date.now();
  const snapshot = { plan: { id: planId, hostId: 'local', projectId: 'p', version: 1 }, drillAfter: true };
  db.prepare("INSERT INTO sre_business_backups(id,plan_id,version,status,snapshot_json,created_at,requested_by) VALUES(?,?,1,'verified',?,?,?)").run(backupId, planId, JSON.stringify(snapshot), now, 'tester');
  const plan = createAgentPlan(988, 'backup and drill', {}), exec = recordAgentExecution(plan, 'sre.business.backup', {}, 'success');
  updateAgentExecution(exec, { result: { operation: { kind: 'business-backup', id: backupId, hostId: 'local', projectId: 'p' } } });
  assert.equal(listSessionOperations(988).operations.length, 1);
  assert.equal(listSessionOperations(988).operations[0].operation.needsReconciliation, true);
  db.prepare("INSERT INTO sre_business_runs(id,plan_id,version,status,snapshot_json,created_at,requested_by) VALUES(?,?,1,'queued',?,?,?)").run(runId, planId, JSON.stringify({ plan: snapshot.plan, backup: { id: backupId } }), now, 'tester');
  const operations = listSessionOperations(988).operations;
  assert.equal(operations.length, 2); assert.equal(operations[1].operation.id, runId); assert.equal(operations[1].operation.running, true);
  assert.equal(operations[0].operation.businessVerified, false);
  assert.equal(durableOperation('onboarding', { status: 'complete' }).operation.businessVerified, false);
  assert.match(durableOperation('onboarding', { status: 'partial' }).verification.reason, /尚未完成/);
});
