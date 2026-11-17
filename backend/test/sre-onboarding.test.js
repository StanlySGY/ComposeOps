import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
const dir = mkdtempSync(path.join(os.tmpdir(), 'onboarding-'));
process.env.DB_PATH = path.join(dir, 'db.sqlite'); process.env.DISABLE_BACKGROUND_JOBS = '1';
const { default: db, setProjectPreference } = await import('../src/lib/db.js');
const { getHost } = await import('../src/services/docker-hosts.js');
const { getSreProfile, saveSreProfile } = await import('../src/services/sre-profiles.js');
const { getAutonomyPolicy } = await import('../src/services/sre-autonomy.js');
const { SLO_ALERT_DEFAULTS } = await import('../src/services/sre-slo-alerts.js');
const { saveOnboarding, applyOnboarding, getOnboarding, recoverOnboarding } = await import('../src/services/sre-onboarding.js');
test.after(async () => { await import('../src/services/workflow-engine.js'); await new Promise(resolve => setImmediate(resolve)); db.close(); rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const project = { id: 'onboard-' + randomUUID(), projectName: 'fixture', hostId: 'local', managed: true, containers: [{ id: 'c', service: 'web' }] };
  setProjectPreference(project.id, { managed: true });
  let ready = true;
  const opts = { scan: async () => [project], host: getHost, hostForId: getHost, dockerForHost: () => ({ info: async () => ({ ID: 'engine' }) }), notifications: () => ({ enabled: ready, channels: [{ type: 'webhook', enabled: ready }] }) };
  const config = { health: { mode: 'create', serviceName: 'web', config: { url: 'http://127.0.0.1/health' } }, recovery: { mode: 'later', reason: '业务暂无数据库，稍后接入灾备' },
    alerts: { ...structuredClone(SLO_ALERT_DEFAULTS), enabled: true }, notifications: 'existing', autonomy: { enabled: false } };
  return { project, opts, config, offline: () => { ready = false; }, online: () => { ready = true; } };
}
const apply = (draft, opts, extra = {}) => applyOnboarding(draft.id, { confirm: 'APPLY_APPLICATION_ONBOARDING', version: draft.version, fingerprint: draft.fingerprint, ...extra }, 'tester', opts);
test('创建草稿幂等，双提交只生成一个健康目标且自动修复默认关闭', async () => {
  const f = fixture(), input = { requestId: randomUUID(), projectId: f.project.id, config: f.config };
  const draft = await saveOnboarding(input, 'tester', f.opts), retry = await saveOnboarding(input, 'tester', f.opts); assert.equal(draft.id, retry.id);
  const [one, two] = await Promise.all([apply(draft, f.opts), apply(draft, f.opts)]); assert.equal(one.status, 'complete'); assert.equal(two.status, 'complete');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sre_profiles WHERE project_id=?').get(f.project.id).n, 1);
  assert.equal(getAutonomyPolicy(one.progress.health.id), null); assert.equal(one.progress.recovery.status, 'deferred');
  assert.equal((await apply(draft, f.opts)).status, 'complete');
});
test('部分失败可恢复；完成步骤不重复，通知未配置不误报完成', async () => {
  const f = fixture(); f.offline(); const draft = await saveOnboarding({ projectId: f.project.id, config: f.config }, 'tester', f.opts);
  const partial = await apply(draft, f.opts); assert.equal(partial.status, 'partial'); assert.equal(partial.progress.health.status, 'configured'); assert.match(partial.error, /通知/);
  const profile = getSreProfile(partial.progress.health.id); f.online(); const complete = await apply(partial, f.opts);
  assert.equal(complete.status, 'complete'); assert.equal(getSreProfile(profile.id).version, profile.version); assert.equal(complete.progress.alerts.version, partial.progress.alerts.version);
});
test('在保存健康目标后中断，恢复通过确定 ID 查回而非重复创建', async () => {
  const f = fixture(); let first = true;
  const opts = { ...f.opts, saveProfile: async (...args) => { const profile = await saveSreProfile(...args); if (first) { first = false; throw new Error('模拟提交后连接中断'); } return profile; } };
  const draft = await saveOnboarding({ projectId: f.project.id, config: f.config }, 'tester', opts), partial = await apply(draft, opts);
  assert.equal(partial.status, 'partial'); assert.equal(partial.progress.health, undefined);
  const complete = await apply(partial, opts); assert.equal(complete.status, 'complete'); assert.equal(getSreProfile(complete.progress.health.id).version, 1);
  db.prepare("UPDATE sre_onboarding SET status='applying' WHERE id=?").run(draft.id); recoverOnboarding(); assert.equal(getOnboarding(draft.id).status, 'partial');
});
test('自动修复需要单独授权且在其他步骤成功后才启用', async () => {
  const f = fixture(); f.config.autonomy = { enabled: true, days: 1, maxDaily: 1, cooldownMinutes: 30 };
  const draft = await saveOnboarding({ projectId: f.project.id, config: f.config }, 'tester', f.opts); await assert.rejects(apply(draft, f.opts), /单独明确授权/);
  f.offline(); const partial = await apply(draft, f.opts, { autonomyConfirm: 'ENABLE_AUTONOMY' }); assert.equal(partial.status, 'partial'); assert.equal(getAutonomyPolicy(partial.progress.health.id), null);
  f.online(); const complete = await apply(partial, f.opts, { autonomyConfirm: 'ENABLE_AUTONOMY' }); assert.equal(complete.status, 'complete'); assert.equal(getAutonomyPolicy(complete.progress.health.id).enabled, true);
});
test('范围隔离、旧版本与外部编辑阻止覆盖', async () => {
  const a = fixture(), b = fixture(); const profile = await saveSreProfile({ projectId: a.project.id, serviceName: 'web', config: a.config.health.config }, 'tester', a.opts);
  b.config.health = { mode: 'existing', id: profile.id, version: profile.version };
  await assert.rejects(saveOnboarding({ projectId: b.project.id, config: b.config }, 'tester', b.opts), /不属于/);
  a.offline(); const draft = await saveOnboarding({ projectId: a.project.id, config: { ...a.config, health: { mode: 'existing', id: profile.id, version: profile.version } } }, 'tester', a.opts);
  const partial = await apply(draft, a.opts); const updated = await saveSreProfile({ id: profile.id, version: profile.version, config: { url: 'http://127.0.0.1/new' } }, 'outside', a.opts);
  a.online(); assert.equal((await apply(partial, a.opts)).status, 'partial'); assert.equal(getSreProfile(profile.id).version, updated.version);
  await assert.rejects(saveOnboarding({ id: draft.id, version: 0, config: draft.config }, 'tester', a.opts), /变化/);
});
