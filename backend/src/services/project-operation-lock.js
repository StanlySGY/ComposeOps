import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import db from '../lib/db.js';

const locks = new Map();
const lockContext = new AsyncLocalStorage();

const guards = new Set();
export function registerProjectOperationGuard(guard) { guards.add(guard); return () => guards.delete(guard); }
export function assertProjectOperationAllowed(projectId) {
  if (db.prepare('SELECT 1 FROM maintenance_project_locks WHERE project_id = ?').get(projectId))
    throw Object.assign(new Error('该项目正在完整备份或等待恢复原运行状态，请先处理备份任务'), { statusCode: 409, code: 'PROJECT_BUSY' });
  for (const guard of guards) guard(projectId);
}
export function isProjectOperationLocked(projectId) {
  return locks.has(projectId) || !!db.prepare('SELECT 1 FROM project_operation_leases WHERE project_id = ? AND expires_at > ?').get(projectId, Date.now());
}

/** 同一项目的 Compose/配置操作串行化,避免并发写文件与重启互相覆盖。 */
export async function withProjectOperationLock(projectId, task) {
  if (!projectId) return task();
  assertProjectOperationAllowed(projectId);
  const held = lockContext.getStore();
  if (held?.has(projectId)) return task();
  const previous = locks.get(projectId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  locks.set(projectId, current);
  await previous;
  const owner = randomUUID();
  let heartbeat;
  try {
    assertProjectOperationAllowed(projectId);
    const now = Date.now();
    const lease = db.prepare(`INSERT INTO project_operation_leases(project_id, owner, expires_at) VALUES(?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
      WHERE project_operation_leases.expires_at < ?`).run(projectId, owner, now + 120000, now);
    if (!lease.changes) throw Object.assign(new Error('该项目正在执行其他操作，请稍后重试'), { statusCode: 409, code: 'PROJECT_BUSY' });
    heartbeat = setInterval(() => {
      db.prepare('UPDATE project_operation_leases SET expires_at = ? WHERE project_id = ? AND owner = ?').run(Date.now() + 120000, projectId, owner);
    }, 30000);
    heartbeat.unref?.();
    return await lockContext.run(new Set([...(held || []), projectId]), task);
  } finally {
    clearInterval(heartbeat);
    db.prepare('DELETE FROM project_operation_leases WHERE project_id = ? AND owner = ?').run(projectId, owner);
    release();
    if (locks.get(projectId) === current) locks.delete(projectId);
  }
}

export function activeProjectLocks() {
  return locks.size;
}
