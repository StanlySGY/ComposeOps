import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const dir = mkdtempSync(path.join(os.tmpdir(), 'sre-delivery-'));
process.env.DB_PATH = path.join(dir, 'test.db'); process.env.DISABLE_BACKGROUND_JOBS = '1'; process.env.SERVE_FRONTEND = '0';
const { default: db, setProjectPreference, addVolumeBackup } = await import('../src/lib/db.js');
const { saveSreProfile, archiveSreProfile, listSreProfiles, getSreProfile } = await import('../src/services/sre-profiles.js');
const { reviewSreChange, approveSreChange, executeSreChange, getSreChange, sreChangeFingerprint, recoverSreChanges } = await import('../src/services/sre-changes.js');
const { saveRecoveryPlan, queueRecoveryRun, executeRecoveryRun, pauseRecoveryPlan, scheduleRecoveryRuns, recoverRecoveryRuns } = await import('../src/services/sre-recovery.js');
const { createSreRetrospective } = await import('../src/services/sre-retrospectives.js');
const { recordIncidentObservation, getIncident } = await import('../src/services/incident-store.js');
const { createAgentPolicyGroup, createAgentPolicyRule, deleteAgentPolicyGroup } = await import('../src/services/agent/policy-store.js');
const { sreInsights } = await import('../src/services/sre-insights.js');
const { getHost } = await import('../src/services/docker-hosts.js');
const oldImage = 'sha256:' + 'a'.repeat(64), newImage = 'sha256:' + 'b'.repeat(64);
test.after(async () => { await import('../src/services/workflow-engine.js'); await new Promise(resolve => setImmediate(resolve)); db.close(); rmSync(dir, { recursive: true, force: true }); });
async function fixture() {
  const id = 'delivery-' + randomUUID(), name = id.slice(0, 20);
  const project = { id, projectName: name, hostId: 'local', host: getHost('local'), managed: true, editable: true, mountEnabled: true, mounted: true, workingDir: '/tmp/' + id, composeFiles: ['/tmp/' + id + '/compose.yml'], containers: [{ id: 'c-old', service: 'web' }] };
  setProjectPreference(id, { managed: true, mountEnabled: true });
  let item = { Id: 'c-old', Created: 'old-created', Image: oldImage, State: { Running: true, StartedAt: 'old-start' }, Config: { Labels: { 'com.docker.compose.project': name, 'com.docker.compose.service': 'web' } } };
  let writes = 0, backups = 0, materials = 0, fingerprint = 'fingerprint', failNext = false, failRollback = false;
  const docker = { info: async () => ({ ID: 'engine' }), getImage: image => ({ inspect: async () => ({ Id: ['new:tag', newImage].includes(image) ? newImage : oldImage, RepoDigests: [] }) }), listContainers: async () => [{ Id: item.Id }], getContainer: () => ({ inspect: async () => structuredClone(item) }) };
  const opts = { scan: async () => [project], dockerForHost: () => docker, capture: async () => ({ fingerprint, effective: { services: { web: { image: 'old:tag', volumes: [{ type: 'volume', source: 'data', target: '/data' }, { type: 'bind', source: '/etc/timezone', target: '/etc/timezone' }] } }, volumes: { data: { name: name + '_data' } } } }),
    probe: async () => ({ outcome: (item.Image === newImage && failNext || item.Image === oldImage && writes > 1 && failRollback) ? 'bad' : 'good', statusCode: 200 }),
    materialize: async (p, change, image, phase) => { materials++; return path.join(project.workingDir, phase + '.json'); },
    verifyMaterial: async () => {}, backupInputs: async () => { backups++; }, dispatch: async (p, file) => { writes++; item = { ...item, Id: 'c-' + writes, Created: 'created-' + writes, Image: file.endsWith('forward.json') ? newImage : oldImage, State: { Running: true, StartedAt: 'start-' + writes } }; return 0; },
    verificationAttempts: 3, verificationWindowMs: 0, sleep: async () => {} };
  const profile = await saveSreProfile({ projectId: id, serviceName: 'web', config: { url: 'http://127.0.0.1/health' } }, 'tester', opts);
  return { project, profile, opts, docker, counts: () => ({ writes, backups, materials }), drift: () => { fingerprint = 'changed'; }, failNext: () => { failNext = true; }, failRollback: () => { failRollback = true; }, replace: () => { item.Id = 'replacement'; } };
}
async function review(f) { return reviewSreChange({ profileId: f.profile.id, image: 'new:tag' }, 'reviewer', f.opts); }
function approve(change, allowRollback = false) { return approveSreChange(change.id, { confirm: 'APPLY_PINNED_IMAGE', fingerprint: sreChangeFingerprint(change), allowRollback }, 'approver'); }
test('固定新旧镜像与完整输入；双执行并发只派发一次，三次 HTTP 证据才成功', async () => {
  const f = await fixture(), change = await review(f);
  assert.equal(change.review.old.imageId, oldImage); assert.equal(change.review.next.imageId, newImage);
  assert.equal(f.counts().writes, 0);
  approve(change);
  await Promise.all([executeSreChange(change.id, f.opts), executeSreChange(change.id, f.opts)]);
  const result = getSreChange(change.id);
  assert.equal(result.status, 'succeeded'); assert.equal(result.result.forwardVerification.evidence.length, 3);
  assert.deepEqual(f.counts(), { writes: 1, backups: 1, materials: 1 });
  await executeSreChange(change.id, f.opts); assert.equal(f.counts().writes, 1);
});
test('审批绑定评审且项目互斥；过期、输入变化、容器替换在写入前阻止', async () => {
  for (const kind of ['fingerprint', 'expired', 'input', 'replacement', 'concurrent']) {
    const f = await fixture(), change = await review(f);
    if (kind === 'fingerprint') {
      assert.throws(() => approveSreChange(change.id, { confirm: 'APPLY_PINNED_IMAGE', fingerprint: 'wrong', allowRollback: true }), /确认/); continue;
    }
    if (kind === 'concurrent') { const other = await review(f); approve(change); assert.throws(() => approve(other), /进行中/); continue; }
    approve(change);
    if (kind === 'expired') db.prepare('UPDATE sre_changes SET expires_at=0 WHERE id=?').run(change.id);
    if (kind === 'input') f.drift();
    if (kind === 'replacement') f.replace();
    assert.equal((await executeSreChange(change.id, f.opts)).status, 'blocked', kind);
    assert.equal(f.counts().writes, 0);
  }
});
test('只有预授权才回退固定原镜像；回退还需 HTTP 验收，失败不伪报成功', async () => {
  for (const mode of ['no-approval', 'rollback-ok', 'rollback-failed']) {
    const f = await fixture(), change = await review(f); approve(change, mode !== 'no-approval'); f.failNext(); if (mode === 'rollback-failed') f.failRollback();
    const result = await executeSreChange(change.id, f.opts);
    assert.equal(result.status, ({ 'no-approval': 'failed', 'rollback-ok': 'rolled_back', 'rollback-failed': 'rollback_failed' })[mode]);
    assert.equal(f.counts().writes, mode === 'no-approval' ? 1 : 2);
    if (mode !== 'no-approval') assert.equal(result.result.rollbackVerification.container.imageId, oldImage);
  }
});
test('超时与进程重启留下未知记录，不执行补偿或重放；拒绝策略优先', async () => {
  const f = await fixture(), change = await review(f); approve(change, true);
  let calls = 0;
  const unknown = await executeSreChange(change.id, { ...f.opts, dispatch: async () => { calls++; throw new Error('lost response'); } });
  assert.equal(unknown.status, 'outcome_unknown'); assert.equal(calls, 1);
  await executeSreChange(change.id, f.opts); assert.equal(f.counts().writes, 0);
  const g = await fixture(), pending = await review(g); approve(pending); db.prepare("UPDATE sre_changes SET status='executing' WHERE id=?").run(pending.id);
  assert.ok(recoverSreChanges() > 0); await executeSreChange(pending.id, g.opts); assert.equal(g.counts().writes, 0);
  const h = await fixture(), denied = await review(h); approve(denied);
  const group = createAgentPolicyGroup({ name: 'release deny ' + randomUUID() });
  createAgentPolicyRule({ groupId: group.id, name: 'deny', effect: 'deny', toolName: 'compose.up', projectId: h.project.id });
  try { assert.equal((await executeSreChange(denied.id, h.opts)).status, 'blocked'); assert.equal(h.counts().writes, 0); }
  finally { deleteAgentPolicyGroup(group.id); }
});
async function planFixture() {
  const f = await fixture(), volume = f.project.projectName + '_data';
  const plan = await saveRecoveryPlan({ hostId: 'local', projectId: f.project.id, volumes: [volume], rpoMinutes: 1440, rtoMinutes: 30 }, 'tester', f.opts);
  const backupId = addVolumeBackup({ projectId: f.project.id, projectName: f.project.projectName, volume, file: 'backup.tar.gz', host: 'local' });
  let checks = 0;
  const verify = async (id, { onResource }) => { checks++; assert.equal(id, backupId); onResource({ kind: 'volume', id: 'test-tmp', state: 'created' }); onResource({ kind: 'volume', id: 'test-tmp', state: 'removed' }); return { ok: true, status: 'verified', files: 3, cleanup: 'removed' }; };
  return { ...f, plan, backupId, volume, verify, checks: () => checks };
}
test('应用恢复计划固定备份归属、年龄与覆盖，隔离证据和清理均通过才达标', async () => {
  const f = await planFixture(), run = queueRecoveryRun(f.plan.id);
  assert.throws(() => queueRecoveryRun(f.plan.id), /进行中/);
  const result = await executeRecoveryRun(run.id, { ...f.opts, verify: f.verify });
  assert.equal(result.status, 'passed'); assert.equal(result.result.businessRecoveryVerified, false); assert.equal(result.result.coveragePercent, 100); assert.equal(result.result.excluded.length, 1); assert.equal(result.result.cleanupComplete, true);
  await executeRecoveryRun(run.id, { ...f.opts, verify: f.verify }); assert.equal(f.checks(), 1);
});
test('备份过旧、错误节点、清理残留、暂停和配置漂移均不能通过恢复演练', async () => {
  for (const mode of ['age', 'host', 'cleanup', 'paused', 'drift']) {
    const f = await planFixture();
    if (mode === 'age') db.prepare("UPDATE volume_backups SET created_at=datetime('now','-7 days') WHERE id=?").run(f.backupId);
    if (mode === 'host') db.prepare("UPDATE volume_backups SET host='other' WHERE id=?").run(f.backupId);
    const run = queueRecoveryRun(f.plan.id);
    if (mode === 'paused') pauseRecoveryPlan(f.plan.id);
    if (mode === 'drift') f.drift();
    const verify = mode === 'cleanup' ? async (id, { onResource }) => { onResource({ kind: 'volume', id: 'leftover', state: 'cleanup_failed' }); throw new Error('cleanup failed'); } : f.verify;
    const result = await executeRecoveryRun(run.id, { ...f.opts, verify });
    assert.equal(result.status, 'failed', mode);
    if (['paused', 'drift', 'host'].includes(mode)) assert.equal(f.checks(), 0);
  }
});
test('定时运行需显式授权；相同到期时刻只入队一次，中断演练不重放', async () => {
  const f = await planFixture();
  const input = { ...f.plan, ...f.plan.config, scheduleHours: 24 };
  await assert.rejects(saveRecoveryPlan(input, 'tester', f.opts), /明确授权/);
  const plan = await saveRecoveryPlan({ ...input, confirm: 'ENABLE_RECOVERY_SCHEDULE' }, 'tester', f.opts);
  scheduleRecoveryRuns(plan.nextRunAt); scheduleRecoveryRuns(plan.nextRunAt);
  const runs = db.prepare('SELECT * FROM sre_recovery_runs WHERE plan_id=?').all(plan.id); assert.equal(runs.length, 1);
  db.prepare("UPDATE sre_recovery_runs SET status='running' WHERE id=?").run(runs[0].id); assert.ok(recoverRecoveryRuns() > 0);
  assert.equal((await executeRecoveryRun(runs[0].id, { ...f.opts, verify: f.verify })).status, 'outcome_unknown'); assert.equal(f.checks(), 0);
});
test('归档保留证据并行政关闭，恢复同一目标生成新版本，不能算成已恢复', async () => {
  const f = await fixture();
  const incident = recordIncidentObservation({ project: f.project, snapshot: { id: 'archive-container', fault: 'bad', healthy: false }, identity: { probe: { profileId: f.profile.id, version: f.profile.version } } });
  const before = sreInsights().resolved; archiveSreProfile(f.profile.id);
  assert.ok(getSreProfile(f.profile.id).archivedAt); assert.equal(listSreProfiles().some(p => p.id === f.profile.id), false);
  assert.equal(getIncident(incident.id).status, 'closed'); assert.equal(getIncident(incident.id).resolvedAt, null); assert.equal(sreInsights().resolved, before);
  const restored = await saveSreProfile({ projectId: f.project.id, serviceName: 'web', config: f.profile.config }, 'tester', f.opts);
  assert.equal(restored.id, f.profile.id); assert.equal(restored.archivedAt, null); assert.ok(restored.version > f.profile.version);
});
test('AI 复盘只接收现有证据引用并持久化快照，未知引用拒绝且不改授权', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM sre_autonomy_policies').get().n;
  const valid = await createSreRetrospective('tester', { config: { apiKey: 'fixture' }, call: async () => ({ content: JSON.stringify({ findings: [{ claim: '目前样本存在未验收结果，尚不能推断根因。', evidenceIds: ['summary'], recommendation: '人工检查失败记录。' }] }) }) });
  assert.equal(valid.status, 'ready'); assert.ok(valid.evidence.sources.length > 1);
  const invalid = await createSreRetrospective('tester', { config: { apiKey: 'fixture' }, call: async () => ({ content: JSON.stringify({ findings: [{ claim: 'invented', evidenceIds: ['nonexistent'] }] }) }) });
  assert.equal(invalid.status, 'failed'); assert.equal(invalid.content, null); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sre_autonomy_policies').get().n, before);
});
test('派发前固定材料遭篡改立即停止，准备阶段容器或授权变化也不得执行', async () => {
  for (const kind of ['material', 'container', 'authorization']) {
    const f = await fixture(), change = await review(f); approve(change, true);
    const opts = { ...f.opts, verifyMaterial: async () => {
      if (kind === 'material') throw new Error('固定材料已变化');
      if (kind === 'container') f.replace();
      if (kind === 'authorization') setProjectPreference(f.project.id, { managed: false });
    } };
    assert.equal((await executeSreChange(change.id, opts)).status, 'blocked'); assert.equal(f.counts().writes, 0);
  }
});
test('未知结果核对保留人工说明与实际证据，演练残留未清理时禁止关闭', async () => {
  const { acknowledgeSreChange } = await import('../src/services/sre-changes.js');
  const { acknowledgeRecoveryRun } = await import('../src/services/sre-recovery.js');
  const f = await fixture(), change = await review(f); approve(change);
  db.prepare("UPDATE sre_changes SET status='outcome_unknown' WHERE id=?").run(change.id);
  const result = await acknowledgeSreChange(change.id, '已人工核对原镜像正在运行，保留未知执行结论', 'tester', f.opts);
  assert.equal(result.status, 'closed'); assert.equal(result.result.reconciliation.verifiedRecovery, false);
  const g = await planFixture(), run = queueRecoveryRun(g.plan.id);
  db.prepare("UPDATE sre_recovery_runs SET status='outcome_unknown',result_json=? WHERE id=?").run(JSON.stringify({ resources: [{ kind: 'volume', id: 'still-exists' }] }), run.id);
  g.docker.getVolume = () => ({ inspect: async () => ({ Name: 'still-exists' }) });
  await assert.rejects(acknowledgeRecoveryRun(run.id, '人工检查临时资源的状态与归属', 'tester', g.opts), /仍存在/);
  g.docker.getVolume = () => ({ inspect: async () => { throw Object.assign(new Error('missing'), { statusCode: 404 }); } });
  assert.equal((await acknowledgeRecoveryRun(run.id, '已人工清理临时卷并核对原卷数据', 'tester', g.opts)).status, 'closed');
});
test('可靠变更、演练与复盘 API 统一拒绝未认证与不可信 Origin', async () => {
  const { buildApp } = await import('../src/app.js'); const { setPassword } = await import('../src/lib/auth.js');
  setPassword('fixture-only-' + randomUUID()); const app = await buildApp({ logger: false });
  try {
    for (const url of ['/api/v1/sre/operations', '/api/v1/sre/recovery/candidates?projectId=x']) assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
    for (const url of ['/api/v1/sre/changes/review', '/api/v1/sre/recovery/plans', '/api/v1/sre/retrospectives']) {
      const response = await app.inject({ method: 'POST', url, payload: {}, headers: { origin: 'https://untrusted.example' } });
      assert.ok([401, 403].includes(response.statusCode));
    }
  } finally { await app.close(); }
});
