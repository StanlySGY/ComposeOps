import { createHash } from 'node:crypto';
import db, { getSetting, setSetting, getProjectPreference } from '../lib/db.js';
import { getDockerForHost, getHost } from './docker-hosts.js';
import { scanAllProjects } from './scanner.js';
import { readContainerLogs } from '../lib/docker-exec.js';
import { getAiConfig, callOpenAI } from './ai.js';
import { diagnoseEvidence, renderDiagnosis, selectDiagnosisSources } from './diagnosis-protocol.js';
import { collectIncidentCorrelation } from './incident-correlation.js';
import { isGuardianEnabled } from './guardian.js';
import { getIncident, recordIncidentObservation, updateIncidentObservation, addIncidentEvidence, safeIncidentData, incidentError } from './incident-store.js';
import { listSreProfiles, getSreProfile } from './sre-profiles.js';
import { createProbeRunner, probeSnapshot } from './sre-probes.js';
import { considerAutomaticRecovery } from './sre-autonomy.js';
import { workerHeartbeat } from './sre-heartbeats.js';
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
  let timer = null, pending = null, stopped = true, workStartedAt = null;
  let probePending = null;
  let generation = 0;
  async function collect() {
    const currentGeneration = generation;
    // HTTP endpoints have their own bounded queue; a slow endpoint cannot stop Docker observations.
    probePending = probeRunner.runOnce({ isCurrent: () => currentGeneration === generation }).catch(error => logger.warn?.({ error: String(safeIncidentData(error.message)) }, '应用探针采集失败'));
    const projects = await withReadTimeout(scan(), 10000);
    if (currentGeneration !== generation) return;
    const profiles = listSreProfiles();
    const open = db.prepare('SELECT id FROM ops_incidents WHERE resolved_at IS NULL AND closed_at IS NULL').all().map(row => getIncident(row.id));
    const targets = new Map();
    for (const project of projects.filter(item => item.managed)) {
      for (const container of project.containers || []) targets.set(`${project.hostId}:${container.id}`, { project, resourceId: container.id });
    }
    for (const incident of open) {
      if (incident.resourceId.startsWith('application:')) continue;
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
          if (profile && getSreProfile(profile.id).version !== profile.version) continue;
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
    // A configured application can fail with zero containers. Preserve an application-level
    // incident without inventing a restart target or treating an unreachable node as healthy.
    const appQueue = profiles.filter(item => item.enabled && getProjectPreference(item.projectId).managed);
    await Promise.all(Array.from({ length: Math.min(4, appQueue.length) }, async () => {
    while (appQueue.length) {
      const profile = appQueue.shift();
      if (currentGeneration !== generation) break;
      const resourceId = 'application:' + profile.id;
      const previous = open.find(item => item.resourceId === resourceId);
      const discovered = projects.find(item => item.id === profile.projectId && item.hostId === profile.hostId && item.managed);
      if (!previous && discovered?.containers?.some(item => item.service === profile.serviceName)) continue;
      try {
        const revision = hostRevision(hostForId(profile.hostId)), docker = dockerForHost(profile.hostId);
        if (!infos.has(profile.hostId)) infos.set(profile.hostId, withReadTimeout(docker.info()));
        const info = await infos.get(profile.hostId);
        if (info.ID !== profile.engineId || revision !== profile.hostRevision) throw incidentError('应用目标的节点身份已变化');
        const listed = await withReadTimeout(docker.listContainers({ all: true, filters: { label: [`${PROJECT_LABEL}=${profile.projectName}`, `${SERVICE_LABEL}=${profile.serviceName}`] } }));
        const items = await Promise.all(listed.map(row => withReadTimeout(docker.getContainer(row.Id).inspect())));
        if (currentGeneration !== generation) break;
        if (getSreProfile(profile.id).version !== profile.version || !getSreProfile(profile.id).enabled) continue;
        if (hostRevision(hostForId(profile.hostId)) !== revision) throw incidentError('采集期间节点已变化');
        const identity = { hostRevision: revision, engineId: info.ID, applicationId: profile.id, probe: { profileId: profile.id, version: profile.version } };
        const snapshot = probeSnapshot(profile, { id: resourceId, name: profile.serviceName, service: profile.serviceName,
          state: items.length ? '服务已出现' : '服务容器不存在', healthy: items.length > 0 && items.every(item => containerSnapshot(item).healthy),
          fault: items.length ? '' : '服务容器不存在', startedAt: items.map(item => item.State?.StartedAt).sort().join(','), restartCount: items.reduce((sum, item) => sum + (item.RestartCount || 0), 0) }, now());
        const project = { id: profile.projectId, projectName: profile.projectName, hostId: profile.hostId };
        const result = recordIncidentObservation({ project, snapshot, identity, at: new Date(now()).toISOString() });
        if (result && !previous) addIncidentEvidence(result.id, 'application_target', '应用无可重启容器，保留人工调查；不会自动创建或重启替代容器', { profileId: profile.id });
        observed++;
      } catch (error) {
        failures++;
        if (previous && currentGeneration === generation) updateIncidentObservation(previous.id, { ...previous.latest, healthy: false, error: String(safeIncidentData(error.message)) }, previous.identity, new Date(now()).toISOString());
      }
    }
    }));
    const status = { observed, failures, checkedAt: new Date(now()).toISOString() };
    if (currentGeneration === generation) setSetting('sre.last_observation', JSON.stringify(status));
    return status;
  }
  function runOnce() {
    if (!pending) {
      workStartedAt = now();
      pending = collect().finally(() => { pending = null; workStartedAt = null; workerHeartbeat('incident-observer', { state: stopped ? 'stopped' : 'idle', progress: true, at: now() }); });
    }
    return pending;
  }
  function tick() {
    if (!stopped) workerHeartbeat('incident-observer', { state: pending ? 'working' : 'idle', workStartedAt, at: now() });
    const currentGeneration = generation;
    if (!stopped) void runOnce().catch(error => {
      if (stopped || currentGeneration !== generation) return;
      workerHeartbeat('incident-observer', { state: 'error', error: error.message, at: now() });
      setSetting('sre.last_observation', JSON.stringify({ checkedAt: new Date(now()).toISOString(), error: String(safeIncidentData(error.message)) }));
      logger.error?.('AI 值守采集失败：' + String(safeIncidentData(error.message)));
    });
  }
  return { runOnce, start() { if (!stopped) return; stopped = false; tick(); timer = setInterval(tick, Math.max(15000, pollMs)); timer.unref?.(); },
    stop() { stopped = true; generation += 1; clearInterval(timer); timer = null; return Promise.allSettled([pending, probePending]); } };
}

export async function diagnoseIncident(id, { call = callOpenAI, config = getAiConfig(), now = Date.now(), correlate = collectIncidentCorrelation } = {}) {
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
    let correlation;
    try { correlation = await withReadTimeout(correlate(id), 20000); } catch { correlation = { timeline: [], gaps: ['关联采集未完成，当前诊断只依据已有证据'] }; }
    const sources = selectDiagnosisSources([{ id: 'current-observation', kind: 'container', at: incident.observedAt, data: incident.latest },
      ...evidence.filter(row => row.kind !== 'diagnosis').map(row => ({ id: 'evidence:' + row.id, kind: row.kind, data: JSON.parse(row.data_json), at: row.observed_at }))], correlation.timeline);
    const report = await diagnoseEvidence(sources, { hostId: incident.hostId, projectId: incident.projectId, serviceName: incident.serviceName, openedAt: incident.openedAt, gaps: correlation.gaps }, { call, config });
    const diagnosis = renderDiagnosis(report.diagnosis);
    const changed = db.prepare('UPDATE ops_incidents SET diagnosis=?,diagnosis_json=?,diagnosis_at=?,diagnosis_error=?,diagnosis_lease_until=0 WHERE id=? AND diagnosis_lease_until=?')
      .run(diagnosis, JSON.stringify({ ...report, sources }), new Date(now).toISOString(), '', id, lease);
    if (changed.changes) addIncidentEvidence(id, 'diagnosis', '结构化 AI 诊断已生成（假设，未经验证）', { diagnosis, protocolVersion: 1, evidenceIds: sources.map(row => row.id), metadata: report.metadata });
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
