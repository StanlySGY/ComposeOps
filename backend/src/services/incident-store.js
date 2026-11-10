import { createHash } from 'node:crypto';
import db from '../lib/db.js';
import { harvestSecretValues, redactSecretValue } from '../lib/secret-redactor.js';
import { createOpsTicket, getOpsTicketDetail, cancelOpsEffect, submitOpsReport } from './ops-tickets.js';
import { recordEvent } from './event-center.js';
import { recordAgentAuditEvent } from './agent/policy-store.js';

export const INCIDENT_RECIPE = 'container-restart-v1';
export const INCIDENT_ACTION = 'incident.restart';
export const HEALTHY_SAMPLES = 3;
export const HEALTHY_WINDOW_MS = 30_000;
export const OBSERVATION_MAX_AGE_MS = 60_000;
const parse = (value) => JSON.parse(value || '{}');
export function safeIncidentData(value) {
  harvestSecretValues(JSON.stringify(value));
  // JSON escaping hides newline assignment boundaries; harvest the original text too.
  const visit = item => {
    if (typeof item === 'string') harvestSecretValues(item);
    else if (item && typeof item === 'object') Object.values(item).forEach(visit);
  };
  visit(value);
  return redactSecretValue(value);
}
const json = (value) => JSON.stringify(safeIncidentData(value));
export function incidentError(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode, code: 'incident_conflict' });
}
function mapIncident(row) {
  if (!row) return null;
  return {
    id: row.id, ticketId: row.id, hostId: row.host_id, projectId: row.project_id,
    resourceId: row.resource_id, projectName: row.project_name, serviceName: row.service_name,
    title: row.title, status: row.status, identity: parse(row.identity_json), latest: parse(row.latest_json),
    diagnosis: row.diagnosis, diagnosisAt: row.diagnosis_at, diagnosisError: row.diagnosis_error,
    effectId: row.effect_id, healthyCount: row.healthy_count, healthySince: row.healthy_since,
    verification: parse(row.verification_json), openedAt: row.opened_at, observedAt: row.observed_at,
    resolvedAt: row.resolved_at, updatedAt: row.updated_at,
  };
}
export function getIncident(id) {
  const incident = mapIncident(db.prepare('SELECT * FROM ops_incidents WHERE id=?').get(String(id)));
  if (!incident) throw incidentError('故障事件不存在', 404);
  return incident;
}
export function listIncidents({ hostId = '', status = '', limit = 100 } = {}) {
  const conditions = [], args = [];
  if (hostId) { conditions.push('host_id=?'); args.push(hostId); }
  if (status === 'open') conditions.push('resolved_at IS NULL');
  else if (status) { conditions.push('status=?'); args.push(status); }
  return db.prepare(`SELECT * FROM ops_incidents ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
    ORDER BY resolved_at IS NOT NULL, updated_at DESC LIMIT ?`)
    .all(...args, Math.max(1, Math.min(Number(limit) || 100, 200))).map(mapIncident);
}
export function incidentStats() {
  const rows = db.prepare('SELECT status,COUNT(*) AS count FROM ops_incidents GROUP BY status').all();
  const stats = { open: 0, approvals: 0, verifying: 0, resolved: 0 };
  for (const row of rows) {
    if (row.status === 'resolved') stats.resolved += row.count; else stats.open += row.count;
    if (row.status === 'awaiting_approval') stats.approvals += row.count;
    if (row.status === 'verifying') stats.verifying += row.count;
  }
  return stats;
}
export function getIncidentDetail(id) {
  const incident = getIncident(id), ticket = getOpsTicketDetail(id);
  return { incident, ...ticket, evidence: db.prepare('SELECT * FROM ops_incident_evidence WHERE incident_id=? ORDER BY id DESC LIMIT 100').all(id)
    .map(row => ({ id: row.id, kind: row.kind, summary: row.summary, data: parse(row.data_json), observedAt: row.observed_at })) };
}
export function addIncidentEvidence(id, kind, summary, data = {}, at = new Date().toISOString()) {
  db.prepare('INSERT INTO ops_incident_evidence(incident_id,kind,summary,data_json,observed_at) VALUES(?,?,?,?,?)')
    .run(id, kind, String(redactSecretValue(summary)).slice(0, 2000), json(data), at);
  // Keep the first observation and the latest 100 records; long incidents stay bounded.
  db.prepare(`DELETE FROM ops_incident_evidence WHERE incident_id=? AND id NOT IN
    (SELECT id FROM ops_incident_evidence WHERE incident_id=? ORDER BY id DESC LIMIT 100)
    AND id<>(SELECT MIN(id) FROM ops_incident_evidence WHERE incident_id=?)`).run(id, id, id);
}
export function recordIncidentObservation({ project, snapshot, identity, at = new Date().toISOString() }) {
  const key = createHash('sha256').update(JSON.stringify([project.hostId, project.id, snapshot.id])).digest('hex');
  let incident = mapIncident(db.prepare('SELECT * FROM ops_incidents WHERE correlation_key=? AND resolved_at IS NULL').get(key));
  if (!incident) {
    if (!snapshot.fault) return null;
    const previous = db.prepare('SELECT id FROM ops_incidents WHERE correlation_key=? ORDER BY rowid DESC LIMIT 1').get(key);
    const title = `${project.projectName} / ${snapshot.name || snapshot.id.slice(0, 12)}：${snapshot.fault}`.slice(0, 200);
    const { ticket } = createOpsTicket({ title, description: 'AI 值守发现故障；诊断、处置和恢复验证记录于本任务。',
      sourceType: 'event', sourceId: key, hostId: project.hostId, projectId: project.id, priority: 'high',
      idempotencyKey: `incident:${key}:${previous?.id || 'initial'}`,
      acceptanceCriteria: ['原节点与原容器身份一致', '连续三次健康观测，持续至少 30 秒', '写操作结果明确，验证证据可追溯'],
    }, 'sre-observer');
    db.prepare(`INSERT INTO ops_incidents(id,correlation_key,host_id,project_id,resource_id,project_name,service_name,
      title,identity_json,latest_json,opened_at,observed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(ticket.id, key, project.hostId, project.id, snapshot.id, project.projectName, snapshot.service || '',
        title, json(identity), json(snapshot), at, at, at);
    db.prepare("UPDATE ops_tickets SET status='active',updated_at=? WHERE id=?").run(at, ticket.id);
    addIncidentEvidence(ticket.id, 'detected', title, snapshot, at);
    recordEvent({ source: 'sre', eventType: 'incident', severity: 'danger', title, detail: '已创建持久故障事件，等待调查与处置',
      assetName: project.projectName, payload: { incidentId: ticket.id, projectId: project.id, resourceId: snapshot.id, hostId: project.hostId, target: '/oncall?incident=' + ticket.id } });
    incident = getIncident(ticket.id);
  }
  return updateIncidentObservation(incident.id, snapshot, identity, at);
}

export function updateIncidentObservation(id, snapshot, identity, at = new Date().toISOString()) {
  const incident = getIncident(id);
  if (incident.resolvedAt || Date.parse(at) < Date.parse(incident.observedAt)) return incident;
  const detail = getOpsTicketDetail(id), effect = detail.effects.find(item => item.id === incident.effectId);
  const identityMatches = JSON.stringify(identity) === JSON.stringify(incident.identity);
  const healthy = identityMatches && snapshot.healthy === true && !snapshot.error;
  const gap = Date.parse(at) - Date.parse(incident.observedAt);
  const continuous = healthy && gap <= OBSERVATION_MAX_AGE_MS && incident.latest.healthy === true && !incident.latest.error;
  const stableRuntime = continuous && snapshot.startedAt === incident.latest.startedAt && snapshot.restartCount === incident.latest.restartCount;
  // HTTP refreshes cannot accelerate a recovery window or inflate the sample count.
  const counted = gap >= 10_000 && (!snapshot.probe || snapshot.probe.sampleId !== incident.latest.probe?.sampleId);
  const count = healthy ? (stableRuntime ? incident.healthyCount + (counted ? 1 : 0) : 1) : 0;
  const since = healthy ? (stableRuntime ? incident.healthySince || at : at) : null;
  const verification = { healthy, samples: count, requiredSamples: HEALTHY_SAMPLES, windowMs: since ? Date.parse(at) - Date.parse(since) : 0,
    requiredWindowMs: HEALTHY_WINDOW_MS, scope: snapshot.probe ? 'application_http' : snapshot.health ? 'container_healthcheck' : 'container_running',
    reason: !identityMatches ? '目标身份发生变化，需要人工重新核对' : snapshot.error || snapshot.fault || '' };
  let status = 'investigating';
  if (effect) status = ({ awaiting_approval: 'awaiting_approval', queued: 'queued', leased: 'queued', executing: 'executing',
    succeeded: 'verifying', outcome_unknown: 'needs_attention', failed: 'needs_attention', rejected: 'needs_attention', cancelled: 'needs_attention' })[effect.status] || 'investigating';
  if (!identityMatches || snapshot.error) status = 'needs_attention';
  const knownOutcome = !effect || ['succeeded', 'failed', 'cancelled', 'rejected'].includes(effect.status);
  const resolved = healthy && count >= HEALTHY_SAMPLES && verification.windowMs >= HEALTHY_WINDOW_MS && knownOutcome;
  if (healthy && !effect && !resolved) status = 'verifying';
  if (resolved) status = 'resolved';
  if (effect?.status === 'succeeded' && !healthy && Date.parse(at) - Date.parse(effect.finishedAt) >= 120_000) {
    status = 'needs_attention'; verification.reason ||= '处置后两分钟仍未通过健康验证';
  }
  // A recovered target must not receive a stale, queued repair.
  if (healthy && effect && ['awaiting_approval', 'queued'].includes(effect.status)) cancelOpsEffect(id, effect.id, '观测到容器恢复，取消待执行处置', 'sre-observer');
  // Persist the report before closing the incident. A crash between these writes is replay-safe.
  if (resolved && !detail.reports.some(report => report.reportType === 'incident-verification')) {
    submitOpsReport(id, { reportType: 'incident-verification', summary: `故障恢复验证通过。验证范围：${snapshot.probe ? '应用 HTTP 探针及容器运行状态' : snapshot.health ? 'Docker 健康检查' : '容器进程存活，未配置应用健康检查'}。`,
      evidence: [{ kind: 'incident', sourceId: id, observedAt: at, summary: `连续 ${count} 次健康观测，持续 ${Math.round(verification.windowMs / 1000)} 秒。` }],
    }, 'sre-verifier');
  }
  db.prepare(`UPDATE ops_incidents SET latest_json=?,observed_at=?,updated_at=?,healthy_count=?,healthy_since=?,
    verification_json=?,status=?,resolved_at=? WHERE id=? AND resolved_at IS NULL`)
    .run(json(snapshot), at, at, count, since, json(verification), status, resolved ? at : null, id);
  const changed = incident.latest.fault !== snapshot.fault || incident.latest.error !== snapshot.error
    || incident.latest.healthy !== snapshot.healthy || status !== incident.status || counted && healthy;
  if (changed) addIncidentEvidence(id, resolved ? 'recovered' : 'observation', resolved ? '独立观测已验证恢复' : verification.reason || '正在验证恢复', { snapshot, verification }, at);
  if (resolved) {
    if (effect) recordAgentAuditEvent({ executionId: effect.id, eventType: 'post_check', actor: 'sre-verifier', toolName: INCIDENT_ACTION,
      decision: 'passed', details: { incidentId: id, verification } });
    recordEvent({ source: 'sre', eventType: 'incident', severity: 'info', title: `${incident.projectName} 故障已验证恢复`,
      detail: '恢复证据已保存，长期任务报告可继续人工验收。', assetName: incident.projectName,
      payload: { incidentId: id, hostId: incident.hostId, projectId: incident.projectId, resourceId: incident.resourceId, target: '/oncall?incident=' + id } });
  }
  return getIncident(id);
}
