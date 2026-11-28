import { setTimeout as pauseBetweenBatches } from 'node:timers/promises';

const BUCKET_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const BUCKET_BATCH = 32;
const DISCOVERY_BATCH = 500;
const DELETE_BATCH = 500;
const WRITE_BATCH_MS = 25;

/** Compact complete historical buckets once. Each batch is atomic so an
 * interruption cannot leave a series deleted without its replacement values. */
export async function compactMetrics(database, now = Date.now(), infrastructure = false) {
  const table = infrastructure ? "infrastructure_metrics" : "container_metrics";
  const index = infrastructure ? "idx_infrastructure_host_resource" : "idx_metrics_host_container";
  const oldest = now - 30 * DAY_MS;
  const start = Math.ceil(oldest / BUCKET_MS) * BUCKET_MS;
  const end = Math.floor((now - (infrastructure ? 1 : 7) * DAY_MS) / BUCKET_MS) * BUCKET_MS;
  let deleted30d = 0;
  let compactedBuckets = 0;
  let compactedRows = 0;
  const deleteExpired = database.prepare(`DELETE FROM ${table} WHERE id IN (
    SELECT id FROM ${table} WHERE timestamp < ? LIMIT ${DELETE_BATCH}
  )`);
  for (;;) {
    const deleted = deleteExpired.run(oldest).changes;
    deleted30d += deleted;
    if (deleted < DELETE_BATCH) break;
    await pauseBetweenBatches(5);
  }

  const series = database.prepare(`SELECT DISTINCT host_id, container_id, metric_type FROM ${table}
    WHERE timestamp >= ? AND timestamp < ?`).all(start, end);
  // Discover candidates without reserving the writer. A mostly compacted
  // multi-GB series can take seconds to scan even when no bucket needs work.
  const candidates = database.prepare(`SELECT CAST(timestamp / ${BUCKET_MS} AS INTEGER) * ${BUCKET_MS} AS bucket
    FROM ${table} INDEXED BY ${index}
    WHERE host_id = ? AND container_id = ? AND metric_type = ? AND timestamp >= ? AND timestamp < ?
    GROUP BY CAST(timestamp / ${BUCKET_MS} AS INTEGER) HAVING COUNT(*) > 1 ORDER BY bucket LIMIT ${DISCOVERY_BATCH}`);
  const readBucket = database.prepare(`SELECT MIN(id) AS keeper,
      SUM(COALESCE(value_sum, value)) AS value_sum, SUM(sample_count) AS sample_count,
      MIN(COALESCE(value_min, value)) AS value_min, MAX(COALESCE(value_max, value)) AS value_max,
      MIN(COALESCE(range_start, timestamp)) AS range_start, MAX(COALESCE(range_end, timestamp)) AS range_end,
      MAX(stats_approximate) AS stats_approximate, COUNT(*) AS samples
    FROM ${table} INDEXED BY ${index}
    WHERE host_id = ? AND container_id = ? AND metric_type = ? AND timestamp >= ? AND timestamp < ?`);
  const update = database.prepare(`UPDATE ${table} SET value = ?, timestamp = ?, sample_count = ?, value_sum = ?, value_min = ?, value_max = ?, range_start = ?, range_end = ?, stats_approximate = ? WHERE id = ?`);
  // Without this hint SQLite can choose metric_type/time and scan every
  // container's CPU series again for each individual container/bucket.
  const remove = database.prepare(`DELETE FROM ${table} INDEXED BY ${index}
    WHERE host_id = ? AND container_id = ? AND metric_type = ? AND timestamp >= ? AND timestamp < ? AND id != ?`);
  const compactBatch = (hostId, containerId, metricType, selected) => {
    // Re-read each narrow bucket after reserving the writer. Arrivals after
    // discovery must be included in both aggregate values and deleted rows.
    database.exec('BEGIN IMMEDIATE');
    try {
      const started = performance.now();
      let removed = 0, buckets = 0, visited = 0, next;
      for (const { bucket } of selected) {
        const metric = readBucket.get(hostId, containerId, metricType, bucket, bucket + BUCKET_MS);
        if (metric.samples > 1) {
          update.run(metric.value_sum / metric.sample_count, bucket, metric.sample_count, metric.value_sum, metric.value_min, metric.value_max, metric.range_start, metric.range_end, metric.stats_approximate, metric.keeper);
          removed += remove.run(hostId, containerId, metricType, bucket, bucket + BUCKET_MS, metric.keeper).changes;
          buckets++;
        }
        next = bucket + BUCKET_MS;
        visited++;
        if (performance.now() - started >= WRITE_BATCH_MS) break;
      }
      database.exec('COMMIT');
      return { buckets, removed, next, visited };
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  };
  for (const { host_id, container_id, metric_type } of series) {
    let cursor = start;
    while (cursor < end) {
      const selected = candidates.all(host_id, container_id, metric_type, cursor, end);
      if (!selected.length) break;
      // Discovery reads a larger bounded window; split only the writes so a
      // dense backlog is not re-scanned for every tiny transaction.
      for (let offset = 0; offset < selected.length;) {
        const batch = compactBatch(host_id, container_id, metric_type, selected.slice(offset, offset + BUCKET_BATCH));
        compactedBuckets += batch.buckets;
        compactedRows += batch.removed;
        cursor = batch.next;
        offset += batch.visited;
        // Give the foreground connection a real opportunity to write between
        // short transactions, rather than immediately reacquiring the same lock.
        await pauseBetweenBatches(5);
      }
    }
  }
  return { deleted30d, aggregatedPeriod: '7-30 days', compactedBuckets, compactedRows };
}
