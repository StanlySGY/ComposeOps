import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const temp = await mkdtemp(path.join(os.tmpdir(), 'maintenance-workspace-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.COMPOSEOPS_RUNNER_IMAGE = 'fixture:local';
const { default: docker } = await import('../src/services/docker.js');
const { withRunner, withReadOnlyRunner, pruneWorkspaceRunners, closeIdleProjectRunners, closeAllWorkspaceRunners } = await import('../src/services/compose-workspace.js');
const project = (id) => ({ id, workingDir: '/apps/' + id, composeFiles: ['/apps/' + id + '/compose.yml'] });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function fixture(t) {
  const removed = [], configs = [];
  t.mock.method(docker, 'createContainer', async config => { configs.push(config); const { WorkingDir } = config; return ({
    start: async () => {},
    inspect: async () => ({ State: { Running: true } }),
    remove: async () => { removed.push(WorkingDir); },
    exec: async ({ Cmd }) => ({
      start: async () => {
        const payload = Buffer.from(Cmd.at(-1) + '\n');
        const header = Buffer.alloc(8);
        header[0] = 1;
        header.writeUInt32BE(payload.length, 4);
        return Readable.from([Buffer.concat([header, payload])]);
      },
      inspect: async () => ({ ExitCode: 0 }),
    }),
  }); });
  return { removed, configs };
}
test('预检等待所选工作命令完成，不能中途删除执行器', async (t) => {
  const { removed } = fixture(t), entered = deferred(), release = deferred();
  const work = withRunner(project('selected'), async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const cleanup = closeIdleProjectRunners(['selected'], { waitMs: 1000 });
  assert.deepEqual(removed, []);
  release.resolve();
  await Promise.all([work, cleanup]);
  assert.deepEqual(removed, ['/apps/selected']);
});
test('只读工作区无网络、无 socket、只读挂载，复用时不会借用执行器权限', async t => {
  const { configs } = fixture(t);
  try {
    let readRunner, executeRunner;
    await withReadOnlyRunner(project('read'), async runner => { readRunner = runner; });
    await withRunner(project('read'), async runner => { executeRunner = runner; });
    await withReadOnlyRunner(project('read'), async runner => { assert.equal(runner, readRunner); });
    assert.notEqual(readRunner, executeRunner);
    assert.equal(configs.length, 2);
    assert.equal(configs[0].HostConfig.NetworkMode, 'none');
    assert.equal(configs[0].HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(configs[0].HostConfig.Mounts, [{ Type: 'bind', Source: '/apps/read', Target: '/apps/read', ReadOnly: true }]);
    assert.equal(configs[1].HostConfig.NetworkMode, undefined);
    assert.equal(configs[1].HostConfig.Mounts.some(m => m.Source === '/var/run/docker.sock'), true);
  } finally { await closeAllWorkspaceRunners(); }
});
test('本地别名节点的同名项目缓存不混用，撤权仅回收指定节点', async t => {
  const { upsertHost, deleteHost } = await import('../src/services/docker-hosts.js');
  const { configs, removed } = fixture(t);
  const alias = upsertHost({ id: 'reader-alias', type: 'local', name: 'reader alias' });
  try {
    await withReadOnlyRunner({ ...project('same'), hostId: 'local' }, async () => {});
    await withReadOnlyRunner({ ...project('same'), hostId: alias.id }, async () => {});
    assert.equal(configs.length, 2);
    pruneWorkspaceRunners([], 'local');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(removed.length, 1);
    await withReadOnlyRunner({ ...project('same'), hostId: alias.id }, async () => {});
    assert.equal(configs.length, 2);
  } finally { await closeAllWorkspaceRunners(); deleteHost(alias.id); }
});
test('启动失败的工作容器立即清理，不依赖尚未生效的 AutoRemove', async t => {
  let created = 0, removed = 0;
  t.mock.method(docker, 'createContainer', async () => { created++; return {
    start: async () => { throw new Error('start failed'); },
    remove: async () => { removed++; },
  }; });
  await assert.rejects(withReadOnlyRunner(project('failed'), async () => assert.fail('must not execute')), /start failed/);
  assert.equal(created, 2); assert.equal(removed, created);
  await closeAllWorkspaceRunners();
});
test('无关应用的工作命令不阻止所选应用回收，超时不强杀活跃执行器', async (t) => {
  const { removed } = fixture(t), entered = deferred(), release = deferred();
  await withRunner(project('selected'), async () => {});
  const work = withRunner(project('other'), async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  try {
    await closeIdleProjectRunners(['selected'], { waitMs: 100 });
    assert.deepEqual(removed, ['/apps/selected']);
    await assert.rejects(closeIdleProjectRunners(['other'], { waitMs: 10 }), { statusCode: 409 });
    assert.deepEqual(removed, ['/apps/selected']);
  } finally {
    release.resolve();
    await work;
    await closeAllWorkspaceRunners();
  }
});
test.after(async () => {
  const { default: db } = await import('../src/lib/db.js');
  db.close();
  await rm(temp, { recursive: true, force: true });
});
