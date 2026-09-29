import {
  addEventRecord,
  listEventRecords,
  updateEventRecord,
  pruneEventRecords,
} from '../lib/db.js';
import { emitEvent, listAlertEvents, updateAlertEvent, pruneAlertEvents } from './events.js';

/**
 * 统一事件中心(Event Center 2.0):
 * - 告警/巡检/部署/回滚/Agent/GitOps/工作流 全部收敛为 event_records 单一事实来源;
 * - 提供统一查询(按类型/级别/状态过滤)与状态流转(open → acknowledged → resolved → closed);
 * - 记录时同步广播到实时订阅者(EventCenter WS)。
 */

export function recordEvent({ eventType = 'alert', source = 'system', title, detail = '', severity = 'info', status = 'open', assetId = null, assetName = '', payload = {} }) {
  const record = addEventRecord({ eventType, source, title, detail, severity, status, assetId, assetName, payload });
  emitEvent({ type: 'event', eventType, ...record });
  return record;
}

export function queryEvents({ eventType = '', severity = '', status = '', limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const unified = listEventRecords({ limit: 500 });
  const representedLegacyIds = new Set(
    unified
      .map((event) => Number(event.payload?.legacyAlertId))
      .filter((id) => Number.isInteger(id) && id > 0),
  );
  // 旧版告警链仍服务顶部告警栏与 Agent 诊断。查询层把尚未迁移的旧记录映射进统一视图,
  // 避免切换到新版事件中心后真实告警消失;带 legacyAlertId 的记录不重复显示。
  const legacy = listAlertEvents(500)
    .filter((event) => !representedLegacyIds.has(Number(event.id)))
    .map(mapLegacyAlertEvent);
  return [...unified, ...legacy]
    .filter((event) => !eventType || event.eventType === eventType)
    .filter((event) => !severity || event.severity === severity)
    .filter((event) => !status || event.status === status)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, safeLimit);
}

export function updateEvent(id, patch = {}) {
  const legacyId = parseLegacyAlertId(id);
  if (legacyId) {
    const status = patch.status;
    const legacyPatch = {};
    if (patch.read !== undefined) legacyPatch.read = patch.read;
    if (['acknowledged', 'resolved', 'closed'].includes(status)) {
      legacyPatch.read = true;
      legacyPatch.muted = true;
    } else if (status === 'open') {
      legacyPatch.read = false;
      legacyPatch.muted = false;
    }
    const updated = updateAlertEvent(legacyId, legacyPatch);
    return updated ? mapLegacyAlertEvent(updated, status) : null;
  }
  return updateEventRecord(id, patch);
}

export function pruneEvents(days = 30) {
  const unified = pruneEventRecords(days);
  const legacy = pruneAlertEvents(days);
  return { changes: unified.changes + legacy.changes };
}

/** 事件中心统计:按类型/级别/状态聚合,供前端概览。 */
export function eventStats() {
  const events = queryEvents({ limit: 500 });
  const byType = {};
  const bySeverity = {};
  const byStatus = {};
  for (const event of events) {
    byType[event.eventType] = (byType[event.eventType] || 0) + 1;
    bySeverity[event.severity] = (bySeverity[event.severity] || 0) + 1;
    byStatus[event.status] = (byStatus[event.status] || 0) + 1;
  }
  return {
    total: events.length,
    open: byStatus.open || 0,
    byType,
    bySeverity,
    byStatus,
  };
}

function parseLegacyAlertId(value) {
  const match = /^legacy-alert-(\d+)$/.exec(String(value || ''));
  return match ? Number(match[1]) : 0;
}

function mapLegacyAlertEvent(event, forcedStatus = '') {
  const priority = String(event.priority || 'warning');
  // 旧表没有 status 列:已读=acknowledged,已读且静默=resolved(兼容层无法区分 resolved/closed)。
  const status = forcedStatus || (event.read ? (event.muted ? 'resolved' : 'acknowledged') : 'open');
  return {
    id: `legacy-alert-${Number(event.id)}`,
    eventType: 'alert',
    source: 'alert-monitor',
    title: event.title || '告警',
    detail: event.detail || '',
    severity: priority === 'danger' ? 'danger' : priority === 'info' ? 'info' : 'warning',
    status,
    assetId: null,
    assetName: event.target || '',
    payload: {
      legacyAlertId: Number(event.id),
      key: event.key || '',
      target: event.target || '',
      logs: event.logs || '',
      diagnosis: event.diagnosis || '',
      muted: !!event.muted,
    },
    read: Number(event.read) || 0,
    createdAt: event.created_at,
    updatedAt: event.updated_at,
  };
}
