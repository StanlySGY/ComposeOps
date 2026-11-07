import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';

const dir = mkdtempSync(path.join(tmpdir(), 'composeops-monitor-scope-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const { getDockerUsage } = await import('../src/services/maintenance.js');
const { upsertHost, deleteHost, setActiveHost, getActiveHostId, pingHost } = await import('../src/services/docker-hosts.js');
const { default: localDocker } = await import('../src/services/docker.js');
const { buildApp } = await import('../src/app.js');
const app = await buildApp({ logger: false });
const originalDf = localDocker.df;
localDocker.df = async () => ({ Images: [], Containers: [], Volumes: [], BuildCache: [] });
test.after(async () => { localDocker.df = originalDf; await app.close(); rmSync(dir, { recursive: true, force: true }); });

async function fakeHost(t, name, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = upsertHost({ name, type: 'tcp', host: '127.0.0.1', port: server.address().port });
  t.after(async () => { deleteHost(host.id); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return host;
}
const snapshot = size => ({ Images: [{ Id: 'same-image', Size: size, Containers: 0 }], Containers: [{ State: 'exited', SizeRw: 7 }], BuildCache: [{ Size: 9, InUse: false }], Volumes: [{ UsageData: { RefCount: 0, Size: 11 } }] });

test('Docker 存储固定指定节点，全部节点汇总保留各节点副本', async t => {
  const first = await fakeHost(t, 'first', (_req, res) => res.end(JSON.stringify(snapshot(100))));
  const second = await fakeHost(t, 'second', (_req, res) => res.end(JSON.stringify(snapshot(200))));
  setActiveHost(first.id);
  t.after(() => setActiveHost('local'));
  const usage = await getDockerUsage(second.id);
  assert.equal(usage.images.total, 200);
  assert.equal(usage.hostId, second.id);
  assert.equal(getActiveHostId(), first.id);
  assert.equal((await getDockerUsage()).images.total, 100);
  const all = await getDockerUsage('all');
  assert.equal(all.images.total, 300);
  assert.equal(all.images.count, 2);
  assert.equal(all.reclaimable, 354);
  assert.deepEqual(all.unavailableHosts, []);
});

test('挂起节点在期限内取消请求，返回显式不完整汇总', async t => {
  let closed = false;
  const slow = await fakeHost(t, 'slow', (req) => req.on('close', () => { closed = true; }));
  const fast = await fakeHost(t, 'fast', (_req, res) => res.end(JSON.stringify(snapshot(50))));
  const start = Date.now();
  const all = await getDockerUsage('all', { timeoutMs: 100 });
  assert.ok(Date.now() - start < 2000);
  assert.deepEqual(all.unavailableHosts, [slow.id]);
  assert.equal(all.images.total, 50);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(closed, true, '超时真正关闭 Docker 请求连接');
  assert.equal((await getDockerUsage(fast.id)).images.total, 50);
});

test('非法节点 API 返回 404，失联节点返回 503，不伪报零用量', async t => {
  const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { password: 'monitor-scope-test-only' } });
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  for (const url of ['/api/v1/system/metrics?hostId=missing', '/api/v1/personal/maintenance/usage?hostId=missing']) {
    assert.equal((await app.inject({ url, headers: { cookie } })).statusCode, 404);
  }
  const failed = await fakeHost(t, 'offline', (_req, res) => { res.statusCode = 500; res.end('{"message":"offline"}'); });
  const result = await app.inject({ url: `/api/v1/personal/maintenance/usage?hostId=${failed.id}`, headers: { cookie } });
  assert.equal(result.statusCode, 503);
  assert.equal(result.json().error, 'host_unavailable');
});

test('ping 成功但容器列表失败时统计为未知', async t => {
  const host = await fakeHost(t, 'restricted', (req, res) => {
    if (req.url.endsWith('/_ping')) return res.end('OK');
    if (req.url.endsWith('/version')) return res.end('{"Version":"test"}');
    res.statusCode = 500; res.end('{"message":"unavailable"}');
  });
  const result = await pingHost(host.id);
  assert.equal(result.ok, true);
  assert.equal(result.containerCount, null);
  assert.equal(result.runningCount, null);
});
