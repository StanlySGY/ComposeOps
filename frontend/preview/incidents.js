// Fictional on-call data. All changes stay in this page's memory; no external calls.
import { previewCorrelation } from './sre-telemetry.js';
const at = '2026-11-10T08:00:00Z';
const incident = {
  id: 'demo-incident', ticketId: 'demo-incident', hostId: 'local', projectId: 'knowledge-base', projectName: 'knowledge-base',
  serviceName: 'wiki-api', resourceId: 'demo-wiki-api', title: 'wiki-api 异常退出（示例）', status: 'investigating',
  latest: { state: 'exited', health: null, healthy: false, fault: '数据库连接失败（示例）', exitCode: 1 },
  diagnosis: '', healthyCount: 0, verification: { scope: 'container_running' }, openedAt: at, observedAt: at, resolvedAt: null, effectId: null,
};
const evidence = [{ id: 1, kind: 'detected', summary: '容器异常退出（离线示例）', data: { exitCode: 1, logs: 'getaddrinfo ENOTFOUND db-old' }, observedAt: at }];
const effects = [];
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const ticket = () => ({ id: incident.id, title: incident.title, status: 'active', priority: 'high', projectId: incident.projectId,
  sourceType: 'event', description: '离线故障处置示例，未连接 Docker 或 AI。', acceptanceCriteria: ['连续健康观测且持续至少 30 秒'], createdAt: at });
const detail = () => ({ incident, ticket: ticket(), effects, evidence, mandates: [], assignments: [], reports: [], activity: [] });

export function previewIncidentFetch(path, method) {
  if (path === '/incidents/demo-incident/correlation' && method === 'GET') return response(previewCorrelation(incident));
  if (path === '/incidents' && method === 'GET') return response({ incidents: [incident],
    stats: { open: 1, approvals: Number(incident.status === 'awaiting_approval'), verifying: Number(incident.status === 'verifying'), resolved: 0 },
    observer: { running: true, last: { checkedAt: new Date().toISOString() }, aiConfigured: true, autoDiagnosis: false }, worker: { enabled: true, preview: true } });
  if (path === '/incidents/demo-incident' && method === 'GET') return response(detail());
  if (path === '/incidents/demo-incident/diagnose' && method === 'POST') {
    incident.diagnosis = '**观测事实**：证据 #1 显示数据库主机名 db-old 无法解析。\n\n**根因假设**：连接配置可能过期。\n\n**建议动作**：核对 Compose 中的数据库服务名；单纯重启未必解决配置错误。\n\n这是预设诊断示例，没有调用 AI。';
    return response({ incident });
  }
  if (path === '/incidents/demo-incident/propose-restart' && method === 'POST') {
    if (!effects.length) effects.push({ id: 'demo-incident-effect', ticketId: incident.id, effectType: 'incident.restart', mode: 'execute', risk: 'high', status: 'awaiting_approval',
      target: { projectId: incident.projectId, hostId: 'local', composeProject: 'knowledge-base', resourceId: incident.resourceId }, payload: { recipeVersion: 'container-restart-v1' }, createdAt: at });
    incident.effectId = effects[0].id; incident.status = 'awaiting_approval'; return response({ effect: effects[0] });
  }
  if (path.startsWith('/ops-tickets/demo-incident/effects/') && method === 'POST' && effects.length) {
    if (path.endsWith('/approve')) { effects[0].status = 'succeeded'; incident.status = 'needs_attention'; incident.verification.reason = '模拟重启已完成，但数据库连接仍失败；不能标记恢复。'; }
    else if (path.endsWith('/cancel')) { effects[0].status = 'cancelled'; incident.status = 'needs_attention'; }
    else return null;
    return response({ effect: effects[0] });
  }
  if (path === '/ops-tickets/demo-incident' && method === 'GET') return response(detail());
  return null;
}
