const credentials = [];
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
export function previewSreTelemetry(path, method, body) {
  if (path === '/sre/telemetry/credentials') {
    if (method === 'GET') return response({ credentials });
    if (method === 'POST') {
      const credential = { ...body, id: 'preview-' + (credentials.length + 1), enabled: true };
      credentials.push(credential); return response({ credential, token: '离线演示凭据，无法用于真实接入' }, 201);
    }
  }
  if (path.startsWith('/sre/telemetry/credentials/') && method === 'DELETE') {
    const credential = credentials.find(row => row.id === path.split('/').at(-1));
    if (credential) credential.enabled = false;
    return response({ credential });
  }
  return null;
}
export function previewCorrelation(incident) {
  const at = Date.parse(incident.openedAt), traceId = '12345678901234567890123456789012';
  const timeline = [
    { id: 'demo-db', kind: 'log', serviceName: 'postgres', at, summary: '数据库服务不可用（虚构示例）', data: { message: 'database unavailable', traceId } },
    { id: 'demo-request', kind: 'trace', serviceName: 'wiki-api', at: at + 200, summary: 'HTTP 503，依赖连接失败（虚构示例）', data: { status: 2, traceId } },
  ];
  return { scope: { hostId: incident.hostId, projectId: incident.projectId }, start: at - 3600000, end: at + 3600000, collectedAt: Date.now(),
    gaps: ['离线示例，不代表当前生产应用'], dependencies: [{ source: 'wiki-api', target: 'postgres' }], timeline,
    hypotheses: [{ claim: '数据库不可用可能影响上游 HTTP 请求', qualification: '存在同一 trace 的关联证据，尚未通过干预验证因果。', evidenceIds: timeline.map(row => row.id) }],
    traces: [{ traceId, services: ['wiki-api', 'postgres'], evidenceIds: timeline.map(row => row.id) }], limitations: '所有数据均为虚构的界面示例。' };
}
