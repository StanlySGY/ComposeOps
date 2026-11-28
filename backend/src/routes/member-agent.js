import { hostConnectionRevision } from '../services/docker-hosts.js';
import db, { createAiSession } from '../lib/db.js';
import { assertAgentAuthority } from '../services/agent/scope.js';
import { getMemberAgent, memberProject } from '../services/agent/member-agent.js';
import { startAgentRun, stopAgentRun, resumeAgentRun, approveAgentRun } from '../services/agent/runs.js';
import { getRun, refreshRunState, runEffects, resolveRunEffect } from '../services/agent/run-store.js';
import { checkRateLimit } from '../lib/rate-limit.js';
const fail = (message, statusCode = 403) => Object.assign(new Error(message), { statusCode });
function owned(request) {
  const run = getRun(request.params.id);
  if (!run || run.ownerId !== request.principal.id || !run.context.memberScope) throw fail('任务不存在', 404);
  assertAgentAuthority(run.context, request.principal.id);
  return run;
}
function publicRun(run) {
  return { id: run.id, goal: run.goal, status: run.status, revision: run.revision, checkpoint: run.checkpoint,
    approval: run.approval, result: run.result, error: run.error, createdAt: run.createdAt, updatedAt: run.updatedAt,
    hostId: run.context.hostId, projectId: run.context.projectId };
}
export default async function memberAgentRoutes(app) {
  app.get('/agent/runs', async request => {
    const runs = db.prepare('SELECT id FROM agent_runs WHERE owner_id=? ORDER BY created_at DESC LIMIT 50').all(request.principal.id);
    return { runs: runs.map(row => getRun(row.id)).filter(run => { try { if (!run.context.memberScope) return false; assertAgentAuthority(run.context, request.principal.id); return true; } catch { return false; } }).map(run => publicRun(refreshRunState(run.id))) };
  });
  app.post('/agent/runs', { schema: { body: { type: 'object', additionalProperties: false, required: ['hostId', 'projectId', 'message'], properties: {
    hostId: { type: 'string', minLength: 1, maxLength: 128 }, projectId: { type: 'string', minLength: 1, maxLength: 256 }, message: { type: 'string', minLength: 1, maxLength: 6000 },
  } } } }, async request => {
    if (!checkRateLimit('member-agent:' + request.principal.id, 10, 60000).allowed) throw fail('请求过于频繁，请稍后再试', 429);
    const { hostId, projectId, message } = request.body;
    const context = { hostId, projectId, initiator: request.principal.id, role: 'executor', webSearchEnabled: false,
      memberScope: { accountId: request.principal.id, accountRevision: request.principal.revision, hostRevision: hostConnectionRevision(hostId), hostId, projectId } };
    await memberProject(context);
    const active = db.prepare("SELECT 1 FROM agent_runs WHERE owner_id=? AND status IN ('running','waiting_approval','stopping')").get(request.principal.id);
    if (active) throw fail('请先完成或停止当前任务', 409);
    context.sessionId = createAiSession(); context.gateKey = 'member-' + context.sessionId;
    return { run: publicRun(startAgentRun(message, context, request.principal.id, null, getMemberAgent()).run) };
  });
  app.get('/agent/runs/:id', async request => { const run = owned(request); return { run: publicRun(refreshRunState(run.id)), effects: runEffects(run.id) }; });
  app.post('/agent/runs/:id/stop', async request => ({ run: publicRun(stopAgentRun(owned(request).id)) }));
  app.post('/agent/runs/:id/resume', { schema: { body: { type: 'object', additionalProperties: false, required: ['revision'], properties: { revision: { type: 'integer', minimum: 0 } } } } }, async request => ({ run: publicRun(resumeAgentRun(owned(request).id, request.body.revision, null, getMemberAgent()).run) }));
  app.post('/agent/runs/:id/approve', { schema: { body: { type: 'object', additionalProperties: false, required: ['executionId', 'toolCallId', 'approved'], properties: { executionId: { type: 'string', maxLength: 128 }, toolCallId: { type: 'string', maxLength: 128 }, approved: { type: 'boolean' } } } } }, async request => ({ ok: approveAgentRun(owned(request).id, request.body) }));
  app.post('/agent/runs/:id/reconcile/:effectId', { schema: { body: { type: 'object', additionalProperties: false, required: ['outcome','evidence'], properties: { outcome: { type: 'string', enum: ['applied','not_applied','failed'] }, evidence: { type: 'string', minLength: 10, maxLength: 4000 } } } } }, async request => {
    const run = owned(request); assertAgentAuthority(run.context, request.principal.id, {}, true);
    return { run: publicRun(resolveRunEffect(run.id, request.params.effectId, request.body, request.principal.id)) };
  });
}
