import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import './helpers/isolated-db.js';
import { upsertHost, deleteHost, getHost } from '../src/services/docker-hosts.js';
import { readDockerDiskUsage, invalidateDiskUsage, diskUsageFailure } from '../src/services/docker-disk-usage.js';
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
  assert.equal(calls, 1, 'unrelated Engine errors must not be automatically retried');
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

test('different caller deadlines still share one node scan', async t => {
  let calls = 0, release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const host = node(t, await endpoint(t, (_req, res) => {
    calls++; release = () => res.end(JSON.stringify(snapshot(20))); started();
  }));
  const short = readDockerDiskUsage(host.id, { timeoutMs: 100 });
  const shortRejected = assert.rejects(short, { statusCode: 503 });
  await ready;
  const long = readDockerDiskUsage(host.id, { timeoutMs: 1000 });
  long.catch(() => {}); // Keep an expected failing implementation from leaking past the assertion.
  await shortRejected;
  assert.equal(calls, 1);
  release(); assert.equal((await long).LayersSize, 20);
  assert.equal((await readDockerDiskUsage(host.id, { timeoutMs: 500 })).LayersSize, 20);
  assert.equal(calls, 1);
});

test('invalid Engine response is not cached as a zero-sized node', async t => {
  let calls = 0;
  const host = node(t, await endpoint(t, (_req, res) => { calls++; res.end(JSON.stringify(calls === 1 ? { message: 'not disk usage' } : snapshot(8))); }));
  await assert.rejects(readDockerDiskUsage(host.id), { statusCode: 502 });
  assert.equal((await readDockerDiskUsage(host.id)).LayersSize, 8);
});

test('one caller cancellation does not abort another caller and empty Engine arrays remain valid', async t => {
  let calls = 0, release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const host = node(t, await endpoint(t, (_req, res) => { calls++; release = () => res.end(JSON.stringify({ LayersSize: 0, Images: null, Containers: null, Volumes: null, BuildCache: null })); started(); }));
  const controller = new AbortController();
  const first = readDockerDiskUsage(host.id, { signal: controller.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await ready; const second = readDockerDiskUsage(host.id); controller.abort(); await rejected;
  release(); assert.equal((await second).LayersSize, 0); assert.equal(calls, 1);
});

test('invalid wait budgets are rejected without making a request', async t => {
  let calls = 0;
  const host = node(t, await endpoint(t, (_req, res) => { calls++; res.end(JSON.stringify(snapshot(1))); }));
  for (const timeoutMs of [0, -1, 60001, Infinity, '100']) assert.throws(() => readDockerDiskUsage(host.id, { timeoutMs }), { statusCode: 400 });
  assert.equal(calls, 0);
});

test('maintenance preserves safe failure categories without upstream body disclosure', async t => {
  const host = node(t, await endpoint(t, (_req, res) => { res.statusCode = 500; res.end('{"message":"upstream credential=do-not-expose"}'); }));
  await assert.rejects(getDockerUsage(host.id), error => {
    assert.equal(error.statusCode, 503); assert.equal(error.failures[0].code, 'engine_error');
    assert.equal(error.failures[0].upstreamStatus, 500); assert.ok(!JSON.stringify(error).includes('do-not-expose')); return true;
  });
  assert.equal(diskUsageFailure({ code: 'DISK_SCAN_TIMEOUT' }).code, 'scan_timeout');
  assert.equal(diskUsageFailure({ code: 'ECONNRESET' }).code, 'connection_error');
});

test('client renewal after 30 seconds must not cancel an unchanged remote scan', async t => {
  let calls = 0, started; const replies = [];
  const ready = new Promise(resolve => { started = resolve; });
  const host = node(t, await endpoint(t, (_req, res) => { calls++; replies.push(res); started(); }));
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const first = readDockerDiskUsage(host.id); first.catch(() => {}); await ready;
  now += 31000;
  const second = readDockerDiskUsage(host.id); second.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 20));
  for (const reply of replies) reply.end(JSON.stringify(snapshot(12)));
  const result = await Promise.allSettled([first, second]);
  assert.equal(calls, 1); assert.ok(result.every(item => item.status === 'fulfilled' && item.value.LayersSize === 12));
});

const snapshotFailure = 'failed to retrieve container list: rw layer snapshot not found for container ' + 'a'.repeat(64);

test('one missing container snapshot gets one shared read retry', async t => {
  let calls = 0;
  const host = node(t, await endpoint(t, (_req, res) => {
    calls++;
    if (calls === 1) { res.statusCode = 500; res.end(JSON.stringify({ message: snapshotFailure })); }
    else res.end(JSON.stringify(snapshot(42)));
  }));
  const results = await Promise.all([readDockerDiskUsage(host.id), readDockerDiskUsage(host.id)]);
  assert.ok(results.every(data => data.LayersSize === 42));
  assert.equal(calls, 2);
  assert.equal((await readDockerDiskUsage(host.id)).LayersSize, 42);
  assert.equal(calls, 2);
});

test('persistent missing snapshots stop after two reads and preserve a safe failure category', async t => {
  let calls = 0;
  const host = node(t, await endpoint(t, (_req, res) => {
    calls++; res.statusCode = 500; res.end(JSON.stringify({ message: snapshotFailure }));
  }));
  await assert.rejects(getDockerUsage(host.id), error => {
    assert.equal(error.statusCode, 503);
    assert.deepEqual(error.failures[0].code, 'engine_snapshot_unavailable');
    assert.ok(!JSON.stringify(error).includes('a'.repeat(64)));
    return true;
  });
  assert.equal(calls, 2);
  await assert.rejects(readDockerDiskUsage(host.id));
  assert.equal(calls, 4, 'persistent failures are not cached as successful data');
});

test('last caller timeout cancels the retry delay without sending a second request', async t => {
  let calls = 0;
  const host = node(t, await endpoint(t, (_req, res) => {
    calls++; res.statusCode = 500; res.end(JSON.stringify({ message: snapshotFailure }));
  }));
  await assert.rejects(readDockerDiskUsage(host.id, { timeoutMs: 100 }), { code: 'DISK_SCAN_TIMEOUT' });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(calls, 1);
});

test('node revision change cancels the old snapshot retry and reads only the new node', async t => {
  let oldCalls = 0, newCalls = 0, started;
  const ready = new Promise(resolve => { started = resolve; });
  const host = node(t, await endpoint(t, (_req, res) => {
    oldCalls++; res.statusCode = 500; res.end(JSON.stringify({ message: snapshotFailure })); started();
  }));
  const pending = readDockerDiskUsage(host.id);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await ready; await new Promise(resolve => setTimeout(resolve, 30));
  const port = await endpoint(t, (_req, res) => { newCalls++; res.end(JSON.stringify(snapshot(99))); });
  upsertHost({ ...host, port });
  await rejected;
  assert.equal((await readDockerDiskUsage(host.id)).LayersSize, 99);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(oldCalls, 1); assert.equal(newCalls, 1);
});
