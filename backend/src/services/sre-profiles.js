import { randomUUID } from 'node:crypto';
import db, { getProjectPreference } from '../lib/db.js';
import { scanProjects } from './scanner.js';
import { getHost, getDockerForHost } from './docker-hosts.js';
import { hostRevision, withReadTimeout } from './incident-observer.js';
import { incidentError, closeProfileIncidents } from './incident-store.js';
import { recordAgentAuditEvent } from './agent/policy-store.js';

export const PROBE_INTERVAL_MS = 30000;
const integer = (value, fallback, min, max, label) => {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw incidentError(label + '超出范围', 400);
  return result;
};
export function validateProbeConfig(input = {}) {
  let url;
  try { url = new URL(input.url); } catch { throw incidentError('请填写完整 HTTP 或 HTTPS 健康检查地址', 400); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.href.length > 2048) {
    throw incidentError('探针只支持无账号、查询参数和片段的 HTTP(S) 地址；请使用专用健康检查路径', 400);
  }
  const target = input.targetPercent ?? 99.9;
  if (typeof target !== 'number' || !Number.isFinite(target) || target < 90 || target > 100) throw incidentError('可用率目标须为 90 至 100', 400);
  return { url: url.href, expectedStatus: integer(input.expectedStatus, 200, 100, 599, '预期状态码'),
    timeoutMs: integer(input.timeoutMs, 3000, 200, 10000, '超时'), maxLatencyMs: integer(input.maxLatencyMs, 1000, 50, 10000, '延迟阈值'),
    failureThreshold: integer(input.failureThreshold, 3, 2, 10, '连续失败次数'), targetPercent: target,
    windowDays: integer(input.windowDays, 7, 1, 30, '统计窗口') };
}
const map = row => row && ({ id: row.id, hostId: row.host_id, projectId: row.project_id, projectName: row.project_name,
  serviceName: row.service_name, hostRevision: row.host_revision, engineId: row.engine_id, version: row.version, enabled: !!row.enabled,
  archivedAt: row.archived_at, config: JSON.parse(row.config_json), createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: row.updated_by });
export function getSreProfile(id) {
  const profile = map(db.prepare('SELECT * FROM sre_profiles WHERE id=?').get(id));
  if (!profile) throw incidentError('应用可靠性目标不存在', 404);
  return profile;
}
export function listSreProfiles({ archived = false } = {}) { return db.prepare('SELECT * FROM sre_profiles' + (archived ? '' : ' WHERE archived_at IS NULL') + ' ORDER BY updated_at DESC').all().map(map); }
export async function saveSreProfile(input, actor = 'admin', { scan = scanProjects, hostForId = getHost, dockerForHost = getDockerForHost, now = Date.now(), createId } = {}) {
  if (typeof input.enabled !== 'undefined' && typeof input.enabled !== 'boolean') throw incidentError('启用状态无效', 400);
  const archived = !input.id && db.prepare('SELECT * FROM sre_profiles WHERE host_id=? AND project_id=? AND service_name=? AND archived_at IS NOT NULL').get(input.hostId || 'local', input.projectId || '', input.serviceName || '');
  const previous = input.id ? getSreProfile(input.id) : map(archived);
  const hostId = previous?.hostId || String(input.hostId || 'local'), projectId = previous?.projectId || String(input.projectId || '');
  const serviceName = previous?.serviceName || String(input.serviceName || '');
  if (previous && !archived && input.version !== previous.version) throw incidentError('目标已被其他操作更新，请刷新后重试');
  if (previous && (input.hostId && input.hostId !== hostId || input.projectId && input.projectId !== projectId || input.serviceName && input.serviceName !== serviceName)) throw incidentError('不能改变目标归属，请创建独立目标');
  const project = (await scan(hostId)).find(item => item.id === projectId);
  if (!project?.managed || !getProjectPreference(projectId).managed || !project.containers.some(item => item.service === serviceName)) throw incidentError('请选择已纳管项目中存在的 Compose 服务', 403);
  const config = validateProbeConfig(input.config);
  const revision = hostRevision(hostForId(hostId));
  const info = await withReadTimeout(dockerForHost(hostId).info());
  if (!info.ID || hostRevision(hostForId(hostId)) !== revision || !getProjectPreference(projectId).managed) throw incidentError('保存期间应用或节点身份发生变化');
  const id = previous?.id || createId || 'srep_' + randomUUID();
  const version = (previous?.version || 0) + 1;
  if (previous?.archivedAt && db.prepare('SELECT COUNT(*) AS n FROM sre_profiles WHERE archived_at IS NULL').get().n >= 200) throw incidentError('可靠性目标已达 200 个上限');
  if (previous) {
    if (getSreProfile(id).version !== previous.version) throw incidentError('目标已被更新，请刷新');
    closeProfileIncidents(id, '应用可靠性目标配置已替换，旧版本观测终止', actor);
  }
  db.transaction(() => {
    if (previous) {
      const change = db.prepare('UPDATE sre_profiles SET archived_at=NULL,config_json=?,enabled=?,version=?,host_revision=?,engine_id=?,updated_at=?,updated_by=? WHERE id=? AND version=?')
        .run(JSON.stringify(config), Number(input.enabled !== false), version, revision, info.ID, now, actor, id, previous.version);
      if (!change.changes) throw incidentError('目标已被更新，请刷新');
      db.prepare('UPDATE sre_autonomy_policies SET enabled=0,version=version+1,updated_at=? WHERE profile_id=?').run(now, id);
    } else {
      if (db.prepare('SELECT COUNT(*) AS n FROM sre_profiles WHERE archived_at IS NULL').get().n >= 200) throw incidentError('可靠性目标已达 200 个上限');
      if (db.prepare('SELECT 1 FROM sre_profiles WHERE host_id=? AND project_id=? AND service_name=?').get(hostId, projectId, serviceName)) throw incidentError('该应用服务已有可靠性目标');
      db.prepare('INSERT INTO sre_profiles(id,host_id,project_id,project_name,service_name,host_revision,engine_id,config_json,enabled,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, hostId, projectId, project.projectName, serviceName, revision, info.ID, JSON.stringify(config), Number(input.enabled !== false), now, now, actor);
    }
  })();
  recordAgentAuditEvent({ executionId: id, eventType: 'sre_profile_updated', actor, toolName: 'sre.profile', decision: 'saved', details: { version, projectId, hostId, serviceName, enabled: input.enabled !== false } });
  return getSreProfile(id);
}
export function pauseSreProfile(id, actor = 'admin') {
  const profile = getSreProfile(id), now = Date.now();
  closeProfileIncidents(id, '应用可靠性目标已暂停，观测终止', actor);
  db.transaction(() => {
    db.prepare('UPDATE sre_profiles SET enabled=0,version=version+1,updated_at=?,updated_by=? WHERE id=?').run(now, actor, id);
    db.prepare('UPDATE sre_autonomy_policies SET enabled=0,version=version+1,updated_at=? WHERE profile_id=?').run(now, id);
  })();
  recordAgentAuditEvent({ executionId: id, eventType: 'sre_profile_paused', actor, toolName: 'sre.profile', decision: 'paused', details: { projectId: profile.projectId } });
  return getSreProfile(id);
}

export function archiveSreProfile(id, actor = 'admin') {
  pauseSreProfile(id, actor);
  db.transaction(() => {
    db.prepare('UPDATE sre_profiles SET archived_at=? WHERE id=?').run(Date.now(), id);
    recordAgentAuditEvent({ executionId: id, eventType: 'sre_profile_archived', actor, toolName: 'sre.profile', decision: 'archived' });
  })();
  return getSreProfile(id);
}
