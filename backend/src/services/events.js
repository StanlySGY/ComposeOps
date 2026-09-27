import {
  addAlertEvent as dbAddAlertEvent,
  listAlertEvents as dbListAlertEvents,
  updateAlertEvent as dbUpdateAlertEvent,
  pruneAlertEvents as dbPruneAlertEvents,
} from '../lib/db.js';

/**
 * 轻量事件总线 + 持久化告警事件:
 * - 内存订阅(供 EventCenter WS 实时推送)
 * - 告警/异常事件落库(alert_events),带 priority / read / muted 状态
 */

const SUBSCRIBERS = new Set(); // Set<Function>

/** 订阅事件流,返回退订函数。 */
export function subscribeEvents(callback) {
  if (typeof callback === 'function') SUBSCRIBERS.add(callback);
  return () => SUBSCRIBERS.delete(callback);
}

/** 广播事件到订阅者(不落库,用于实时 UI 提示)。 */
export function emitEvent(payload) {
  const event = { ts: Date.now(), ...payload };
  for (const subscriber of SUBSCRIBERS) {
    try { subscriber(event); } catch { /* 单个订阅者异常不应阻断事件广播。 */ }
  }
  return event;
}

/**
 * 记录一条持久化告警事件。同一 key(如 containerId:event)的未读事件会先静默,避免重复刷屏。
 */
export function recordAlertEvent({ key, title, detail, priority = 'warning', to = null, logs = '' }) {
  return dbAddAlertEvent({
    key: String(key || ''),
    title: String(title || '告警'),
    detail: String(detail || ''),
    priority,
    to,
    logs,
  });
}

/** 记录并广播(health-alerter / alert-monitor 使用)。 */
export function recordAlertEventAndNotify({ key, title, detail, priority = 'warning', to = null, logs = '' }) {
  const event = recordAlertEvent({ key, title, detail, priority, to, logs });
  emitEvent({ type: 'alert', ...event });
  // 守护模式:开关开启时 fire-and-forget AI 自动诊断(带冷却,绝不影响告警主链路)
  void (async () => {
    try {
      const { maybeDiagnose } = await import('./guardian.js');
      maybeDiagnose(event);
    } catch { /* 守护模块加载失败不影响告警 */ }
  })();
  return event;
}

export function listAlertEvents(limit = 50) {
  return dbListAlertEvents(limit);
}

export function updateAlertEvent(id, patch = {}) {
  return dbUpdateAlertEvent(id, patch);
}

export function pruneAlertEvents(days = 7) {
  return dbPruneAlertEvents(days);
}
