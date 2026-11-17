import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
const directory = mkdtempSync(path.join(os.tmpdir(), 'sre-platform-test-'));
process.env.DB_PATH = path.join(directory, 'test.db');
process.env.DISABLE_BACKGROUND_JOBS = '1';
process.env.SERVE_FRONTEND = '0';
const { default: db, setProjectPreference } = await import('../src/lib/db.js');
const { saveSreProfile, getSreProfile, pauseSreProfile, validateProbeConfig } = await import('../src/services/sre-profiles.js');
const { runHttpProbe, recordProbeSample, probeStatistics, probeSnapshot, createProbeRunner } = await import('../src/services/sre-probes.js');
const { saveAutonomyPolicy, getAutonomyPolicy, considerAutomaticRecovery } = await import('../src/services/sre-autonomy.js');
const { recordIncidentObservation, getIncident, updateIncidentObservation } = await import('../src/services/incident-store.js');
const { hostRevision, containerSnapshot } = await import('../src/services/incident-observer.js');
const { getHost } = await import('../src/services/docker-hosts.js');
const { createOpsEffectWorker } = await import('../src/services/ops-effect-worker.js');
const { createAgentPolicyGroup, createAgentPolicyRule, deleteAgentPolicyGroup } = await import('../src/services/agent/policy-store.js');
const { buildApp } = await import('../src/app.js');
const { setPassword } = await import('../src/lib/auth.js');
let server, app;
const profileDocker = () => ({ info: async () => ({ ID: 'engine' }) });
test.after(async () => { await app?.close(); if (server) await new Promise(resolve => server.close(resolve)); db.close(); rmSync(directory, { recursive: true, force: true }); });
async function fixture() {
  const resourceId = randomBytes(32).toString('hex');
  const project = { id: 'sre-' + resourceId.slice(0, 12), projectName: 'web-' + resourceId.slice(0, 8), hostId: 'local', managed: true, containers: [{ id: resourceId, service: 'web' }] };
  setProjectPreference(project.id, { managed: true });
  const profile = await saveSreProfile({ hostId: 'local', projectId: project.id, serviceName: 'web', config: { url: 'http://127.0.0.1:1/health', failureThreshold: 2 } }, 'test-admin', { scan: async () => [project], dockerForHost: profileDocker });
  const item = { Id: resourceId, Created: new Date().toISOString(), Name: '/web', Config: { Labels: { 'com.docker.compose.project': project.projectName, 'com.docker.compose.service': 'web' } }, State: { Status: 'running', Running: true, Health: { Status: 'healthy' }, StartedAt: '2026-01-01' }, RestartCount: 0 };
  const identity = { hostRevision: hostRevision(getHost('local')), engineId: 'engine', containerId: resourceId, createdAt: item.Created, composeProject: project.projectName, probe: { profileId: profile.id, version: profile.version } };
  const now = Date.now();
  recordProbeSample(profile, { outcome: 'bad', statusCode: 503 }, now - 30000);
  recordProbeSample(profile, { outcome: 'bad', statusCode: 503 }, now);
  const snapshot = probeSnapshot(profile, containerSnapshot(item), now); snapshot.probe.replicas = 1;
  const incident = recordIncidentObservation({ project, snapshot, identity, at: new Date(now - 45000).toISOString() });
  updateIncidentObservation(incident.id, snapshot, identity, new Date(now).toISOString());
  let writes = 0;
  const docker = { info: async () => ({ ID: 'engine' }), listContainers: async () => [{ Id: resourceId }], getContainer: () => ({ inspect: async () => item, restart: async () => { writes++; } }) };
  const worker = () => createOpsEffectWorker({ workerId: resourceId.slice(0, 12), incidentDependencies: { dockerForHost: () => docker, probe: async () => ({ outcome: 'bad' }) } });
  const authorize = (overrides = {}) => saveAutonomyPolicy(profile.id, { version: getAutonomyPolicy(profile.id)?.version || 0, enabled: true, confirm: 'ENABLE_AUTONOMY', expiresAt: Date.now() + 3600000, cooldownMs: 300000, maxDaily: 1, ...overrides }, 'test-admin');
  return { project, profile, item, identity, snapshot, incident, docker, worker, writes: () => writes, authorize };
}
test('探针限制 URL、状态码与延迟；真实 HTTP 不跟随跳转且超时结束', async () => {
  for (const url of ['file:///etc/passwd', 'https://user:pass@example.org', 'https://example.org/?token=x', 'https://example.org/#x']) assert.throws(() => validateProbeConfig({ url }));
  assert.throws(() => validateProbeConfig({ url: 'https://example.org', timeoutMs: 0 }));
  let redirected = 0;
  server = http.createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/ok' }); response.end(); }
    else if (request.url === '/slow') setTimeout(() => response.end('late'), 400);
    else { redirected++; response.end('ok'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await runHttpProbe(validateProbeConfig({ url: base + '/ok' }))).outcome, 'good');
  assert.equal((await runHttpProbe(validateProbeConfig({ url: base + '/redirect' }))).outcome, 'bad');
  assert.equal(redirected, 1);
  assert.equal((await runHttpProbe(validateProbeConfig({ url: base + '/slow', timeoutMs: 200 }))).reason, '健康检查请求超时');
});
test('统计按时间覆盖计算，断档不能推定成功，配置变更隔离样本并撤销自动授权', async () => {
  const f = await fixture(), start = Date.now();
  f.authorize();
  db.prepare('DELETE FROM sre_probe_samples WHERE profile_id=?').run(f.profile.id);
  db.prepare('UPDATE sre_profiles SET updated_at=? WHERE id=?').run(start, f.profile.id);
  recordProbeSample(f.profile, { outcome: 'good' }, start);
  const stats = probeStatistics(getSreProfile(f.profile.id), start + 120000);
  assert.equal(stats.coveragePercent, 25); assert.equal(stats.unknownMs, 90000);
  assert.equal(stats.observedAvailabilityPercent, 100); assert.equal(stats.guaranteedAvailabilityPercent, 25);
  assert.ok(stats.budgetRemainingMs < 0);
  const changed = await saveSreProfile({ ...f.profile, config: { ...f.profile.config, expectedStatus: 204 } }, 'test-admin', { scan: async () => [f.project], dockerForHost: profileDocker });
  assert.equal(changed.version, 2); assert.equal(getAutonomyPolicy(changed.id).enabled, false);
  assert.equal(recordProbeSample(f.profile, { outcome: 'good' }), null);
  assert.equal(probeStatistics(changed).samples, 0);
  await assert.rejects(saveSreProfile(f.profile, 'test-admin', { scan: async () => [f.project] }), /更新/);
});
test('没有预授权零写入，显式授权后单次派发且保留应用级验收', async () => {
  const f = await fixture();
  assert.equal(await considerAutomaticRecovery(f.incident.id), null);
  assert.equal(f.writes(), 0);
  f.authorize();
  const effect = await considerAutomaticRecovery(f.incident.id);
  assert.ok(effect); assert.equal(await considerAutomaticRecovery(f.incident.id), null);
  assert.equal((await f.worker().runOnce()).status, 'succeeded'); assert.equal(f.writes(), 1);
  assert.equal(getIncident(f.incident.id).resolvedAt, null);
  const start = Date.now() + 15000;
  for (const delta of [0, 15000, 30000, 45000, 60000]) {
    if (delta % 30000 === 0) recordProbeSample(f.profile, { outcome: 'good', statusCode: 200 }, start + delta);
    updateIncidentObservation(f.incident.id, probeSnapshot(f.profile, containerSnapshot(f.item), start + delta), f.identity, new Date(start + delta).toISOString());
    if (delta < 60000) assert.equal(getIncident(f.incident.id).resolvedAt, null);
  }
  assert.equal(getIncident(f.incident.id).status, 'resolved');
  assert.equal(getIncident(f.incident.id).verification.scope, 'application_http');
});
test('自动派发前撤销、维护、预算、过期与多副本条件均阻止写操作', async () => {
  for (const mode of ['revoked', 'maintenance', 'expired', 'replicas', 'budget']) {
    const f = await fixture(); const policy = f.authorize(mode === 'maintenance' ? { maintenanceUntil: Date.now() + 60000 } : {});
    if (mode === 'expired') db.prepare('UPDATE sre_autonomy_policies SET expires_at=0 WHERE id=?').run(policy.id);
    if (mode === 'replicas') updateIncidentObservation(f.incident.id, { ...f.snapshot, probe: { ...f.snapshot.probe, replicas: 2 } }, f.identity);
    if (mode === 'budget') db.prepare("INSERT INTO sre_auto_authorizations(incident_id,policy_id,policy_version,profile_version,target_json,reserved_at,state) VALUES(?,?,1,1,'{}',?,'blocked')").run('prior-' + policy.id, policy.id, Date.now());
    const effect = await considerAutomaticRecovery(f.incident.id);
    if (mode === 'revoked') {
      assert.ok(effect); saveAutonomyPolicy(f.profile.id, { version: policy.version, enabled: false });
      assert.equal((await f.worker().runOnce()).status, 'rejected');
    } else assert.equal(effect, null, mode);
    assert.equal(f.writes(), 0, mode);
  }
});
test('拒绝策略优先于预授权，配置暂停阻断在途探针和自动处置', async () => {
  const f = await fixture(); f.authorize();
  const group = createAgentPolicyGroup({ name: f.project.id });
  createAgentPolicyRule({ groupId: group.id, name: 'deny', effect: 'deny', toolName: 'container.restart', projectId: f.project.id });
  await assert.rejects(considerAutomaticRecovery(f.incident.id), /拒绝/);
  assert.equal(f.writes(), 0); deleteAgentPolicyGroup(group.id);
  pauseSreProfile(f.profile.id);
  assert.equal(recordProbeSample(f.profile, { outcome: 'good' }), null);
  assert.equal(getAutonomyPolicy(f.profile.id).enabled, false);
});
test('交错自动授权只占用一次预算，节点替换不沿用旧授权，未知结果不重试', async () => {
  const f = await fixture(); f.authorize();
  const results = await Promise.all([considerAutomaticRecovery(f.incident.id), considerAutomaticRecovery(f.incident.id)]);
  assert.equal(results.filter(Boolean).length, 1);
  let calls = 0;
  f.docker.getContainer = () => ({ inspect: async () => f.item, restart: async () => { calls++; throw new Error('connection lost'); } });
  assert.equal((await f.worker().runOnce()).status, 'outcome_unknown');
  assert.equal(await considerAutomaticRecovery(f.incident.id), null);
  assert.equal((await f.worker().runOnce()).processed, false); assert.equal(calls, 1);
  const g = await fixture(); g.authorize();
  db.prepare("UPDATE sre_profiles SET engine_id='old-engine' WHERE id=?").run(g.profile.id);
  assert.equal(await considerAutomaticRecovery(g.incident.id), null);
  assert.equal(g.writes(), 0);
});
test('每次派发前重新检查副本数与探针，恢复中的目标不自动重启', async () => {
  for (const mode of ['replicas', 'recovered']) {
    const f = await fixture(); f.authorize(); await considerAutomaticRecovery(f.incident.id);
    if (mode === 'replicas') f.docker.listContainers = async () => [{ Id: f.item.Id }, { Id: 'new-replica' }];
    const worker = createOpsEffectWorker({ workerId: 'recheck-' + mode, incidentDependencies: { dockerForHost: () => f.docker, probe: async () => ({ outcome: mode === 'recovered' ? 'good' : 'bad' }) } });
    assert.equal((await worker.runOnce()).status, 'rejected'); assert.equal(f.writes(), 0);
  }
});
test('新 API 受鉴权和 Origin 限制，配置输出不包含 Docker 凭据', async () => {
  app = await buildApp({ logger: false }); setPassword('test-sre-platform-password');
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/sre/profiles' })).statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'test-sre-platform-password' }, headers: { origin: 'http://localhost', host: 'localhost' } });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'https://evil.example', host: 'localhost' };
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/sre/profiles', headers, payload: {} })).statusCode, 403);
  const result = await app.inject({ method: 'GET', url: '/api/v1/sre/profiles', headers });
  assert.equal(result.statusCode, 200); assert.ok(result.json().profiles.length);
  assert.equal(result.body.includes('test-sre-platform-password'), false);
});
test('停止观察后在途 HTTP 结果不能写回，未纳管项目不会发出探针', async () => {
  const f = await fixture(); db.prepare('DELETE FROM sre_probe_samples WHERE profile_id=?').run(f.profile.id);
  let active = true, resolveProbe;
  const runner = createProbeRunner({ dockerForHost: profileDocker, probe: () => new Promise(resolve => { resolveProbe = resolve; }) });
  // Disable unrelated fixtures so this assertion has one independent target.
  db.prepare('UPDATE sre_profiles SET enabled=0 WHERE id<>?').run(f.profile.id);
  const pending = runner.runOnce({ isCurrent: () => active });
  await new Promise(resolve => setImmediate(resolve));
  active = false; resolveProbe({ outcome: 'good' }); await pending;
  assert.equal(probeStatistics(f.profile).samples, 0);
  setProjectPreference(f.project.id, { managed: false });
  let calls = 0;
  await createProbeRunner({ probe: async () => { calls++; return { outcome: 'good' }; } }).runOnce();
  assert.equal(calls, 0);
});
test('服务所有容器消失仍建立应用故障，不制造重启目标，重新出现后凭独立探针验收', async () => {
  const f = await fixture(); pauseSreProfile(f.profile.id);
  const profile = await saveSreProfile({ ...getSreProfile(f.profile.id), enabled: true, config: f.profile.config }, 'tester', { scan: async () => [f.project], dockerForHost: profileDocker });
  let clock = Date.now(), exists = false, automatic = 0;
  const { createIncidentObserver } = await import('../src/services/incident-observer.js');
  const docker = { info: async () => ({ ID: 'engine' }), listContainers: async () => exists ? [{ Id: f.item.Id }] : [], getContainer: () => ({ inspect: async () => f.item }) };
  const observer = createIncidentObserver({ scan: async () => [], dockerForHost: () => docker, now: () => clock,
    probeRunner: { runOnce: async () => {} }, autoRecover: async () => { automatic++; }, logger: { warn() {} } });
  recordProbeSample(profile, { outcome: 'bad', statusCode: 503 }, clock);
  await observer.runOnce();
  const row = db.prepare('SELECT id FROM ops_incidents WHERE resource_id=? AND closed_at IS NULL').get('application:' + profile.id);
  assert.ok(row); assert.equal(getIncident(row.id).latest.fault, '服务容器不存在'); assert.equal(automatic, 0);
  const { proposeIncidentRestart } = await import('../src/services/incident-remediation.js');
  assert.throws(() => proposeIncidentRestart(row.id), /身份信息/);
  exists = true;
  for (let i = 0; i < 3; i++) { clock += 30000; recordProbeSample(profile, { outcome: 'good', statusCode: 200 }, clock); await observer.runOnce(); }
  assert.equal(getIncident(row.id).status, 'resolved'); assert.equal(getIncident(row.id).verification.scope, 'application_http');
  await observer.stop();
});
test('应用缺容器检查在暂停后收到迟到结果也不能重新创建故障', async () => {
  const f = await fixture(); let finish, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const { createIncidentObserver } = await import('../src/services/incident-observer.js');
  const observer = createIncidentObserver({ scan: async () => [], probeRunner: { runOnce: async () => {} }, logger: { warn() {} },
    dockerForHost: () => ({ info: async () => ({ ID: 'engine' }), listContainers: async options => {
      if (options.filters.label.includes('com.docker.compose.project=' + f.project.projectName)) { entered(); return new Promise(resolve => { finish = resolve; }); }
      return [];
    } }) });
  const pending = observer.runOnce(); await ready; pauseSreProfile(f.profile.id); finish([]); await pending;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ops_incidents WHERE resource_id=? AND closed_at IS NULL').get('application:' + f.profile.id).n, 0);
  await observer.stop();
});
