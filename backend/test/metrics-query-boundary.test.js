import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import db, { setProjectPreference } from '../src/lib/db.js';
import { queryHistoricalMetrics, queryHistoricalMetricWindow, getMetricsStats, detectAnomalies, evaluateAlertRules } from '../src/services/metrics.js';
import metricsRoutes from '../src/routes/metrics.js';
import { getDockerForHost } from '../src/services/docker-hosts.js';
import { invalidateScanCache, scanProjects } from '../src/services/scanner.js';

test.beforeEach(() => db.exec('DELETE FROM container_metrics'));
const insert = db.prepare('INSERT INTO container_metrics(host_id, container_id, metric_type, value, unit, timestamp) VALUES(?,?,?,?,?,?)');

test('历史查询结果有界，密集采样聚合保留权重与真实峰值', () => {
  const now = Date.now();
  db.transaction(() => { for (let i = 0; i < 5000; i++) insert.run('local', 'dense', 'cpu', i === 2500 ? 99 : 1, '%', now - 5000 + i); })();
  const rows = queryHistoricalMetrics({ hostId: 'local', containerId: 'dense', metricType: 'cpu', startTime: now - 6000, endTime: now, aggregation: 0 });
  assert.ok(rows.length <= 2000, `returned ${rows.length} points`);
  assert.equal(rows.reduce((sum, row) => sum + row.sample_count, 0), 5000);
  assert.equal(Math.max(...rows.map(row => row.value_max)), 99);
  assert.equal(rows.reduce((sum, row) => sum + row.value_sum, 0), 5098);
});

test('服务层拒绝无效、反向和超长范围以及不合法聚合', () => {
  const now = Date.now(), options = { containerId: 'fixture', metricType: 'cpu', startTime: now - 60000, endTime: now };
  for (const change of [{ startTime: now + 1 }, { startTime: 0 }, { startTime: NaN }, { aggregation: -1 }, { aggregation: 'bad' }, { aggregation: Infinity }]) {
    assert.throws(() => queryHistoricalMetrics({ ...options, ...change }), { statusCode: 400 });
  }
  for (const hours of [-1, 0, Infinity, 24 * 31]) assert.throws(() => getMetricsStats('fixture', 'cpu', hours, 'local'), { statusCode: 400 });
});

test('历史API非法输入在扫描节点前拒绝', async t => {
  invalidateScanCache();
  const scan = t.mock.method(getDockerForHost('local'), 'listContainers', async () => { throw new Error('invalid query must not scan'); });
  const app = Fastify(); await app.register(metricsRoutes, { prefix: '/metrics' }); t.after(() => app.close());
  const requests = [
    { method: 'GET', url: '/metrics/historical?containerId=fixture&metricType=cpu&aggregation=bad' },
    { method: 'GET', url: '/metrics/historical?containerId=fixture&metricType=unknown' },
    { method: 'GET', url: '/metrics/historical?containerId=fixture&metricType=cpu&startTime=10&endTime=1' },
    { method: 'GET', url: '/metrics/stats/fixture/cpu?hours=999999' },
    { method: 'POST', url: '/metrics/anomalies', payload: { containerId: 'fixture', metricType: 'network_rx' } },
    { method: 'POST', url: '/metrics/anomalies', payload: { containerId: 'fixture', metricType: 'cpu', hours: -1 } },
  ];
  for (const request of requests) assert.equal((await app.inject(request)).statusCode, 400, request.url);
  assert.equal(scan.mock.callCount(), 0);
});

test('累计字节不能当作流量速率异常或智能告警', () => {
  const now = Date.now();
  const points = Array.from({ length: 20 }, (_, i) => ({ host_id: 'local', container_id: 'counter', metric_type: 'network_rx', timestamp: now - 2000 + i * 50, value: i === 19 ? 100000000 : i }));
  for (const item of points) insert.run(item.host_id, item.container_id, item.metric_type, item.value, 'bytes', item.timestamp);
  assert.deepEqual(detectAnomalies(points), []);
  assert.deepEqual(evaluateAlertRules('counter', 'local'), []);
});

test('异常检测不能把不同节点和不同指标接成一条趋势', () => {
  const points = [];
  for (let i = 0; i < 20; i++) {
    points.push({ host_id: i < 10 ? 'local' : 'remote', container_id: 'same', metric_type: 'cpu', timestamp: i, value: i < 10 ? 10 : 90 });
  }
  assert.deepEqual(detectAnomalies(points), []);
});

test('长窗口自动提高粒度而不截掉尾部，返回真实采样说明', () => {
  const now = Date.now(), start = now - 29 * 86400000;
  db.transaction(() => { for (let i = 0; i < 4000; i++) insert.run('local', 'long', 'cpu', i === 3999 ? 100 : 1, '%', start + Math.floor((now - start) * i / 3999)); })();
  const result = queryHistoricalMetricWindow({ containerId: 'long', metricType: 'cpu', startTime: start, endTime: now, aggregation: 0 });
  assert.ok(result.metrics.length <= 2000); assert.equal(result.sampling.adjusted, true);
  assert.equal(result.sampling.sourceSamples, 4000); assert.ok(result.sampling.aggregationSeconds > 300);
  assert.equal(Math.max(...result.metrics.map(row => row.value_max)), 100);
  assert.equal(result.metrics.at(-1).value_max, 100);
});

test('HTTP历史提供采样范围和检测依据，撤销纳管后缓存扫描也拒绝', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'metric-query-')), file = path.join(root, 'compose.yml'), id = path.basename(root);
  await writeFile(file, 'services: {}\n'); t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(getDockerForHost('local'), 'listContainers', async () => [{ Id: id, Names: ['/' + id], State: 'running', Labels: {
    'com.docker.compose.project': id, 'com.docker.compose.project.working_dir': root, 'com.docker.compose.project.config_files': file,
  } }]);
  invalidateScanCache(); const [project] = await scanProjects('local'); setProjectPreference(project.id, { managed: true });
  insert.run('local', id, 'cpu', 1, '%', Date.now() - 1000);
  insert.run('another-host', id, 'cpu', 99, '%', Date.now() - 1000);
  const app = Fastify(); await app.register(metricsRoutes, { prefix: '/metrics' }); t.after(() => app.close());
  const url = `/metrics/historical?containerId=${id}&metricType=cpu`;
  const response = await app.inject({ method: 'GET', url }); assert.equal(response.statusCode, 200);
  const data = response.json(); assert.equal(data.sampling.sourceSamples, 1); assert.equal(data.metrics[0].value, 1);
  assert.equal(data.sampling.endTime - data.sampling.startTime, 86400000);
  const analysis = await app.inject({ method: 'POST', url: '/metrics/anomalies', payload: { containerId: id, metricType: 'cpu' } });
  assert.equal(analysis.statusCode, 200); assert.equal(analysis.json().analysis.sufficientSamples, false);
  setProjectPreference(project.id, { managed: false });
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/metrics/anomalies', payload: { containerId: id, metricType: 'cpu' } })).statusCode, 403);
});
