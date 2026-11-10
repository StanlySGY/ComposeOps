import { setImmediate as yieldToLoop } from 'node:timers/promises';

const BUCKET_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** Compact complete historical buckets once. Each batch is atomic so an
 * interruption cannot leave a series deleted without its replacement values. */
export async function compactMetrics(database, now = Date.now()) {
  const oldest = now - 30 * DAY_MS;
  const start = Math.ceil(oldest / BUCKET_MS) * BUCKET_MS;
  const end = Math.floor((now - 7 * DAY_MS) / BUCKET_MS) * BUCKET_MS;
  let deleted30d = 0;
  let compactedBuckets = 0;
  let compactedRows = 0;
  const deleteExpired = database.prepare(`DELETE FROM container_metrics WHERE id IN (
    SELECT id FROM container_metrics WHERE timestamp < ? LIMIT 2000
  )`);
  for (;;) {
    const deleted = deleteExpired.run(oldest).changes;
    deleted30d += deleted;
    if (deleted < 2000) break;
    await yieldToLoop();
  }

  const series = database.prepare(`SELECT DISTINCT host_id, container_id, metric_type FROM container_metrics
    WHERE timestamp >= ? AND timestamp < ?`).all(start, end);
  const buckets = database.prepare(`SELECT MIN(id) AS keeper,
      SUM(COALESCE(value_sum, value)) AS value_sum, SUM(sample_count) AS sample_count,
      MIN(COALESCE(value_min, value)) AS value_min, MAX(COALESCE(value_max, value)) AS value_max,
      MIN(COALESCE(range_start, timestamp)) AS range_start, MAX(COALESCE(range_end, timestamp)) AS range_end,
      MAX(stats_approximate) AS stats_approximate,
      CAST(timestamp / ${BUCKET_MS} AS INTEGER) * ${BUCKET_MS} AS bucket, COUNT(*) AS samples
    FROM container_metrics INDEXED BY idx_metrics_host_container
    WHERE host_id = ? AND container_id = ? AND metric_type = ? AND timestamp >= ? AND timestamp < ?
    GROUP BY CAST(timestamp / ${BUCKET_MS} AS INTEGER) HAVING COUNT(*) > 1 LIMIT 500`);
  const update = database.prepare('UPDATE container_metrics SET value = ?, timestamp = ?, sample_count = ?, value_sum = ?, value_min = ?, value_max = ?, range_start = ?, range_end = ?, stats_approximate = ? WHERE id = ?');
  // Without this hint SQLite can choose metric_type/time and scan every
  // container's CPU series again for each individual container/bucket.
  const remove = database.prepare(`DELETE FROM container_metrics INDEXED BY idx_metrics_host_container
    WHERE host_id = ? AND container_id = ? AND metric_type = ? AND timestamp >= ? AND timestamp < ? AND id != ?`);
  const compactBatch = (hostId, containerId, metricType) => {
    // Reserve the writer before reading the bucket to avoid a read-to-write
    // upgrade race against the collector on the main connection.
    database.exec('BEGIN IMMEDIATE');
    try {
      const batch = buckets.all(hostId, containerId, metricType, start, end);
      let removed = 0;
      for (const metric of batch) {
        update.run(metric.value_sum / metric.sample_count, metric.bucket, metric.sample_count, metric.value_sum, metric.value_min, metric.value_max, metric.range_start, metric.range_end, metric.stats_approximate, metric.keeper);
        removed += remove.run(hostId, containerId, metricType, metric.bucket, metric.bucket + BUCKET_MS, metric.keeper).changes;
      }
      database.exec('COMMIT');
      return { buckets: batch.length, removed };
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  };
  for (const { host_id, container_id, metric_type } of series) {
    for (;;) {
      const batch = compactBatch(host_id, container_id, metric_type);
      compactedBuckets += batch.buckets;
      compactedRows += batch.removed;
      await yieldToLoop();
      if (batch.buckets < 500) break;
    }
  }
  return { deleted30d, aggregatedPeriod: '7-30 days', compactedBuckets, compactedRows };
}
