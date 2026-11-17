import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
const dir = mkdtempSync(path.join(os.tmpdir(), 'business-recovery-'));
process.env.DB_PATH = path.join(dir, 'db.sqlite'); process.env.DISABLE_BACKGROUND_JOBS = '1';
const { default: db, setProjectPreference } = await import('../src/lib/db.js');
const { getHost } = await import('../src/services/docker-hosts.js');
const { validateBusinessConfig, businessAssertionSql } = await import('../src/services/business-recovery-config.js');
const { saveBusinessPlan, queueBusinessBackup, executeBusinessBackup, queueBusinessRun, executeBusinessRun, getBusinessRun, recoverBusinessJobs, businessBackupFile, acknowledgeBusinessJob, pauseBusinessPlan } = await import('../src/services/sre-business-recovery.js');
const { businessDump, recoveryContainerConfig } = await import('../src/services/business-recovery-docker.js');
const { persistDumpStream } = await import('../src/services/db-dumper.js');
const { createAgentPolicyGroup, createAgentPolicyRule, deleteAgentPolicyGroup } = await import('../src/services/agent/policy-store.js');
test.after(async () => { await import('../src/services/workflow-engine.js'); await new Promise(resolve => setImmediate(resolve)); db.close(); rmSync(dir, { recursive: true, force: true }); });
const image = char => 'sha256:' + char.repeat(64);
const config = () => ({ engine: 'postgres', dbService: 'db', appService: 'app', database: 'business', user: 'reader', credentialEnv: 'POSTGRES_PASSWORD', appEnvironment: { DATABASE_URL: '$DB_URL' },
  assertions: [{ table: 'public.items', column: 'name', equals: 'known-value', expectedRows: 1 }], http: { port: 8080, path: '/items', bodyContains: 'known-value', expectedStatus: 200 }, rpoMinutes: 60, rtoMinutes: 1, scheduleHours: 0 });
async function fixture() {
  const project = { id: 'business-' + randomUUID(), projectName: 'fixture', hostId: 'local', managed: true, editable: true, mountEnabled: true, containers: [{ id: 'source-db', service: 'db' }, { id: 'source-app', service: 'app' }] };
  setProjectPreference(project.id, { managed: true });
  let fingerprint = 'fixed'; const items = new Map(), created = [], removed = [];
  const source = service => ({ Id: 'source-' + service, Created: '2026-11-10', Image: image(service === 'db' ? 'a' : 'b'), State: { Running: true }, Mounts: [],
    Config: { Cmd: ['node', 'app.js'], Entrypoint: null, User: '', Env: ['POSTGRES_PASSWORD=private-source-password'], Labels: { 'com.docker.compose.project': project.projectName, 'com.docker.compose.service': service } } });
  const entity = (kind, id) => ({ modem: {}, inspect: async () => { if (id.startsWith('source-')) return source(id.slice(7)); const row = items.get(id); if (!row) throw Object.assign(new Error('missing'), { statusCode: 404 }); return row; },
    start: async () => {}, remove: async () => { removed.push(id); items.delete(id); } });
  const docker = { info: async () => ({ ID: 'engine' }), getImage: value => ({ inspect: async () => ({ Id: value.startsWith('sha256:') ? value : image('c'), Config: { Volumes: value === image('a') ? { '/var/lib/postgresql/data': {} } : {} } }) }),
    listContainers: async opts => [{ Id: 'source-' + opts.filters.label.find(value => value.startsWith('com.docker.compose.service')).split('=').at(-1) }],
    getContainer: id => entity('container', id), getNetwork: id => entity('network', id), getVolume: id => entity('volume', id),
    createNetwork: async cfg => { created.push(cfg); items.set(cfg.Name, cfg); return entity('network', cfg.Name); },
    createVolume: async cfg => { created.push(cfg); items.set(cfg.Name, cfg); return entity('volume', cfg.Name); },
    createContainer: async cfg => { created.push(cfg); items.set(cfg.name, { Config: cfg }); return entity('container', cfg.name); } };
  const opts = { scan: async () => [project], host: getHost, dockerForHost: () => docker, capture: async () => ({ fingerprint, effective: { services: { db: {}, app: {} } } }),
    dump: async (_container, _config, password, file) => { assert.equal(password, 'private-source-password'); await writeFile(file, gzipSync('known-data')); return { rawBytes: 10 }; },
    restore: async (_container, _config, password, file) => { assert.notEqual(password, 'private-source-password'); assert.equal(gunzipSync(await readFile(file)).toString(), 'known-data'); },
    assertData: async () => [{ table: 'public.items', actualRows: 1, expectedRows: 1, passed: true }], ready: async () => {}, exec: async () => JSON.stringify({ statusCode: 200, bodyMatched: true }), sleep: async () => {} };
  const plan = await saveBusinessPlan({ projectId: project.id, config: config() }, 'tester', opts);
  const backup = async () => { const queued = queueBusinessBackup(plan.id); return executeBusinessBackup(queued.id, opts); };
  return { project, plan, opts, docker, created, removed, items, backup, drift: () => { fingerprint = 'drifted'; } };
}
test('校验业务表断言与隔离变量；拒绝任意 SQL、空检查和明文密钥', () => {
  assert.equal(businessAssertionSql(validateBusinessConfig(config()), config().assertions[0]), `SELECT COUNT(*) FROM "public"."items" WHERE "name" = 'known-value'`);
  for (const edit of [c => { c.assertions = []; }, c => { c.assertions[0].table = 'items; DROP DATABASE other'; }, c => { c.http.path = '//external'; }, c => { c.appEnvironment = { PASSWORD: 'secret', HOST: '$DB_HOST' }; }, c => { c.appEnvironment.EXTRA_URL = 'postgresql://user:secret@live/db'; }, c => { c.http.bodyContains = ''; }]) {
    const value = config(); edit(value); assert.throws(() => validateBusinessConfig(value));
  }
  const escaped = config(); escaped.assertions[0].equals = "it's known"; assert.match(businessAssertionSql(validateBusinessConfig(escaped), escaped.assertions[0]), /it''s known/);
});
test('固定备份、独立网络与新卷、SQL 和三次 HTTP 断言，清理后才通过', async () => {
  const f = await fixture(), backup = await f.backup(); assert.equal(backup.status, 'verified');
  const run = queueBusinessRun(f.plan.id, backup.id); const finished = await executeBusinessRun(run.id, f.opts);
  assert.equal(finished.status, 'passed'); assert.equal(finished.result.businessRecoveryVerified, true); assert.equal(finished.result.httpChecks.length, 3);
  assert.equal(f.items.size, 0); assert.equal(f.removed.length, 5); assert.equal(f.created[0].Internal, true);
  for (const container of f.created.filter(row => row.HostConfig)) {
    assert.equal(container.HostConfig.PortBindings, undefined); assert.equal(container.HostConfig.Privileged, undefined);
    assert.ok(container.HostConfig.Mounts.every(mount => mount.Type === 'volume' && mount.Source.startsWith('composeops-recovery-')));
    assert.ok(!JSON.stringify(container.Env).includes('private-source-password'));
  }
  assert.ok(!JSON.stringify(finished).includes('private-source-password'));
});
test('备份损坏、缺凭据、目标漂移在创建隔离资源前阻断', async () => {
  for (const kind of ['corrupt', 'credentials', 'drift']) {
    const f = await fixture();
    if (kind === 'credentials') {
      const read = f.docker.getContainer; f.docker.getContainer = id => ({ ...read(id), inspect: async () => { const source = await read(id).inspect(); source.Config.Env = []; return source; } });
      assert.equal((await f.backup()).status, 'failed'); assert.equal(f.created.length, 0); continue;
    }
    const backup = await f.backup(), run = queueBusinessRun(f.plan.id, backup.id);
    if (kind === 'corrupt') await writeFile(businessBackupFile(backup.id), 'corrupt'); else f.drift();
    assert.equal((await executeBusinessRun(run.id, f.opts)).status, 'failed'); assert.equal(f.created.length, 0);
  }
});
test('SQL 不符、HTTP 不符或恢复超时不能作为业务恢复通过', async () => {
  for (const kind of ['sql', 'http', 'timeout']) {
    const f = await fixture(), backup = await f.backup(), run = queueBusinessRun(f.plan.id, backup.id);
    const opts = { ...f.opts, ...(kind === 'sql' ? { assertData: async () => [{ passed: false }] } : kind === 'http' ? { exec: async () => '{"statusCode":503,"bodyMatched":false}' } : { restore: async () => { throw new Error('恢复超时'); } }) };
    const result = await executeBusinessRun(run.id, opts); assert.equal(result.status, 'failed', kind); assert.equal(result.result.businessRecoveryVerified, false); assert.equal(result.result.cleanupComplete, true);
  }
});
test('重复入队和并发执行不重复创建，计划变更与拒绝策略阻止运行', async () => {
  const f = await fixture(), backup = await f.backup(), run = queueBusinessRun(f.plan.id, backup.id);
  assert.throws(() => queueBusinessRun(f.plan.id, backup.id), /进行中/);
  await Promise.all([executeBusinessRun(run.id, f.opts), executeBusinessRun(run.id, f.opts)]); assert.equal(f.created.length, 5);
  const g = await fixture(), gBackup = await g.backup(), queued = queueBusinessRun(g.plan.id, gBackup.id); pauseBusinessPlan(g.plan.id);
  assert.equal((await executeBusinessRun(queued.id, g.opts)).status, 'failed'); assert.equal(g.created.length, 0);
  const h = await fixture(), group = createAgentPolicyGroup({ name: 'business-deny', enabled: true });
  try { createAgentPolicyRule({ groupId: group.id, name: '禁止备份', toolName: 'sre.business.backup', projectId: h.project.id, effect: 'deny' }); assert.throws(() => queueBusinessBackup(h.plan.id), /拒绝/); }
  finally { deleteAgentPolicyGroup(group.id); }
});
test('进程中断与清理失败保留未知状态；仍有资源时不能核对关闭', async () => {
  const f = await fixture(), backup = await f.backup(), run = queueBusinessRun(f.plan.id, backup.id);
  const getVolume = f.docker.getVolume; f.docker.getVolume = id => ({ ...getVolume(id), remove: async () => { throw new Error('disk busy'); } });
  const result = await executeBusinessRun(run.id, f.opts); assert.equal(result.status, 'outcome_unknown'); assert.equal(result.result.cleanupComplete, false);
  await assert.rejects(acknowledgeBusinessJob('run', run.id, '已核对隔离恢复的残留资源', 'tester', f.opts), /仍有登记资源/);
  f.items.clear(); await acknowledgeBusinessJob('run', run.id, '已人工核对并删除全部隔离资源', 'tester', f.opts); assert.equal(getBusinessRun(run.id).status, 'closed');
  const next = queueBusinessRun(f.plan.id, backup.id); db.prepare("UPDATE sre_business_runs SET status='running' WHERE id=?").run(next.id); recoverBusinessJobs();
  assert.equal((await executeBusinessRun(next.id, f.opts)).status, 'outcome_unknown');
});
test('备份严格限制字节，失败不发布归档', async () => {
  const body = Buffer.from('large-dump'), header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(body.length, 4);
  await assert.rejects(persistDumpStream(Readable.from([Buffer.concat([header, body])]), path.join(dir, 'oversize.gz'), async () => ({ ExitCode: 0, Running: false }), { maxRawBytes: 2 }), /容量/);
});
test('恢复结束时 Engine 变化不能向新节点发送清理命令', async () => {
  const f = await fixture(), backup = await f.backup(), run = queueBusinessRun(f.plan.id, backup.id);
  const result = await executeBusinessRun(run.id, { ...f.opts, restore: async () => {
    f.docker.info = async () => ({ ID: 'different-engine' });
    throw new Error('节点连接已改变');
  } });
  assert.equal(result.status, 'outcome_unknown'); assert.equal(result.result.cleanupComplete, false);
  assert.equal(f.removed.length, 0); assert.ok(f.items.size > 0);
});
test('隔离容器不继承宿主权限、网络、原卷与发布端口', () => {
  const options = recoveryContainerConfig(image('a'), 'internal-only', {}, 'db', { database: true });
  assert.equal(options.HostConfig.NetworkMode, 'internal-only'); assert.deepEqual(options.HostConfig.CapDrop, ['ALL']); assert.equal(options.HostConfig.RestartPolicy.Name, 'no'); assert.equal(options.HostConfig.PidsLimit, 256);
});
test('MySQL/MariaDB 先拒绝非 InnoDB 表，不启动不一致导出', async () => {
  let calls = 0;
  const data = Buffer.from('1\n'), frame = Buffer.alloc(8); frame[0] = 1; frame.writeUInt32BE(data.length, 4);
  const container = { exec: async () => { calls++; return { start: async () => Readable.from([Buffer.concat([frame, data])]), inspect: async () => ({ ExitCode: 0, Running: false }) }; }, modem: { demuxStream: (source, stdout, _stderr) => source.on('data', bytes => stdout.write(bytes.subarray(8))) } };
  await assert.rejects(businessDump(container, { ...config(), engine: 'mysql' }, 'pass', path.join(dir, 'unused.gz')), /非事务表/); assert.equal(calls, 1);
});
