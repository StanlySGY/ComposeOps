/**
 * 容器指标采集器
 * 
 * 后台定时采集容器资源指标并存储到数据库
 */

import { getActivityDocker } from './docker-hosts.js';
import db, { pruneAiData } from '../lib/db.js';
import { getSetting, setSetting } from '../lib/db.js';
import { applyRetentionPolicy } from './metrics.js';

const collectionState = { promise: null };

/** 给一个 Promise 加超时,避免 Docker API 调用挂起时采集循环无限堆积。 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const STATS_TIMEOUT = 10000; // container.stats 单次最多等 10 秒

/**
 * 采集所有运行中容器的指标
 */
export async function collectAllMetrics() {
  if (collectionState.promise) return { collected: 0, skipped: true, timestamp: Date.now() };
  const operation = (async () => {
    try {
      const docker = await getActivityDocker();
      const containers = await docker.listContainers({ filters: { status: ['running'] } });

      const collected = [];
      for (const containerInfo of containers) {
        try {
          const metrics = await collectContainerMetrics(containerInfo.Id);
          collected.push({ container: containerInfo.Id, metrics });
        } catch (error) {
          console.error(`采集容器 ${containerInfo.Id} 指标失败:`, error.message);
        }
      }

      return { collected: collected.length, timestamp: Date.now() };
    } catch (error) {
      console.error('采集指标失败:', error.message);
      throw error;
    }
  })();
  collectionState.promise = operation;
  return operation.finally(() => {
    if (collectionState.promise === operation) collectionState.promise = null;
  });
}

/** 将 Docker stats 中的任意输入归一化为有限数字。 */
function finiteMetricNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeMetricNumber(value) {
  return Math.max(0, finiteMetricNumber(value));
}

function sumNonNegativeMetricValues(items, readValue) {
  return items.reduce((sum, item) => {
    const next = sum + nonNegativeMetricNumber(readValue(item));
    return Number.isFinite(next) ? next : Number.MAX_VALUE;
  }, 0);
}

/**
 * 将单个容器的 Docker stats 转换为可持久化指标。
 * Docker 在容器刚启动、禁用资源限制或不同存储驱动下可能省略部分字段。
 */
export function parseContainerMetrics(containerId, stats = {}, timestamp = Date.now()) {
  const source = stats && typeof stats === 'object' ? stats : {};
  const metricTimestamp = finiteMetricNumber(timestamp, Date.now());
  const metrics = [];

  // CPU 的首个 stats 样本可能没有可用的前一采样值,此时跳过而不是写入 NaN。
  const cpuStats = source.cpu_stats || {};
  const previousCpuStats = source.precpu_stats || {};
  const cpuDelta = finiteMetricNumber(cpuStats.cpu_usage?.total_usage)
    - finiteMetricNumber(previousCpuStats.cpu_usage?.total_usage);
  const systemDelta = finiteMetricNumber(cpuStats.system_cpu_usage)
    - finiteMetricNumber(previousCpuStats.system_cpu_usage);
  const onlineCpus = finiteMetricNumber(cpuStats.online_cpus, 1);
  if (systemDelta > 0 && onlineCpus > 0) {
    const cpuPercent = Math.max(0, (cpuDelta / systemDelta) * onlineCpus * 100);
    if (Number.isFinite(cpuPercent)) {
      metrics.push({
        container_id: containerId,
        metric_type: 'cpu',
        value: Math.round(cpuPercent * 100) / 100,
        unit: '%',
        timestamp: metricTimestamp
      });
    }
  }

  // 内存没有 limit 时不写入无意义的 Infinity;缓存字段缺失按 0 处理。
  const memoryStats = source.memory_stats || {};
  const memoryUsed = Math.max(0,
    finiteMetricNumber(memoryStats.usage) - finiteMetricNumber(memoryStats.stats?.cache));
  const memoryLimit = finiteMetricNumber(memoryStats.limit);
  if (memoryLimit > 0) {
    const memoryPercent = (memoryUsed / memoryLimit) * 100;
    if (Number.isFinite(memoryPercent)) {
      metrics.push({
        container_id: containerId,
        metric_type: 'memory',
        value: Math.round(memoryPercent * 100) / 100,
        unit: '%',
        timestamp: metricTimestamp
      });
    }
  }

  // 网络流量和磁盘 IO 即使缺失也保留 0 样本,便于趋势查询区分无数据与零流量。
  const networks = source.networks && typeof source.networks === 'object' ? source.networks : {};
  const networkValues = Object.values(networks);
  const rxBytes = sumNonNegativeMetricValues(networkValues, (network) => network?.rx_bytes);
  const txBytes = sumNonNegativeMetricValues(networkValues, (network) => network?.tx_bytes);

  metrics.push({
    container_id: containerId,
    metric_type: 'network_rx',
    value: rxBytes,
    unit: 'bytes',
    timestamp: metricTimestamp
  });

  metrics.push({
    container_id: containerId,
    metric_type: 'network_tx',
    value: txBytes,
    unit: 'bytes',
    timestamp: metricTimestamp
  });

  const blkio = Array.isArray(source.blkio_stats?.io_service_bytes_recursive)
    ? source.blkio_stats.io_service_bytes_recursive
    : [];
  const diskRead = sumNonNegativeMetricValues(
    blkio.filter((item) => String(item?.op || '').toLowerCase() === 'read'),
    (item) => item?.value
  );
  const diskWrite = sumNonNegativeMetricValues(
    blkio.filter((item) => String(item?.op || '').toLowerCase() === 'write'),
    (item) => item?.value
  );

  metrics.push({
    container_id: containerId,
    metric_type: 'disk_read',
    value: diskRead,
    unit: 'bytes',
    timestamp: metricTimestamp
  });

  metrics.push({
    container_id: containerId,
    metric_type: 'disk_write',
    value: diskWrite,
    unit: 'bytes',
    timestamp: metricTimestamp
  });

  return metrics;
}

/**
 * 采集单个容器的指标
 */
async function collectContainerMetrics(containerId) {
  const docker = await getActivityDocker();
  const container = docker.getContainer(containerId);
  const stats = await withTimeout(container.stats({ stream: false }), STATS_TIMEOUT, `容器 ${containerId} stats`);
  const metrics = parseContainerMetrics(containerId, stats);

  // 批量插入数据库
  const insert = db.prepare(`
    INSERT INTO container_metrics(container_id, metric_type, value, unit, timestamp)
    VALUES(?, ?, ?, ?, ?)
  `);
  
  const transaction = db.transaction(() => {
    for (const metric of metrics) {
      insert.run(
        metric.container_id,
        metric.metric_type,
        metric.value,
        metric.unit,
        metric.timestamp
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
  
  // 每小时清理一次过期数据;AI 会话/Agent 审计按天粒度顺带清理(每天最多跑一次)
  const pruneIntervalId = setInterval(() => {
    try {
      applyRetentionPolicy();
    } catch (error) {
      console.error('清理过期指标失败:', error.message);
    }
    pruneAiDataOnceDaily();
  }, 60 * 60 * 1000);
  
  return { intervalId, pruneIntervalId };
}

/**
 * AI 会话/Agent 审计保留策略:每天(UTC)最多执行一次,保留天数由
 * setting retention.ai_days 控制(默认 90 天,7..3650)。
 */
let lastAiPruneDay = '';
export function pruneAiDataOnceDaily() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastAiPruneDay === today) return;
  lastAiPruneDay = today;
  const retentionDays = Number(getSetting('retention.ai_days', '90')) || 90;
  try {
    const result = pruneAiData(retentionDays);
    setSetting('retention.ai_last_pruned_at', new Date().toISOString());
    if (result.history || result.plans) {
      console.log(`[retention] 已清理 AI 历史 ${result.history} 条、Agent 计划 ${result.plans} 个、执行记录 ${result.executions} 条`);
    }
  } catch (error) {
    console.error('[retention] AI 数据清理失败:', error.message);
  }
}
