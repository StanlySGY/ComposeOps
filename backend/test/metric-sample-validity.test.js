import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseContainerStats, queryContainerMetrics } from '../src/services/agent-metrics.js';
import { parseContainerMetrics } from '../src/services/metrics-collector.js';
import { getDockerForHost, setActiveHost, upsertHost, deleteHost } from '../src/services/docker-hosts.js';
import { scanProjects, invalidateScanCache } from '../src/services/scanner.js';
import { setProjectPreference } from '../src/lib/db.js';

test('缺失指标不能以0冒充有效数据，首次CPU采样也保持未知', () => {
  for (const metric of ['cpu', 'memory', 'network', 'disk']) assert.equal(parseContainerStats({}, metric).numeric, null, metric);
  assert.equal(parseContainerStats({ cpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000, online_cpus: 4 } }, 'cpu').numeric, null);
});

test('历史采集缺失指标不写零点，真实零值仍可保留', () => {
  assert.deepEqual(parseContainerMetrics('fixture', {}), []);
  const values = parseContainerMetrics('fixture', { networks: { eth0: { rx_bytes: 0, tx_bytes: 0 } }, blkio_stats: { io_service_bytes_recursive: [] } });
  assert.equal(values.length, 4); assert.ok(values.every(item => item.value === 0));
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'metric-snapshot-')), file = path.join(root, 'compose.yml'), id = path.basename(root);
  await writeFile(file, 'services: {}\n'); t.after(() => rm(root, { recursive: true, force: true }));
  const docker = getDockerForHost('local'), rows = [{ Id: id, Names: ['/' + id], State: 'running', Labels: {
    'com.docker.compose.project': id, 'com.docker.compose.project.working_dir': root, 'com.docker.compose.project.config_files': file,
  } }];
  t.mock.method(docker, 'listContainers', async () => rows);
  const sample = t.mock.fn(async () => ({ memory_stats: { usage: 30, limit: 100 } }));
  t.mock.method(docker, 'getContainer', () => ({ stats: sample }));
  invalidateScanCache(); const [project] = await scanProjects('local'); setProjectPreference(project.id, { managed: true });
  return { id, sample, project, rows };
}
test.beforeEach(() => { setActiveHost('local'); invalidateScanCache(); });

test('同一容器并行查询四种指标共享一个真实采样，没有历史不伪造平均和稳定趋势', async t => {
  const { id, sample } = await fixture(t);
  const results = await Promise.all(['cpu', 'memory', 'network', 'disk'].map(metric => queryContainerMetrics(id, metric)));
  assert.equal(sample.mock.callCount(), 1);
  assert.equal(results[1].current, 30); assert.equal(results[1].average, null); assert.equal(results[1].trend, 'unknown');
  assert.equal(new Set(results.map(item => item.timestamp)).size, 1);
});

test('采样失败不缓存失败，短缓存到期会重新获取指标', async t => {
  const { id, sample } = await fixture(t); let now = Date.now(); t.mock.method(Date, 'now', () => now);
  sample.mock.mockImplementationOnce(async () => { throw new Error('采样暂不可用'); });
  await assert.rejects(queryContainerMetrics(id, 'memory'), /暂不可用/);
  assert.equal((await queryContainerMetrics(id, 'memory')).current, 30);
  await queryContainerMetrics(id, 'cpu'); assert.equal(sample.mock.callCount(), 2);
  now += 1001; sample.mock.mockImplementation(async () => ({ memory_stats: { usage: 60, limit: 100 } }));
  assert.equal((await queryContainerMetrics(id, 'memory')).current, 60); assert.equal(sample.mock.callCount(), 3);
});

test('在途采样期间撤销纳管不能返回数据，缓存命中也复核权限', async t => {
  const f = await fixture(t); let release, enter; const entered = new Promise(resolve => { enter = resolve; });
  f.sample.mock.mockImplementation(() => { enter(); return new Promise(resolve => { release = resolve; }); });
  const pending = queryContainerMetrics(f.id, 'memory'); await entered;
  setProjectPreference(f.project.id, { managed: false }); release({ memory_stats: { usage: 30, limit: 100 } });
  await assert.rejects(pending, { statusCode: 403 });
  await assert.rejects(queryContainerMetrics(f.id, 'memory'), { statusCode: 403 });
});

test('在途采样期间切换节点，旧结果被拒绝', async t => {
  const f = await fixture(t); let release, enter; const entered = new Promise(resolve => { enter = resolve; });
  f.sample.mock.mockImplementation(() => { enter(); return new Promise(resolve => { release = resolve; }); });
  const host = upsertHost({ name: '另一个节点', type: 'tcp', host: '127.0.0.1', port: 9 });
  t.after(() => { setActiveHost('local'); deleteHost(host.id); });
  const pending = queryContainerMetrics(f.id, 'memory'); await entered; setActiveHost(host.id); release({});
  await assert.rejects(pending, { statusCode: 409 });
});

test('不合作的指标传输会超时并允许后续重试', async t => {
  const f = await fixture(t); let enter; const entered = new Promise(resolve => { enter = resolve; });
  f.sample.mock.mockImplementation(() => { enter(); return new Promise(() => {}); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failed = assert.rejects(queryContainerMetrics(f.id, 'memory'), { statusCode: 504 });
  await entered; t.mock.timers.tick(8001); await failed;
  f.sample.mock.mockImplementation(async () => ({ memory_stats: { usage: 0, limit: 100 } }));
  assert.equal((await queryContainerMetrics(f.id, 'memory')).current, 0);
});

test('CPU计数回退和非法字段保持未知，内存工作集采用统一cgroup缓存口径', () => {
  const reset = { cpu_stats: { cpu_usage: { total_usage: 5 }, system_cpu_usage: 200, online_cpus: 2 }, precpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 100 } };
  assert.equal(parseContainerStats(reset, 'cpu').numeric, null); assert.equal(parseContainerMetrics('fixture', reset).length, 0);
  const memory = { memory_stats: { usage: 100, limit: 200, stats: { inactive_file: 10, total_inactive_file: 20, cache: 30 } } };
  assert.equal(parseContainerStats(memory, 'memory').current, 45); assert.equal(parseContainerMetrics('fixture', memory)[0].value, 45);
  for (const value of [null, false, '0', -1, Infinity]) {
    assert.equal(parseContainerStats({ memory_stats: { usage: value, limit: 100 } }, 'memory').numeric, null);
  }
});

test('超大、零或无效时间范围在读取Docker前拒绝', async t => {
  const sample = t.mock.method(getDockerForHost('local'), 'listContainers', async () => { throw new Error('不应访问'); });
  for (const period of ['0m', '8d', '999999999999999d', 'invalid']) await assert.rejects(queryContainerMetrics('fixture', 'cpu', period), { statusCode: 400 });
  assert.equal(sample.mock.callCount(), 0);
});
