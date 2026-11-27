import { getActivityDocker } from './docker-hosts.js';
import { containerMemory } from '../lib/container-metrics.js';

/**
 * 读取指定容器的单次资源快照。
 * 返回 { cpuPercent, memUsageMB, memLimitMB, memPercent, netIO, blockIO }。
 */
export async function readContainerStat(containerId, docker = getActivityDocker(), signal) {
  const stat = await docker.getContainer(containerId).stats({ stream: false, ...(signal ? { abortSignal: signal } : {}) });
  return parseContainerStat(stat);
}

/** 把 dockerode stats JSON 归一化为前端友好的资源快照(纯函数,便于单测)。 */
export function parseContainerStat(raw) {
  const cpu = raw?.cpu_stats?.cpu_usage?.total_usage || 0;
  const sys = raw?.cpu_stats?.system_cpu_usage || 0;
  const prevCpu = raw?.precpu_stats?.cpu_usage?.total_usage || 0;
  const prevSys = raw?.precpu_stats?.system_cpu_usage || 0;
  const onlineCpus = raw?.cpu_stats?.online_cpus ||
    raw?.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  let cpuPercent = 0;
  const sysDelta = sys - prevSys;
  const cpuDelta = cpu - prevCpu;
  if (sysDelta > 0 && cpuDelta >= 0) {
    cpuPercent = cpuDelta / sysDelta * onlineCpus * 100;
  }
  const memory = containerMemory(raw?.memory_stats);
  const memUsage = memory.used;
  const memLimit = memory.limit;
  const netIO = sumNetwork(raw?.networks);
  const blockIO = sumBlock(raw?.blkio_stats || raw?.blkioio_stats);
  return {
    cpuPercent: round2(cpuPercent),
    cpuReady: prevSys > 0 && sysDelta > 0 && cpuDelta >= 0,
    memUsage,
    memLimit,
    memUsageMB: round2(memUsage / 1024 / 1024),
    memLimitMB: round2(memLimit / 1024 / 1024),
    memPercent: memLimit > 0 ? round2(memUsage / memLimit * 100) : 0,
    netIO,
    blockIO,
  };
}

function sumNetwork(networks) {
  if (!networks || typeof networks !== 'object') return { rxBytes: 0, txBytes: 0 };
  let rx = 0, tx = 0;
  for (const value of Object.values(networks)) {
    rx += Number(value?.rx_bytes) || 0;
    tx += Number(value?.tx_bytes) || 0;
  }
  return { rxBytes: rx, txBytes: tx };
}

function sumBlock(blkio) {
  if (!blkio?.io_service_bytes_recursive) return { readBytes: 0, writeBytes: 0 };
  let read = 0, write = 0;
  for (const item of blkio.io_service_bytes_recursive) {
    if (!item?.op) continue;
    if (item.op === 'Read') read += Number(item.value) || 0;
    if (item.op === 'Write') write += Number(item.value) || 0;
  }
  return { readBytes: read, writeBytes: write };
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
