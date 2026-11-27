#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = await mkdtemp(path.join(tmpdir(), 'metric-history-acceptance-'));
process.env.DB_PATH = path.join(root, 'fixture.db'); process.env.DISABLE_BACKGROUND_JOBS = '1';
const { default: db } = await import('../backend/src/lib/db.js');
const { queryHistoricalMetricWindow, getMetricsStats } = await import('../backend/src/services/metrics.js');
try {
  const now = Date.now(), start = now - 29 * 86400000, total = 120000;
  const insert = db.prepare('INSERT INTO container_metrics(host_id,container_id,metric_type,value,unit,timestamp) VALUES(?,?,?,?,?,?)');
  const begin = performance.now();
  db.transaction(() => {
    for (let i = 0; i < total; i++) insert.run('local', 'fixture', 'cpu', i % 100, '%', start + Math.floor((now - start) * i / (total - 1)));
    insert.run('other-host', 'fixture', 'cpu', 9999, '%', now);
  })();
  const insertMs = Math.round(performance.now() - begin), samples = [];
  for (const aggregation of [0, 'auto', 3600]) {
    const begin = performance.now();
    const { metrics, sampling } = queryHistoricalMetricWindow({ hostId: 'local', containerId: 'fixture', metricType: 'cpu', startTime: start, endTime: now, aggregation });
    assert.ok(metrics.length <= 2000); assert.equal(sampling.sourceSamples, total);
    assert.equal(metrics.reduce((sum, row) => sum + row.value_sum, 0), total * 49.5);
    assert.equal(Math.max(...metrics.map(row => row.value_max)), 99);
    assert.equal(metrics.at(-1).value_max, 99);
    samples.push({ requestedAggregation: aggregation, points: metrics.length, sourceSamples: sampling.sourceSamples, aggregationSeconds: sampling.aggregationSeconds, elapsedMs: Math.round(performance.now() - begin) });
  }
  const statsStart = performance.now(), stats = getMetricsStats('fixture', 'cpu', 30 * 24, 'local');
  assert.equal(stats.count, total); assert.equal(stats.mean, 49.5); assert.equal(stats.max, 99);
  console.log(JSON.stringify({ passed: true, isolatedRows: total + 1, insertMs, queries: samples, statsMs: Math.round(performance.now() - statsStart), exactWeightAndPeak: true, crossHostExcluded: true, productionDataChanged: false }));
} finally { db.close(); await rm(root, { recursive: true, force: true }); }
