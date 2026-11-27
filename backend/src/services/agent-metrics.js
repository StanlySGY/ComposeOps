/**
 * 容器资源监控工具
 * 
 * 提供实时资源使用查询、历史趋势分析、告警配置
 */

import { getProjectDocker, getActiveHostId, hostConnectionRevision, onHostsChange } from './docker-hosts.js';
import { getProjectPreference } from '../lib/db.js';
import { containerMetricValues } from '../lib/container-metric-values.js';
import { scanProjects } from './scanner.js';

// 告警规则的创建/列举/删除已统一收敛到 alert-rules.js(存储 agent.alert_rules,
// 由 alert-monitor 评估);本文件只保留指标查询与纳管容器解析。

/** 只允许访问当前 Docker 节点上明确纳管的容器。 */
export async function resolveManagedContainer(containerIdOrName) {
  const needle = String(containerIdOrName || '');
  if (!needle) throw Object.assign(new Error('容器标识不能为空'), { statusCode: 400 });
  const hostId = getActiveHostId(), revision = hostConnectionRevision(hostId);
  const projects = await scanProjects(hostId);
  if (getActiveHostId() !== hostId || hostConnectionRevision(hostId) !== revision) throw Object.assign(new Error('读取期间节点已变化，请刷新重试'), { statusCode: 409 });
  const exact = [], prefixes = [];
  for (const project of projects) {
    if (!project.managed) continue;
    for (const container of project.containers) {
      if (container.id === needle || container.name === needle) exact.push({ project, container });
      else if (container.id.startsWith(needle)) prefixes.push({ project, container });
    }
  }
  const matches = exact.length ? exact : prefixes;
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
const samples = new Map();
onHostsChange(() => samples.clear());

function assertMetricScope(project, revision) {
  if (getActiveHostId() !== project.hostId || hostConnectionRevision(project.hostId) !== revision) throw Object.assign(new Error('读取期间节点已变化，请刷新重试'), { statusCode: 409 });
  if (!getProjectPreference(project.id).managed) throw Object.assign(new Error('项目已取消纳管，不能返回容器指标'), { statusCode: 403 });
}

async function readMetricSample(project, containerId, revision) {
  const now = Date.now(), key = JSON.stringify([project.hostId, revision, containerId]);
  const existing = samples.get(key);
  if (existing?.promise) return existing.promise;
  if (existing?.until > now) return existing.sample;
  for (const [entryKey, entry] of samples) if (!entry.promise && entry.until <= now) samples.delete(entryKey);
  if (samples.size >= 200) throw Object.assign(new Error('指标采样繁忙，请稍后重试'), { statusCode: 503 });
  const entry = { until: 0, promise: null }, controller = new AbortController(); let timer;
  entry.promise = Promise.race([
    Promise.resolve().then(() => getProjectDocker(project).getContainer(containerId).stats({ stream: false, abortSignal: controller.signal })),
    new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('容器指标读取超时，请检查节点连接后重试'), { statusCode: 504 })); }, 8000); }),
  ]).then(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Object.assign(new Error('容器指标响应无效'), { statusCode: 502 });
    const sample = { raw, timestamp: new Date().toISOString() };
    if (samples.get(key) === entry && hostConnectionRevision(project.hostId) === revision) Object.assign(entry, { sample, until: Date.now() + 1000 });
    return sample;
  }).catch(error => { if (samples.get(key) === entry) samples.delete(key); throw error; })
    .finally(() => { clearTimeout(timer); entry.promise = null; });
  samples.set(key, entry);
  return entry.promise;
}

export async function queryContainerMetrics(containerIdOrName, metric = 'cpu', period = '5m') {
  if (!['cpu', 'memory', 'network', 'disk'].includes(metric)) throw Object.assign(new Error('不支持的指标类型'), { statusCode: 400 });
  parsePeriod(period);
  const { project, container: managedContainer } = await resolveManagedContainer(containerIdOrName);
  const revision = hostConnectionRevision(project.hostId);
  assertMetricScope(project, revision);
  const sample = managedContainer.state === 'running'
    ? await readMetricSample(project, managedContainer.id, revision) : { raw: {}, timestamp: new Date().toISOString() };
  assertMetricScope(project, revision);
  const parsed = parseContainerStats(sample.raw, metric);
  const historical = await getHistoricalMetrics(managedContainer.id, metric, period, project.hostId);
  assertMetricScope(project, revision);
  return {
    current: parsed.current, available: parsed.available, kind: parsed.kind,
    reason: managedContainer.state !== 'running' ? '容器当前未运行' : parsed.reason,
    average: historical.avg ?? null, peak: historical.max ?? null,
    trend: parsed.kind === 'counter' ? 'unknown' : calculateTrend(historical.data),
    unit: parsed.unit, timestamp: sample.timestamp, period,
    historicalApproximation: historical.approximation || null,
  };
}

/**
 * 解析容器统计数据
 */
export function parseContainerStats(stats = {}, metric) {
  const values = containerMetricValues(stats);
  const kind = ['network', 'disk'].includes(metric) ? 'counter' : 'gauge';
  if (['cpu', 'memory'].includes(metric)) {
    const value = values[metric], current = value == null ? null : roundMetric(value);
    return { current, numeric: current, unit: '%', kind, available: current !== null,
      reason: current === null ? metric === 'cpu' ? '等待有效 CPU 差分采样' : '缺少有效内存使用量或上限' : '',
      ...(metric === 'memory' ? { usedBytes: values.memoryUsed, limitBytes: values.memoryLimit } : {}) };
  }
  if (['network', 'disk'].includes(metric)) {
    const network = metric === 'network', first = values[network ? 'network_rx' : 'disk_read'], second = values[network ? 'network_tx' : 'disk_write'];
    const current = first === null && second === null ? null : network
      ? { rx: first === null ? null : formatBytes(first), tx: second === null ? null : formatBytes(second) }
      : { read: first === null ? null : formatBytes(first), write: second === null ? null : formatBytes(second) };
    return { current, numeric: first, unit: 'bytes', kind, available: first !== null && second !== null,
      reason: first === null || second === null ? '该容器的累计计数未完整提供' : '',
      ...(network ? { rxBytes: first, txBytes: second } : { readBytes: first, writeBytes: second }) };
  }
  throw Object.assign(new Error(`不支持的指标类型: ${metric}`), { statusCode: 400 });
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundMetric(value) {
  const number = finiteNumber(value), rounded = Math.round(number * 100) / 100;
  return Number.isFinite(rounded) ? rounded : number;
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
async function getHistoricalMetrics(containerIdOrName, metric, period, hostId = 'local') {
  const { getMetricsStats, queryHistoricalMetrics } = await import('./metrics.js');
  const storedMetric = metric === 'network' ? 'network_rx' : metric === 'disk' ? 'disk_read' : metric;
  const periodMs = parsePeriod(period);
  const endTime = Date.now();
  const stats = getMetricsStats(containerIdOrName, storedMetric, periodMs / 3600000, hostId);
  if (!stats) return { avg: null, max: null, data: [] };
  const rows = queryHistoricalMetrics({ containerId: containerIdOrName, hostId, metricType: storedMetric, startTime: endTime - periodMs, endTime, aggregation: 'auto' });
  return { avg: roundMetric(stats.mean), max: stats.max, data: rows.map(row => row.value), approximation: stats.approximation };
}

/**
 * 解析时间周期字符串为毫秒
 */
function parsePeriod(period) {
  const match = String(period || '').match(/^(\d+)(m|h|d)$/);
  if (!match) throw Object.assign(new Error('指标时间范围无效'), { statusCode: 400 });
  
  const [, num, unit] = match;
  const value = parseInt(num, 10);
  const duration = value * ({ m: 60000, h: 3600000, d: 86400000 }[unit]);
  if (!Number.isSafeInteger(duration) || duration < 60000 || duration > 7 * 86400000) throw Object.assign(new Error('指标时间范围须在1分钟至7天之间'), { statusCode: 400 });
  
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
  const values = (data || []).filter(value => typeof value === 'number' && Number.isFinite(value));
  if (values.length < 2) return 'unknown';
  
  const recent = values.slice(-5);
  const avg = recent.reduce((sum, v) => sum + v, 0) / recent.length;
  const lastValue = recent[recent.length - 1];
  
  if (lastValue > avg * 1.1) return 'increasing';
  if (lastValue < avg * 0.9) return 'decreasing';
  return 'stable';
}
