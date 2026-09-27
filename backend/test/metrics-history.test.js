import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-metrics-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const dbModule = await import('../src/lib/db.js');
const { default: db } = dbModule;
const { queryHistoricalMetrics, getMetricsStats, detectAnomalies } = await import('../src/services/metrics.js');

test('metrics: 历史指标使用毫秒时间戳并按毫秒窗口过滤', () => {
  db.prepare('DELETE FROM container_metrics').run();
  const now = Date.now();
  const insert = db.prepare('INSERT INTO container_metrics(container_id, metric_type, value, unit, timestamp) VALUES(?, ?, ?, ?, ?)');
  insert.run('container-test', 'cpu', 10, '%', now - 4000);
  insert.run('container-test', 'cpu', 20, '%', now - 2000);
  insert.run('container-test', 'cpu', 30, '%', now);

  const rows = queryHistoricalMetrics({
    containerId: 'container-test',
    metricType: 'cpu',
    startTime: now - 2500,
    endTime: now + 1000,
    aggregation: 0,
  });
  assert.deepEqual(rows.map((row) => row.value), [20, 30]);
  assert.equal(rows[0].timestamp, now - 2000);
  assert.equal(getMetricsStats('container-test', 'cpu', 1).unit, '%');
});

test('metrics: 时间戳 0 也参与边界过滤', () => {
  db.prepare('DELETE FROM container_metrics').run();
  const insert = db.prepare('INSERT INTO container_metrics(container_id, metric_type, value, unit, timestamp) VALUES(?, ?, ?, ?, ?)');
  insert.run('container-zero', 'cpu', 1, '%', 0);
  insert.run('container-zero', 'cpu', 2, '%', 1);
  const rows = queryHistoricalMetrics({ containerId: 'container-zero', metricType: 'cpu', startTime: 0, endTime: 0, aggregation: 0 });
  assert.deepEqual(rows.map((row) => row.value), [1]);
});

test('metrics: 移动平均基线为 0 时不产生 NaN', () => {
  const metrics = Array.from({ length: 10 }, (_, index) => ({ container_id: 'zero-base', metric_type: 'cpu', value: 0, timestamp: index }));
  metrics.push({ container_id: 'zero-base', metric_type: 'cpu', value: 1, timestamp: 10 });
  const anomalies = detectAnomalies(metrics, ['moving_average']);
  assert.equal(anomalies.length, 1);
  assert.equal(Number.isFinite(anomalies[0].deviation), true);
});
