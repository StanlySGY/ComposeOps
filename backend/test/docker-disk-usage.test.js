import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import './helpers/isolated-db.js';
import { upsertHost, deleteHost, getHost } from '../src/services/docker-hosts.js';
import { readDockerDiskUsage, invalidateDiskUsage } from '../src/services/docker-disk-usage.js';
import { getDockerUsage } from '../src/services/maintenance.js';
import { getStorageStats } from '../src/services/cost-analysis.js';

async function endpoint(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
function node(t, port) {
  const host = upsertHost({ name: 'disk-test', type: 'tcp', host: '127.0.0.1', port });
  t.after(() => { if (getHost(host.id)) deleteHost(host.id); });
  return host;
}
const snapshot = size => ({ LayersSize: size, Images: [{ Size: size, SharedSize: 0, Containers: 0 }], Containers: [], Volumes: [], BuildCache: [] });

test('maintenance and cost share one cold scan and reuse the completed observation', async t => {
  let calls = 0, release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const host = node(t, await endpoint(t, (_req, res) => {
    calls++;
    release = () => res.end(JSON.stringify(snapshot(1048576)));
    started();
  }));
  const first = getDockerUsage(host.id);
  await ready;
  const second = getStorageStats(host.id);
  release();
  const [usage, cost] = await Promise.all([first, second]);
  assert.equal(usage.images.total, 1048576);
  assert.equal(cost.images.sizeMB, 1);
  await getDockerUsage(host.id);
  assert.equal(calls, 1);
});

test('failed scans retry; invalidation discards completed data', async t => {
  let calls = 0;
  const host = node(t, await endpoint(t, (_req, res) => {
    calls++;
    if (calls === 1) { res.statusCode = 500; res.end('{"message":"busy"}'); }
    else res.end(JSON.stringify(snapshot(calls)));
  }));
  await assert.rejects(readDockerDiskUsage(host.id));
  assert.equal((await readDockerDiskUsage(host.id)).LayersSize, 2);
  invalidateDiskUsage(host.id);
  assert.equal((await readDockerDiskUsage(host.id)).LayersSize, 3);
});

test('node edit cancels the old scan and cannot seed the new connection cache', async t => {
  let started, closed;
  const ready = new Promise(resolve => { started = resolve; });
  const disconnected = new Promise(resolve => { closed = resolve; });
  const host = node(t, await endpoint(t, req => { req.once('close', closed); started(); }));
  const pending = readDockerDiskUsage(host.id);
  const rejected = assert.rejects(pending);
  await ready;
  const port = await endpoint(t, (_req, res) => res.end(JSON.stringify(snapshot(99))));
  upsertHost({ ...host, port });
  await rejected;
  await disconnected;
  assert.equal((await readDockerDiskUsage(host.id)).LayersSize, 99);
  deleteHost(host.id);
  assert.throws(() => readDockerDiskUsage(host.id), /不存在/);
});

test('a hung scan times out, closes its connection and is not reused', async t => {
  let calls = 0, closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const host = node(t, await endpoint(t, (req, res) => {
    calls++;
    if (calls === 1) req.once('close', closed);
    else res.end(JSON.stringify(snapshot(2)));
  }));
  await assert.rejects(readDockerDiskUsage(host.id, { timeoutMs: 80 }));
  await disconnected;
  assert.equal((await readDockerDiskUsage(host.id, { timeoutMs: 80 })).LayersSize, 2);
});
