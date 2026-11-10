import db from '../lib/db.js';
import { getIncidentDetail, safeIncidentData, incidentError } from './incident-store.js';
import { scanAllProjects } from './scanner.js';
import { captureDeploymentInputs } from './reviewed-deployment.js';
import { getHost, getDockerForHost } from './docker-hosts.js';
import { hostRevision, withReadTimeout, PROJECT_LABEL, SERVICE_LABEL } from './incident-observer.js';
import { readContainerLogs } from '../lib/docker-exec.js';
import { queryTelemetry } from './sre-telemetry.js';

const milliseconds = value => typeof value === 'number' ? value : Date.parse(value);
export function dependencyHypotheses(serviceName, edges, timeline) {
  const hypotheses = [];
  for (const edge of edges.filter(item => item.source === serviceName)) {
    const failures = timeline.filter(item => item.serviceName === edge.target && (item.data?.fault || item.data?.outcome === 'bad' || item.severity >= 17));
    for (const failure of failures.slice(0, 3)) {
      const upstream = timeline.find(item => item.serviceName === serviceName && (item.traceId && item.traceId === failure.traceId)
        && (item.severity >= 17 || item.data?.outcome === 'bad'));
      hypotheses.push({ kind: 'hypothesis', category: 'dependency_failure', confidence: upstream ? 'medium' : 'low',
        claim: `${edge.target} 的异常可能影响依赖它的 ${serviceName}，需要验证失败请求与依赖状态。`,
        evidenceIds: [edge.evidenceId, failure.id, ...(upstream ? [upstream.id] : [])],
        qualification: upstream ? '存在同一 trace 的错误记录，但客户端遥测与当前依赖关系仍不足以单独证明根因。' : '只发现当前依赖关系及同窗口异常；时间相关不能证明因果。' });
    }
  }
  return hypotheses.slice(0, 6);
}
const pending = new Map();
export function collectIncidentCorrelation(id, options = {}) {
  if (pending.has(id)) return pending.get(id);
  if (pending.size >= 2) throw incidentError('已有两个故障正在关联分析，请稍后重试', 429);
  const work = collect(id, options).finally(() => pending.delete(id)); pending.set(id, work); return work;
}
async function collect(id, { scan = scanAllProjects, capture = captureDeploymentInputs, host = getHost, dockerForHost = getDockerForHost, logs = readContainerLogs, now = Date.now() } = {}) {
  const detail = getIncidentDetail(id), incident = detail.incident, gaps = [], dependencies = [], timeline = [];
  const end = Math.min(now, milliseconds(incident.resolvedAt || incident.observedAt) + 300000), start = Math.max(milliseconds(incident.openedAt) - 900000, end - 7200000);
  for (const row of detail.evidence.filter(row => row.kind !== 'diagnosis').slice(0, 40)) timeline.push({ id: 'evidence:' + row.id, kind: row.kind, at: milliseconds(row.observedAt), serviceName: incident.serviceName, summary: row.summary, data: row.data });
  timeline.push({ id: 'current-observation', kind: 'container', at: milliseconds(incident.observedAt), serviceName: incident.serviceName, summary: '故障服务最近状态', data: incident.latest });
  let project, docker;
  try {
    project = (await withReadTimeout(scan(), 10000)).find(item => item.id === incident.projectId && item.hostId === incident.hostId && item.managed);
    if (!project) throw incidentError('应用已撤管或当前节点不可用');
    const revision = hostRevision(host(incident.hostId));
    if (incident.identity.hostRevision !== revision) throw incidentError('故障节点配置与当前配置不同，仅保留历史证据');
    docker = dockerForHost(incident.hostId);
    if ((await withReadTimeout(docker.info())).ID !== incident.identity.engineId) throw incidentError('Docker Engine 身份已变化，仅保留历史证据');
    if (project.editable && project.mountEnabled) {
      const snapshot = await withReadTimeout(capture(project), 15000);
      if (revision !== hostRevision(host(incident.hostId))) throw incidentError('采集期间节点配置变化');
      for (const [name, service] of Object.entries(snapshot.effective.services || {})) {
        for (const dependency of Array.isArray(service.depends_on) ? service.depends_on : Object.keys(service.depends_on || {})) dependencies.push({ source: name, target: dependency, evidenceId: 'compose-dependencies' });
      }
      timeline.push({ id: 'compose-dependencies', kind: 'dependency', at: now, serviceName: '', summary: '当前 Compose 声明的服务依赖（不代表故障发生时配置）', data: { edges: dependencies, fingerprint: snapshot.fingerprint, historical: false } });
    } else gaps.push('当前节点无法读取完整 Compose；缺少声明式依赖，仍保留日志与遥测证据。');
    const services = new Set([incident.serviceName, ...dependencies.filter(edge => edge.source === incident.serviceName).map(edge => edge.target)]);
    for (const container of project.containers.filter(row => services.has(row.service)).slice(0, 4)) {
      try {
        const target = docker.getContainer(container.id), inspected = await withReadTimeout(target.inspect());
        if (inspected.Id !== container.id || inspected.Config?.Labels?.[PROJECT_LABEL] !== incident.projectName || inspected.Config?.Labels?.[SERVICE_LABEL] !== container.service) throw incidentError('容器身份不一致');
        const content = await withReadTimeout(logs(target, 50));
        timeline.push({ id: 'live-logs:' + container.id, kind: 'logs_snapshot', at: now, serviceName: container.service, summary: '当前日志快照；时间为采集时间', data: { logs: String(safeIncidentData(content)).slice(-8000), containerId: container.id, timestampMeaning: 'collected_at' } });
      } catch { gaps.push(`${container.service} 当前日志无法读取。`); }
    }
  } catch (error) { gaps.push(String(safeIncidentData(error.message))); project = null; }
  const containerIds = [...new Set([...(incident.resourceId.startsWith('application:') ? [] : [incident.resourceId]), ...(project?.containers.map(row => row.id) || [])])].slice(0, 20);
  if (containerIds.length) {
    const rows = db.prepare(`SELECT id,container_id,metric_type,value,unit,timestamp,sample_count,value_min,value_max,stats_approximate FROM container_metrics WHERE host_id=? AND container_id IN (${containerIds.map(() => '?').join(',')}) AND timestamp>=? AND timestamp<=? ORDER BY timestamp DESC LIMIT 120`).all(incident.hostId, ...containerIds, start, end);
    for (const row of rows) timeline.push({ id: 'metric:' + row.id, kind: 'metric', at: row.timestamp, serviceName: project?.containers.find(c => c.id === row.container_id)?.service || incident.serviceName, summary: `${row.metric_type} ${row.value} ${row.unit || ''}`, data: row });
    if (!rows.length) gaps.push('选定窗口没有容器指标，不能推断资源正常。');
  }
  const probes = db.prepare(`SELECT s.id,s.sampled_at,s.outcome,s.latency_ms,s.status_code,s.reason,p.service_name FROM sre_probe_samples s JOIN sre_profiles p ON p.id=s.profile_id AND p.version=s.version
    WHERE p.host_id=? AND p.project_id=? AND s.sampled_at>=? AND s.sampled_at<=? ORDER BY s.sampled_at DESC LIMIT 80`).all(incident.hostId, incident.projectId, start, end);
  for (const row of probes) timeline.push({ id: 'probe:' + row.id, kind: 'probe', at: row.sampled_at, serviceName: row.service_name, summary: '独立 HTTP 探针', data: { outcome: row.outcome, latencyMs: row.latency_ms, statusCode: row.status_code, reason: row.reason } });
  const changes = db.prepare('SELECT id,status,updated_at,review_json,result_json,error FROM sre_changes WHERE host_id=? AND project_id=? AND updated_at>=? AND updated_at<=? ORDER BY updated_at DESC LIMIT 20').all(incident.hostId, incident.projectId, start, end);
  for (const row of changes) {
    const review = JSON.parse(row.review_json), result = JSON.parse(row.result_json);
    const services = review.recipe === 'application-release-v1' ? review.services : [review];
    for (const service of services || []) timeline.push({ id: 'change:' + row.id + ':' + service.serviceName, kind: 'change', at: row.updated_at,
      serviceName: service.serviceName, summary: review.recipe === 'application-release-v1' ? '最近应用发布（时间为发布记录更新时间）' : '最近可靠变更',
      data: { status: row.status, oldImage: service.old?.imageId, newImage: service.next?.imageId, error: row.error,
        step: result.steps?.find(step => step.serviceName === service.serviceName), rollback: result.rollbackSteps?.find(step => step.serviceName === service.serviceName) } });
  }
  const peers = db.prepare('SELECT id,service_name,title,latest_json,observed_at FROM ops_incidents WHERE host_id=? AND project_id=? AND id<>? AND observed_at>=? AND observed_at<=? ORDER BY observed_at DESC LIMIT 20')
    .all(incident.hostId, incident.projectId, id, new Date(start).toISOString(), new Date(end).toISOString());
  for (const row of peers) timeline.push({ id: 'incident:' + row.id, kind: 'incident', at: milliseconds(row.observed_at), serviceName: row.service_name, summary: row.title, data: JSON.parse(row.latest_json) });
  const telemetry = queryTelemetry({ hostId: incident.hostId, projectId: incident.projectId, start, end });
  timeline.push(...telemetry.map(row => ({ ...row, summary: row.kind === 'trace' ? row.data.name : 'OTLP 日志' })));
  if (!telemetry.length) gaps.push('选定窗口没有 OTLP trace/log；不能据此推断调用链正常。');
  const traces = [...new Set(telemetry.map(row => row.traceId).filter(Boolean))].map(traceId => ({ traceId,
    evidenceIds: telemetry.filter(row => row.traceId === traceId).map(row => row.id), services: [...new Set(telemetry.filter(row => row.traceId === traceId).map(row => row.serviceName))] }));
  return safeIncidentData({ scope: { hostId: incident.hostId, projectId: incident.projectId, serviceName: incident.serviceName }, start, end, collectedAt: now,
    dependencies, traces, timeline: timeline.sort((a, b) => b.at - a.at).slice(0, 400), hypotheses: dependencyHypotheses(incident.serviceName, dependencies, timeline), gaps,
    limitations: '同节点、同应用内最多两小时历史及当前日志/依赖快照。窗口和条数有限；客户端遥测不可信，关联线索必须验证，时间相关不等于因果。' });
}
