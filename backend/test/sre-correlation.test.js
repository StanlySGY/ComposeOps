import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import db, { setProjectPreference } from '../src/lib/db.js';
import { createTelemetryCredential, authenticateTelemetry, ingestOtlp, parseOtlp, queryTelemetry, revokeTelemetryCredential, pruneTelemetry } from '../src/services/sre-telemetry.js';
import { collectIncidentCorrelation, dependencyHypotheses } from '../src/services/incident-correlation.js';
import { recordIncidentObservation } from '../src/services/incident-store.js';
import { hostRevision } from '../src/services/incident-observer.js';
import { selectDiagnosisSources } from '../src/services/diagnosis-protocol.js';
import telemetryRoutes from '../src/routes/telemetry.js';
const host = { id: 'test-host', type: 'local', updatedAt: 1 }, now = Date.now(), traceId = 'a'.repeat(32), webSpan = 'b'.repeat(16), dbSpan = 'c'.repeat(16);
const project = { id: 'correlation-app', hostId: host.id, projectName: 'app', managed: true, editable: true, mountEnabled: true,
  containers: [{ id: 'web-container', service: 'web' }, { id: 'db-container', service: 'db' }] };
const docker = { info: async () => ({ ID: 'engine' }), getContainer: id => ({ inspect: async () => ({ Id: id, Config: { Labels: { 'com.docker.compose.project': 'app', 'com.docker.compose.service': id === 'web-container' ? 'web' : 'db' } } }) }) };
const dependencies = { scan: async () => [project], host: () => host, dockerForHost: () => docker };
const nano = time => (BigInt(time) * 1000000n).toString();
function payload(signal = 'traces', service = 'web', overrides = {}) {
  const resource = { attributes: [{ key: 'service.name', value: { stringValue: service } }] };
  if (signal === 'traces') return { resourceSpans: [{ resource, scopeSpans: [{ spans: [{ traceId, spanId: service === 'web' ? webSpan : dbSpan, parentSpanId: service === 'db' ? webSpan : '', name: service === 'web' ? 'GET /items' : 'database query', startTimeUnixNano: nano(now - 1000), endTimeUnixNano: nano(now), status: { code: 2 }, ...overrides }] }] }] };
  return { resourceLogs: [{ resource, scopeLogs: [{ logRecords: [{ timeUnixNano: nano(now), traceId, spanId: dbSpan, severityNumber: 17, body: { stringValue: 'database connection refused' }, ...overrides }] }] }] };
}
let credential, token;
test.before(async () => { setProjectPreference(project.id, { managed: true }); const result = await createTelemetryCredential({ name: 'test', hostId: host.id, projectId: project.id, services: ['web', 'db'] }, 'tester', dependencies); credential = result.credential; token = result.token; });
test('范围凭据只接受相同节点身份；撤销、撤管和节点配置漂移立即阻断', async () => {
  assert.equal((await authenticateTelemetry('Bearer ' + token, dependencies)).id, credential.id);
  await assert.rejects(authenticateTelemetry('Bearer ' + '0'.repeat(64), dependencies), /失效/);
  await assert.rejects(authenticateTelemetry('Bearer ' + token, { ...dependencies, host: () => ({ ...host, updatedAt: 2 }) }), /变化/);
  setProjectPreference(project.id, { managed: false }); await assert.rejects(authenticateTelemetry('Bearer ' + token, dependencies), /失效/); setProjectPreference(project.id, { managed: true });
  const other = await createTelemetryCredential({ name: 'revoked', hostId: host.id, projectId: project.id, services: ['web'] }, 'test', dependencies); revokeTelemetryCredential(other.credential.id); await assert.rejects(authenticateTelemetry('Bearer ' + other.token, dependencies), /失效/);
});
test('OTLP 解析十六进制链路与时间，拒绝越界服务、伪造项目、非法 ID 和超大批次', () => {
  const parsed = parseOtlp(payload(), 'traces', credential, now); assert.equal(parsed[0].traceId, traceId); assert.equal(parsed[0].data.durationMs, 1000);
  assert.throws(() => parseOtlp(payload('traces', 'foreign'), 'traces', credential, now), /范围/);
  const forged = payload(); forged.resourceSpans[0].resource.attributes.push({ key: 'composeops.project.id', value: { stringValue: 'foreign' } }); assert.throws(() => parseOtlp(forged, 'traces', credential, now), /范围/);
  for (const bad of [{ traceId: '0'.repeat(32) }, { spanId: 'short' }, { startTimeUnixNano: nano(now + 600000) }, { status: { code: 'ERROR' } }]) assert.throws(() => parseOtlp(payload('traces', 'web', bad), 'traces', credential, now));
  const huge = payload(); huge.resourceSpans[0].scopeSpans[0].spans = Array(201).fill(huge.resourceSpans[0].scopeSpans[0].spans[0]); assert.throws(() => parseOtlp(huge, 'traces', credential, now), /限额|200/);
});
test('跨记录值级脱敏，日志与链路幂等入库，跨项目和节点查询不能串读', () => {
  const logs = payload('logs', 'db', { body: { stringValue: 'PASSWORD=fixture-private-value\nrepeat fixture-private-value' } });
  ingestOtlp(logs, 'logs', credential, now); ingestOtlp(payload('traces', 'web'), 'traces', credential, now); ingestOtlp(payload('traces', 'db'), 'traces', credential, now);
  assert.equal(ingestOtlp(payload('traces', 'db'), 'traces', credential, now).duplicates, 1);
  const rows = queryTelemetry({ hostId: host.id, projectId: project.id, start: now - 60000, end: now });
  assert.equal(rows.length, 3); assert.equal(JSON.stringify(rows).includes('fixture-private-value'), false);
  assert.equal(queryTelemetry({ hostId: 'different', projectId: project.id, start: now - 60000, end: now }).length, 0);
  assert.equal(queryTelemetry({ hostId: host.id, projectId: 'different', start: now - 60000, end: now }).length, 0);
});
test('持久配额与过期清理，不会因接入服务重启而归零', () => {
  const minute = Math.floor(now / 60000) * 60000;
  db.prepare('UPDATE sre_telemetry_quotas SET records=2000,window_at=? WHERE credential_id=?').run(minute, credential.id);
  assert.throws(() => ingestOtlp(payload(), 'traces', credential, now), /限额/);
  db.prepare('UPDATE sre_telemetry_quotas SET records=0 WHERE credential_id=?').run(credential.id);
  db.prepare("INSERT INTO sre_telemetry(id,host_id,project_id,service_name,signal,observed_at,received_at,severity,data_json,credential_id) VALUES('expired','host','project','service','logs',1,1,0,'{}','credential')").run();
  pruneTelemetry(now); assert.equal(db.prepare("SELECT id FROM sre_telemetry WHERE id='expired'").get(), undefined);
});
test('真实 HTTP 路由接受 gzip JSON，匿名、错误编码及过大解压内容被拒绝', async () => {
  const app = Fastify(); await app.register(telemetryRoutes, { prefix: '/otlp/v1', authenticate: header => authenticateTelemetry(header, dependencies) });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/otlp/v1/traces', payload: payload() })).statusCode, 401);
    const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-encoding': 'gzip' };
    assert.equal((await app.inject({ method: 'POST', url: '/otlp/v1/traces', headers, payload: gzipSync(JSON.stringify(payload())) })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/otlp/v1/traces', headers, payload: gzipSync(' '.repeat(1024 * 1024 + 1)) })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/otlp/v1/traces', headers: { ...headers, 'content-encoding': 'br' }, payload: '{}' })).statusCode, 415);
  } finally { await app.close(); }
});
test('故障关联汇集依赖、同 trace 日志与跨服务异常；假设明确保留不确定性', async () => {
  const identity = { hostRevision: hostRevision(host), engineId: 'engine', containerId: 'web-container', createdAt: 'test', composeProject: 'app' };
  const incident = recordIncidentObservation({ project, identity, snapshot: { id: 'web-container', service: 'web', name: 'web', state: 'exited', healthy: false, fault: '数据库不可达', startedAt: 'test' }, at: new Date(now).toISOString() });
  db.prepare('INSERT INTO sre_changes(id,status,host_id,project_id,profile_id,review_json,result_json,created_at,updated_at,expires_at,reviewed_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('correlated-release', 'rolled_back', host.id, project.id, 'profile', JSON.stringify({ recipe: 'application-release-v1', services: [{ serviceName: 'db' }, { serviceName: 'web' }] }),
      JSON.stringify({ steps: [{ serviceName: 'db', passed: true }, { serviceName: 'web', passed: false }], rollbackSteps: [{ serviceName: 'web', passed: true }] }), now, now, now + 10000, 'tester');
  const result = await collectIncidentCorrelation(incident.id, { ...dependencies, now, capture: async () => ({ fingerprint: 'test', effective: { services: { web: { depends_on: { db: { condition: 'service_started' } } }, db: {} } } }), logs: async () => 'database connection refused' });
  assert.equal(result.scope.projectId, project.id); assert.equal(result.dependencies.length, 1); assert.equal(result.traces.length, 1);
  assert.ok(result.hypotheses.length); assert.equal(result.hypotheses[0].kind, 'hypothesis'); assert.match(result.hypotheses[0].qualification, /不足以单独证明/);
  assert.ok(result.timeline.some(row => row.kind === 'logs_snapshot')); assert.ok(result.timeline.some(row => row.kind === 'dependency'));
  assert.equal(result.timeline.filter(row => row.kind === 'change').length, 2);
  assert.equal(result.timeline.find(row => row.kind === 'change' && row.serviceName === 'web').data.step.passed, false);
  assert.equal(result.timeline.find(row => row.kind === 'change' && row.serviceName === 'web').data.rollback.passed, true);
  const selected = selectDiagnosisSources([{ id: 'initial', kind: 'container', data: {} }], result.timeline);
  assert.ok(selected.some(row => row.kind === 'trace')); assert.ok(selected.some(row => row.kind === 'dependency'));
  const temporalOnly = dependencyHypotheses('web', [{ source: 'web', target: 'db', evidenceId: 'd' }], [{ id: 'e', serviceName: 'db', data: { fault: 'failed' } }]);
  assert.equal(temporalOnly[0].confidence, 'low'); assert.match(temporalOnly[0].qualification, /不能证明因果/);
});
