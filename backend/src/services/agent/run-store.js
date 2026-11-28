import { randomUUID, createHmac, randomBytes } from 'node:crypto';
import db, { getAgentBackgroundTask } from '../../lib/db.js';
import { readDurableOperation } from './operations.js';
import { redactSecretValue, harvestSecretValues } from '../../lib/secret-redactor.js';
import { accountById } from '../../lib/accounts.js';

const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const safeJson = value => JSON.stringify(redactSecretValue(value));
export const ACTIVE_RUN_STATES = new Set(['running', 'waiting_approval', 'stopping']);
export function getRun(id) {
  const row = db.prepare('SELECT * FROM agent_runs WHERE id=?').get(id);
  if (!row) return null;
  return { id: row.id, sessionId: row.session_id, ownerId: row.owner_id, goal: row.goal, context: parse(row.context_json, {}),
    status: row.status, planIds: parse(row.plan_ids_json, []), checkpoint: parse(row.checkpoint_json, {}),
    approval: parse(row.approval_json), result: parse(row.result_json), error: row.error, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
export function listRuns(sessionId) {
  return db.prepare('SELECT id FROM agent_runs WHERE session_id=? ORDER BY created_at DESC LIMIT 30').all(Number(sessionId)).map(row => refreshRunState(row.id));
}
export function createRun(goal, context, ownerId = 'admin') {
  if (!Number.isSafeInteger(Number(context.sessionId)) || Number(context.sessionId) <= 0) throw Object.assign(new Error('持久任务需要有效会话'), { statusCode: 400 });
  harvestSecretValues(goal); harvestSecretValues(JSON.stringify(context));
  const id = 'run-' + randomUUID(), now = Date.now();
  try {
    db.prepare('INSERT INTO agent_runs(id,session_id,owner_id,goal,context_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, Number(context.sessionId), ownerId, String(redactSecretValue(goal)), safeJson(context), 'running', now, now);
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) throw Object.assign(new Error('本会话已有运行中的任务，请先查看或停止它'), { statusCode: 409 });
    throw error;
  }
  return getRun(id);
}
export function patchRun(id, patch) {
  const row = getRun(id);
  if (!row) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
  const next = { ...row, ...patch };
  db.prepare(`UPDATE agent_runs SET status=?,plan_ids_json=?,checkpoint_json=?,approval_json=?,result_json=?,error=?,revision=revision+1,updated_at=? WHERE id=?`)
    .run(next.status, safeJson(next.planIds), safeJson(next.checkpoint), next.approval ? safeJson(next.approval) : null,
      next.result ? safeJson(next.result) : null, next.error ? String(redactSecretValue(next.error)) : null, Date.now(), id);
  return getRun(id);
}
export function appendRunEvent(id, event) {
  // Tokens are live-only; bounded checkpoints and the final answer survive reconnect.
  if (['token', 'thinking', 'reasoning'].includes(event.type)) return;
  db.prepare('INSERT INTO agent_run_events(run_id,event_json,created_at) VALUES(?,?,?)').run(id, safeJson(event), Date.now());
  db.prepare('DELETE FROM agent_run_events WHERE run_id=? AND id NOT IN (SELECT id FROM agent_run_events WHERE run_id=? ORDER BY id DESC LIMIT 500)').run(id, id);
}
export function runEvents(id, after = 0) {
  return db.prepare('SELECT id,event_json,created_at FROM agent_run_events WHERE run_id=? AND id>? ORDER BY id LIMIT 500').all(id, Number(after) || 0)
    .map(row => ({ id: row.id, event: parse(row.event_json, {}), createdAt: row.created_at }));
}
export function runEffects(id) {
  return db.prepare('SELECT * FROM agent_run_effects WHERE run_id=? ORDER BY created_at,id').all(id)
    .map(row => ({ id: row.id, tool: row.tool_name, status: row.status, params: parse(row.params_json, {}), result: parse(row.result_json), evidence: parse(row.evidence_json), fingerprint: row.fingerprint }));
}
export function uncertainEffects(id) { refreshLinkedEffects(id); return runEffects(id).filter(effect => ['started', 'unknown'].includes(effect.status)); }

/** Called at the last boundary before a leaf tool mutates state. Fail closed on DB errors. */
export async function runDurableEffect(runId, tool, params, execute) {
  if (!runId) return execute();
  const run = getRun(runId);
  if (!run || !ACTIVE_RUN_STATES.has(run.status) || run.status === 'stopping') throw Object.assign(new Error('持久任务已停止，禁止继续写入'), { statusCode: 409 });
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  let key = db.prepare("SELECT value FROM settings WHERE key='agent.effect_signing_key'").get()?.value;
  if (!key) { key = randomBytes(32).toString('hex'); db.prepare("INSERT INTO settings(key,value) VALUES('agent.effect_signing_key',?)").run(key); }
  const owner = accountById(run.ownerId);
  if (!owner?.enabled || owner.role !== 'admin') throw Object.assign(new Error('任务发起者已失去管理员权限'), { statusCode: 403 });
  const fingerprint = createHmac('sha256', key).update(JSON.stringify(canonical(params))).digest('hex');
  refreshLinkedEffects(runId);
  const prior = db.prepare('SELECT * FROM agent_run_effects WHERE run_id=? AND tool_name=? AND fingerprint=?').get(runId, tool, fingerprint);
  if (prior?.status === 'resolved_failed') throw Object.assign(new Error('此步骤已核对为失败，不会自动重试；请检查证据并制定新方案'), { statusCode: 409 });
  if (prior?.status === 'resolved_applied') return { durableReplaySkipped: true, priorEffectId: prior.id, manuallyReconciled: true, evidence: parse(prior.evidence_json) };
  if (prior?.status === 'succeeded') return parse(prior.result_json);
  if (uncertainEffects(runId).length) throw Object.assign(new Error('已有写操作结果未知，必须先核对证据，禁止继续或重复写入'), { statusCode: 409 });
  const id = prior?.id || 'effect-' + randomUUID(), now = Date.now();
  db.prepare(`INSERT INTO agent_run_effects(id,run_id,tool_name,fingerprint,params_json,status,created_at,updated_at)
    VALUES(?,?,?,?,?,'started',?,?) ON CONFLICT(id) DO UPDATE SET status='started',result_json=NULL,evidence_json=NULL,updated_at=excluded.updated_at`)
    .run(id, runId, tool, fingerprint, safeJson(params), now, now);
  try {
    const result = await execute();
    const uncertain = result?.success === false || result?.ok === false || (typeof result?.exitCode === 'number' && result.exitCode !== 0);
    db.prepare('UPDATE agent_run_effects SET status=?,result_json=?,updated_at=? WHERE id=?').run(uncertain ? 'unknown' : 'succeeded', safeJson(result), Date.now(), id);
    return result;
  } catch (error) {
    db.prepare("UPDATE agent_run_effects SET status='unknown',result_json=?,updated_at=? WHERE id=?").run(safeJson({ error: error.message }), Date.now(), id);
    throw error;
  }
}
/** Refresh referenced executors from durable storage, never by dispatching a tool. */
export function refreshLinkedEffects(runId) {
  let pending = false;
  for (const effect of runEffects(runId)) {
    if (!['succeeded', 'unknown'].includes(effect.status) || effect.evidence?.manual) continue;
    const result = effect.result;
    if (!result?.operation?.id && !(result?.background && result.taskId)) continue;
    let updated, unknown, running = false;
    try {
      if (result.operation?.id) {
        const current = readDurableOperation(result.operation);
        const refs = [current, ...(current.relatedOperations || [])];
        unknown = refs.some(item => item.operation.needsReconciliation);
        running = refs.some(item => item.operation.running);
        updated = { ...result, operation: current.operation, verification: current.verification,
          relatedOperations: (current.relatedOperations || []).map(({ operation, verification }) => ({ operation, verification })) };
      } else {
        const task = getAgentBackgroundTask(result.taskId);
        if (!task || Number(task.sessionId) !== Number(getRun(runId).sessionId)) throw new Error('后台任务记录不可用');
        running = ['queued', 'running', 'stopping'].includes(task.status);
        unknown = ['outcome_unknown', 'stopped', 'failed'].includes(task.status);
        updated = { ...result, taskStatus: task.status, exitCode: task.exitCode, error: task.error,
          verification: { status: unknown ? 'unknown' : running ? 'pending' : task.status === 'completed' ? 'completed' : 'failed' } };
      }
    } catch { unknown = true; updated = { ...result, verification: { status: 'unknown', reason: '关联执行记录不可用，请核对实际资源；未重放。' } }; }
    pending ||= running;
    const status = unknown ? 'unknown' : 'succeeded';
    if (JSON.stringify(updated) !== JSON.stringify(result) || status !== effect.status) {
      db.prepare('UPDATE agent_run_effects SET status=?,result_json=?,evidence_json=?,updated_at=? WHERE id=?')
        .run(status, safeJson(updated), safeJson({ source: 'durable-executor', checkedAt: Date.now(), pending: running }), Date.now(), effect.id);
    }
  }
  return { pending };
}
export function resolveRunEffect(runId, effectId, { outcome, evidence }, actor) {
  const run = getRun(runId);
  if (!run || ACTIVE_RUN_STATES.has(run.status)) throw Object.assign(new Error('请先等待任务结束，再核对未知副作用'), { statusCode: 409 });
  if (!['applied', 'not_applied', 'failed'].includes(outcome) || typeof evidence !== 'string' || evidence.trim().length < 10 || evidence.length > 4000) {
    throw Object.assign(new Error('请记录实际资源检查证据（10–4000 字）和结论'), { statusCode: 400 });
  }
  if (refreshLinkedEffects(runId).pending) throw Object.assign(new Error('关联操作仍在执行，请等待其结算后核对'), { statusCode: 409 });
  const effect = runEffects(runId).find(item => item.id === effectId);
  if (!effect || !['unknown', 'started'].includes(effect.status)) throw Object.assign(new Error('该副作用不需要核对或已被更新'), { statusCode: 409 });
  const record = { outcome, evidence: evidence.trim(), actor, at: Date.now(), manual: true };
  return db.transaction(() => {
    db.prepare('UPDATE agent_run_effects SET status=?,evidence_json=?,updated_at=? WHERE id=?')
      .run(outcome === 'not_applied' ? 'resolved_not_applied' : outcome === 'applied' ? 'resolved_applied' : 'resolved_failed', safeJson(record), Date.now(), effectId);
    appendRunEvent(runId, { type: 'effect_reconciled', effectId, ...record });
    return patchRun(runId, { status: uncertainEffects(runId).length ? 'needs_reconciliation' : 'interrupted' });
  })();
}
export function recoverAgentRuns() {
  return db.transaction(() => {
    db.prepare("UPDATE agent_run_effects SET status='unknown',updated_at=? WHERE status='started'").run(Date.now());
    const rows = db.prepare("SELECT id FROM agent_runs WHERE status IN ('running','waiting_approval','stopping')").all();
    for (const row of rows) patchRun(row.id, { status: uncertainEffects(row.id).length ? 'needs_reconciliation' : 'interrupted', approval: null,
      error: '服务已重启。原审批已失效；继续前将核对已完成步骤。' });
    return rows.length;
  })();
}

export function refreshRunState(id) {
  const run = getRun(id);
  if (!run || ACTIVE_RUN_STATES.has(run.status)) return run;
  const linked = refreshLinkedEffects(id);
  if (runEffects(id).some(effect => ['started', 'unknown'].includes(effect.status))) {
    return run.status === 'needs_reconciliation' ? run : patchRun(id, { status: 'needs_reconciliation' });
  }
  if (linked.pending && run.status === 'completed') return patchRun(id, { status: 'awaiting_results' });
  if (!linked.pending && ['awaiting_results', 'needs_reconciliation'].includes(run.status)) return patchRun(id, { status: 'interrupted', error: '关联执行器已结算，请核对结果后继续。' });
  return run;
}
