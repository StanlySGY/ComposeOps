import db from '../lib/db.js';
import { Worker } from 'node:worker_threads';
import { compactMetrics } from './metrics-retention.js';

/**
 * 数据聚合策略：根据时间范围自动选择合适的聚合粒度
 * - 最近1小时：2秒原始数据
 * - 1-6小时：10秒聚合
 * - 6小时-1天：1分钟聚合
 * - 1天以上：5分钟聚合
 */
function getAggregationInterval(timeRangeMs) {
  const hours = timeRangeMs / (1000 * 60 * 60);
  if (hours <= 1) return { interval: 2, unit: 'second' };
  if (hours <= 6) return { interval: 10, unit: 'second' };
  if (hours <= 24) return { interval: 60, unit: 'second' };
  return { interval: 300, unit: 'second' };
}

/**
 * Z-Score 异常检测算法
 * 标准差超过3倍认为是异常点
 */
function detectAnomaliesZScore(metrics, threshold = 3) {
  if (metrics.length < 10) return []; // 样本太少无法检测

  const values = metrics.map(m => m.value);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return []; // 无变化，无异常

  const anomalies = [];
  for (let i = 0; i < metrics.length; i++) {
    const zScore = Math.abs((metrics[i].value - mean) / stdDev);
    if (zScore > threshold) {
      anomalies.push({
        ...metrics[i],
        anomaly_type: 'z_score',
        score: zScore,
        threshold,
        mean,
        stdDev,
      });
    }
  }

  return anomalies;
}

/**
 * 移动平均异常检测
 * 当前值与移动平均值偏差超过阈值百分比时报警
 */
function detectAnomaliesMovingAverage(metrics, windowSize = 10, deviationThreshold = 0.3) {
  if (metrics.length < windowSize) return [];

  const anomalies = [];
  
  for (let i = windowSize; i < metrics.length; i++) {
    const window = metrics.slice(i - windowSize, i);
    const movingAvg = window.reduce((sum, m) => sum + m.value, 0) / windowSize;
    const currentValue = metrics[i].value;
    const deviation = movingAvg === 0
      ? (currentValue === 0 ? 0 : 1)
      : Math.abs(currentValue - movingAvg) / Math.abs(movingAvg);

    if (deviation > deviationThreshold) {
      anomalies.push({
        ...metrics[i],
        anomaly_type: 'moving_average',
        deviation,
        movingAvg,
        threshold: deviationThreshold,
      });
    }
  }

  return anomalies;
}

/**
 * 趋势异常检测
 * 检测急剧上升或下降的趋势
 */
function detectAnomaliesTrend(metrics, windowSize = 5, slopeThreshold = 0.5) {
  if (metrics.length < windowSize * 2) return [];

  const anomalies = [];

  for (let i = windowSize; i < metrics.length - windowSize; i++) {
    const prevWindow = metrics.slice(i - windowSize, i);
    const nextWindow = metrics.slice(i, i + windowSize);
    
    const prevAvg = prevWindow.reduce((sum, m) => sum + m.value, 0) / windowSize;
    const nextAvg = nextWindow.reduce((sum, m) => sum + m.value, 0) / windowSize;
    
    if (prevAvg === 0) continue;
    
    const slope = (nextAvg - prevAvg) / prevAvg;

    if (Math.abs(slope) > slopeThreshold) {
      anomalies.push({
        ...metrics[i],
        anomaly_type: 'trend',
        slope,
        direction: slope > 0 ? 'increasing' : 'decreasing',
        threshold: slopeThreshold,
        prevAvg,
        nextAvg,
      });
    }
  }

  return anomalies;
}

/**
 * 综合异常检测
 */
export function detectAnomalies(metrics, algorithms = ['z_score', 'moving_average', 'trend']) {
  const anomalyMap = new Map();

  if (algorithms.includes('z_score')) {
    const zScoreAnomalies = detectAnomaliesZScore(metrics);
    for (const anomaly of zScoreAnomalies) {
      const key = `${anomaly.container_id}-${anomaly.timestamp}`;
      if (!anomalyMap.has(key)) {
        anomalyMap.set(key, { ...anomaly, algorithms: [] });
      }
      anomalyMap.get(key).algorithms.push('z_score');
      anomalyMap.get(key).z_score_details = {
        score: anomaly.score,
        threshold: anomaly.threshold,
        mean: anomaly.mean,
        stdDev: anomaly.stdDev,
      };
    }
  }

  if (algorithms.includes('moving_average')) {
    const maAnomalies = detectAnomaliesMovingAverage(metrics);
    for (const anomaly of maAnomalies) {
      const key = `${anomaly.container_id}-${anomaly.timestamp}`;
      if (!anomalyMap.has(key)) {
        anomalyMap.set(key, { ...anomaly, algorithms: [] });
      }
      anomalyMap.get(key).algorithms.push('moving_average');
      anomalyMap.get(key).moving_average_details = {
        deviation: anomaly.deviation,
        movingAvg: anomaly.movingAvg,
        threshold: anomaly.threshold,
      };
    }
  }

  if (algorithms.includes('trend')) {
    const trendAnomalies = detectAnomaliesTrend(metrics);
    for (const anomaly of trendAnomalies) {
      const key = `${anomaly.container_id}-${anomaly.timestamp}`;
      if (!anomalyMap.has(key)) {
        anomalyMap.set(key, { ...anomaly, algorithms: [] });
      }
      anomalyMap.get(key).algorithms.push('trend');
      anomalyMap.get(key).trend_details = {
        slope: anomaly.slope,
        direction: anomaly.direction,
        threshold: anomaly.threshold,
        prevAvg: anomaly.prevAvg,
        nextAvg: anomaly.nextAvg,
      };
    }
  }

  return Array.from(anomalyMap.values()).sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * 查询历史指标数据
 */
function metricFilter({ containerId, hostId, metricType, startTime, endTime }) {
  const clauses = ['1=1']; const params = [];
  for (const [column, value] of [['host_id', hostId], ['container_id', containerId], ['metric_type', metricType]]) {
    if (value) { clauses.push(`${column} = ?`); params.push(value); }
  }
  const hasStart = startTime != null && Number.isFinite(Number(startTime));
  const hasEnd = endTime != null && Number.isFinite(Number(endTime));
  if (hasStart) {
    // Retained buckets use their start timestamp; include a partial bucket then flag its uncertainty.
    clauses.push('timestamp >= ? AND COALESCE(range_end, timestamp) >= ?');
    params.push(Number(startTime) - 300000, Number(startTime));
  }
  if (hasEnd) { clauses.push('timestamp <= ? AND COALESCE(range_start, timestamp) <= ?'); params.push(Number(endTime), Number(endTime)); }
  return { where: clauses.join(' AND '), params, hasStart, hasEnd };
}

export function queryHistoricalMetrics(options) {
  const { startTime, endTime, aggregation = 'auto' } = options;
  const { where, params, hasStart, hasEnd } = metricFilter(options);
  const interval = aggregation === 'auto' && hasStart && hasEnd
    ? getAggregationInterval(Number(endTime) - Number(startTime)).interval
    : (typeof aggregation === 'number' && Number.isFinite(aggregation) ? aggregation : 0);
  const approximation = ['stats_approximate', ...(hasStart ? [`COALESCE(range_start, timestamp) < ${Number(startTime)}`] : []), ...(hasEnd ? [`COALESCE(range_end, timestamp) > ${Number(endTime)}`] : [])].join(' OR ');
  if (interval <= 2) return db.prepare(`SELECT host_id, container_id, metric_type, value, unit, timestamp,
    sample_count, COALESCE(value_sum, value) AS value_sum, COALESCE(value_min, value) AS value_min,
    COALESCE(value_max, value) AS value_max, (${approximation}) AS stats_approximate FROM container_metrics WHERE ${where} ORDER BY timestamp`).all(...params);
  // Only aggregated points cross the SQLite/JS boundary, never the entire raw window.
  const bucket = Math.max(1, Math.floor(interval * 1000));
  return db.prepare(`SELECT host_id, container_id, metric_type, unit,
    CAST(timestamp / ${bucket} AS INTEGER) * ${bucket} AS timestamp,
    SUM(COALESCE(value_sum, value)) / SUM(sample_count) AS value,
    SUM(COALESCE(value_sum, value)) AS value_sum, SUM(sample_count) AS sample_count,
    MIN(COALESCE(value_min, value)) AS value_min, MAX(COALESCE(value_max, value)) AS value_max,
    MAX(${approximation}) AS stats_approximate
    FROM container_metrics WHERE ${where}
    GROUP BY host_id, container_id, metric_type, CAST(timestamp / ${bucket} AS INTEGER) ORDER BY timestamp`).all(...params);
}

/** Raw windows have exact quantiles; retained buckets use weighted means and explicitly report approximation. */
export function getMetricsStats(containerId, metricType, hours = 24, hostId) {
  const endTime = Date.now(); const startTime = endTime - hours * 3600000;
  const { where, params } = metricFilter({ containerId, metricType, hostId, startTime, endTime });
  const stats = db.prepare(`SELECT SUM(sample_count) AS count,
    SUM(COALESCE(value_sum, value)) / SUM(sample_count) AS mean,
    MIN(COALESCE(value_min, value)) AS min, MAX(COALESCE(value_max, value)) AS max,
    MIN(unit) AS unit, MAX(stats_approximate) AS legacy,
    MAX(sample_count > 1) AS compacted,
    MAX(COALESCE(range_start, timestamp) < ? OR COALESCE(range_end, timestamp) > ?) AS partial
    FROM container_metrics WHERE ${where}`).get(startTime, endTime, ...params);
  if (!stats.count) return null;
  // Window functions sort inside SQLite; only three quantiles return to JS.
  const quantiles = db.prepare(`WITH distribution AS (
      SELECT value, SUM(sample_count) AS weight FROM container_metrics WHERE ${where} GROUP BY value
    ), ordered AS (
      SELECT value, SUM(weight) OVER (ORDER BY value ROWS UNBOUNDED PRECEDING) AS cumulative FROM distribution
    ) SELECT MIN(CASE WHEN cumulative > ? THEN value END) AS median,
      MIN(CASE WHEN cumulative > ? THEN value END) AS p95,
      MIN(CASE WHEN cumulative > ? THEN value END) AS p99 FROM ordered`)
    .get(...params, Math.floor(stats.count * .5), Math.floor(stats.count * .95), Math.floor(stats.count * .99));
  return {
    count: stats.count, mean: stats.mean, min: stats.min, max: stats.max, ...quantiles, unit: stats.unit,
    approximation: { quantiles: !!(stats.compacted || stats.legacy || stats.partial),
      aggregates: !!(stats.legacy || stats.partial), legacy: !!stats.legacy, partialWindow: !!stats.partial },
    quantileMethod: stats.compacted || stats.legacy ? 'weighted-bucket-means' : 'raw-order-statistic',
    timeRange: { start: startTime, end: endTime, hours },
  };
}

/**
 * 数据保留策略
 * - 2秒原始数据保留7天
 * - 超过7天的数据聚合为5分钟粒度后删除原始数据
 */
let retentionInFlight;
export function applyRetentionPolicy() {
  if (retentionInFlight) return retentionInFlight;
  const databasePath = db.pragma('database_list').find(row => row.name === 'main')?.file;
  const task = databasePath ? new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./metrics-retention-worker.js', import.meta.url), { workerData: { databasePath, now: Date.now() } });
    let received = false;
    worker.once('message', response => {
      received = true;
      if (response.error) reject(new Error(response.error));
      else resolve(response.result);
    });
    worker.once('error', reject);
    worker.once('exit', code => { if (!received) reject(new Error(`指标保留任务提前退出 (${code})`)); });
  }) : compactMetrics(db); // In-memory databases are only used by isolated tests.
  retentionInFlight = task.finally(() => { retentionInFlight = null; });
  return retentionInFlight;
}

/**
 * 智能告警规则评估
 */
export function evaluateAlertRules(containerId, hostId) {
  const rules = [
    {
      name: 'cpu_high',
      metricType: 'cpu',
      condition: (stats) => stats && stats.p95 > 80,
      message: (stats) => `CPU使用率持续偏高（P95: ${stats.p95.toFixed(1)}%）`,
      priority: 'warning',
    },
    {
      name: 'cpu_critical',
      metricType: 'cpu',
      condition: (stats) => stats && stats.mean > 90,
      message: (stats) => `CPU使用率严重过高（平均: ${stats.mean.toFixed(1)}%）`,
      priority: 'critical',
    },
    {
      name: 'memory_high',
      metricType: 'memory',
      condition: (stats) => stats && stats.p95 > 85,
      message: (stats) => `内存使用率持续偏高（P95: ${stats.p95.toFixed(1)}%）`,
      priority: 'warning',
    },
    {
      name: 'memory_critical',
      metricType: 'memory',
      condition: (stats) => stats && stats.mean > 95,
      message: (stats) => `内存使用率接近上限（平均: ${stats.mean.toFixed(1)}%）`,
      priority: 'critical',
    },
    {
      name: 'network_spike',
      metricType: 'network_rx',
      condition: (stats) => stats && stats.max > stats.mean * 10,
      message: (stats) => `网络接收流量出现异常峰值（最大: ${(stats.max / 1024 / 1024).toFixed(1)}MB/s）`,
      priority: 'info',
    },
  ];

  const alerts = [];

  for (const rule of rules) {
    const stats = getMetricsStats(containerId, rule.metricType, 1, hostId); // 最近1小时
    if (rule.condition(stats)) {
      alerts.push({
        rule: rule.name,
        message: rule.message(stats),
        priority: rule.priority,
        containerId,
        metricType: rule.metricType,
        stats,
        timestamp: Math.floor(Date.now() / 1000),
      });
    }
  }

  return alerts;
}

export function previewRetentionPolicy(now = Date.now()) {
  const day = 24 * 3600 * 1000;
  const deleted30d = db.prepare('SELECT COUNT(*) AS n FROM container_metrics WHERE timestamp < ?').get(now - 30 * day).n;
  const compactedRows = db.prepare('SELECT COUNT(*) AS n FROM container_metrics WHERE timestamp >= ? AND timestamp < ?').get(now - 30 * day, now - 7 * day).n;
  return { deleted30d, compactedRows, rawDays: 7, totalDays: 30, aggregateSeconds: 300 };
}
