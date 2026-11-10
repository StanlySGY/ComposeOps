import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import db, { DB_PATH, setProjectPreference } from '../src/lib/db.js';
import { observeSreAlert, listSreAlerts, listAlertDeliveries, closeSreAlerts, deliverSreAlerts, recoverAlertDeliveries } from '../src/services/sre-alerts.js';
import { burnWindow, saveSloAlertRule, SLO_ALERT_DEFAULTS, evaluateSloAlerts, sloAlertEvidence } from '../src/services/sre-slo-alerts.js';
import { collectPlatformSample, evaluatePlatformSample, getPlatformConfig, savePlatformConfig, rotatePlatformMonitorToken, authenticatePlatformMonitor, createPlatformMonitor } from '../src/services/sre-platform.js';
import { workerHeartbeat, workerHeartbeats } from '../src/services/sre-heartbeats.js';
import { createSreRuntime } from '../src/services/sre-runtime.js';
import { saveSreProfile } from '../src/services/sre-profiles.js';
import { readBackupObservation } from '../src/lib/backup-observation.js';
import { backupDatabase } from '../src/lib/database-backup.js';
import { advanceCheckerState, runCheckerOnce } from '../../scripts/platform-checker.mjs';
process.env.SERVE_FRONTEND = '0'; process.env.DISABLE_BACKGROUND_JOBS = '1';
const notifications = { enabled: true, channels: [{ type: 'webhook', enabled: true }] };
const eventLog = [], deps = { notifications, event: event => eventLog.push(event) };
const base = 1800000000000;
function observe(key, condition, at, extra = {}) { return observeSreAlert({ key, scope: 'test', revision: '1', title: '测试', condition, at, ...extra }, deps); }
test.beforeEach(() => {
  db.exec('DELETE FROM sre_alert_deliveries; DELETE FROM sre_alert_states; DELETE FROM sre_platform_samples; DELETE FROM sre_worker_heartbeats;'); eventLog.length = 0;
});
test('持续触发去重；重复样本、缺测、长间隔和维护期不能假恢复', () => {
  observe('a', 'bad', base); assert.equal(observe('a', 'bad', base + 30000).state, 'firing');
  observe('a', 'bad', base + 60000); observe('a', 'bad', base + 60000);
  assert.equal(listAlertDeliveries().length, 1); assert.equal(eventLog.length, 1);
  observe('a', 'good', base + 90000); observe('a', 'unknown', base + 120000); observe('a', 'good', base + 150000);
  assert.equal(observe('a', 'good', base + 180000).state, 'firing');
  observe('a', 'good', base + 210000, { suppressed: true });
  assert.equal(observe('a', 'good', base + 240000).state, 'firing');
  observe('a', 'good', base + 270000); assert.equal(observe('a', 'good', base + 300000).state, 'resolved');
  assert.equal(listAlertDeliveries().length, 2); assert.equal(eventLog.length, 2);
  observe('gap', 'bad', base); observe('gap', 'bad', base + 30000);
  observe('gap', 'good', base + 60000); observe('gap', 'good', base + 360000); observe('gap', 'good', base + 390000);
  assert.equal(listSreAlerts().find(row => row.key === 'gap').state, 'firing');
});
test('规则改版行政关闭旧告警并取消待发通知，不冒充恢复', () => {
  observe('a', 'bad', base); observe('a', 'bad', base + 30000);
  closeSreAlerts('test', '2', '配置变更', base + 60000);
  assert.equal(listSreAlerts()[0].state, 'closed'); assert.equal(listAlertDeliveries()[0].status, 'superseded');
  assert.equal(observe('a', 'good', base + 90000).state, 'closed'); assert.equal(eventLog.length, 1);
});
test('渠道失败持久重试，成功不重发，进程中断的发送保留未知', async () => {
  observe('a', 'bad', base); observe('a', 'bad', base + 30000);
  let clock = base + 60000, calls = 0;
  const args = { now: () => clock, config: () => notifications, send: async () => { calls++; if (calls === 1) throw new Error('timeout'); return { ok: true }; } };
  await deliverSreAlerts(args); assert.equal(listAlertDeliveries()[0].status, 'retry');
  await deliverSreAlerts(args); assert.equal(calls, 1);
  clock += 120000; await deliverSreAlerts(args); await deliverSreAlerts(args);
  assert.equal(calls, 2); assert.equal(listAlertDeliveries()[0].status, 'sent');
  db.prepare("UPDATE sre_alert_deliveries SET status='sending'").run(); recoverAlertDeliveries(clock);
  await deliverSreAlerts(args); assert.equal(calls, 2); assert.equal(listAlertDeliveries()[0].status, 'outcome_unknown');
});
test('通知并发派发合并，恢复后旧触发通知失效', async () => {
  observe('a', 'bad', base); observe('a', 'bad', base + 30000);
  let release, calls = 0;
  const options = { config: () => notifications, now: () => base + 60000, send: () => { calls++; return new Promise(resolve => { release = resolve; }); } };
  const first = deliverSreAlerts(options), second = deliverSreAlerts(options);
  assert.equal(first, second); release({ ok: true }); await first; assert.equal(calls, 1);
  observe('b', 'bad', base); observe('b', 'bad', base + 30000);
  for (const delta of [60000, 90000, 120000]) observe('b', 'good', base + delta);
  await deliverSreAlerts({ config: () => notifications, now: () => base + 150000, send: async () => ({ ok: true }) });
  assert.equal(listAlertDeliveries().find(row => row.alertKey === 'b' && row.transition === 'firing').status, 'superseded');
});
test('错误预算按时间积分，短故障不会单凭瞬时失败触发长窗口；缺测不算成功', () => {
  const samples = Array.from({ length: 120 }, (_, i) => ({ sampled_at: base + i * 30000, outcome: i === 119 ? 'bad' : 'good' }));
  const result = burnWindow(samples, { now: base + 3600000, windowMs: 3600000, targetPercent: 99.9 });
  assert.equal(result.coverage, 1); assert.equal(result.badMs, 30000); assert.ok(result.burnRate < 14.4);
  const gap = burnWindow([samples[0]], { now: base + 300000, windowMs: 300000, targetPercent: 99.9 });
  assert.equal(gap.coverage, 0.1); assert.equal(gap.unknownMs, 270000);
  assert.equal(burnWindow(samples, { now: base + 3600000, windowMs: 3600000, targetPercent: 100 }).zeroBudget, true);
});
test('多窗口规则绑定目标版本；配置冲突拒绝；目标改版关闭旧状态', async () => {
  const project = { id: 'alert-project', hostId: 'local', projectName: 'alert-project', managed: true, containers: [{ id: 'c', service: 'web' }] };
  setProjectPreference(project.id, { managed: true });
  const options = { scan: async () => [project], dockerForHost: () => ({ info: async () => ({ ID: 'engine' }) }) };
  const profile = await saveSreProfile({ hostId: 'local', projectId: project.id, serviceName: 'web', config: { url: 'http://127.0.0.1:1/health' } }, 'test', options);
  const config = { ...structuredClone(SLO_ALERT_DEFAULTS), enabled: true };
  const rule = saveSloAlertRule(profile.id, { version: 0, config });
  assert.throws(() => saveSloAlertRule(profile.id, { version: 0, config }), /变化/);
  const insert = db.prepare('INSERT INTO sre_probe_samples(profile_id,version,sampled_at,outcome) VALUES(?,?,?,?)');
  for (let i = 0; i < 720; i++) insert.run(profile.id, profile.version, base + i * 30000, i >= 710 ? 'bad' : 'good');
  const evidence = sloAlertEvidence(profile, rule, base + 21600000);
  assert.equal(evidence.fast.condition, 'bad'); assert.equal(evidence.slow.condition, 'bad');
  evaluateSloAlerts(base + 21600000, deps); evaluateSloAlerts(base + 21630000, deps);
  assert.ok(listSreAlerts().some(row => row.state === 'firing'));
  await saveSreProfile({ ...profile, config: { ...profile.config, expectedStatus: 204 } }, 'test', options);
  evaluateSloAlerts(base + 21660000, deps);
  assert.ok(listSreAlerts().filter(row => row.scope === `profile:${profile.id}`).every(row => row.state === 'closed'));
});
test('平台采集计算真实增长、磁盘余量，缺文件与备份失败不伪造健康', async () => {
  db.prepare('INSERT INTO sre_platform_samples(sampled_at,data_json) VALUES(?,?)').run(base - 3600000, JSON.stringify({ databaseBytes: 100, walBytes: 20 }));
  const sample = await collectPlatformSample({ now: base, fileStat: async file => ({ size: file.endsWith('-wal') ? 40 : 200 }), filesystemStat: async () => ({ blocks: 100, bavail: 5, bsize: 4096 }), backupRead: async () => ({ state: 'failed', durationMs: 1000 }) });
  assert.equal(sample.growthBytesPerHour, 120); assert.equal(sample.diskFreePercent, 5);
  evaluatePlatformSample(sample, undefined, deps); evaluatePlatformSample({ ...sample, at: base + 30000 }, undefined, deps);
  const active = listSreAlerts().filter(row => row.state === 'firing');
  assert.ok(active.some(row => row.key.endsWith(':disk'))); assert.ok(active.some(row => row.key.endsWith(':backup-failure')));
  const missing = await collectPlatformSample({ now: base, fileStat: async () => { throw new Error('no access'); }, filesystemStat: async () => { throw new Error('no access'); } });
  assert.equal(missing.databaseBytes, null); assert.equal(missing.diskFreePercent, null); assert.ok(missing.errors.length);
});
test('心跳保留工作开始时间，旧进程心跳不能满足当前进程', () => {
  workerHeartbeat('sre-runtime', { state: 'working', workStartedAt: base, at: base });
  workerHeartbeat('sre-runtime', { state: 'working', workStartedAt: base, at: base + 30000 });
  assert.equal(workerHeartbeats(base + 60000)[0].ageMs, 30000); assert.equal(workerHeartbeats(base)[0].workStartedAt, base);
  db.prepare("UPDATE sre_worker_heartbeats SET instance_id='old'").run(); assert.equal(workerHeartbeats(base)[0].currentInstance, false);
});
test('可靠性执行器工作阻塞时心跳仍推进且不会重复执行；停机后不再触发', async () => {
  let calls = 0, resolve;
  db.prepare("INSERT INTO sre_changes(id,status,host_id,project_id,profile_id,review_json,created_at,updated_at,expires_at,reviewed_by) VALUES('pending-test','queued','local','p','p','{}',1,1,9999999999999,'test')").run();
  const runtime = createSreRuntime({ intervalMs: 10, schedule: () => {}, change: () => { calls++; return new Promise(done => { resolve = done; }); } });
  runtime.start(); await new Promise(done => setTimeout(done, 35));
  assert.equal(calls, 1); assert.equal(workerHeartbeats()[0].state, 'working');
  const stopping = runtime.stop(); resolve(); await stopping;
  await new Promise(done => setTimeout(done, 20)); assert.equal(calls, 1);
  db.prepare("DELETE FROM sre_changes WHERE id='pending-test'").run();
});
test('平台监测停机时取消迟到结果，避免停止后写入样本', async () => {
  let resolve;
  const monitor = createPlatformMonitor({ collect: () => new Promise(done => { resolve = done; }) });
  monitor.start(); const stopping = monitor.stop(); resolve({ at: base }); await stopping;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sre_platform_samples').get().n, 0);
});
test('备份记录只在快照验证通过后成功，失败保留上次成功时间', async () => {
  const result = await backupDatabase(DB_PATH, path.join(path.dirname(DB_PATH), 'verified-backup.db'));
  assert.equal(result.observationRecorded, true);
  const first = await readBackupObservation(DB_PATH); assert.equal(first.state, 'succeeded'); assert.ok(first.lastSuccessAt);
  await assert.rejects(backupDatabase(DB_PATH, DB_PATH), /相同/);
  const failed = await readBackupObservation(DB_PATH); assert.equal(failed.state, 'failed'); assert.equal(failed.lastSuccessAt, first.lastSuccessAt);
});
test('阈值版本检查与凭据轮换；凭据只授权健康检查', async () => {
  const current = getPlatformConfig();
  assert.throws(() => savePlatformConfig({ ...current, thresholds: { ...current.thresholds, diskFreePercent: 0 } }), /范围/);
  savePlatformConfig(current); assert.throws(() => savePlatformConfig(current), /变化/);
  const first = rotatePlatformMonitorToken().token; assert.equal(authenticatePlatformMonitor(`Bearer ${first}`), true);
  const second = rotatePlatformMonitorToken().token; assert.equal(authenticatePlatformMonitor(`Bearer ${first}`), false);
  const { buildApp } = await import('../src/app.js'); const { setPassword } = await import('../src/lib/auth.js');
  setPassword('observability-test-password'); const app = await buildApp({ logger: false });
  try {
    assert.equal((await app.inject('/api/v1/sre/platform')).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/healthz/platform/', payload: { location: 'same-host' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/healthz/platform/', headers: { authorization: `Bearer ${second}` }, payload: { location: 'same-host' } })).statusCode, 503);
    assert.equal((await app.inject({ url: '/api/v1/sre/platform', headers: { authorization: `Bearer ${second}` } })).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'observability-test-password' }, headers: { origin: 'http://localhost', host: 'localhost' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/sre/platform/monitor-token', headers: { cookie, origin: 'https://evil.invalid', host: 'localhost' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/v1/sre/platform', headers: { cookie } })).statusCode, 200);
  } finally { await app.close(); }
});
test('独立检查器真实 HTTP 停止/恢复，持久去重与通知失败重试', async () => {
  let healthy = true, deliveries = 0, failDelivery = true, clock = Date.now();
  const server = http.createServer((request, response) => {
    if (request.url === '/notify') { deliveries++; response.writeHead(failDelivery ? 503 : 200); response.end('{}'); return; }
    if (!healthy) { response.destroy(); return; }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ status: 'ok', at: clock, stale: false }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`, folder = path.dirname(DB_PATH);
  const config = { url: address + '/health', tokenFile: path.join(folder, 'checker.token'), stateFile: path.join(folder, 'checker.json'), webhookUrl: address + '/notify', location: 'same-host' };
  await writeFile(config.tokenFile, 'a'.repeat(64), { mode: 0o600 });
  const run = async () => { clock += 30000; return runCheckerOnce(config, { now: () => clock }); };
  try {
    await run(); await run(); assert.equal((await run()).status, 'healthy');
    healthy = false; await run(); await run(); let result = await run(); assert.equal(result.status, 'firing'); assert.equal(deliveries, 1); assert.equal(result.transitions[0].notification, 'retry');
    failDelivery = false; await run(); result = await run(); assert.equal(result.transitions[0].notification, 'sent'); assert.equal(deliveries, 2);
    await run(); assert.equal(deliveries, 2);
    healthy = true; await run(); await run(); result = await run(); assert.equal(result.status, 'healthy'); assert.equal(deliveries, 3);
    const saved = JSON.parse(await readFile(config.stateFile, 'utf8')); assert.equal(saved.transitions.length, 2); assert.equal(JSON.stringify(saved).includes('a'.repeat(64)), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('独立检查器缺测不累计连续恢复，重复观测不新增事件', () => {
  let state = {};
  for (let i = 0; i < 3; i++) state = advanceCheckerState(state, { at: base + i * 30000, ok: false });
  assert.equal(state.status, 'firing');
  state = advanceCheckerState(state, { at: base + 90000, ok: true });
  state = advanceCheckerState(state, { at: base + 300000, ok: true });
  assert.equal(state.status, 'firing'); assert.equal(state.good, 1);
  assert.equal(advanceCheckerState(state, { at: base + 300000, ok: false }).transitions.length, 1);
});
