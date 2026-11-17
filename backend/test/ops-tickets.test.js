import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-ops-tickets-'));
process.env.DB_PATH = path.join(tempDir, 'ops-tickets.db');

const { buildApp } = await import('../src/app.js');
const { default: db } = await import('../src/lib/db.js');
const {
  claimNextOpsEffect, startOpsEffect, completeOpsEffect,
  recoverExpiredOpsEffects,
} = await import('../src/services/ops-tickets.js');
const app = await buildApp({ logger: false });
await app.ready();

const plainHeaders = { origin: 'http://localhost:3001', host: 'localhost:3001' };
let headers = plainHeaders;
let ticketId;
let mandateId;
let assignmentId;

test.after(async () => {
  await app.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('ops tickets: require an authenticated same-origin admin session', async () => {
  const denied = await app.inject({ method: 'GET', url: '/api/v1/ops-tickets', headers: plainHeaders });
  assert.equal(denied.statusCode, 401);
  const setup = await app.inject({
    method: 'POST', url: '/api/v1/auth/setup', headers: plainHeaders,
    payload: { password: 'ops-ticket-test-password' },
  });
  assert.equal(setup.statusCode, 200, setup.body);
  const cookie = String(setup.headers['set-cookie']).split(';', 1)[0];
  headers = { ...plainHeaders, cookie };
  const workerStatus = await app.inject({ method: 'GET', url: '/api/v1/ops-tickets/worker/status', headers });
  assert.equal(workerStatus.statusCode, 200, workerStatus.body);
  assert.equal(workerStatus.json().readOnlyOnly, false);
  assert.deepEqual(workerStatus.json().supportedActions.map((item) => item.effectType), ['service.inspect', 'container.inspect', 'incident.restart']);
});

test('ops tickets: Ticket is independent from Agent Session and idempotent', async () => {
  const created = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets', headers,
    payload: {
      title: '核对 staging Compose 服务', description: '检查镜像、容器状态并提交证据。',
      priority: 'high', sourceType: 'manual', projectId: 'project-staging',
      acceptanceCriteria: ['列出目标服务及镜像摘要', '报告附带可追溯证据'],
      idempotencyKey: 'ticket-create-staging-001',
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  ticketId = created.json().ticket.id;
  assert.match(ticketId, /^opt_/);
  assert.equal(created.json().ticket.status, 'planning');
  assert.equal(created.json().ticket.projectId, 'project-staging');

  const replay = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets', headers,
    payload: { title: 'duplicate must not create', idempotencyKey: 'ticket-create-staging-001' },
  });
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal(replay.json().ticket.id, ticketId);
  assert.equal(replay.json().replayed, true);

  const list = await app.inject({ method: 'GET', url: '/api/v1/ops-tickets?status=planning&query=staging', headers });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().tickets.length, 1);
  assert.equal(list.json().tickets[0].id, ticketId);

  const updated = await app.inject({
    method: 'PATCH', url: '/api/v1/ops-tickets/' + ticketId, headers,
    payload: { status: 'ready', priority: 'urgent' },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().ticket.status, 'ready');

  const invalidTransition = await app.inject({
    method: 'PATCH', url: '/api/v1/ops-tickets/' + ticketId, headers,
    payload: { status: 'succeeded' },
  });
  assert.equal(invalidTransition.statusCode, 409);
});

test('ops tickets: immutable scoped Mandate is deny-first and versioned', async () => {
  const invalid = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/mandates', headers,
    payload: { scope: {}, allowedActions: ['service.inspect'] },
  });
  assert.equal(invalid.statusCode, 400);

  const issued = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/mandates', headers,
    payload: {
      scope: { projectIds: ['project-staging'] },
      allowedActions: ['service.inspect', 'image.pull'],
      deniedActions: ['volume.delete', 'database.drop'],
    },
  });
  assert.equal(issued.statusCode, 201, issued.body);
  mandateId = issued.json().mandate.id;
  assert.equal(issued.json().mandate.version, 1);
  assert.equal(issued.json().mandate.status, 'active');
  assert.match(issued.json().mandate.fingerprint, /^[a-f0-9]{64}$/);

  const forbiddenAction = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/effects', headers,
    payload: { mode: 'execute', effectType: 'volume.delete', mandateId, target: { projectId: 'project-staging' } },
  });
  assert.equal(forbiddenAction.statusCode, 403);

  const wrongScope = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/effects', headers,
    payload: { mode: 'execute', effectType: 'image.pull', mandateId, target: { projectId: 'project-production' } },
  });
  assert.equal(wrongScope.statusCode, 403);

  const staleIntent = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/effects', headers,
    payload: { mode: 'execute', effectType: 'image.pull', mandateId, target: { projectId: 'project-staging' } },
  });
  assert.equal(staleIntent.statusCode, 201, staleIntent.body);
  const staleEffectId = staleIntent.json().effect.id;

  const replacement = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/mandates', headers,
    payload: { scope: { projectIds: ['project-staging'], composeProjectNames: ['compose-staging'] }, allowedActions: ['service.inspect'] },
  });
  assert.equal(replacement.statusCode, 201, replacement.body);
  assert.equal(replacement.json().mandate.version, 2);
  assert.equal(replacement.json().mandate.status, 'active');
  assert.equal(replacement.json().mandate.id === mandateId, false);
  mandateId = replacement.json().mandate.id;
  const stale = db.prepare('SELECT status FROM ops_effects WHERE id=?').get(staleEffectId);
  assert.equal(stale.status, 'rejected', 'superseding a Mandate must invalidate unstarted effect intents');
  const staleApproval = await app.inject({ method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/effects/' + staleEffectId + '/approve', headers });
  assert.equal(staleApproval.statusCode, 409);
});

test('ops tickets: Assignments link existing sessions and preserve explicit handoffs', async () => {
  const created = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/assignments', headers,
    payload: {
      workerRole: 'executor', sourceType: 'agent-session', sourceId: 'existing-plan-session',
      sessionId: 7, mandateId, handoffSummary: '检查指定 staging 项目。',
      idempotencyKey: 'assignment-first',
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  assignmentId = created.json().assignment.id;
  assert.equal(created.json().assignment.sessionId, 7);
  assert.equal(created.json().assignment.sourceId, 'existing-plan-session');
  assert.equal(created.json().assignment.mandateId, mandateId);

  const uncertain = await app.inject({
    method: 'PATCH', url: '/api/v1/ops-tickets/' + ticketId + '/assignments/' + assignmentId,
    headers, payload: { status: 'outcome_unknown' },
  });
  assert.equal(uncertain.statusCode, 200, uncertain.body);
  const badTransition = await app.inject({
    method: 'PATCH', url: '/api/v1/ops-tickets/' + ticketId + '/assignments/' + assignmentId,
    headers, payload: { status: 'running' },
  });
  assert.equal(badTransition.statusCode, 409);

  const reconciled = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/assignments/' + assignmentId + '/reconcile',
    headers, payload: { outcome: 'failed', note: '已核对真实服务，执行没有完成。' },
  });
  assert.equal(reconciled.statusCode, 200, reconciled.body);
  assert.equal(reconciled.json().assignment.status, 'failed');

  const second = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/assignments', headers,
    payload: { workerRole: 'validator', sourceType: 'manual', replacesAssignmentId: assignmentId, handoffSummary: '转由只读验证角色复核。' },
  });
  assert.equal(second.statusCode, 409, 'terminal assignments must not be handed off');
  const first = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/assignments', headers,
    payload: { workerRole: 'planner', sourceType: 'manual', handoffSummary: '创建可交接的规划任务。' },
  });
  assert.equal(first.statusCode, 201, first.body);
  const third = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/assignments', headers,
    payload: { workerRole: 'validator', sourceType: 'manual', replacesAssignmentId: first.json().assignment.id, handoffSummary: '接手前序规划并只读验收。' },
  });
  assert.equal(third.statusCode, 201, third.body);
  assert.ok(third.json().assignment.sequence > first.json().assignment.sequence);
});

test('ops tickets: structured report retains evidence and requires a human decision', async () => {
  const created = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/reports', headers,
    payload: {
      assignmentId, reportType: 'verification', summary: '服务状态已核对，发现镜像版本落后。',
      findings: [{ title: '镜像版本落后', severity: 'warning', detail: '运行镜像旧于远端镜像。', recommendation: '先评估发布窗口。' }],
      evidence: [{ kind: 'docker-inspect', sourceId: 'container-id-001', summary: '容器 inspect 记录已留存。' }],
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const reportId = created.json().report.id;
  assert.equal(created.json().report.status, 'submitted');
  assert.equal(created.json().report.findings[0].severity, 'warning');
  assert.equal(created.json().report.evidence.length, 1);
  const ticket = await app.inject({ method: 'GET', url: '/api/v1/ops-tickets/' + ticketId, headers });
  assert.equal(ticket.statusCode, 200, ticket.body);
  assert.equal(ticket.json().ticket.status, 'review');
  assert.equal(ticket.json().reports.length, 1);

  const prematureSuccess = await app.inject({ method: 'PATCH', url: '/api/v1/ops-tickets/' + ticketId, headers, payload: { status: 'succeeded' } });
  assert.equal(prematureSuccess.statusCode, 409, 'ticket must not succeed without an accepted report');

  const decision = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/reports/' + reportId + '/decision',
    headers, payload: { accepted: true, note: '证据完整，人工验收通过。' },
  });
  assert.equal(decision.statusCode, 200, decision.body);
  assert.equal(decision.json().report.status, 'accepted');
  const completedTicket = await app.inject({ method: 'PATCH', url: '/api/v1/ops-tickets/' + ticketId, headers, payload: { status: 'succeeded' } });
  assert.equal(completedTicket.statusCode, 200, completedTicket.body);
  assert.equal(completedTicket.json().ticket.status, 'succeeded');
  const repeated = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/reports/' + reportId + '/decision',
    headers, payload: { accepted: true },
  });
  assert.equal(repeated.statusCode, 409);
});

test('ops tickets: approval queues an intent but does not execute a side effect', async () => {
  const created = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/effects', headers,
    payload: {
      mode: 'execute', risk: 'low', effectType: 'service.inspect', mandateId,
      target: { projectId: 'project-staging', composeProject: 'compose-staging' }, payload: { inspection: 'read-only' }, idempotencyKey: 'effect-inspect-1',
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const effectId = created.json().effect.id;
  assert.equal(created.json().effect.status, 'awaiting_approval');

  const approval = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/effects/' + effectId + '/approve', headers,
  });
  assert.equal(approval.statusCode, 200, approval.body);
  assert.equal(approval.json().effect.status, 'queued');

  const claimed = claimNextOpsEffect('ops-ticket-test-worker', 30);
  assert.equal(claimed.id, effectId);
  assert.equal(claimed.status, 'leased');
  const started = startOpsEffect(effectId, 'ops-ticket-test-worker');
  assert.equal(started.status, 'executing');
  const complete = completeOpsEffect(effectId, 'ops-ticket-test-worker', {
    success: true, result: { checked: true, sideEffect: false },
  });
  assert.equal(complete.status, 'succeeded');
  assert.equal(complete.result.sideEffect, false);
});

test('ops tickets: a Mandate revoked after claim blocks execution start', async () => {
  const issued = await app.inject({ method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/mandates', headers,
    payload: { scope: { projectIds: ['project-staging'], composeProjectNames: ['compose-staging'] }, allowedActions: ['service.inspect'] } });
  assert.equal(issued.statusCode, 201, issued.body);
  const currentMandateId = issued.json().mandate.id;
  const intent = await app.inject({ method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/effects', headers,
    payload: { mode: 'execute', effectType: 'service.inspect', mandateId: currentMandateId, target: { projectId: 'project-staging', composeProject: 'compose-staging' } } });
  assert.equal(intent.statusCode, 201, intent.body);
  const effectId = intent.json().effect.id;
  const approved = await app.inject({ method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/effects/' + effectId + '/approve', headers });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(claimNextOpsEffect('revocation-test-worker', 30).id, effectId);

  const revoked = await app.inject({ method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/mandates/' + currentMandateId + '/revoke', headers,
    payload: { reason: '测试派发前撤销授权' } });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal(db.prepare('SELECT status FROM ops_effects WHERE id=?').get(effectId).status, 'rejected');
  assert.throws(() => startOpsEffect(effectId, 'revocation-test-worker'), { code: 'effect_lease_invalid' });
  const renewed = await app.inject({ method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/mandates', headers,
    payload: { scope: { projectIds: ['project-staging'], composeProjectNames: ['compose-staging'] }, allowedActions: ['service.inspect'] } });
  assert.equal(renewed.statusCode, 201, renewed.body);
  mandateId = renewed.json().mandate.id;
});

test('ops tickets: expired unstarted lease requeues; expired executing lease becomes outcome_unknown', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/effects', headers,
    payload: {
      mode: 'execute', risk: 'low', effectType: 'service.inspect', mandateId,
      target: { projectId: 'project-staging', composeProject: 'compose-staging' }, payload: { inspection: 'recovery-test' },
    },
  });
  assert.equal(create.statusCode, 201, create.body);
  const effectId = create.json().effect.id;
  const approve = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/effects/' + effectId + '/approve', headers,
  });
  assert.equal(approve.statusCode, 200, approve.body);

  const claimed = claimNextOpsEffect('crashed-before-start', 30);
  assert.equal(claimed.id, effectId);
  db.prepare('UPDATE ops_effects SET lease_expires_at=? WHERE id=?').run(new Date(Date.now() - 10000).toISOString(), effectId);
  assert.deepEqual(recoverExpiredOpsEffects(), { requeued: 1, outcomeUnknown: 0 });
  assert.equal(db.prepare('SELECT status FROM ops_effects WHERE id=?').get(effectId).status, 'queued');

  const reclaimed = claimNextOpsEffect('crashed-during-run', 30);
  assert.equal(reclaimed.id, effectId);
  assert.equal(startOpsEffect(effectId, 'crashed-during-run').status, 'executing');
  db.prepare('UPDATE ops_effects SET lease_expires_at=? WHERE id=?').run(new Date(Date.now() - 10000).toISOString(), effectId);
  assert.deepEqual(recoverExpiredOpsEffects(), { requeued: 0, outcomeUnknown: 1 });
  assert.equal(db.prepare('SELECT status FROM ops_effects WHERE id=?').get(effectId).status, 'outcome_unknown');
  const staleLease = db.prepare('SELECT lease_owner,lease_expires_at FROM ops_effects WHERE id=?').get(effectId);
  assert.equal(staleLease.lease_owner, null);
  assert.equal(staleLease.lease_expires_at, null);
  assert.equal(claimNextOpsEffect('must-not-replay', 30), null);

  const reconciled = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets/' + ticketId + '/effects/' + effectId + '/reconcile',
    headers, payload: { outcome: 'failed', note: '已核对目标环境，读取操作未产生变更。' },
  });
  assert.equal(reconciled.statusCode, 200, reconciled.body);
  assert.equal(reconciled.json().effect.status, 'failed');
});

test('ops tickets: activity log links all domain records and writes require origin', async () => {
  const detail = await app.inject({ method: 'GET', url: '/api/v1/ops-tickets/' + ticketId, headers });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.ok(detail.json().activity.some((item) => item.eventType === 'ticket_created'));
  assert.ok(detail.json().activity.some((item) => item.eventType === 'mandate_issued'));
  assert.ok(detail.json().activity.some((item) => item.eventType === 'effect_approved_queued'));
  assert.ok(detail.json().assignments.length >= 3, JSON.stringify(detail.json().assignments));
  assert.ok(detail.json().effects.length >= 2);

  const badOrigin = await app.inject({
    method: 'POST', url: '/api/v1/ops-tickets', headers: { cookie: headers.cookie, host: 'localhost:3001', origin: 'https://untrusted.example' },
    payload: { title: 'origin must be rejected' },
  });
  assert.equal(badOrigin.statusCode, 403);
});
