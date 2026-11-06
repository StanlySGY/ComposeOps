import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';
import Fastify from 'fastify';
import { compactMetrics } from '../src/services/metrics-retention.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-retention-'));
process.env.DB_PATH = path.join(directory, 'test.db');
const { default: db } = await import('../src/lib/db.js');
const { applyRetentionPolicy } = await import('../src/services/metrics.js');
const { default: metricsRoutes } = await import('../src/routes/metrics.js');
const DAY = 86400000;
const BUCKET = 300000;
const now = Date.UTC(2026, 10, 6, 10, 2);
const oldBucket = Math.floor((now - 10 * DAY) / BUCKET) * BUCKET;
const insert = db.prepare('INSERT INTO container_metrics(container_id, metric_type, value, unit, timestamp) VALUES(?,?,?,?,?)');
const rows = () => db.prepare('SELECT id, container_id, metric_type, value, unit, timestamp FROM container_metrics ORDER BY id').all();
beforeEach(() => { db.exec('DROP TRIGGER IF EXISTS reject_retention; DELETE FROM container_metrics'); });
after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('retention compacts full buckets atomically and does not rewrite them again', async () => {
  insert.run('app', 'cpu', 10, '%', oldBucket + 1000);
  insert.run('app', 'cpu', 30, '%', oldBucket + 2000);
  insert.run('other', 'cpu', 90, '%', oldBucket + 1000);
  insert.run('app', 'memory', 70, '%', oldBucket + 1000);
  insert.run('app', 'cpu', 50, '%', now - DAY);
  insert.run('expired', 'cpu', 100, '%', now - 31 * DAY);
  const result = await compactMetrics(db, now);
  assert.equal(result.deleted30d, 1);
  assert.equal(result.compactedBuckets, 1);
  assert.equal(result.compactedRows, 1);
  const retained = rows();
  assert.equal(retained.length, 4);
  assert.equal(retained[0].value, 20);
  assert.equal(retained[0].timestamp, oldBucket);
  const again = await compactMetrics(db, now);
  assert.equal(again.compactedRows, 0);
  assert.equal(again.compactedBuckets, 0);
  assert.deepEqual(rows(), retained);
});

test('retention waits for the full seven-day boundary bucket before averaging', async () => {
  const boundary = Math.floor((now - 7 * DAY) / BUCKET) * BUCKET;
  insert.run('app', 'cpu', 10, '%', boundary + 1000);
  insert.run('app', 'cpu', 20, '%', boundary + 3000);
  insert.run('app', 'cpu', 90, '%', boundary + 180000);
  const original = rows();
  assert.equal((await compactMetrics(db, now)).compactedBuckets, 0);
  assert.deepEqual(rows(), original);
  assert.equal((await compactMetrics(db, now + BUCKET)).compactedBuckets, 1);
  assert.equal(rows()[0].value, 40);
});

test('retention failure rolls back both the updated average and removed samples', async () => {
  insert.run('app', 'cpu', 10, '%', oldBucket + 1000);
  insert.run('app', 'cpu', 30, '%', oldBucket + 2000);
  const original = rows();
  db.exec("CREATE TRIGGER reject_retention BEFORE DELETE ON container_metrics BEGIN SELECT RAISE(ABORT, 'test interrupted'); END");
  await assert.rejects(compactMetrics(db, now), /test interrupted/);
  assert.deepEqual(rows(), original);
  db.exec('DROP TRIGGER reject_retention');
  await compactMetrics(db, now);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].value, 20);
});

test('retention handles multiple bounded batches without merging containers or metric types', async () => {
  db.transaction(() => {
    for (let i = 0; i < 510; i++) {
      insert.run('app', 'cpu', i, '%', oldBucket + i * BUCKET + 1000);
      insert.run('app', 'cpu', i + 10, '%', oldBucket + i * BUCKET + 2000);
    }
    for (let i = 0; i < 2100; i++) insert.run('expired', 'cpu', 1, '%', now - 31 * DAY);
  })();
  const result = await compactMetrics(db, now);
  assert.equal(result.deleted30d, 2100);
  assert.equal(result.compactedBuckets, 510);
  assert.equal(rows().length, 510);
  assert.equal(rows()[509].value, 514);
});

test('retention worker shares concurrent requests and lets the main event loop respond', async () => {
  const timestamp = Date.now() - 10 * DAY;
  insert.run('app', 'cpu', 20, '%', timestamp);
  insert.run('app', 'cpu', 40, '%', timestamp + 1);
  const first = applyRetentionPolicy();
  assert.equal(first, applyRetentionPolicy());
  let responsive = false;
  setImmediate(() => { responsive = true; });
  const result = await first;
  assert.equal(responsive, true);
  assert.equal(result.compactedBuckets, 1);
  assert.equal(rows()[0].value, 30);
});

test('retention worker errors release the running gate so the task can be retried', async () => {
  const timestamp = Date.now() - 10 * DAY;
  insert.run('app', 'cpu', 20, '%', timestamp);
  insert.run('app', 'cpu', 40, '%', timestamp + 1);
  db.exec("CREATE TRIGGER reject_retention BEFORE DELETE ON container_metrics BEGIN SELECT RAISE(ABORT, 'test interrupted'); END");
  await assert.rejects(applyRetentionPolicy(), /test interrupted/);
  assert.equal(rows().length, 2);
  db.exec('DROP TRIGGER reject_retention');
  assert.equal((await applyRetentionPolicy()).compactedBuckets, 1);
});

test('retention API awaits the worker result before reporting success', async () => {
  const app = Fastify();
  try {
    await app.register(metricsRoutes);
    const response = await app.inject({ method: 'POST', url: '/retention-policy' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { success: true, result: { deleted30d: 0, aggregatedPeriod: '7-30 days', compactedBuckets: 0, compactedRows: 0 } });
  } finally { await app.close(); }
});
