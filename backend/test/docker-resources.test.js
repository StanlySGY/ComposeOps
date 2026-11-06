import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-resources-'));
process.env.DB_PATH = path.join(temp, 'test.db');
const { getActivityDocker, setActiveHost, upsertHost } = await import('../src/services/docker-hosts.js');
const { listDockerResources, removeDockerResource } = await import('../src/services/docker-resources.js');
const docker = getActivityDocker();

function inventory(t, { images = [], volumes = [], networks = [], containers = [] } = {}) {
  t.mock.method(docker, 'listImages', async () => images);
  t.mock.method(docker, 'listVolumes', async () => ({ Volumes: volumes }));
  t.mock.method(docker, 'listNetworks', async () => networks);
  t.mock.method(docker, 'listContainers', async options => { assert.equal(options.all, true); return containers; });
}

test('inventory includes stopped-container image and network references; custom bridge is not builtin', async t => {
  inventory(t, {
    images: [{ Id: 'sha256:used', Containers: -1, RepoTags: [] }, { Id: 'sha256:free', RepoTags: ['app:old'] }],
    networks: [{ Id: 'builtin', Name: 'bridge', Driver: 'bridge' }, { Id: 'used-network', Name: 'app_default', Driver: 'bridge' }, { Id: 'free-network', Name: 'app_old', Driver: 'bridge' }],
    containers: [{ Id: 'stopped', State: 'exited', ImageID: 'sha256:used', NetworkSettings: { Networks: { app_default: { NetworkID: 'used-network' } } } }],
  });
  const result = await listDockerResources();
  assert.equal(result.hostId, 'local');
  assert.equal(result.images[0].inUse, true);
  assert.equal(result.images[0].containers, 1);
  assert.equal(result.images[1].inUse, false);
  assert.deepEqual(result.networks.map(n => [n.builtin, n.attached, n.unused]), [[true, 0, false], [false, 1, false], [false, 0, true]]);
});

test('network inspect endpoints and container references are deduplicated; stopped links without NetworkID still count', async t => {
  inventory(t, { networks: [{ Id: 'network', Name: 'custom', Driver: 'bridge', Containers: { c1: {} } }], containers: [{ Id: 'c1', NetworkSettings: { Networks: { custom: { NetworkID: 'network' } } } }, { Id: 'c2', State: 'exited', NetworkSettings: { Networks: { custom: {} } } }] });
  assert.equal((await listDockerResources()).networks[0].attached, 2);
});

test('volume size distinguishes unavailable, unsupported and zero bytes', async t => {
  inventory(t, { volumes: [{ Name: 'unknown' }, { Name: 'unsupported', UsageData: { Size: -1 } }, { Name: 'empty', UsageData: { Size: 0 } }] });
  assert.deepEqual((await listDockerResources()).volumes.map(v => v.size), [null, null, 0]);
});

test('incomplete container references fail the entire inventory closed', async t => {
  inventory(t);
  t.mock.method(docker, 'listContainers', async () => { throw new Error('Docker disconnected'); });
  await assert.rejects(listDockerResources(), /Docker disconnected/);
});

test('changed host rejects deletion before obtaining the resource', async t => {
  const get = t.mock.method(docker, 'getVolume', () => { throw new Error('must not delete'); });
  await assert.rejects(removeDockerResource('volume', 'same-name', false, 'another-host'), e => e.statusCode === 409 && e.code === 'resource_host_changed');
  assert.equal(get.mock.callCount(), 0);
});

test('network deletion refuses stopped references and builtins; free network removes by ID', async t => {
  let details = { Id: 'net1', Name: 'custom', Driver: 'bridge' };
  let refs = [{ Id: 'stopped', NetworkSettings: { Networks: { custom: {} } } }];
  const remove = t.mock.fn(async () => {});
  t.mock.method(docker, 'getNetwork', id => { assert.equal(id, 'net1'); return { inspect: async () => details, remove }; });
  t.mock.method(docker, 'listContainers', async () => refs);
  await assert.rejects(removeDockerResource('network', 'net1', false, 'local'), { statusCode: 409 });
  refs = []; details = { ...details, Name: 'bridge' };
  await assert.rejects(removeDockerResource('network', 'net1', false, 'local'), { statusCode: 409 });
  assert.equal(remove.mock.callCount(), 0);
  details = { ...details, Name: 'custom' };
  await removeDockerResource('network', 'net1', false, 'local');
  assert.equal(remove.mock.callCount(), 1);
});

test('a host switch during reference lookup keeps an already accepted deletion bound to the original client', async t => {
  const remote = upsertHost({ id: 'test-remote', name: 'test remote', type: 'tcp', host: '127.0.0.1', port: 1 });
  let resolve;
  t.mock.method(docker, 'listContainers', () => new Promise(r => { resolve = r; }));
  const remove = t.mock.fn(async opts => assert.equal(opts.force, false));
  t.mock.method(docker, 'getVolume', id => { assert.equal(id, 'original-volume'); return { remove }; });
  try {
    const deleting = removeDockerResource('volume', 'original-volume', false, 'local');
    setActiveHost(remote.id);
    resolve([]);
    await deleting;
    assert.equal(remove.mock.callCount(), 1);
  } finally { setActiveHost('local'); }
});
