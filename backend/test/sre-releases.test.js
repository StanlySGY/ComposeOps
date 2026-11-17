import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
const dir = mkdtempSync(path.join(os.tmpdir(), 'sre-releases-'));
process.env.DB_PATH = path.join(dir, 'db.sqlite'); process.env.DISABLE_BACKGROUND_JOBS = '1';
const { default: db, setProjectPreference } = await import('../src/lib/db.js');
const { getHost } = await import('../src/services/docker-hosts.js');
const { saveSreProfile } = await import('../src/services/sre-profiles.js');
const { reviewSreRelease, approveSreRelease, executeSreRelease, releaseOrder } = await import('../src/services/sre-releases.js');
const { reviewSreChange, approveSreChange, sreChangeFingerprint, getSreChange, recoverSreChanges } = await import('../src/services/sre-changes.js');
const { createAgentPolicyGroup, createAgentPolicyRule, deleteAgentPolicyGroup } = await import('../src/services/agent/policy-store.js');
test.after(async () => { await import('../src/services/workflow-engine.js'); await new Promise(resolve => setImmediate(resolve)); db.close(); rmSync(dir, { recursive: true, force: true }); });
const oldImage = 'sha256:' + 'a'.repeat(64), nextImage = 'sha256:' + 'b'.repeat(64);
async function fixture() {
  const id = 'release-' + randomUUID(), project = { id, projectName: id, hostId: 'local', host: getHost('local'), managed: true, editable: true, mountEnabled: true, mounted: true, workingDir: '/tmp/' + id, composeFiles: ['/tmp/' + id + '/compose.yml'], containers: ['db', 'api', 'web'].map(name => ({ id: name + '-0', service: name })) };
  setProjectPreference(id, { managed: true });
  let fingerprint = 'fixed', counter = 0, failure = '', failRollback = false, drop = false; const writes = [], materials = [], current = {};
  for (const name of ['db', 'api', 'web']) current[name] = { Id: name + '-0', Created: 'created-0', Image: oldImage, State: { Running: true, StartedAt: 'now' }, Config: { Labels: { 'com.docker.compose.project': id, 'com.docker.compose.service': name } } };
  const docker = { info: async () => ({ ID: 'engine' }), getImage: value => ({ inspect: async () => ({ Id: value === 'new:tag' ? nextImage : value, RepoDigests: [] }) }),
    listContainers: async opts => [{ Id: current[opts.filters.label.find(value => value.startsWith('com.docker.compose.service=')).split('=').at(-1)].Id }],
    getContainer: id => ({ inspect: async () => structuredClone(Object.values(current).find(row => row.Id === id)) }) };
  const effective = { services: { db: { image: 'old:tag' }, api: { image: 'old:tag', depends_on: { db: {} } }, web: { image: 'old:tag', depends_on: { api: {} } } } };
  const opts = { scan: async () => [project], dockerForHost: () => docker, capture: async () => ({ fingerprint, effective: structuredClone(effective) }),
    probe: async config => { const name = new URL(config.url).pathname.slice(1); return { outcome: failure === name && current[name].Image === nextImage || failRollback && writes.length > 2 && current[name].Image === oldImage ? 'bad' : 'good' }; },
    backupInputs: async () => {}, materialize: async (_project, _change, _image, phase, document) => { materials.push({ phase, document }); return '/tmp/' + phase; }, verifyMaterial: async () => {},
    dispatch: async (_project, file, service) => { if (drop) throw new Error('connection lost'); writes.push({ service, phase: file.includes('rollback') ? 'rollback' : 'forward' }); counter++; current[service] = { ...current[service], Id: service + '-' + counter, Created: 'created-' + counter, Image: file.includes('rollback') ? oldImage : nextImage }; return 0; },
    verificationAttempts: 3, verificationWindowMs: 0, sleep: async () => {} };
  const profiles = [];
  for (const serviceName of ['db', 'api', 'web']) profiles.push(await saveSreProfile({ projectId: id, serviceName, config: { url: 'http://127.0.0.1/' + serviceName } }, 'tester', opts));
  const input = { services: profiles.map(profile => ({ profileId: profile.id, image: 'new:tag', migration: 'none', compatibilityNote: '镜像仅更新应用代码，未执行数据结构迁移' })) };
  return { project, opts, input, profiles, writes, materials, current, effective, fail: service => { failure = service; }, failRollback: () => { failRollback = true; }, drift: () => { fingerprint = 'drift'; }, disconnect: () => { drop = true; } };
}
const approve = (change, allowRollback = true) => approveSreRelease(change.id, { confirm: 'APPLY_APPLICATION_RELEASE', fingerprint: sreChangeFingerprint(change), allowRollback, compatibilityConfirmed: true });
test('DAG 包含依赖原因；循环、缺失依赖阻断评审', () => {
  assert.deepEqual(releaseOrder({ web: { depends_on: ['api'] }, api: { depends_on: ['db'] }, db: {} }).order, ['db', 'api', 'web']);
  assert.throws(() => releaseOrder({ a: { depends_on: ['b'] }, b: { depends_on: ['a'] } }), /循环/);
  assert.throws(() => releaseOrder({ a: { depends_on: ['missing'] } }), /应用外/);
});
test('完整应用镜像固定，按依赖顺序派发且每项 HTTP 验证；双执行不会重复', async () => {
  const f = await fixture(), change = await reviewSreRelease(f.input, 'tester', f.opts); assert.deepEqual(change.review.order, ['db', 'api', 'web']); approve(change);
  await Promise.all([executeSreRelease(change.id, f.opts), executeSreRelease(change.id, f.opts)]);
  const result = getSreChange(change.id); assert.equal(result.status, 'succeeded'); assert.deepEqual(f.writes.map(row => row.service), ['db', 'api', 'web']);
  assert.equal(result.result.steps.length, 3); assert.ok(result.result.steps.every(row => row.passed && row.evidence.length === 3));
  assert.ok(f.materials[0].document.services.web.image === nextImage); assert.ok(f.materials[1].document.services.web.image === oldImage);
});
test('中间服务失败停止后续，预授权按已执行服务反序回退并联合复验', async () => {
  const f = await fixture(), change = await reviewSreRelease(f.input, 'tester', f.opts); approve(change); f.fail('api');
  const result = await executeSreRelease(change.id, f.opts);
  assert.equal(result.status, 'rolled_back'); assert.deepEqual(f.writes, [{ service: 'db', phase: 'forward' }, { service: 'api', phase: 'forward' }, { service: 'api', phase: 'rollback' }, { service: 'db', phase: 'rollback' }]);
  assert.equal(f.current.web.Id, 'web-0'); assert.ok(result.result.rollbackVerification.every(row => row.passed));
});
test('无回退授权、回退失败、不可逆迁移均不误报成功', async () => {
  const f = await fixture(), change = await reviewSreRelease(f.input, 'tester', f.opts); approve(change, false); f.fail('api'); assert.equal((await executeSreRelease(change.id, f.opts)).status, 'failed'); assert.equal(f.writes.length, 2);
  const g = await fixture(), other = await reviewSreRelease(g.input, 'tester', g.opts); approve(other); g.fail('api'); g.failRollback(); assert.equal((await executeSreRelease(other.id, g.opts)).status, 'rollback_failed');
  const h = await fixture(); h.input.services[1].migration = 'irreversible'; await assert.rejects(reviewSreRelease(h.input, 'tester', h.opts), /不可逆/);
});
test('配置、容器漂移与拒绝策略在派发前阻断；单服务变更共用互斥', async () => {
  for (const kind of ['config', 'container', 'deny', 'concurrent']) {
    const f = await fixture(), change = await reviewSreRelease(f.input, 'tester', f.opts); let group;
    if (kind === 'concurrent') {
      const single = await reviewSreChange({ profileId: f.profiles[0].id, image: 'new:tag' }, 'tester', f.opts); approve(change); assert.throws(() => approveSreChange(single.id, { confirm: 'APPLY_PINNED_IMAGE', fingerprint: sreChangeFingerprint(single), allowRollback: false }), /进行中/); continue;
    }
    approve(change);
    if (kind === 'config') f.drift();
    if (kind === 'container') f.current.web.Id = 'external-replacement';
    if (kind === 'deny') { group = createAgentPolicyGroup({ name: 'deny-release', enabled: true }); createAgentPolicyRule({ groupId: group.id, name: 'deny', effect: 'deny', toolName: 'compose.up', projectId: f.project.id }); }
    try { assert.equal((await executeSreRelease(change.id, f.opts)).status, 'blocked', kind); assert.equal(f.writes.length, 0); }
    finally { if (group) deleteAgentPolicyGroup(group.id); }
  }
});
test('失联和重启留下未知，不自动继续或回退', async () => {
  const f = await fixture(), change = await reviewSreRelease(f.input, 'tester', f.opts); approve(change); f.disconnect(); assert.equal((await executeSreRelease(change.id, f.opts)).status, 'outcome_unknown');
  assert.equal((await executeSreRelease(change.id, f.opts)).status, 'outcome_unknown'); assert.equal(f.writes.length, 0);
  const g = await fixture(), queued = await reviewSreRelease(g.input, 'tester', g.opts); approve(queued); db.prepare("UPDATE sre_changes SET status='executing' WHERE id=?").run(queued.id); recoverSreChanges(); assert.equal(getSreChange(queued.id).status, 'outcome_unknown');
});
