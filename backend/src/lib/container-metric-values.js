import { containerMemory } from './container-metrics.js';

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const sum = values => {
  if (values.some(value => value === null)) return null;
  const total = values.reduce((a, b) => a + b, 0);
  return Number.isFinite(total) ? total : null;
};

/** Missing counters are unknown; an explicitly reported zero remains zero. */
export function containerMetricValues(raw = {}) {
  const cpu = raw?.cpu_stats, previous = raw?.precpu_stats;
  const total = number(cpu?.cpu_usage?.total_usage), oldTotal = number(previous?.cpu_usage?.total_usage);
  const system = number(cpu?.system_cpu_usage), oldSystem = number(previous?.system_cpu_usage);
  const cores = number(cpu?.online_cpus) || (Array.isArray(cpu?.cpu_usage?.percpu_usage) ? cpu.cpu_usage.percpu_usage.length : 0);
  let cpuPercent = null;
  if ([total, oldTotal, system, oldSystem].every(value => value !== null) && oldSystem > 0 && system > oldSystem && total >= oldTotal && cores > 0) {
    cpuPercent = number((total - oldTotal) / (system - oldSystem) * cores * 100);
  }
  const memoryReady = number(raw?.memory_stats?.usage) !== null && number(raw?.memory_stats?.limit) > 0;
  const memory = memoryReady ? containerMemory(raw.memory_stats) : { used: null, limit: null, percent: null };
  const network = raw?.networks && !Array.isArray(raw.networks) && typeof raw.networks === 'object' ? Object.values(raw.networks) : [];
  const rx = network.length ? sum(network.map(item => number(item?.rx_bytes))) : null;
  const tx = network.length ? sum(network.map(item => number(item?.tx_bytes))) : null;
  const io = raw?.blkio_stats?.io_service_bytes_recursive ?? raw?.blkioio_stats?.io_service_bytes_recursive;
  const counter = op => Array.isArray(io) ? sum(io.filter(item => String(item?.op).toLowerCase() === op).map(item => number(item?.value))) : null;
  return { cpu: cpuPercent, memory: number(memory.percent), memoryUsed: memory.used, memoryLimit: memory.limit, network_rx: rx, network_tx: tx, disk_read: counter('read'), disk_write: counter('write') };
}
