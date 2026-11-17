import { stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import db, { DB_PATH, getSetting, setSetting } from '../lib/db.js';
import { readBackupObservation } from '../lib/backup-observation.js';
import { workerHeartbeats, workerHeartbeat } from './sre-heartbeats.js';
import { observeSreAlert, closeSreAlerts, deliverSreAlerts, recoverAlertDeliveries, pruneSreObservations, listSreAlerts, listAlertDeliveries } from './sre-alerts.js';
import { evaluateSloAlerts } from './sre-slo-alerts.js';
import { recordAgentAuditEvent } from './agent/policy-store.js';
import { pruneTelemetry } from './sre-telemetry.js';

export const PLATFORM_DEFAULTS = Object.freeze({ heartbeatSeconds: 90, queueMinutes: 10, executionMinutes: 30,
  databaseGiB: 10, walMiB: 1024, growthMiBPerHour: 512, diskFreePercent: 10, backupHours: 48, backupMinutes: 30,
  externalSeconds: 120, maintenanceUntil: 0 });
const bounds = { heartbeatSeconds: [30, 600], queueMinutes: [1, 1440], executionMinutes: [1, 1440], databaseGiB: [0.1, 10000],
  walMiB: [1, 100000], growthMiBPerHour: [1, 100000], diskFreePercent: [1, 90], backupHours: [1, 8760], backupMinutes: [1, 1440], externalSeconds: [30, 3600] };
export function getPlatformConfig() {
  return JSON.parse(getSetting('sre.platform.config', JSON.stringify({ version: 0, thresholds: PLATFORM_DEFAULTS })));
}
export function savePlatformConfig(input, actor = 'admin') {
  const current = getPlatformConfig();
  if (input.version !== current.version) throw Object.assign(new Error('平台阈值已变化，请刷新'), { statusCode: 409 });
  const thresholds = {};
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const value = input.thresholds?.[key];
    if (!Number.isFinite(value) || value < min || value > max) throw Object.assign(new Error(`阈值 ${key} 超出范围`), { statusCode: 400 });
    thresholds[key] = value;
  }
  const maintenanceUntil = input.thresholds?.maintenanceUntil || 0;
  if (!Number.isSafeInteger(maintenanceUntil) || maintenanceUntil < 0 || maintenanceUntil > Date.now() + 30 * 86400000) throw Object.assign(new Error('维护截止时间无效'), { statusCode: 400 });
  thresholds.maintenanceUntil = maintenanceUntil;
  const next = { version: current.version + 1, thresholds, updatedBy: actor, updatedAt: Date.now() };
  db.transaction(() => {
    setSetting('sre.platform.config', JSON.stringify(next));
    closeSreAlerts('platform', String(next.version), '平台阈值已修改；关闭旧告警不代表恢复', Date.now(), { withinTransaction: true });
    recordAgentAuditEvent({ eventType: 'sre_platform_thresholds', actor, toolName: 'sre.platform', decision: 'saved', details: next });
  })();
  return next;
}
export function rotatePlatformMonitorToken(actor = 'admin') {
  const token = randomBytes(32).toString('hex');
  setSetting('sre.platform.monitor_token_hash', createHash('sha256').update(token).digest('hex'));
  setSetting('sre.platform.external', JSON.stringify({ at: null, location: 'unknown' }));
  recordAgentAuditEvent({ eventType: 'sre_monitor_token_rotated', actor, toolName: 'sre.platform', decision: 'rotated' });
  return { token };
}
export function authenticatePlatformMonitor(authorization) {
  const token = /^Bearer ([a-f0-9]{64})$/.exec(String(authorization || ''))?.[1];
  const stored = getSetting('sre.platform.monitor_token_hash', '');
  if (!token || !/^[a-f0-9]{64}$/.test(stored)) return false;
  return timingSafeEqual(Buffer.from(stored, 'hex'), createHash('sha256').update(token).digest());
}
export function recordExternalCheck(location, now = Date.now()) {
  if (!['same-host', 'separate-host'].includes(location)) throw Object.assign(new Error('请声明检查器部署位置'), { statusCode: 400 });
  setSetting('sre.platform.external', JSON.stringify({ at: now, location }));
}
export function queueAges(now = Date.now()) {
  const query = (table, queueTime, startTime, busyStates) => {
    const rows = db.prepare(`SELECT status,${queueTime} AS queued,${startTime} AS started FROM ${table} WHERE status IN ('queued',${busyStates.map(() => '?').join(',')})`).all(...busyStates);
    return { queued: rows.filter(row => row.status === 'queued').length, executing: rows.filter(row => row.status !== 'queued').length,
      oldestQueuedMs: Math.max(0, ...rows.filter(row => row.status === 'queued').map(row => now - row.queued)),
      oldestExecutionMs: Math.max(0, ...rows.filter(row => row.status !== 'queued').map(row => now - (row.started ?? row.queued))) };
  };
  return {
    effects: query('ops_effects', "CAST(strftime('%s',created_at) AS INTEGER)*1000", "CAST(strftime('%s',started_at) AS INTEGER)*1000", ['leased', 'executing']),
    changes: query('sre_changes', 'created_at', 'started_at', ['checking', 'executing', 'verifying', 'rolling_back', 'verifying_rollback']),
    recovery: query('sre_recovery_runs', 'created_at', 'started_at', ['running']),
    businessBackups: query('sre_business_backups', 'created_at', 'started_at', ['running']),
    businessRecovery: query('sre_business_runs', 'created_at', 'started_at', ['running']),
    diagnosis: query('sre_diagnosis_evaluations', 'created_at', 'started_at', ['running']),
  };
}
export async function collectPlatformSample({ now = Date.now(), source = DB_PATH, fileStat = stat, filesystemStat = statfs, backupRead = readBackupObservation } = {}) {
  const errors = [];
  const size = async (file, missingZero = false) => { try { return (await fileStat(file)).size; } catch (error) { if (missingZero && error.code === 'ENOENT') return 0; errors.push('文件容量读取失败'); return null; } };
  const [databaseBytes, walBytes, disk, backup] = await Promise.all([size(source), size(`${source}-wal`, true), filesystemStat(path.dirname(source)).catch(() => { errors.push('磁盘容量读取失败'); return null; }), backupRead(source)]);
  const previous = db.prepare('SELECT sampled_at,data_json FROM sre_platform_samples WHERE sampled_at<=? AND sampled_at>=? ORDER BY sampled_at DESC LIMIT 1').get(now - 300000, now - 7200000);
  const previousData = previous ? JSON.parse(previous.data_json) : null;
  const growthBytesPerHour = previous && databaseBytes != null && walBytes != null && previousData.databaseBytes != null && previousData.walBytes != null
    ? Math.max(0, (databaseBytes + walBytes - previousData.databaseBytes - previousData.walBytes) * 3600000 / (now - previous.sampled_at)) : null;
  return { at: now, databaseBytes, walBytes, growthBytesPerHour, diskTotalBytes: disk ? disk.blocks * disk.bsize : null,
    diskFreeBytes: disk ? disk.bavail * disk.bsize : null, diskFreePercent: disk?.blocks ? disk.bavail / disk.blocks * 100 : null,
    backup, workers: workerHeartbeats(now), queues: queueAges(now), errors,
    external: { configured: !!getSetting('sre.platform.monitor_token_hash'), ...JSON.parse(getSetting('sre.platform.external', '{}')) } };
}
export function evaluatePlatformSample(sample, config = getPlatformConfig(), dependencies = {}) {
  const t = config.thresholds, now = sample.at, revision = String(config.version);
  const observe = (key, title, condition, detail) => observeSreAlert({ key: `platform:${revision}:${key}`, scope: 'platform', revision, title, condition, detail, at: now, suppressed: t.maintenanceUntil > now }, dependencies);
  const threshold = (key, title, value, maximum) => observe(key, title, value == null ? 'unknown' : value > maximum ? 'bad' : 'good', { value, maximum });
  threshold('database', '平台数据库容量', sample.databaseBytes, t.databaseGiB * 1024 ** 3);
  threshold('wal', '平台 WAL 容量', sample.walBytes, t.walMiB * 1024 ** 2);
  threshold('growth', '平台数据库增长速率', sample.growthBytesPerHour, t.growthMiBPerHour * 1024 ** 2);
  observe('disk', '平台磁盘余量', sample.diskFreePercent == null ? 'unknown' : sample.diskFreePercent < t.diskFreePercent ? 'bad' : 'good', { percent: sample.diskFreePercent, minimum: t.diskFreePercent });
  observe('collection', '平台容量采集失败', sample.errors.length ? 'bad' : 'good', { errors: sample.errors });
  const backupAge = sample.backup.lastSuccessAt ? now - sample.backup.lastSuccessAt : null;
  observe('backup-age', '平台备份过期或缺少记录', backupAge == null || backupAge > t.backupHours * 3600000 ? 'bad' : 'good', { ageMs: backupAge, maximumHours: t.backupHours });
  observe('backup-failure', '最近平台备份失败', sample.backup.state === 'failed' ? 'bad' : sample.backup.state === 'succeeded' ? 'good' : 'unknown', sample.backup);
  threshold('backup-duration', '平台备份耗时', sample.backup.state === 'running' ? now - sample.backup.startedAt : sample.backup.durationMs ?? null, t.backupMinutes * 60000);
  const expected = process.env.DISABLE_BACKGROUND_JOBS === '1' ? [] : ['sre-runtime', 'incident-observer'];
  if (process.env.OPS_EFFECT_WORKER_ENABLED === '1') expected.push('effect-worker');
  for (const name of expected) {
    const worker = sample.workers.find(row => row.name === name);
    observe(`worker:${name}`, `执行器心跳 · ${name}`, !worker || !worker.currentInstance || worker.ageMs > t.heartbeatSeconds * 1000 || ['stopped', 'error'].includes(worker.state) ? 'bad' : 'good', { worker: worker || null, maximumSeconds: t.heartbeatSeconds });
    threshold(`worker-duration:${name}`, `执行器单轮耗时 · ${name}`, worker?.workStartedAt ? now - worker.workStartedAt : 0, t.executionMinutes * 60000);
  }
  for (const [name, queue] of Object.entries(sample.queues)) {
    threshold(`queue:${name}`, `任务等待超时 · ${name}`, queue.oldestQueuedMs, t.queueMinutes * 60000);
    threshold(`execution:${name}`, `任务执行超时 · ${name}`, queue.oldestExecutionMs, t.executionMinutes * 60000);
  }
  observe('external', '独立检查器心跳', !sample.external.configured || !sample.external.at || now - sample.external.at > t.externalSeconds * 1000 ? 'bad' : 'good', sample.external);
}
export function platformSnapshot(now = Date.now()) {
  const row = db.prepare('SELECT * FROM sre_platform_samples ORDER BY sampled_at DESC LIMIT 1').get();
  const sample = row ? JSON.parse(row.data_json) : null;
  return { config: getPlatformConfig(), sample, stale: !sample || now - sample.at > 90000,
    history: db.prepare('SELECT sampled_at,data_json FROM sre_platform_samples WHERE sampled_at>=? ORDER BY sampled_at DESC LIMIT 120').all(now - 3600000)
      .reverse().map(item => { const value = JSON.parse(item.data_json); return { at: item.sampled_at, databaseBytes: value.databaseBytes, walBytes: value.walBytes, diskFreePercent: value.diskFreePercent }; }),
    alerts: listSreAlerts(), deliveries: listAlertDeliveries() };
}
export function createPlatformMonitor({ collect = collectPlatformSample, logger = console, intervalMs = 30000 } = {}) {
  let timer, pending, stopped = true;
  const runOnce = () => {
    if (pending) return pending;
    pending = (async () => {
      workerHeartbeat('platform-monitor', { state: 'working', workStartedAt: Date.now() });
      const sample = await collect();
      if (stopped) return null;
      db.prepare('INSERT OR REPLACE INTO sre_platform_samples(sampled_at,data_json) VALUES(?,?)').run(sample.at, JSON.stringify(sample));
      evaluatePlatformSample(sample); evaluateSloAlerts(sample.at); pruneSreObservations(sample.at);
      pruneTelemetry(sample.at);
      workerHeartbeat('platform-monitor', { state: 'idle', progress: true });
      // Delivery may take minutes; observation must continue independently.
      void deliverSreAlerts().catch(error => logger.warn?.({ message: error.message }, '告警通知暂未完成'));
      return sample;
    })().finally(() => { pending = null; });
    return pending;
  };
  const tick = () => { if (!stopped) void runOnce().catch(error => { workerHeartbeat('platform-monitor', { state: 'error', error: error.message }); logger.warn?.({ message: error.message }, '平台监测暂未完成'); }); };
  return { runOnce, start() { if (!stopped) return; stopped = false; recoverAlertDeliveries(); tick(); timer = setInterval(tick, intervalMs); timer.unref?.(); },
    async stop() { stopped = true; clearInterval(timer); await pending; workerHeartbeat('platform-monitor', { state: 'stopped' }); } };
}
let monitor;
export function startPlatformMonitor(options) { if (!monitor) { monitor = createPlatformMonitor(options); monitor.start(); } }
export async function stopPlatformMonitor() { const current = monitor; monitor = null; await current?.stop(); }
