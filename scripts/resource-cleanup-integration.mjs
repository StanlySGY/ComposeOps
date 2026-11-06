import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Touch only uniquely named disposable resources. Never start the scratch container.
const name = 'composeops-resource-audit-' + Date.now();
const dir = await mkdtemp(path.join(tmpdir(), name));
process.env.DB_PATH = path.join(dir, 'audit.db');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
let imageId, networkId, containerId, volumeCreated = false;
const steps = [];
try {
  await writeFile(path.join(dir, 'marker'), name);
  execFileSync('tar', ['-cf', path.join(dir, 'rootfs.tar'), '-C', dir, 'marker']);
  imageId = docker('import', path.join(dir, 'rootfs.tar'), name + ':test');
  networkId = docker('network', 'create', name);
  docker('volume', 'create', name); volumeCreated = true;
  containerId = docker('create', '--name', name, '--network', name, '--mount', `type=volume,source=${name},target=/data`, name + ':test', '/never-run');
  const { listDockerResources, removeDockerResource } = await import('../backend/src/services/docker-resources.js');
  let inventory = await listDockerResources();
  const image = inventory.images.find(row => row.id === imageId);
  const network = inventory.networks.find(row => row.id === networkId);
  const volume = inventory.volumes.find(row => row.name === name);
  assert.equal(image.inUse, true);
  assert.equal(network.builtin, false);
  assert.equal(network.unused, false);
  assert.equal(volume.orphan, false);
  steps.push('stopped container references recognized for image, custom bridge and volume');
  for (const [kind, id] of [['image', imageId], ['volume', name], ['network', networkId]]) {
    await assert.rejects(removeDockerResource(kind, id, false, inventory.hostId));
    await assert.rejects(removeDockerResource(kind, id, false, 'not-the-current-host'), error => error.code === 'resource_host_changed');
  }
  steps.push('referenced resources and wrong-host deletion refused');
  docker('rm', containerId); containerId = null;
  inventory = await listDockerResources();
  assert.equal(inventory.images.find(row => row.id === imageId).inUse, false);
  assert.equal(inventory.networks.find(row => row.id === networkId).unused, true);
  assert.equal(inventory.volumes.find(row => row.name === name).orphan, true);
  await removeDockerResource('image', imageId, false, inventory.hostId); imageId = null;
  await removeDockerResource('network', networkId, false, inventory.hostId); networkId = null;
  await removeDockerResource('volume', name, false, inventory.hostId); volumeCreated = false;
  steps.push('unreferenced temporary resources deleted successfully by ID');
  console.log(JSON.stringify({ ok: true, name, steps }, null, 2));
} finally {
  if (containerId) docker('rm', '-f', containerId);
  if (networkId) docker('network', 'rm', networkId);
  if (volumeCreated) docker('volume', 'rm', name);
  if (imageId) docker('image', 'rm', imageId);
  await rm(dir, { recursive: true, force: true });
}
