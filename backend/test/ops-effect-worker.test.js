import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-effect-worker-'));
process.env.DB_PATH = path.join(tempDir, 'effect-worker.db');

const { default: db } = await import('../src/lib/db.js');
const {
  createOpsTicket, issueOpsMandate, proposeOpsEffect, approveOpsEffect,
  claimNextOpsEffect, startOpsEffect, rejectOpsEffect, recoverExpiredOpsEffects,
} = await import('../src/services/ops-tickets.js');
const { createOpsEffectWorker } = await import('../src/services/ops-effect-worker.js');

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createIntent({
  effectType = 'service.inspect',
  risk = 'low',
  payload = {},
  target = {},
  resourceScope = false,
  approved = true,
  idempotencyKey = null,
} = {}) {
  const ticket = createOpsTicket({
    title: 'Effect Worker 隔离测试',
    projectId: 'project-worker-test',
  }).ticket;
  const resourceId = target.resourceId || '';
  const mandate = issueOpsMandate(ticket.id, {
    scope: {
      projectIds: ['project-worker-test'],
      resourceIds: resourceScope && resourceId ? [resourceId] : [],
      composeProjectNames: ['compose-worker-test'],
    },
    allowedActions: [effectType],
  });
  const fullTarget = {
    projectId: 'project-worker-test',
    composeProject: 'compose-worker-test',
    ...target,
  };
  const proposed = proposeOpsEffect(ticket.id, {
    effectType, mode: 'execute', risk, mandateId: mandate.id,
    target: fullTarget, payload,
    idempotencyKey: idempotencyKey || 'effect-' + randomUUID(),
  }).effect;
  if (approved) approveOpsEffect(ticket.id, proposed.id, 'worker-test-admin');
  return { ticket, mandate, effect: proposed, target: fullTarget };
}

const silentLogger = { warn() {}, error() {} };

test('Effect Worker: service.inspect only lists containers with the exact Compose project label', async () => {
  const { effect } = createIntent();
  const calls = [];
  const worker = createOpsEffectWorker({
    workerId: 'worker-service-inspect',
    logger: silentLogger,
    dockerClient: {
      async listContainers(options) {
        calls.push(options);
        return [
          {
            Id: 'a'.repeat(64), Names: ['/web'], Image: 'nginx:stable',
            State: 'running', Status: 'Up 3 hours', Created: 1793800000,
            Labels: { 'com.docker.compose.project': 'compose-worker-test', 'com.docker.compose.service': 'web' },
          },
          {
            Id: 'b'.repeat(64), Names: ['/outside'], Image: 'redis:latest',
            State: 'running', Status: 'Up 1 hour', Created: 1793800000,
            Labels: { 'com.docker.compose.project': 'another-project', 'com.docker.compose.service': 'cache' },
          },
        ];
      },
    },
  });

  const outcome = await worker.runOnce();
  assert.equal(outcome.status, 'succeeded');
  assert.deepEqual(calls, [{
    all: true,
    filters: { label: ['com.docker.compose.project=compose-worker-test'] },
  }]);
  assert.equal(outcome.effect.id, effect.id);
  assert.equal(outcome.effect.result.count, 1);
  assert.equal(outcome.effect.result.containers[0].names[0], 'web');
  assert.equal(outcome.effect.result.containers[0].composeProject, 'compose-worker-test');
  assert.equal(outcome.effect.result.readOnly, true);
});

test('Effect Worker: container.inspect returns a narrow redacted allowlist, never Docker Env or mounts', async () => {
  const resourceId = 'c'.repeat(64);
  const { effect } = createIntent({ effectType: 'container.inspect', target: { resourceId }, resourceScope: true });
  const calls = [];
  const worker = createOpsEffectWorker({
    workerId: 'worker-container-inspect',
    logger: silentLogger,
    dockerClient: {
      getContainer(id) {
        calls.push(id);
        return {
          async inspect() {
            return {
              Id: resourceId,
              Name: '/api',
              Image: 'sha256:image-id',
              Created: '2026-11-04T09:00:00.000Z',
              Config: {
                Image: 'node:22',
                Env: ['DATABASE_PASSWORD=very-secret-value'],
                Labels: { 'com.docker.compose.project': 'compose-worker-test', 'com.docker.compose.service': 'api' },
              },
              HostConfig: { Binds: ['/host/private:/app'] },
              NetworkSettings: { Networks: { private: { IPAddress: '172.20.0.2' } } },
              State: { Status: 'running', Running: true, ExitCode: 0, OOMKilled: false },
            };
          },
        };
      },
    },
  });

  const outcome = await worker.runOnce();
  assert.equal(outcome.status, 'succeeded');
  assert.deepEqual(calls, [resourceId]);
  assert.equal(outcome.effect.id, effect.id);
  assert.equal(outcome.effect.result.name, 'api');
  assert.equal(outcome.effect.result.state.running, true);
  const serialized = JSON.stringify(outcome.effect.result);
  assert.equal(serialized.includes('very-secret-value'), false);
  assert.equal(serialized.includes('DATABASE_PASSWORD'), false);
  assert.equal(serialized.includes('/host/private'), false);
  assert.equal(serialized.includes('172.20.0.2'), false);
  assert.equal(Object.hasOwn(outcome.effect.result, 'Config'), false);
  assert.equal(Object.hasOwn(outcome.effect.result, 'HostConfig'), false);
  assert.equal(Object.hasOwn(outcome.effect.result, 'NetworkSettings'), false);
});

test('Effect Worker: a container from a different Compose project fails closed', async () => {
  const resourceId = 'd'.repeat(64);
  createIntent({ effectType: 'container.inspect', target: { resourceId }, resourceScope: true });
  const worker = createOpsEffectWorker({
    workerId: 'worker-project-mismatch',
    logger: silentLogger,
    dockerClient: {
      getContainer: () => ({
        async inspect() {
          return {
            Id: resourceId, Name: '/foreign',
            Config: { Image: 'alpine', Labels: { 'com.docker.compose.project': 'foreign-project' } },
            State: { Status: 'running' },
          };
        },
      }),
    },
  });
  const outcome = await worker.runOnce();
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.effect.error, /不属于授权的 Compose 项目/);
});

test('Effect Worker: unknown actions and risk above low are rejected before Docker is called', async () => {
  let dockerCalls = 0;
  const dockerClient = {
    async listContainers() { dockerCalls += 1; return []; },
    getContainer() { dockerCalls += 1; throw new Error('must not be invoked'); },
  };
  createIntent({ effectType: 'compose.up' });
  const unsupportedWorker = createOpsEffectWorker({ dockerClient, workerId: 'worker-unsupported', logger: silentLogger });
  const unsupported = await unsupportedWorker.runOnce();
  assert.equal(unsupported.status, 'rejected');
  assert.match(unsupported.effect.error, /不支持动作 compose.up/);

  createIntent({ effectType: 'service.inspect', risk: 'high' });
  const riskWorker = createOpsEffectWorker({ dockerClient, workerId: 'worker-high-risk', logger: silentLogger });
  const risky = await riskWorker.runOnce();
  assert.equal(risky.status, 'rejected');
  assert.match(risky.effect.error, /最高只接受 low 风险/);

  const { effect: invalidPayloadEffect } = createIntent();
  db.prepare("UPDATE ops_effects SET payload_json='[]' WHERE id=?").run(invalidPayloadEffect.id);
  const invalidPayload = await createOpsEffectWorker({ dockerClient, workerId: 'worker-invalid-payload', logger: silentLogger }).runOnce();
  assert.equal(invalidPayload.status, 'rejected');
  assert.match(invalidPayload.effect.error, /不接受额外参数/);
  assert.equal(dockerCalls, 0);
});

test('Effect Worker: a Compose project name outside the immutable Mandate is rejected before Docker is called', async () => {
  let dockerCalls = 0;
  const { effect } = createIntent();
  db.prepare('UPDATE ops_effects SET target_json=? WHERE id=?')
    .run(JSON.stringify({ projectId: 'project-worker-test', composeProject: 'another-compose-project' }), effect.id);
  const worker = createOpsEffectWorker({
    workerId: 'worker-compose-scope',
    logger: silentLogger,
    dockerClient: { async listContainers() { dockerCalls += 1; return []; } },
  });
  const outcome = await worker.runOnce();
  assert.equal(outcome.processed, false);
  assert.equal(db.prepare('SELECT status FROM ops_effects WHERE id=?').get(effect.id).status, 'rejected');
  assert.equal(dockerCalls, 0);
});

test('Effect Worker: unapproved queued intents are rejected and startOpsEffect independently blocks missing approval', () => {
  const { effect } = createIntent({ approved: true });
  db.prepare("UPDATE ops_effects SET approved_by=NULL, approved_at=NULL WHERE id=?").run(effect.id);
  const claimed = claimNextOpsEffect('worker-missing-approval', 30);
  assert.equal(claimed.id, effect.id);
  assert.throws(() => startOpsEffect(effect.id, 'worker-missing-approval'), { code: 'effect_not_approved' });
  const rejected = rejectOpsEffect(effect.id, 'worker-missing-approval', '测试：缺少人工审批');
  assert.equal(rejected.status, 'rejected');
});

test('Effect Worker: idempotency keys replay only the same semantic request', () => {
  const ticket = createOpsTicket({ title: 'Effect 幂等测试', projectId: 'project-worker-test' }).ticket;
  const mandate = issueOpsMandate(ticket.id, {
    scope: { projectIds: ['project-worker-test'], composeProjectNames: ['compose-worker-test'] },
    allowedActions: ['service.inspect'],
  });
  const key = 'worker-idempotency-' + randomUUID();
  const payload = {
    effectType: 'service.inspect', mode: 'execute', risk: 'low',
    mandateId: mandate.id,
    target: { projectId: 'project-worker-test', composeProject: 'compose-worker-test' },
    payload: {}, idempotencyKey: key,
  };
  const first = proposeOpsEffect(ticket.id, payload);
  const replay = proposeOpsEffect(ticket.id, payload);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.effect.id, first.effect.id);
  assert.throws(() => proposeOpsEffect(ticket.id, {
    ...payload,
    target: { ...payload.target, composeProject: 'different-compose-project' },
  }), { code: 'idempotency_conflict' });
});

test('Effect Worker: executing lease recovery clears stale owner and never requeues an uncertain run', () => {
  const { effect } = createIntent();
  const claimed = claimNextOpsEffect('worker-crash-recovery', 30);
  assert.equal(claimed.id, effect.id);
  assert.equal(startOpsEffect(effect.id, 'worker-crash-recovery').status, 'executing');
  db.prepare('UPDATE ops_effects SET lease_expires_at=? WHERE id=?')
    .run(new Date(Date.now() - 10000).toISOString(), effect.id);
  assert.deepEqual(recoverExpiredOpsEffects(), { requeued: 0, outcomeUnknown: 1 });
  const row = db.prepare('SELECT status,lease_owner,lease_expires_at FROM ops_effects WHERE id=?').get(effect.id);
  assert.equal(row.status, 'outcome_unknown');
  assert.equal(row.lease_owner, null);
  assert.equal(row.lease_expires_at, null);
  assert.equal(claimNextOpsEffect('worker-must-not-replay', 30), null);
});

test('Effect Worker: reports its read-only capability and stops its polling loop', () => {
  const worker = createOpsEffectWorker({
    workerId: 'worker-lifecycle',
    dockerClient: { async listContainers() { return []; } },
    logger: silentLogger,
  });
  assert.equal(worker.getStatus().state, 'stopped');
  assert.equal(worker.getStatus().readOnlyOnly, true);
  assert.deepEqual(worker.getStatus().supportedActions.map((item) => item.effectType), ['service.inspect', 'container.inspect']);
  worker.start();
  assert.equal(worker.getStatus().state, 'running');
  assert.equal(worker.getStatus().enabled, true);
  worker.stop();
  assert.equal(worker.getStatus().state, 'stopped');
});
