import { randomBytes, randomUUID, createHash } from 'node:crypto';
import db, { getProjectPreference } from '../lib/db.js';
import { scanAllProjects } from './scanner.js';
import { getHost, getDockerForHost } from './docker-hosts.js';
import { hostRevision, withReadTimeout } from './incident-observer.js';
import { incidentError, safeIncidentData } from './incident-store.js';
import { isSensitiveKey } from '../lib/redaction.js';
import { harvestSecretValues } from '../lib/secret-redactor.js';
import { recordAgentAuditEvent } from './agent/policy-store.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const mapCredential = row => ({ id: row.id, name: row.name, hostId: row.host_id, projectId: row.project_id, services: JSON.parse(row.services_json), enabled: !!row.enabled, createdAt: row.created_at, createdBy: row.created_by });
export const listTelemetryCredentials = () => db.prepare('SELECT * FROM sre_telemetry_credentials ORDER BY created_at DESC LIMIT 100').all().map(mapCredential);
export async function createTelemetryCredential(input, actor = 'admin', { scan = scanAllProjects, host = getHost, dockerForHost = getDockerForHost } = {}) {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || !Array.isArray(input.services) || !input.services.length || input.services.length > 20) throw incidentError('请填写凭据名称和 1–20 个服务范围', 400);
  const project = (await scan()).find(p => p.id === input.projectId && p.hostId === input.hostId && p.managed);
  if (!project || !getProjectPreference(project.id).managed) throw incidentError('仅能为已纳管应用创建遥测凭据');
  const names = new Set(project.containers.map(c => c.service));
  if (input.services.some(name => typeof name !== 'string' || !names.has(name))) throw incidentError('凭据服务必须属于该应用', 400);
  const revision = hostRevision(host(input.hostId)), info = await withReadTimeout(dockerForHost(input.hostId).info());
  if (!info.ID || revision !== hostRevision(host(input.hostId))) throw incidentError('节点身份无法确认');
  const token = randomBytes(32).toString('hex'), id = 'otel_' + randomUUID();
  db.transaction(() => {
    if (db.prepare('SELECT COUNT(*) AS n FROM sre_telemetry_credentials WHERE enabled=1').get().n >= 20) throw incidentError('最多启用 20 个遥测凭据');
    db.prepare('INSERT INTO sre_telemetry_credentials(id,name,token_hash,host_id,project_id,services_json,host_revision,engine_id,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, String(safeIncidentData(input.name.trim())), digest(token), input.hostId, input.projectId, JSON.stringify([...new Set(input.services)]), revision, info.ID, Date.now(), actor);
    recordAgentAuditEvent({ eventType: 'telemetry_credential_created', actor, toolName: 'sre.telemetry', decision: 'scoped', details: { id, hostId: input.hostId, projectId: input.projectId, services: input.services } });
  })();
  return { credential: mapCredential(db.prepare('SELECT * FROM sre_telemetry_credentials WHERE id=?').get(id)), token };
}
export function revokeTelemetryCredential(id, actor = 'admin') {
  db.prepare('UPDATE sre_telemetry_credentials SET enabled=0 WHERE id=?').run(id);
  recordAgentAuditEvent({ eventType: 'telemetry_credential_revoked', actor, toolName: 'sre.telemetry', decision: 'revoked', details: { id } });
  return { revoked: true };
}
const engineCache = new Map();
export async function authenticateTelemetry(authorization, { host = getHost, dockerForHost = getDockerForHost, now = Date.now() } = {}) {
  const token = /^Bearer ([a-f0-9]{64})$/.exec(String(authorization || ''))?.[1];
  if (!token) throw incidentError('遥测凭据无效', 401);
  const row = db.prepare('SELECT * FROM sre_telemetry_credentials WHERE token_hash=? AND enabled=1').get(digest(token));
  if (!row || !getProjectPreference(row.project_id).managed) throw incidentError('遥测凭据已失效', 401);
  const revision = hostRevision(host(row.host_id));
  if (revision !== row.host_revision) throw incidentError('遥测节点配置已变化，请重新创建凭据', 403);
  const cached = engineCache.get(row.host_id);
  if (!cached || cached.revision !== revision || now - cached.at > 30000) {
    const info = await withReadTimeout(dockerForHost(row.host_id).info(), 5000);
    engineCache.set(row.host_id, { id: info.ID, revision, at: now });
  }
  if (engineCache.get(row.host_id).id !== row.engine_id) throw incidentError('Docker Engine 身份已变化', 403);
  return { ...mapCredential(row), hostRevision: revision, engineId: row.engine_id };
}
const fields = new Set(['service.name', 'service.version', 'db.system', 'db.system.name', 'db.operation.name', 'server.address', 'server.port', 'error.type', 'http.request.method', 'http.response.status_code', 'composeops.host.id', 'composeops.project.id']);
function array(value, maximum, label) { if (!Array.isArray(value) || value.length > maximum) throw incidentError(`${label}格式无效或超过限额`, 400); return value; }
function anyValue(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  if (typeof value.stringValue === 'string') return value.stringValue.slice(0, 4096);
  if (typeof value.boolValue === 'boolean') return value.boolValue;
  if (typeof value.intValue === 'string' && /^-?\d{1,20}$/.test(value.intValue)) return value.intValue;
  if (Number.isFinite(value.doubleValue)) return value.doubleValue;
  if (value.arrayValue) return array(value.arrayValue.values || [], 64, '属性数组').map(item => anyValue(item, depth + 1));
  if (value.kvlistValue) return Object.fromEntries(array(value.kvlistValue.values || [], 64, '属性对象').map(item => [String(item.key).slice(0, 100), anyValue(item.value, depth + 1)]));
  return null;
}
function attributes(input = [], all = false) {
  const output = {};
  for (const item of array(input, 64, '属性')) {
    if (typeof item.key !== 'string' || item.key.length > 120) throw incidentError('属性名称无效', 400);
    const value = anyValue(item.value);
    if (isSensitiveKey(item.key.replaceAll('.', '_')) && typeof value === 'string') harvestSecretValues(`${item.key.replaceAll('.', '_')}=${value}`);
    if (all || fields.has(item.key)) output[item.key] = value;
  }
  return output;
}
function identifier(value, length, required = false) {
  if (!required && (value == null || value === '')) return '';
  if (typeof value !== 'string' || !new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value) || /^0+$/.test(value)) throw incidentError('trace/span ID 必须为非零十六进制字符串', 400);
  return value.toLowerCase();
}
function timestamp(value, now, required = false) {
  if (!required && (value == null || value === '' || value === '0')) return now;
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) throw incidentError('遥测时间戳必须为纳秒十进制字符串', 400);
  const time = Number(BigInt(value) / 1000000n);
  if (time < now - 7 * 86400000 || time > now + 300000) throw incidentError('遥测时间超出 7 天保留窗口或超过未来 5 分钟', 400);
  return time;
}
export function parseOtlp(payload, signal, credential, now = Date.now()) {
  const resources = array(payload?.[signal === 'traces' ? 'resourceSpans' : 'resourceLogs'] || [], 50, '资源批次'), records = [];
  for (const resource of resources) {
    const attrs = attributes(resource.resource?.attributes), service = attrs['service.name'];
    if (!credential.services.includes(service) || (attrs['composeops.host.id'] && attrs['composeops.host.id'] !== credential.hostId) || (attrs['composeops.project.id'] && attrs['composeops.project.id'] !== credential.projectId)) throw incidentError('遥测服务或资源标签不属于凭据范围', 403);
    for (const scope of array(resource[signal === 'traces' ? 'scopeSpans' : 'scopeLogs'] || [], 50, '仪表范围')) {
      for (const entry of array(scope[signal === 'traces' ? 'spans' : 'logRecords'] || [], 200, '记录')) {
        if (records.length >= 200) throw incidentError('每批最多 200 条遥测记录', 413);
        const traceId = identifier(entry.traceId, 32, signal === 'traces'), spanId = identifier(entry.spanId, 16, signal === 'traces');
        if (spanId && !traceId) throw incidentError('span ID 需要同时提供 trace ID', 400);
        const parentSpanId = signal === 'traces' ? identifier(entry.parentSpanId, 16) : '';
        const observedAt = timestamp(signal === 'traces' ? entry.startTimeUnixNano : entry.timeUnixNano || entry.observedTimeUnixNano, now, signal === 'traces');
        const data = { attributes: attributes(entry.attributes), resource: attrs, trust: '客户端遥测，未经独立核验' };
        let severity;
        if (signal === 'traces') {
          const endAt = timestamp(entry.endTimeUnixNano, now, true);
          if (endAt < observedAt || typeof entry.name !== 'string' || !entry.name || entry.name.length > 500 || ![0, 1, 2].includes(entry.status?.code ?? 0)) throw incidentError('跨度名称、时间或状态无效', 400);
          Object.assign(data, { name: entry.name, endAt, durationMs: endAt - observedAt, statusCode: entry.status?.code ?? 0, message: String(entry.status?.message || '').slice(0, 2000) });
          severity = data.statusCode === 2 ? 17 : 9;
        } else {
          severity = entry.severityNumber ?? 0;
          if (!Number.isInteger(severity) || severity < 0 || severity > 24) throw incidentError('日志严重级别无效', 400);
          Object.assign(data, { body: anyValue(entry.body), severityText: String(entry.severityText || '').slice(0, 40), timestampSource: entry.timeUnixNano || entry.observedTimeUnixNano ? 'client' : 'receiver' });
        }
        const safe = safeIncidentData(data), id = digest(JSON.stringify([credential.hostId, credential.projectId, service, signal, traceId, spanId, ...(signal === 'logs' ? [entry.timeUnixNano || entry.observedTimeUnixNano || now, safe] : [])]));
        records.push({ id, service, traceId, spanId, parentSpanId, observedAt, severity, data: safe });
      }
    }
  }
  // Redact again after the whole batch has harvested secrets appearing in later attributes.
  return safeIncidentData(records);
}
export function ingestOtlp(payload, signal, credential, now = Date.now()) {
  const records = parseOtlp(payload, signal, credential, now), bytes = Buffer.byteLength(JSON.stringify(payload));
  return db.transaction(() => {
    const live = db.prepare('SELECT enabled FROM sre_telemetry_credentials WHERE id=?').get(credential.id);
    if (!live?.enabled || !getProjectPreference(credential.projectId).managed) throw incidentError('遥测凭据已撤销', 401);
    const minute = Math.floor(now / 60000) * 60000, quota = db.prepare('SELECT * FROM sre_telemetry_quotas WHERE credential_id=?').get(credential.id);
    const count = (quota?.window_at === minute ? quota.records : 0) + records.length, totalBytes = (quota?.window_at === minute ? quota.bytes : 0) + bytes;
    if (count > 2000 || totalBytes > 8 * 1024 ** 2) throw incidentError('遥测分钟限额已用尽，请稍后重试', 429);
    db.prepare('INSERT INTO sre_telemetry_quotas(credential_id,window_at,records,bytes) VALUES(?,?,?,?) ON CONFLICT(credential_id) DO UPDATE SET window_at=excluded.window_at,records=excluded.records,bytes=excluded.bytes').run(credential.id, minute, count, totalBytes);
    const insert = db.prepare('INSERT OR IGNORE INTO sre_telemetry(id,host_id,project_id,service_name,signal,trace_id,span_id,parent_span_id,observed_at,received_at,severity,data_json,credential_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    let accepted = 0;
    for (const row of records) accepted += insert.run(row.id, credential.hostId, credential.projectId, row.service, signal, row.traceId, row.spanId, row.parentSpanId, row.observedAt, now, row.severity, JSON.stringify(row.data), credential.id).changes;
    pruneTelemetry(now, credential);
    return { accepted, duplicates: records.length - accepted };
  })();
}
export function pruneTelemetry(now = Date.now(), scope = null) {
  db.prepare('DELETE FROM sre_telemetry WHERE received_at<?').run(now - 7 * 86400000);
  if (scope) db.prepare('DELETE FROM sre_telemetry WHERE id IN (SELECT id FROM sre_telemetry WHERE host_id=? AND project_id=? ORDER BY received_at DESC,id LIMIT -1 OFFSET 20000)').run(scope.hostId, scope.projectId);
  db.prepare('DELETE FROM sre_telemetry WHERE id IN (SELECT id FROM sre_telemetry ORDER BY received_at DESC,id LIMIT -1 OFFSET 200000)').run();
  db.prepare('DELETE FROM sre_telemetry_quotas WHERE window_at<?').run(now - 86400000);
}
export function queryTelemetry({ hostId, projectId, start, end, serviceName = '', traceId = '', limit = 200 }) {
  return db.prepare('SELECT * FROM sre_telemetry WHERE host_id=? AND project_id=? AND observed_at>=? AND observed_at<=? AND (?=\'\' OR service_name=?) AND (?=\'\' OR trace_id=?) ORDER BY observed_at DESC LIMIT ?')
    .all(hostId, projectId, start, end, serviceName, serviceName, traceId, traceId, Math.max(1, Math.min(limit, 200))).map(row => ({ id: 'telemetry:' + row.id, kind: row.signal === 'traces' ? 'trace' : 'log',
      at: row.observed_at, serviceName: row.service_name, traceId: row.trace_id, spanId: row.span_id, parentSpanId: row.parent_span_id, severity: row.severity, data: JSON.parse(row.data_json) }));
}
