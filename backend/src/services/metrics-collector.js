/**
 * 容器指标采集器
 * 
 * 后台定时采集容器资源指标并存储到数据库
 */

import { listHosts } from './docker-hosts.js';
import db from '../lib/db.js';
import { mapLimited, sampleContainers } from './container-sampler.js';
import { applyRetentionPolicy } from './metrics.js';
import { containerMetricValues } from '../lib/container-metric-values.js';

const collectionState = { promise: null };

/**
 * 采集所有运行中容器的指标
 */
export async function collectAllMetrics() {
  if (collectionState.promise) return { collected: 0, skipped: true, timestamp: Date.now() };
  const operation = mapLimited(listHosts(), 3, async host => {
    try {
      const sample = await sampleContainers(host.id);
      let collected = 0;
      for (const container of sample.containers) {
        if (!container.raw) continue;
        persistContainerMetrics(container.id, container.raw, host.id, container.sampledAt);
        collected++;
      }
      return { hostId: host.id, collected, ok: true };
    } catch { return { hostId: host.id, collected: 0, ok: false }; }
  }).then(hosts => ({ hosts, collected: hosts.reduce((count, host) => count + host.collected, 0), timestamp: Date.now() }));
  collectionState.promise = operation;
  return operation.finally(() => {
    if (collectionState.promise === operation) collectionState.promise = null;
  });
}

/** Missing counters remain absent in history; explicit zero samples are retained. */
export function parseContainerMetrics(containerId, stats = {}, timestamp = Date.now()) {
  const values = containerMetricValues(stats);
  const at = Number.isFinite(timestamp) ? timestamp : Date.now();
  return ['cpu', 'memory', 'network_rx', 'network_tx', 'disk_read', 'disk_write'].filter(type => values[type] !== null).map(type => ({
    container_id: containerId, metric_type: type, value: ['cpu', 'memory'].includes(type) && values[type] < Number.MAX_VALUE / 100 ? Math.round(values[type] * 100) / 100 : values[type],
    unit: ['cpu', 'memory'].includes(type) ? '%' : 'bytes', timestamp: at,
  }));
}

function persistContainerMetrics(containerId, stats, hostId, sampledAt) {
  const metrics = parseContainerMetrics(containerId, stats, sampledAt);

  // 批量插入数据库
  const insert = db.prepare(`
    INSERT INTO container_metrics(container_id, metric_type, value, unit, timestamp, host_id)
    VALUES(?, ?, ?, ?, ?, ?)
  `);
  
  const transaction = db.transaction(() => {
    for (const metric of metrics) {
      insert.run(
        metric.container_id,
        metric.metric_type,
        metric.value,
        metric.unit,
        metric.timestamp,
        hostId
      );
    }
  });
  
  transaction();
  return metrics.length;
}

/**
 * 清理过期的历史数据
 * @param {number} retentionDays - 保留天数
 */
export function pruneMetrics(retentionDays = 7) {
  const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  const result = db.prepare('DELETE FROM container_metrics WHERE timestamp < ?').run(cutoffTime);
  return { deleted: result.changes };
}

/**
 * 启动定时采集任务
 * @param {number} intervalSeconds - 采集间隔(秒)
 */
export function startMetricsCollection(intervalSeconds = 30) {
  const safeIntervalSeconds = Number.isFinite(Number(intervalSeconds))
    ? Math.max(5, Math.min(Number(intervalSeconds), 3600))
    : 30;
  // 立即执行一次
  collectAllMetrics().catch(error => {
    console.error('初始指标采集失败:', error.message);
  });
  
  // 定时采集
  const intervalId = setInterval(() => {
    collectAllMetrics().catch(error => {
      console.error('定时指标采集失败:', error.message);
    });
  }, safeIntervalSeconds * 1000);
  
  // 指标由独立 worker 清理；AI 历史统一由 maintenance 调度。
  const pruneIntervalId = setInterval(async () => {
    try {
      await applyRetentionPolicy();
    } catch (error) {
      console.error('清理过期指标失败:', error.message);
    }
  }, 60 * 60 * 1000);
  
  return { intervalId, pruneIntervalId };
}
