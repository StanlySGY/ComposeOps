/**
 * 容器资源监控工具
 * 
 * 提供实时资源使用查询、历史趋势分析、告警配置
 */

import { getActivityDocker } from './docker-hosts.js';
import { getSetting, setSetting } from '../lib/db.js';
import { scanProjects } from './scanner.js';

const ALERT_METRICS = new Set(['cpu', 'memory', 'network', 'disk']);
const ALERT_ACTIONS = new Set(['notify', 'restart', 'scale']);
const ALERT_DURATION_PATTERN = /^[1-9]\d*(?:s|m|h|d)$/;

function readAlertRules() {
  const value = getSetting('alert_rules', '[]');
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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

/**
 * 配置资源告警规则
 */
export async function configureAlert(config = {}) {
  const { container, metric, threshold, duration = '5m', action = 'notify' } = config;
  const numericThreshold = Number(threshold);
  if (!ALERT_METRICS.has(metric)) {
    throw Object.assign(new Error('不支持的告警指标类型'), { statusCode: 400 });
  }
  if (threshold === '' || threshold === null || threshold === undefined || !Number.isFinite(numericThreshold)) {
    throw Object.assign(new Error('告警阈值必须是有限数字'), { statusCode: 400 });
  }
  if (['cpu', 'memory'].includes(metric) && (numericThreshold < 0 || numericThreshold > 100)) {
    throw Object.assign(new Error('CPU 和内存告警阈值必须在 0 到 100 之间'), { statusCode: 400 });
  }
  if (['network', 'disk'].includes(metric) && numericThreshold < 0) {
    throw Object.assign(new Error('网络和磁盘告警阈值不能小于 0'), { statusCode: 400 });
  }
  if (typeof duration !== 'string' || duration.length > 16 || !ALERT_DURATION_PATTERN.test(duration)) {
    throw Object.assign(new Error('告警持续时间格式无效,请使用如 5m 的格式'), { statusCode: 400 });
  }
  if (!ALERT_ACTIONS.has(action)) {
    throw Object.assign(new Error('不支持的告警动作'), { statusCode: 400 });
  }
  
  // 验证容器存在
  const { container: managedContainer } = await resolveManagedContainer(container);
  const docker = await getActivityDocker();
  const containerObj = docker.getContainer(managedContainer.id);
  await containerObj.inspect(); // 抛出异常如果不存在
  
  // 创建告警规则
  const rule = {
    id: `alert_${Date.now()}`,
    container: managedContainer.id,
    metric,
    threshold: numericThreshold,
    duration,
    action,
    enabled: true,
    createdAt: new Date().toISOString()
  };
  
  // 保存到数据库
  const existingRules = readAlertRules();
  existingRules.push(rule);
  setSetting('alert_rules', JSON.stringify(existingRules));
  
  return { ruleId: rule.id, enabled: true };
}

/**
 * 列出告警规则
 */
export async function listAlerts(containerFilter = null) {
  const rules = readAlertRules();
  const managedIds = new Set();
  for (const project of await scanProjects()) {
    if (project.managed) for (const container of project.containers) managedIds.add(container.id);
  }
  const visibleRules = rules.filter((rule) => managedIds.has(rule.container));
  
  if (containerFilter) {
    const { container } = await resolveManagedContainer(containerFilter);
    return visibleRules.filter(r => r.container === container.id);
  }
  
  return visibleRules;
}

/**
 * 删除告警规则
 */
export async function deleteAlert(ruleId) {
  const rules = readAlertRules();
  const rule = rules.find((item) => item.id === ruleId);
  if (!rule) return { deleted: 0 };
  await resolveManagedContainer(rule.container);
  const updated = rules.filter(r => r.id !== ruleId);
  setSetting('alert_rules', JSON.stringify(updated));
  return { deleted: rules.length - updated.length };
}

/**
 * 检查告警条件（由后台任务定期调用）
 */
export async function checkAlerts() {
  const rules = readAlertRules();
  const docker = await getActivityDocker();
  const managedIds = new Set();
  for (const project of await scanProjects()) {
    if (project.managed) for (const container of project.containers) managedIds.add(container.id);
  }
  const triggered = [];
  
  for (const rule of rules.filter(r => r.enabled && managedIds.has(r.container))) {
    try {
      const container = docker.getContainer(rule.container);
      const stats = await container.stats({ stream: false });
      const parsed = parseContainerStats(stats, rule.metric);
      
      const currentValue = parsed.numeric;
      
      if (currentValue > rule.threshold) {
        triggered.push({
          rule,
          currentValue,
          threshold: rule.threshold,
          container: rule.container,
          metric: rule.metric
        });
      }
    } catch (error) {
      console.error(`检查告警规则 ${rule.id} 失败:`, error.message);
    }
  }
  
  return triggered;
}
