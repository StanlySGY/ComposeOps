import db from '../lib/db.js';

export const HOST_RESOURCE = 'host';
export const serviceResource = (projectId, service) => `service:${projectId}:${service}`;
export const diskResource = disk => `disk:${disk.device}:${disk.type}`;

export function saveInfrastructureMetrics(hostId, resourceId, values, timestamp) {
  const insert = db.prepare('INSERT INTO infrastructure_metrics(host_id, container_id, metric_type, value, unit, timestamp) VALUES(?,?,?,?,?,?)');
  db.transaction(() => {
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const unit = /Percent$|^cpu$|^memory$/.test(key) ? '%' : /Rate$|^rx$|^tx$/.test(key) ? 'bytes/s' : 'bytes';
      insert.run(hostId, resourceId, key, value, unit, timestamp);
    }
  })();
}

export function infrastructureHistory(hostId, { resource = HOST_RESOURCE, metric = 'cpu', hours = 1, now = Date.now() } = {}) {
  const duration = Math.min(24 * 30, Math.max(.25, Number(hours) || 1)) * 3600000;
  const step = duration <= 3600000 && !resource.startsWith('disk:') ? 10000 : duration <= 86400000 ? 60000 : 300000;
  const start = now - duration;
  const rows = db.prepare(`SELECT CAST(timestamp / ? AS INTEGER) * ? AS timestamp,
    SUM(COALESCE(value_sum,value)) / SUM(sample_count) AS value,
    MIN(COALESCE(value_min,value)) AS min, MAX(COALESCE(value_max,value)) AS max,
    SUM(sample_count) AS samples, MIN(unit) AS unit,
    MIN(COALESCE(range_start,timestamp)) AS firstSample, MAX(COALESCE(range_end,timestamp)) AS lastSample
    FROM infrastructure_metrics WHERE host_id=? AND container_id=? AND metric_type=? AND timestamp>=? AND timestamp<=?
    GROUP BY CAST(timestamp / ? AS INTEGER) ORDER BY timestamp`).all(step, step, hostId, resource, metric, start, now, step);
  return { hostId, resource, metric, start, end: now, interval: step, points: rows };
}

export function capacityForecast(hostId, disk, now = Date.now()) {
  const { points } = infrastructureHistory(hostId, { resource: diskResource(disk), metric: 'used', hours: 24, now });
  if (points.length < 60 || points.at(-1).timestamp - points[0].timestamp < 6 * 3600000) return null;
  const first = points.slice(0, 10).reduce((n, p) => n + p.value, 0) / 10;
  const last = points.slice(-10).reduce((n, p) => n + p.value, 0) / 10;
  const rate = (last - first) / (points.at(-1).timestamp - points[0].timestamp);
  if (rate <= 0 || points.some((p, i) => i && p.timestamp - points[i - 1].timestamp > 3600000)) return null;
  const hours = disk.free / rate / 3600000;
  return hours <= 24 * 90 ? { hours: Math.round(hours), confidence: 'low', label: '按最近一天增长估算；实际写入可能变化' } : null;
}
