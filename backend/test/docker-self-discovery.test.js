import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(os.tmpdir(), 'docker-self-discovery-'));
process.env.DB_PATH = path.join(directory, 'test.sqlite');
const { default: docker } = await import('../src/services/docker.js');
const { prepareFullRestore } = await import('../src/services/container-maintenance.js');
const { inspectHostDirectory } = await import('../src/services/compose-workspace.js');
const { default: db } = await import('../src/lib/db.js');
test.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const apply = entries => { for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } };
  apply(values); t.after(() => apply(previous));
}

for (const hostname of [undefined, '', '   ']) {
  test(`本机备份不以空容器身份访问 Docker：${JSON.stringify(hostname)}`, async t => {
    environment(t, { HOSTNAME: hostname, COMPOSEOPS_RUNNER_IMAGE: 'fixture:runner' });
    t.mock.method(docker, 'info', async () => ({ OSType: 'linux', ID: 'fixture-engine' }));
    const inspect = t.mock.method(docker, 'getContainer', () => ({ inspect: async () => {
      throw Object.assign(new Error('fixture missing container'), { statusCode: 404 });
    } }));
    // 在执行任何备份前以错误节点终止，只检验运行环境识别路径。
    await assert.rejects(prepareFullRestore({ expectedHostId: 'another-host' }), /节点已变化|无法确认本机/);
    assert.equal(inspect.mock.callCount(), 0);
  });
}

test('宿主运行未配置执行器镜像时返回可操作错误，不发送空 ID 查询', async t => {
  environment(t, { HOSTNAME: undefined, COMPOSEOPS_RUNNER_IMAGE: undefined });
  const inspect = t.mock.method(docker, 'getContainer', () => ({ inspect: async () => {
    throw Object.assign(new Error('fixture missing container'), { statusCode: 404 });
  } }));
  await assert.rejects(inspectHostDirectory({ id: 'local', type: 'local' }, '/apps'), {
    statusCode: 409, message: /COMPOSEOPS_RUNNER_IMAGE/,
  });
  assert.equal(inspect.mock.callCount(), 0);
});

test('当前容器暂时不可读后可以重新探测镜像，不缓存失败结果', async t => {
  environment(t, { HOSTNAME: 'fixture-panel', COMPOSEOPS_RUNNER_IMAGE: undefined });
  let calls = 0;
  t.mock.method(docker, 'getContainer', () => ({ inspect: async () => {
    if (++calls === 1) throw new Error('temporary Docker error');
    return { Config: { Image: 'fixture:runner' } };
  } }));
  const created = t.mock.method(docker, 'createContainer', async () => { throw new Error('fixture reached helper creation'); });
  const inspect = () => inspectHostDirectory({ id: 'local', type: 'local' }, '/apps');
  await assert.rejects(inspect(), /temporary Docker error/);
  await assert.rejects(inspect(), /fixture reached helper creation/);
  assert.equal(calls, 2);
  assert.equal(created.mock.calls[0].arguments[0].Image, 'fixture:runner');
});

test('传统卷备份也不以空 HOSTNAME 探测容器挂载', async t => {
  environment(t, { HOSTNAME: '' });
  const { addVolumeBackup, getVolumeBackup } = await import('../src/lib/db.js');
  const { deleteVolumeBackup } = await import('../src/services/volume-backup.js');
  const id = addVolumeBackup({ projectId: 'self-discovery', projectName: 'fixture', volume: 'fixture', file: 'fixture.tar.gz', bytes: 1, host: 'local' });
  const inspect = t.mock.method(docker, 'getContainer', () => ({ inspect: async () => {
    throw Object.assign(new Error('fixture missing container'), { statusCode: 404 });
  } }));
  t.mock.method(docker, 'getImage', () => ({ inspect: async () => ({}) }));
  t.mock.method(docker, 'createContainer', async () => { throw new Error('fixture reached volume helper'); });
  await assert.rejects(deleteVolumeBackup(id), /fixture reached volume helper|无法读取当前应用容器/);
  assert.ok(getVolumeBackup(id), 'helper 没有完成时不得删除备份记录');
  assert.equal(inspect.mock.callCount(), 0);
});
