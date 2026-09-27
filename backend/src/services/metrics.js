import db from '../lib/db.js';

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
 * 聚合历史指标数据
 */
function aggregateMetrics(metrics, intervalSeconds) {
  if (intervalSeconds <= 2) return metrics; // 返回原始数据

  const buckets = new Map();
  
  for (const metric of metrics) {
    const intervalMs = intervalSeconds * 1000;
    const bucketTimestamp = Math.floor(metric.timestamp / intervalMs) * intervalMs;
    const key = `${metric.container_id}-${metric.metric_type}-${bucketTimestamp}`;
    
    if (!buckets.has(key)) {
      buckets.set(key, {
        container_id: metric.container_id,
        metric_type: metric.metric_type,
        values: [],
        timestamp: bucketTimestamp,
        unit: metric.unit,
      });
    }
    
    buckets.get(key).values.push(metric.value);
  }

  // 计算每个桶的平均值
  return Array.from(buckets.values()).map(bucket => ({
    container_id: bucket.container_id,
    metric_type: bucket.metric_type,
    value: bucket.values.reduce((sum, v) => sum + v, 0) / bucket.values.length,
    unit: bucket.unit,
    timestamp: bucket.timestamp,
    sample_count: bucket.values.length,
  }));
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
export function queryHistoricalMetrics({
  containerId,
  metricType,
  startTime,
  endTime,
  aggregation = 'auto',
}) {
  const params = [];
  let query = 'SELECT container_id, metric_type, value, unit, timestamp FROM container_metrics WHERE 1=1';

  if (containerId) {
    query += ' AND container_id = ?';
    params.push(containerId);
  }

  if (metricType) {
    query += ' AND metric_type = ?';
    params.push(metricType);
  }

  const hasStartTime = startTime !== undefined && startTime !== null && Number.isFinite(Number(startTime));
  const hasEndTime = endTime !== undefined && endTime !== null && Number.isFinite(Number(endTime));
  if (hasStartTime) {
    query += ' AND timestamp >= ?';
    params.push(Number(startTime));
  }

  if (hasEndTime) {
    query += ' AND timestamp <= ?';
    params.push(Number(endTime));
  }

  query += ' ORDER BY timestamp ASC';

  const metrics = db.prepare(query).all(...params);

  // 自动聚合
  if (aggregation === 'auto' && hasStartTime && hasEndTime) {
    const timeRange = Number(endTime) - Number(startTime);
    const { interval } = getAggregationInterval(timeRange);
    return aggregateMetrics(metrics, interval);
  }

  // 手动指定聚合间隔
  if (typeof aggregation === 'number' && aggregation > 2) {
    return aggregateMetrics(metrics, aggregation);
  }

  return metrics;
}

/**
 * 获取容器指标统计信息
 */
export function getMetricsStats(containerId, metricType, hours = 24) {
  const endTime = Date.now();
  const startTime = endTime - hours * 3600 * 1000;

  const metrics = queryHistoricalMetrics({
    containerId,
    metricType,
    startTime,
    endTime,
  });

  if (metrics.length === 0) {
    return null;
  }

  const values = metrics.map(m => m.value);
  const sum = values.reduce((acc, v) => acc + v, 0);
  const mean = sum / values.length;
  const sortedValues = [...values].sort((a, b) => a - b);
  const min = sortedValues[0];
  const max = sortedValues[sortedValues.length - 1];
  const median = sortedValues[Math.floor(sortedValues.length / 2)];
  const p95 = sortedValues[Math.floor(sortedValues.length * 0.95)];
  const p99 = sortedValues[Math.floor(sortedValues.length * 0.99)];

  return {
    count: metrics.length,
    mean,
    median,
    min,
    max,
    p95,
    p99,
    unit: metrics[0].unit,
    timeRange: {
      start: startTime,
      end: endTime,
      hours,
    },
  };
}

/**
 * 数据保留策略
 * - 2秒原始数据保留7天
 * - 超过7天的数据聚合为5分钟粒度后删除原始数据
 */
export function applyRetentionPolicy() {
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 3600 * 1000;

  // 删除超过30天的聚合数据
  const deleted30d = db.prepare(
    'DELETE FROM container_metrics WHERE timestamp < ?'
  ).run(thirtyDaysAgo);

  // 对7-30天的数据进行聚合并删除原始数据
  const oldMetrics = db.prepare(
    'SELECT DISTINCT container_id, metric_type FROM container_metrics WHERE timestamp < ? AND timestamp >= ?'
  ).all(sevenDaysAgo, thirtyDaysAgo);

  for (const { container_id, metric_type } of oldMetrics) {
    const metrics = queryHistoricalMetrics({
      containerId: container_id,
      metricType: metric_type,
      startTime: thirtyDaysAgo,
      endTime: sevenDaysAgo,
      aggregation: 300, // 5分钟聚合
    });

    // 删除原始数据
    db.prepare(
      'DELETE FROM container_metrics WHERE container_id = ? AND metric_type = ? AND timestamp < ? AND timestamp >= ?'
    ).run(container_id, metric_type, sevenDaysAgo, thirtyDaysAgo);

    // 插入聚合后的数据
    const insert = db.prepare(
      'INSERT INTO container_metrics(container_id, metric_type, value, unit, timestamp) VALUES(?, ?, ?, ?, ?)'
    );
    for (const metric of metrics) {
      insert.run(metric.container_id, metric.metric_type, metric.value, metric.unit, metric.timestamp);
    }
  }

  return {
    deleted30d: deleted30d.changes,
    aggregatedPeriod: '7-30 days',
  };
}

/**
 * 智能告警规则评估
 */
export function evaluateAlertRules(containerId) {
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
    const stats = getMetricsStats(containerId, rule.metricType, 1); // 最近1小时
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
