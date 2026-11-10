import { createHash } from 'node:crypto';
import db, { getSetting, setSetting } from '../lib/db.js';
import { getDockerForHost, getHost } from './docker-hosts.js';
import { scanAllProjects } from './scanner.js';
import { readContainerLogs } from '../lib/docker-exec.js';
import { getAiConfig, callOpenAI, fenceUntrusted, newFenceNonce, UNTRUSTED_GUARD } from './ai.js';
import { isGuardianEnabled } from './guardian.js';
import { getIncident, recordIncidentObservation, updateIncidentObservation, addIncidentEvidence, safeIncidentData, incidentError } from './incident-store.js';
import { listSreProfiles } from './sre-profiles.js';
import { createProbeRunner, probeSnapshot } from './sre-probes.js';
import { considerAutomaticRecovery } from './sre-autonomy.js';
let activeDiagnoses = 0;

export const PROJECT_LABEL = 'com.docker.compose.project';
export const SERVICE_LABEL = 'com.docker.compose.service';
export function hostRevision(host) {
  if (!host) throw incidentError('故障所属节点已删除');
  // Connection revision without credentials or hashes derived from credentials.
  return createHash('sha256').update(JSON.stringify([host.id, host.type, host.host, host.port, host.username, host.hostFingerprint, host.updatedAt])).digest('hex');
}
export function containerSnapshot(item) {
  const state = item.State || {}, health = state.Health?.Status || null;
  const fault = health === 'unhealthy' ? '健康检查失败' : state.Restarting ? '容器反复重启'
    : !state.Running && state.OOMKilled ? '内存不足退出'
      : !state.Running && Number(state.ExitCode) !== 0 ? `异常退出（${state.ExitCode}）` : '';
  return safeIncidentData({ id: item.Id, name: String(item.Name || '').replace(/^\//, ''),
    service: item.Config?.Labels?.[SERVICE_LABEL] || '', image: item.Config?.Image || '',
    state: state.Status || 'unknown', running: !!state.Running, health,
    healthy: state.Running === true && !state.Restarting && !state.Paused && (!health || health === 'healthy'),
    exitCode: state.ExitCode, oomKilled: !!state.OOMKilled, restartCount: item.RestartCount || 0,
    startedAt: state.StartedAt || null, finishedAt: state.FinishedAt || null, fault });
}
export async function withReadTimeout(work, timeoutMs = 8000) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(incidentError('Docker 观测超时')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

export function createIncidentObserver({ scan = scanAllProjects, dockerForHost = getDockerForHost, hostForId = getHost,
  now = () => Date.now(), pollMs = 15000, logger = console, diagnose = diagnoseIncident, probeRunner = createProbeRunner(), autoRecover = considerAutomaticRecovery } = {}) {
  let timer = null, pending = null, stopped = true;
  let probePending = null;
  let generation = 0;
  async function collect() {
    const currentGeneration = generation;
    // HTTP endpoints have their own bounded queue; a slow endpoint cannot stop Docker observations.
    probePending = probeRunner.runOnce({ isCurrent: () => currentGeneration === generation }).catch(error => logger.warn?.({ error: String(safeIncidentData(error.message)) }, '应用探针采集失败'));
    const projects = await withReadTimeout(scan(), 10000);
    if (currentGeneration !== generation) return;
    const profiles = listSreProfiles();
    const open = db.prepare('SELECT id FROM ops_incidents WHERE resolved_at IS NULL').all().map(row => getIncident(row.id));
    const targets = new Map();
    for (const project of projects.filter(item => item.managed)) {
      for (const container of project.containers || []) targets.set(`${project.hostId}:${container.id}`, { project, resourceId: container.id });
    }
    for (const incident of open) {
      const key = `${incident.hostId}:${incident.resourceId}`;
      const target = targets.get(key);
      if (target) target.incident = incident;
      else targets.set(key, { incident, resourceId: incident.resourceId,
        project: { id: incident.projectId, projectName: incident.projectName, hostId: incident.hostId } });
    }
    const infos = new Map();
    let observed = 0, failures = 0;
    // Bound Docker pressure while ensuring one unreachable node cannot stall all others.
    const queue = [...targets.values()];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        if (currentGeneration !== generation) break;
        const { project, resourceId, incident } = queue.shift();
        try {
          const revision = hostRevision(hostForId(project.hostId));
          const docker = dockerForHost(project.hostId);
          if (!infos.has(project.hostId)) infos.set(project.hostId, withReadTimeout(docker.info()));
          const info = await infos.get(project.hostId);
          if (!info?.ID) throw incidentError('无法核对 Docker Engine 身份');
          const item = await withReadTimeout(docker.getContainer(resourceId).inspect());
          if (currentGeneration !== generation) break;
          if (hostRevision(hostForId(project.hostId)) !== revision) throw incidentError('采集期间节点配置已变化');
          if (item.Id !== resourceId || item.Config?.Labels?.[PROJECT_LABEL] !== project.projectName) throw incidentError('容器身份或项目归属发生变化');
          const identity = { hostRevision: revision, engineId: info.ID, containerId: item.Id, createdAt: item.Created, composeProject: project.projectName };
          let snapshot = containerSnapshot(item);
          const profile = profiles.find(profile => profile.hostId === project.hostId && profile.projectId === project.id && profile.serviceName === snapshot.service);
          if (profile && (profile.enabled || incident?.identity.probe)) {
            snapshot = probeSnapshot(profile, snapshot, now());
            if (profile.engineId !== info.ID || profile.hostRevision !== revision) { snapshot.healthy = false; snapshot.error = '应用目标的 Docker 节点身份发生变化，请重新审阅目标'; }
            snapshot.probe.replicas = project.containers?.filter(container => container.service === snapshot.service).length || 0;
            identity.probe = { profileId: profile.id, version: profile.version };
          }
          const result = recordIncidentObservation({ project, snapshot, identity, at: new Date(now()).toISOString() });
          observed += 1;
          if (result && !result.resolvedAt && !incident) {
            try {
              const logs = await withReadTimeout(readContainerLogs(docker.getContainer(resourceId), 100));
              if (currentGeneration !== generation) break;
              addIncidentEvidence(result.id, 'logs', '发现故障时的最近日志（已脱敏）', { logs: String(safeIncidentData(logs)).slice(-16000) });
            } catch (error) { if (currentGeneration === generation) addIncidentEvidence(result.id, 'logs_unavailable', '日志采集失败', { error: error.message }); }
          }
          if (result && !result.resolvedAt && !result.diagnosis && isGuardianEnabled() && activeDiagnoses < 2) {
            void diagnose(result.id).catch(error => logger.warn?.({ error: String(safeIncidentData(error.message)) }, 'AI 值守诊断暂未完成'));
          }
          if (result && !result.resolvedAt && currentGeneration === generation) {
            try { await autoRecover(result.id); } catch (error) { logger.warn?.({ error: String(safeIncidentData(error.message)) }, '自动处置未派发'); }
          }
        } catch (error) {
          if (currentGeneration !== generation) break;
          failures += 1;
          if (incident) updateIncidentObservation(incident.id, { ...incident.latest, healthy: false, error: String(safeIncidentData(error.message)) }, incident.identity, new Date(now()).toISOString());
        }
      }
    }));
    const status = { observed, failures, checkedAt: new Date(now()).toISOString() };
    if (currentGeneration === generation) setSetting('sre.last_observation', JSON.stringify(status));
    return status;
  }
  function runOnce() {
    if (!pending) pending = collect().finally(() => { pending = null; });
    return pending;
  }
  function tick() {
    const currentGeneration = generation;
    if (!stopped) void runOnce().catch(error => {
      if (stopped || currentGeneration !== generation) return;
      setSetting('sre.last_observation', JSON.stringify({ checkedAt: new Date(now()).toISOString(), error: String(safeIncidentData(error.message)) }));
      logger.error?.('AI 值守采集失败：' + String(safeIncidentData(error.message)));
    });
  }
  return { runOnce, start() { if (!stopped) return; stopped = false; tick(); timer = setInterval(tick, Math.max(15000, pollMs)); timer.unref?.(); },
    stop() { stopped = true; generation += 1; clearInterval(timer); timer = null; return Promise.allSettled([pending, probePending]); } };
}

export async function diagnoseIncident(id, { call = callOpenAI, config = getAiConfig(), now = Date.now() } = {}) {
  const incident = getIncident(id);
  if (incident.resolvedAt) throw incidentError('故障已恢复，可查看已有证据和诊断');
  if (!config.apiKey) throw incidentError('请先配置 AI 服务；只读值守与人工处置仍可使用', 400);
  if (activeDiagnoses >= 2) throw incidentError('已有两个事件正在诊断，请稍后重试', 429);
  const lease = now + 120000;
  const claimed = db.prepare(`UPDATE ops_incidents SET diagnosis_lease_until=? WHERE id=? AND diagnosis_lease_until<=?
    AND (diagnosis_at IS NULL OR diagnosis_at<=?)`).run(lease, id, now, new Date(now - 600000).toISOString());
  if (!claimed.changes) throw incidentError('该事件正在诊断或刚完成诊断，请稍后查看');
  activeDiagnoses += 1;
  try {
    const evidence = db.prepare('SELECT id,kind,data_json,observed_at FROM ops_incident_evidence WHERE incident_id=? ORDER BY id DESC LIMIT 12').all(id);
    const context = safeIncidentData({ incident, evidence: evidence.map(row => ({ id: row.id, kind: row.kind, data: JSON.parse(row.data_json), observedAt: row.observed_at })) });
    const nonce = newFenceNonce();
    const result = await withReadTimeout(call({ ...config, stream: false, messages: [
      { role: 'system', content: `你是 ComposeOps 的 AI 值守员。只分析证据，不执行动作。根因是假设而非事实；引用证据编号和时间，缺失证据必须说明。给出影响、最多三条处置建议及风险。不要声称已恢复，恢复由独立健康观测判定。${UNTRUSTED_GUARD}` },
      { role: 'user', content: '请用中文给出：观测事实、根因假设、影响、建议动作、证据不足之处。\n' + fenceUntrusted('INCIDENT_EVIDENCE', JSON.stringify(context), nonce) },
    ] }), 90000);
    const diagnosis = String(safeIncidentData(result.content || '')).trim().slice(0, 16000);
    if (!diagnosis) throw incidentError('AI 未返回有效诊断');
    const changed = db.prepare('UPDATE ops_incidents SET diagnosis=?,diagnosis_at=?,diagnosis_error=?,diagnosis_lease_until=0 WHERE id=? AND diagnosis_lease_until=?')
      .run(diagnosis, new Date(now).toISOString(), '', id, lease);
    if (changed.changes) addIncidentEvidence(id, 'diagnosis', 'AI 诊断已生成（假设，未经验证）', { diagnosis, evidenceIds: evidence.map(row => row.id) });
    return getIncident(id);
  } catch (error) {
    db.prepare('UPDATE ops_incidents SET diagnosis_error=?,diagnosis_at=?,diagnosis_lease_until=0 WHERE id=? AND diagnosis_lease_until=?')
      .run(String(safeIncidentData(error.message)).slice(0, 1000), new Date(now).toISOString(), id, lease);
    throw error;
  } finally { activeDiagnoses -= 1; }
}

let observer = null;
export function startIncidentObserver(options) { if (!observer) { observer = createIncidentObserver(options); observer.start(); } }
export async function stopIncidentObserver() { const current = observer; observer = null; await current?.stop(); }
export function incidentObserverStatus() {
  let last = null;
  try { last = JSON.parse(getSetting('sre.last_observation', 'null')); } catch { /* damaged status is not a healthy observation */ }
  return { running: !!observer, intervalMs: 15000, last, aiConfigured: !!getAiConfig().apiKey, autoDiagnosis: isGuardianEnabled() };
}
