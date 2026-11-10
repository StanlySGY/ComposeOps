import { randomUUID } from 'node:crypto';
import db, { getProjectPreference } from '../lib/db.js';
import { getSreProfile } from './sre-profiles.js';
import { latestProbe } from './sre-probes.js';
import { getHost } from './docker-hosts.js';
import { hostRevision } from './incident-observer.js';
import { incidentError, getIncident, addIncidentEvidence } from './incident-store.js';
import { approveOpsEffect } from './ops-tickets.js';
import { recordAgentAuditEvent } from './agent/policy-store.js';

const map = row => row && ({ id: row.id, profileId: row.profile_id, version: row.version, profileVersion: row.profile_version,
  enabled: !!row.enabled, expiresAt: row.expires_at, cooldownMs: row.cooldown_ms, maxDaily: row.max_daily,
  maintenanceUntil: row.maintenance_until, approvedBy: row.approved_by, approvedAt: row.approved_at, updatedAt: row.updated_at });
export function getAutonomyPolicy(profileId) { return map(db.prepare('SELECT * FROM sre_autonomy_policies WHERE profile_id=?').get(profileId)) || null; }
export function saveAutonomyPolicy(profileId, input, actor = 'admin', now = Date.now()) {
  const profile = getSreProfile(profileId), previous = getAutonomyPolicy(profileId);
  if (input.version !== (previous?.version || 0)) throw incidentError('授权版本已变化，请刷新后重新审阅');
  if (typeof input.enabled !== 'boolean') throw incidentError('授权启用状态无效', 400);
  if (!input.enabled) {
    if (!previous) return null;
    db.prepare('UPDATE sre_autonomy_policies SET enabled=0,version=version+1,updated_at=? WHERE id=?').run(now, previous.id);
  } else {
    if (input.confirm !== 'ENABLE_AUTONOMY') throw incidentError('请明确确认应用自动重启授权', 400);
    if (!profile.enabled || !getProjectPreference(profile.projectId).managed || hostRevision(getHost(profile.hostId)) !== profile.hostRevision) throw incidentError('目标未启用、未纳管或节点已变化');
    const expiresAt = Number(input.expiresAt), cooldownMs = Number(input.cooldownMs), maxDaily = Number(input.maxDaily), maintenanceUntil = Number(input.maintenanceUntil || 0);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 30 * 86400000) throw incidentError('授权期限须在未来 30 天以内', 400);
    if (!Number.isInteger(cooldownMs) || cooldownMs < 300000 || cooldownMs > 86400000) throw incidentError('冷却期须为 5 分钟至 24 小时', 400);
    if (!Number.isInteger(maxDaily) || maxDaily < 1 || maxDaily > 10) throw incidentError('每 24 小时预算须为 1 至 10 次', 400);
    if (!Number.isSafeInteger(maintenanceUntil) || maintenanceUntil < 0 || maintenanceUntil > now + 30 * 86400000) throw incidentError('维护窗口无效', 400);
    db.prepare(`INSERT INTO sre_autonomy_policies(id,profile_id,profile_version,enabled,expires_at,cooldown_ms,max_daily,maintenance_until,approved_by,approved_at,updated_at)
      VALUES(?,?,?,1,?,?,?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET version=version+1,profile_version=excluded.profile_version,enabled=1,
      expires_at=excluded.expires_at,cooldown_ms=excluded.cooldown_ms,max_daily=excluded.max_daily,maintenance_until=excluded.maintenance_until,
      approved_by=excluded.approved_by,approved_at=excluded.approved_at,updated_at=excluded.updated_at`)
      .run(previous?.id || 'srea_' + randomUUID(), profileId, profile.version, expiresAt, cooldownMs, maxDaily, maintenanceUntil, actor, now, now);
  }
  const policy = getAutonomyPolicy(profileId);
  recordAgentAuditEvent({ executionId: policy.id, eventType: 'sre_autonomy_authorized', actor, toolName: 'incident.restart', decision: policy.enabled ? 'allow_bounded' : 'disabled', details: policy });
  return policy;
}
function policyValid(policy, profile, now) {
  if (!policy?.enabled || !profile.enabled || policy.profileVersion !== profile.version || policy.expiresAt <= now || policy.maintenanceUntil > now) throw incidentError('应用自动处置授权未生效、已过期、版本改变或处于维护窗口');
  if (!getProjectPreference(profile.projectId).managed || hostRevision(getHost(profile.hostId)) !== profile.hostRevision) throw incidentError('应用或节点不再处于授权范围');
}
export function validateAutoAuthorization(effect, now = Date.now()) {
  const row = db.prepare('SELECT * FROM sre_auto_authorizations WHERE effect_id=?').get(effect.id);
  if (!row) {
    if (String(effect.approvedBy || '').startsWith('sre-policy:')) throw incidentError('自动审批缺少持久授权记录');
    return;
  }
  const policy = map(db.prepare('SELECT * FROM sre_autonomy_policies WHERE id=?').get(row.policy_id));
  if (!policy || policy.version !== row.policy_version) throw incidentError('自动处置授权已撤销或改变');
  const profile = getSreProfile(policy.profileId);
  policyValid(policy, profile, now);
  if (profile.engineId !== effect.target.identity?.engineId || profile.hostRevision !== effect.target.identity?.hostRevision) throw incidentError('自动处置目标超出授权节点身份');
  if (effect.approvedBy !== 'sre-policy:' + policy.id || row.incident_id !== effect.ticketId || row.target_json !== JSON.stringify(effect.target)
    || row.profile_version !== profile.version || row.state !== 'queued') throw incidentError('自动处置与已批准范围不一致');
}
export async function considerAutomaticRecovery(incidentId, { now = Date.now() } = {}) {
  const incident = getIncident(incidentId);
  const profileId = incident.latest.probe?.profileId;
  if (!profileId || incident.resolvedAt || incident.effectId || incident.latest.error || !incident.latest.fault || now - Date.parse(incident.openedAt) < 30000) return null;
  const profile = getSreProfile(profileId), policy = getAutonomyPolicy(profileId), sample = latestProbe(profile);
  if (!policy?.enabled) return null;
  if (profile.engineId !== incident.identity.engineId || profile.hostRevision !== incident.identity.hostRevision || incident.identity.probe?.version !== profile.version) return null;
  // Only a single-replica service can use this recipe automatically. A service endpoint
  // cannot identify the broken replica in a replicated service; that requires an operator.
  if (incident.latest.probe.replicas !== 1 || !sample?.fault || now - sample.at > 60000) return null;
  try { policyValid(policy, profile, now); } catch { return null; }
  const target = { projectId: incident.projectId, hostId: incident.hostId, composeProject: incident.projectName, resourceId: incident.resourceId, identity: incident.identity };
  const reserved = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM sre_auto_authorizations WHERE incident_id=?').get(incidentId)) return false;
    const recent = db.prepare('SELECT reserved_at FROM sre_auto_authorizations WHERE policy_id=? AND reserved_at>? ORDER BY reserved_at DESC').all(policy.id, now - 86400000);
    if (recent.length >= policy.maxDaily || recent[0] && now - recent[0].reserved_at < policy.cooldownMs) return false;
    const unresolved = db.prepare(`SELECT 1 FROM sre_auto_authorizations a JOIN ops_incidents i ON i.id=a.incident_id
      WHERE i.project_id=? AND i.host_id=? AND i.resolved_at IS NULL LIMIT 1`).get(incident.projectId, incident.hostId);
    if (unresolved) return false;
    db.prepare('INSERT INTO sre_auto_authorizations(incident_id,policy_id,policy_version,profile_version,target_json,reserved_at) VALUES(?,?,?,?,?,?)')
      .run(incidentId, policy.id, policy.version, profile.version, JSON.stringify(target), now);
    return true;
  })();
  if (!reserved) return null;
  try {
    const { proposeIncidentRestart } = await import('./incident-remediation.js');
    // No async boundary exists between the proposal, policy recheck, durable binding and approval.
    const { effect } = proposeIncidentRestart(incidentId, 'sre-policy:' + policy.id);
    const current = getAutonomyPolicy(profileId);
    if (current.version !== policy.version) throw incidentError('自动处置授权已改变');
    policyValid(current, getSreProfile(profileId), Date.now());
    db.prepare("UPDATE sre_auto_authorizations SET effect_id=?,state='queued' WHERE incident_id=?").run(effect.id, incidentId);
    approveOpsEffect(incidentId, effect.id, 'sre-policy:' + policy.id);
    addIncidentEvidence(incidentId, 'policy_approval', '应用预授权允许本次单容器重启', { policyId: policy.id, version: policy.version, approvedBy: policy.approvedBy,
      maxDaily: policy.maxDaily, cooldownMs: policy.cooldownMs, expiresAt: policy.expiresAt, effectId: effect.id });
    recordAgentAuditEvent({ executionId: effect.id, eventType: 'sre_auto_approval', actor: policy.approvedBy, toolName: 'incident.restart', decision: 'approved_by_policy', details: { policyId: policy.id, policyVersion: policy.version, incidentId } });
    return effect;
  } catch (error) {
    db.prepare("UPDATE sre_auto_authorizations SET state='blocked',reason=? WHERE incident_id=?").run('自动处置登记未完成，须人工核对', incidentId);
    addIncidentEvidence(incidentId, 'automation_blocked', '自动处置未派发，请人工核对策略与任务', { policyId: policy.id });
    throw error;
  }
}
