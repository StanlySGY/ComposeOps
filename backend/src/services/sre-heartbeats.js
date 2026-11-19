import { randomUUID } from 'node:crypto';
import db from '../lib/db.js';
import { redactSecretValue } from '../lib/secret-redactor.js';

export const platformInstance = randomUUID();
export function workerHeartbeat(name, { state = 'idle', workStartedAt = null, progress = false, error = '', at = Date.now() } = {}) {
  try {
    db.prepare(`INSERT INTO sre_worker_heartbeats(name,instance_id,state,heartbeat_at,work_started_at,progress_at,error)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET instance_id=excluded.instance_id,state=excluded.state,
      heartbeat_at=excluded.heartbeat_at,work_started_at=excluded.work_started_at,error=excluded.error,
      progress_at=CASE WHEN ? OR instance_id<>excluded.instance_id THEN excluded.progress_at ELSE progress_at END`)
      .run(name, platformInstance, state, at, workStartedAt, at, String(redactSecretValue(error)).slice(0, 500), Number(progress));
    return true;
  } catch (cause) {
    // Heartbeats are best-effort: a concurrent SQLite writer may briefly own
    // the WAL lock. Skip this sample and let the next tick retry; never crash
    // the API process because observability could not persist one heartbeat.
    if (cause?.code === 'SQLITE_BUSY' || cause?.code === 'SQLITE_LOCKED' || cause?.errcode === 5 || cause?.errcode === 6) return false;
    throw cause;
  }
}
export function workerHeartbeats(now = Date.now()) {
  return db.prepare('SELECT * FROM sre_worker_heartbeats').all().map(row => ({ name: row.name, state: row.state,
    currentInstance: row.instance_id === platformInstance, heartbeatAt: row.heartbeat_at, ageMs: Math.max(0, now - row.heartbeat_at),
    workStartedAt: row.work_started_at, progressAt: row.progress_at, error: row.error }));
}
