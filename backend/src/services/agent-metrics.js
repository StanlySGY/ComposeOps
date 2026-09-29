/**
 * 容器资源监控工具
 * 
 * 提供实时资源使用查询、历史趋势分析、告警配置
 */

import { getActivityDocker } from './docker-hosts.js';
import { scanProjects } from './scanner.js';

// 告警规则的创建/列举/删除已统一收敛到 alert-rules.js(存储 agent.alert_rules,
// 由 alert-monitor 评估);本文件只保留指标查询与纳管容器解析。

/** 只允许访问当前 Docker 节点上明确纳管的容器。 */
export async function resolveManagedContainer(containerIdOrName) {
  const needle = String(containerIdOrName || '');
  if (!needle) throw Object.assign(new Error('容器标识不能为空'), { statusCode: 400 });
  const projects = await scanProjects();
  const matches = [];
  for (const project of projects) {
    if (!project.managed) continue;
    const container = project.containers.find((item) =>
      item.id === needle || item.id.startsWith(needle) || item.name === needle
    );
    if (container) matches.push({ project, container });
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw Object.assign(new Error('容器标识不唯一，请使用完整容器 ID 或名称'), { statusCode: 400 });
  throw Object.assign(new Error('容器不属于当前节点的纳管项目'), { statusCode: 403 });
}

/**
 * 查询容器资源使用情况
 * @param {string} containerIdOrName - 容器 ID 或名称
 * @param {string} metric - 指标类型 (cpu/memory/network/disk)
 * @param {string} period - 时间周期 (1m/5m/1h/1d)
 * @returns {Promise<object>}
 */
export async function queryContainerMetrics(containerIdOrName, metric = 'cpu', period = '5m') {
  const { container: managedContainer } = await resolveManagedContainer(containerIdOrName);
  const docker = await getActivityDocker();
  const container = docker.getContainer(managedContainer.id);
  
  // 获取实时统计
  const stats = await container.stats({ stream: false });
  
  // 解析统计数据
  const parsed = parseContainerStats(stats, metric);
  
  // 获取历史数据（如果启用了监控）
  const historical = await getHistoricalMetrics(managedContainer.id, metric, period);
  
  return {
    current: parsed.current,
    average: historical.avg ?? parsed.current,
    peak: historical.max ?? parsed.current,
    trend: calculateTrend(historical.data?.length ? historical.data : [parsed.numeric]),
    unit: parsed.unit,
    timestamp: new Date().toISOString(),
    period
  };
}

/**
 * 解析容器统计数据
 */
export function parseContainerStats(stats = {}, metric) {
  switch (metric) {
    case 'cpu': {
      const cpuStats = stats.cpu_stats || {};
      const previousCpuStats = stats.precpu_stats || {};
      const cpuDelta = finiteNumber(cpuStats.cpu_usage?.total_usage) - finiteNumber(previousCpuStats.cpu_usage?.total_usage);
      const systemDelta = finiteNumber(cpuStats.system_cpu_usage) - finiteNumber(previousCpuStats.system_cpu_usage);
      const onlineCpus = finiteNumber(cpuStats.online_cpus, 1);
      const cpuPercent = systemDelta > 0 && onlineCpus > 0
        ? Math.max(0, (cpuDelta / systemDelta) * onlineCpus * 100)
        : 0;
      const current = roundMetric(cpuPercent);
      return { current, numeric: current, unit: '%' };
    }
    
    case 'memory': {
      const memoryStats = stats.memory_stats || {};
      const used = Math.max(0, finiteNumber(memoryStats.usage) - finiteNumber(memoryStats.stats?.cache));
      const limit = finiteNumber(memoryStats.limit);
      const percent = limit > 0 ? (used / limit) * 100 : 0;
      const current = roundMetric(percent);
      return {
        current,
        numeric: current,
        unit: '%',
        usedBytes: used,
        limitBytes: limit
      };
    }
    
    case 'network': {
      const rx = Object.values(stats.networks || {}).reduce((sum, net) => sum + finiteNumber(net?.rx_bytes), 0);
      const tx = Object.values(stats.networks || {}).reduce((sum, net) => sum + finiteNumber(net?.tx_bytes), 0);
      return {
        current: { rx: formatBytes(rx), tx: formatBytes(tx) },
        numeric: rx,
        unit: 'bytes',
        rxBytes: rx,
        txBytes: tx
      };
    }
    
    case 'disk': {
      const ioStats = stats.blkio_stats?.io_service_bytes_recursive || [];
      const read = ioStats
        .filter((item) => String(item?.op || '').toLowerCase() === 'read')
        .reduce((sum, item) => sum + finiteNumber(item?.value), 0);
      const write = ioStats
        .filter((item) => String(item?.op || '').toLowerCase() === 'write')
        .reduce((sum, item) => sum + finiteNumber(item?.value), 0);
      return {
        current: { read: formatBytes(read), write: formatBytes(write) },
        numeric: read,
        unit: 'bytes',
        readBytes: read,
        writeBytes: write
      };
    }
    
    default:
      throw new Error(`不支持的指标类型: ${metric}`);
  }
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundMetric(value) {
  return Math.round(finiteNumber(value) * 100) / 100;
}

/**
 * 格式化字节数
 */
function formatBytes(bytes) {
  bytes = Math.max(0, finiteNumber(bytes));
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 获取历史指标数据
 */
async function getHistoricalMetrics(containerIdOrName, metric, period) {
  const db = (await import('../lib/db.js')).default;
  const storedMetric = metric === 'network' ? 'network_rx' : metric === 'disk' ? 'disk_read' : metric;
  
  // 解析时间窗口
  const periodMs = parsePeriod(period);
  const startTime = Date.now() - periodMs;
  
  // 查询历史数据
  const rows = db.prepare(`
    SELECT value, timestamp
    FROM container_metrics
    WHERE container_id = ? AND metric_type = ? AND timestamp >= ?
    ORDER BY timestamp ASC
  `).all(containerIdOrName, storedMetric, startTime);
  
  if (rows.length === 0) {
    return { avg: null, max: null, data: [] };
  }
  
  const values = rows.map(r => r.value);
  return {
    avg: Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 100) / 100,
    max: Math.max(...values),
    data: values
  };
}

/**
 * 解析时间周期字符串为毫秒
 */
function parsePeriod(period) {
  const match = String(period || '').match(/^(\d+)(m|h|d)$/);
  if (!match) return 5 * 60 * 1000; // 默认 5 分钟
  
  const [, num, unit] = match;
  const value = parseInt(num, 10);
  
  switch (unit) {
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return 5 * 60 * 1000;
  }
}

/**
 * 计算趋势
 */
function calculateTrend(data) {
  const values = data.map((value) => Number(value)).filter(Number.isFinite);
  if (values.length < 2) return 'stable';
  
  const recent = values.slice(-5);
  const avg = recent.reduce((sum, v) => sum + v, 0) / recent.length;
  const lastValue = recent[recent.length - 1];
  
  if (lastValue > avg * 1.1) return 'increasing';
  if (lastValue < avg * 0.9) return 'decreasing';
  return 'stable';
}
