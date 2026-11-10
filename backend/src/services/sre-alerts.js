import { randomUUID } from 'node:crypto';
import db from '../lib/db.js';
import { redactSecretValue } from '../lib/secret-redactor.js';
import { getNotificationConfig, sendNotification } from './notifications.js';
import { recordEvent } from './event-center.js';

const json = value => JSON.stringify(redactSecretValue(value));
const view = row => row && ({ key: row.key, scope: row.scope, revision: row.revision, title: row.title,
  state: row.state, condition: row.condition, episode: row.episode, observedAt: row.observed_at,
  changedAt: row.changed_at, suppressed: !!row.suppressed, detail: JSON.parse(row.detail_json) });
export const listSreAlerts = (scope = '') => db.prepare('SELECT * FROM sre_alert_states WHERE (? = \'\' OR scope = ?) ORDER BY changed_at DESC LIMIT 300').all(scope, scope).map(view);
export const listAlertDeliveries = () => db.prepare('SELECT id,alert_key AS alertKey,transition,channel,status,attempts,updated_at AS updatedAt,error FROM sre_alert_deliveries ORDER BY created_at DESC LIMIT 200').all();

function queueDelivery(row, transition, now, config) {
  const title = `ComposeOps：${transition === 'firing' ? '告警' : '恢复'} · ${row.title}`;
  const body = `${row.scope}\n${JSON.stringify(JSON.parse(row.detail_json))}\n事件 ${row.key} / ${row.episode} / ${transition}`;
  const channels = config.enabled ? config.channels.filter(channel => channel.enabled).map(channel => channel.type) : [];
  for (const channel of channels.length ? channels : ['none']) {
    db.prepare(`INSERT OR IGNORE INTO sre_alert_deliveries(id,alert_key,episode,transition,channel,title,body,status,next_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), row.key, row.episode, transition, channel, title, body,
      channel === 'none' ? 'unconfigured' : 'pending', now, now, now);
  }
}

/** One durable state per versioned condition. Repeated samples and process restarts cannot re-trigger it. */
export function observeSreAlert({ key, scope, revision = '1', title, condition, detail = {}, at = Date.now(),
  suppressed = false, fireAfter = 2, recoverAfter = 3, recoverMs = 60000, maxGapMs = 90000 },
{ notifications = getNotificationConfig(true), event = recordEvent } = {}) {
  if (!['good', 'bad', 'unknown'].includes(condition) || !Number.isFinite(at)) throw new Error('无效告警观测');
  let transition;
  const result = db.transaction(() => {
    let row = db.prepare('SELECT * FROM sre_alert_states WHERE key=?').get(key);
    if (row && (at <= row.observed_at || row.state === 'closed')) return view(row);
    if (!row) row = { key, scope, revision, title, state: 'normal', condition: 'unknown', episode: 0,
      bad_count: 0, good_count: 0, good_since: null, observed_at: at, changed_at: at, suppressed: 0 };
    const contiguous = at - row.observed_at <= maxGapMs && !row.suppressed && !suppressed;
    row.bad_count = condition === 'bad' && !suppressed ? (contiguous ? row.bad_count : 0) + 1 : 0;
    row.good_count = condition === 'good' && !suppressed ? (contiguous ? row.good_count : 0) + 1 : 0;
    row.good_since = row.good_count > 1 ? row.good_since : row.good_count ? at : null;
    if (row.state !== 'firing' && row.bad_count >= fireAfter) { row.state = 'firing'; row.episode++; transition = 'firing'; }
    if (row.state === 'firing' && row.good_count >= recoverAfter && at - row.good_since >= recoverMs) { row.state = 'resolved'; transition = 'resolved'; }
    Object.assign(row, { condition, observed_at: at, detail_json: json(detail), suppressed: Number(suppressed), title: String(redactSecretValue(title)) });
    if (transition) row.changed_at = at;
    db.prepare(`INSERT INTO sre_alert_states(key,scope,revision,title,state,condition,episode,bad_count,good_count,good_since,observed_at,changed_at,detail_json,suppressed)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET title=excluded.title,state=excluded.state,condition=excluded.condition,
      episode=excluded.episode,bad_count=excluded.bad_count,good_count=excluded.good_count,good_since=excluded.good_since,
      observed_at=excluded.observed_at,changed_at=excluded.changed_at,detail_json=excluded.detail_json,suppressed=excluded.suppressed`)
      .run(key, scope, String(revision), row.title, row.state, condition, row.episode, row.bad_count, row.good_count, row.good_since, at, row.changed_at, row.detail_json, row.suppressed);
    if (transition) queueDelivery(row, transition, at, notifications);
    return view(row);
  })();
  if (transition) event({ eventType: 'alert', source: 'sre-alerts', title: result.title,
    severity: transition === 'firing' ? 'warning' : 'info', status: transition === 'firing' ? 'open' : 'resolved',
    detail: transition === 'firing' ? '持续观测触发告警' : '连续独立观测已验证恢复', payload: result });
  return result;
}

export function closeSreAlerts(scope, revision, reason, now = Date.now(), { withinTransaction = false } = {}) {
  const close = () => {
    const rows = db.prepare("SELECT key FROM sre_alert_states WHERE scope=? AND revision<>? AND state<>'closed'").all(scope, String(revision));
    for (const row of rows) {
      db.prepare("UPDATE sre_alert_states SET state='closed',changed_at=?,detail_json=? WHERE key=?").run(now, json({ reason, administrativeClosure: true }), row.key);
      db.prepare("UPDATE sre_alert_deliveries SET status='superseded',updated_at=? WHERE alert_key=? AND status IN ('pending','retry')").run(now, row.key);
    }
    return rows.length;
  };
  return withinTransaction ? close() : db.transaction(close)();
}

/** Interrupted deliveries are ambiguous: do not silently resend a possibly delivered notification. */
export function recoverAlertDeliveries(now = Date.now()) {
  return db.prepare("UPDATE sre_alert_deliveries SET status='outcome_unknown',error='通知发送被中断，需核对接收端',updated_at=? WHERE status='sending'").run(now).changes;
}
let delivering;
export function deliverSreAlerts({ send = sendNotification, now = Date.now, config = getNotificationConfig } = {}) {
  if (delivering) return delivering;
  delivering = (async () => {
    const rows = db.prepare("SELECT * FROM sre_alert_deliveries WHERE status IN ('pending','retry') AND next_at<=? ORDER BY created_at,id LIMIT 8").all(now());
    for (const row of rows) {
      // Recheck state: a later transition/configuration may supersede a pending notification.
      const live = db.prepare('SELECT state,episode FROM sre_alert_states WHERE key=?').get(row.alert_key);
      if (!live || live.state === 'closed' || live.episode !== row.episode || (row.transition === 'firing' && live.state !== 'firing')) {
        db.prepare("UPDATE sre_alert_deliveries SET status='superseded',updated_at=? WHERE id=? AND status IN ('pending','retry')").run(now(), row.id); continue;
      }
      const settings = config(true), channel = settings.channels.find(item => item.type === row.channel && item.enabled);
      if (!settings.enabled || !channel) {
        db.prepare("UPDATE sre_alert_deliveries SET status='unconfigured',updated_at=? WHERE id=?").run(now(), row.id); continue;
      }
      const claimed = db.prepare("UPDATE sre_alert_deliveries SET status='sending',attempts=attempts+1,updated_at=? WHERE id=? AND status IN ('pending','retry')").run(now(), row.id);
      if (!claimed.changes) continue;
      try {
        const result = await send(row.title, row.body, { enabled: true, channels: [channel] });
        if (!result?.ok || result.results?.some(item => !item.ok)) throw new Error('接收渠道未确认发送成功');
        db.prepare("UPDATE sre_alert_deliveries SET status='sent',updated_at=?,error='' WHERE id=?").run(now(), row.id);
      } catch (error) {
        const attempts = row.attempts + 1;
        db.prepare('UPDATE sre_alert_deliveries SET status=?,next_at=?,updated_at=?,error=? WHERE id=?')
          .run(attempts >= 5 ? 'failed' : 'retry', now() + Math.min(3600000, 30000 * 2 ** attempts), now(), String(redactSecretValue(error.message)).slice(0, 500), row.id);
      }
    }
    return rows.length;
  })().finally(() => { delivering = null; });
  return delivering;
}

export function pruneSreObservations(now = Date.now()) {
  db.prepare('DELETE FROM sre_platform_samples WHERE sampled_at<?').run(now - 7 * 86400000);
  db.prepare("DELETE FROM sre_alert_deliveries WHERE updated_at<? AND status NOT IN ('pending','retry','sending','outcome_unknown')").run(now - 90 * 86400000);
  db.prepare("DELETE FROM sre_alert_states WHERE changed_at<? AND state IN ('closed','resolved','normal') AND key NOT IN (SELECT alert_key FROM sre_alert_deliveries)").run(now - 90 * 86400000);
}
