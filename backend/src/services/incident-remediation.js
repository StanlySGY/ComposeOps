import db, { getProjectPreference } from '../lib/db.js';
import { issueOpsMandate, proposeOpsEffect, getOpsTicketDetail, startOpsEffect, heartbeatOpsEffect } from './ops-tickets.js';
import { getIncident, addIncidentEvidence, incidentError, INCIDENT_ACTION, INCIDENT_RECIPE, OBSERVATION_MAX_AGE_MS } from './incident-store.js';
import { getDockerForHost, getHost } from './docker-hosts.js';
import { hostRevision, containerSnapshot, withReadTimeout, PROJECT_LABEL } from './incident-observer.js';
import { withProjectOperationLock } from './project-operation-lock.js';
import { evaluateAgentPolicy, recordAgentAuditEvent, fingerprintAgentParams } from './agent/policy-store.js';
import { getSreProfile } from './sre-profiles.js';
import { runHttpProbe } from './sre-probes.js';
import { validateAutoAuthorization } from './sre-autonomy.js';

function policyParams(incident) {
  return { projectId: incident.projectId, hostId: incident.hostId, containerId: incident.resourceId };
}
function checkPolicy(incident, executionId = null) {
  for (const toolName of [INCIDENT_ACTION, 'container.restart', 'compose.restart']) {
    const decision = evaluateAgentPolicy({ toolName, projectId: incident.projectId, params: policyParams(incident) });
    if (executionId) recordAgentAuditEvent({ executionId, toolName, actor: 'sre-worker', eventType: 'policy_decision',
      decision: decision.decision, reason: decision.reason, ruleId: decision.ruleId,
      parametersHash: fingerprintAgentParams(policyParams(incident)), details: { incidentId: incident.id } });
    if (decision.decision === 'deny') throw incidentError('处置被拒绝策略阻止：' + decision.reason, 403);
  }
}
export function incidentTarget(incident) {
  return { projectId: incident.projectId, hostId: incident.hostId, composeProject: incident.projectName,
    resourceId: incident.resourceId, identity: incident.identity };
}
export function proposeIncidentRestart(id, actor = 'admin') {
  const incident = getIncident(id), detail = getOpsTicketDetail(id);
  const old = detail.effects.find(effect => effect.idempotencyKey === INCIDENT_RECIPE);
  if (old) {
    // Never adopt a generic/manual Effect by a client-controlled idempotency key.
    // An interrupted registration also fails closed and requires manual inspection.
    if (incident.effectId !== old.id) throw incidentError('处置记录未与故障关联，请在任务中人工核对，不能自动接管');
    return { effect: old, replayed: true };
  }
  if (incident.resolvedAt || incident.closedAt || !incident.latest.fault || incident.latest.error) throw incidentError('当前证据不足以生成重启处置，请等待有效故障观测');
  if (Date.now() - Date.parse(incident.observedAt) > OBSERVATION_MAX_AGE_MS) throw incidentError('故障证据已过期，请等待下一轮采集');
  if (!getProjectPreference(incident.projectId).managed) throw incidentError('项目已取消纳管，不能生成处置');
  if (hostRevision(getHost(incident.hostId)) !== incident.identity.hostRevision) throw incidentError('节点配置已变化，需要重新核对');
  if (!/^[a-f0-9]{64}$/i.test(incident.resourceId) || !incident.identity.createdAt || !incident.identity.engineId) throw incidentError('目标身份信息不完整');
  checkPolicy(incident);
  const mandate = issueOpsMandate(id, { scope: { projectIds: [incident.projectId], hostIds: [incident.hostId],
    resourceIds: [incident.resourceId], composeProjectNames: [incident.projectName] }, allowedActions: [INCIDENT_ACTION],
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }, actor);
  const proposed = proposeOpsEffect(id, { effectType: INCIDENT_ACTION, risk: 'high', mode: 'execute', mandateId: mandate.id,
    target: incidentTarget(incident), payload: { incidentId: id, recipeVersion: INCIDENT_RECIPE }, idempotencyKey: INCIDENT_RECIPE }, actor);
  db.prepare("UPDATE ops_incidents SET effect_id=?,status='awaiting_approval',updated_at=? WHERE id=?")
    .run(proposed.effect.id, new Date().toISOString(), id);
  addIncidentEvidence(id, 'proposal', '建议重启此容器一次，等待人工审批；随后独立验证健康', {
    effectId: proposed.effect.id, recipeVersion: INCIDENT_RECIPE, risk: 'high', timeoutSeconds: 10,
    limitation: '重启可能造成短暂中断，不修复错误配置或数据；每个事件最多派发一次，不自动重试。',
  });
  return proposed;
}

export function validateIncidentEffect(effect) {
  try {
    const incident = getIncident(effect.ticketId);
    if (['succeeded', 'failed', 'cancelled'].includes(getOpsTicketDetail(effect.ticketId).ticket.status)) throw incidentError('关联长期任务已结束，不能继续处置');
    if (effect.effectType !== INCIDENT_ACTION || effect.risk !== 'high' || effect.mode !== 'execute') throw incidentError('故障处置动作、风险或模式无效');
    if (incident.effectId !== effect.id || incident.resolvedAt || incident.closedAt) throw incidentError('该动作不属于未恢复的故障事件');
    if (JSON.stringify(effect.target) !== JSON.stringify(incidentTarget(incident))) throw incidentError('处置目标与故障身份快照不一致');
    if (JSON.stringify(effect.payload) !== JSON.stringify({ incidentId: incident.id, recipeVersion: INCIDENT_RECIPE })) throw incidentError('处置参数不符合已登记流程');
    if (effect.idempotencyKey !== INCIDENT_RECIPE || effect.startedAt) throw incidentError('故障处置不能重复派发，请人工核对');
    validateAutoAuthorization(effect);
    return '';
  } catch (error) { return error.message; }
}

/** The durable ledger is the only dispatcher. No side effect is invoked before the project lock, identity and approval checks. */
export async function executeIncidentRestart(effect, { workerId, dockerForHost = getDockerForHost, hostForId = getHost,
  onStarted = () => {}, restartTimeoutMs = 45000, probe = runHttpProbe } = {}) {
  return withProjectOperationLock(effect.target.projectId, async () => {
    const invalid = validateIncidentEffect(effect);
    if (invalid) throw incidentError(invalid);
    const incident = getIncident(effect.ticketId);
    if (!getProjectPreference(incident.projectId).managed) throw incidentError('项目已取消纳管');
    if (hostRevision(hostForId(incident.hostId)) !== incident.identity.hostRevision) throw incidentError('节点配置已变化');
    const docker = dockerForHost(incident.hostId);
    const info = await withReadTimeout(docker.info());
    if (info.ID !== incident.identity.engineId) throw incidentError('Docker Engine 身份已变化');
    const container = docker.getContainer(incident.resourceId);
    const item = await withReadTimeout(container.inspect());
    if (item.Id !== incident.resourceId || item.Created !== incident.identity.createdAt || item.Config?.Labels?.[PROJECT_LABEL] !== incident.projectName) throw incidentError('容器身份或项目归属已变化');
    let fault = containerSnapshot(item).fault;
    if (incident.identity.probe) {
      const profile = getSreProfile(incident.identity.probe.profileId);
      if (!profile.enabled || profile.version !== incident.identity.probe.version || profile.engineId !== info.ID || profile.hostRevision !== incident.identity.hostRevision || profile.hostId !== incident.hostId || profile.projectId !== incident.projectId
        || profile.serviceName !== item.Config?.Labels?.['com.docker.compose.service']) throw incidentError('应用探针目标或版本已变化');
      const currentProbe = await probe(profile.config);
      if (currentProbe.outcome === 'unknown') throw incidentError('无法复核应用探针，取消派发');
      if (String(effect.approvedBy).startsWith('sre-policy:')) {
        const replicas = await withReadTimeout(docker.listContainers({ all: true, filters: { label: [`${PROJECT_LABEL}=${incident.projectName}`, `com.docker.compose.service=${profile.serviceName}`] } }));
        if (replicas.length !== 1 || replicas[0].Id !== incident.resourceId || currentProbe.outcome !== 'bad') throw incidentError('自动处置只接受持续探针失败的单副本服务');
      }
      fault ||= currentProbe.outcome === 'bad' ? '应用探针失败' : '';
    }
    if (!fault) throw incidentError('目标当前没有可处置故障，取消旧处置');
    if (hostRevision(hostForId(incident.hostId)) !== incident.identity.hostRevision || !getProjectPreference(incident.projectId).managed) throw incidentError('执行前节点或纳管范围发生变化');
    checkPolicy(incident, effect.id);
    // Recheck after async reads, then atomically transition the existing ledger before invoking Docker.
    const rechecked = validateIncidentEffect(effect);
    if (rechecked) throw incidentError(rechecked);
    heartbeatOpsEffect(effect.id, workerId);
    startOpsEffect(effect.id, workerId);
    onStarted();
    addIncidentEvidence(incident.id, 'execution', '授权已复核，正在重启指定容器一次', { effectId: effect.id, actor: effect.approvedBy });
    recordAgentAuditEvent({ executionId: effect.id, eventType: 'execution_started', actor: effect.approvedBy,
      toolName: INCIDENT_ACTION, decision: 'approved', details: { incidentId: incident.id, recipeVersion: INCIDENT_RECIPE } });
    let timer;
    try {
      await Promise.race([container.restart({ t: 10 }), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('重启响应超时，实际执行结果未知')), restartTimeoutMs);
      })]);
    } catch (error) {
      // An HTTP error does not prove Docker did not perform the restart.
      throw Object.assign(error, { outcomeUnknown: true });
    } finally { clearTimeout(timer); }
    addIncidentEvidence(incident.id, 'execution_acknowledged', 'Docker 已确认重启请求完成，等待独立健康验收', { effectId: effect.id });
    recordAgentAuditEvent({ executionId: effect.id, eventType: 'execution_result', actor: 'sre-worker', toolName: INCIDENT_ACTION,
      decision: 'awaiting_verification', details: { incidentId: incident.id, dispatched: true, verified: false } });
    db.prepare("UPDATE ops_incidents SET healthy_count=0,healthy_since=NULL,status='verifying',updated_at=? WHERE id=?")
      .run(new Date().toISOString(), incident.id);
    return { recipeVersion: INCIDENT_RECIPE, readOnly: false, dispatched: true, verified: false, incidentId: incident.id,
      message: '重启请求已完成；只有后续健康观测通过才会标记恢复。' };
  });
}
