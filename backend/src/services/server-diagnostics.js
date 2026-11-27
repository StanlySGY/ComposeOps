import { getActiveHostId, getDockerForHost, getHost, hostConnectionRevision } from './docker-hosts.js';
import { storageHostScope } from './storage-host-scope.js';
import { infrastructureSnapshot } from './infrastructure.js';
import { getSystemStorageDf } from './docker-storage.js';

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const failure = (message, statusCode = 503) => Object.assign(new Error(message), { statusCode });

function readWithSignal(read, signal) {
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return read(signal); }), cancelled])
    .finally(() => signal.removeEventListener('abort', onAbort));
}

/** Engine capacity and verified host observations have different scopes. Missing
 * host telemetry stays unknown; never substitute the panel's OS namespace. */
export async function inspectServer(hostId = getActiveHostId(), { timeoutMs = 15000, snapshot = infrastructureSnapshot, followActive = true } = {}) {
  const scope = storageHostScope(hostId), host = getHost(hostId), docker = getDockerForHost(hostId);
  const connectionRevision = hostConnectionRevision(hostId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(failure('节点诊断读取超时，请检查连接后重试')), timeoutMs);
  try {
    const [engineRead, containerRead] = await Promise.allSettled([
      readWithSignal(abortSignal => docker.info({ abortSignal }), controller.signal),
      readWithSignal(abortSignal => docker.listContainers({ all: true, abortSignal }), controller.signal),
    ]);
    if (!getHost(hostId) || hostConnectionRevision(hostId) !== connectionRevision || (followActive && storageHostScope(hostId).hostRevision !== scope.hostRevision)) {
      throw failure('节点或连接配置发生变化，请重新读取诊断数据', 409);
    }
    if (engineRead.status !== 'fulfilled' || !engineRead.value?.Name) throw failure('目标节点 Docker 信息暂不可用，请检查连接后重试');
    const info = engineRead.value;
    const node = snapshot(hostId).nodes.find(item => item.hostId === hostId);
    const sameEngine = !!info.ID && node?.engine?.id === info.ID && node.engine.hostname === info.Name && node.engine.kernel === info.KernelVersion;
    const observed = sameEngine ? node.host : null;
    const fresh = observed?.status === 'ready' && node.status === 'ready'
      && ['ssh', 'host-agent'].includes(observed.source) && observed.hostname === info.Name && observed.kernel === info.KernelVersion && Number.isFinite(observed.sampledAt)
      && Date.now() - observed.sampledAt <= 30000 && observed.sampledAt <= Date.now() + 30000;
    const metrics = fresh ? observed : null;
    const containersAvailable = containerRead.status === 'fulfilled' && Array.isArray(containerRead.value);
    const rows = containersAvailable ? containerRead.value : null;
    const observedMemoryTotal = number(metrics?.memory?.total);
    const memoryTotal = observedMemoryTotal ?? number(info.MemTotal);
    return {
      hostId, hostName: scope.hostName, connectionRevision, checkedAt: Date.now(), scope: 'docker-host',
      hostname: info.Name, platform: [info.OSType, info.KernelVersion].filter(Boolean).join(' ') || null,
      hostMetrics: { status: fresh ? 'ready' : (observed && Date.now() - observed.sampledAt > 30000) || observed?.status === 'stale' ? 'stale' : 'unavailable', source: observed?.source || null,
        sampledAt: observed?.sampledAt || null, reason: fresh ? '' : observed?.reason || (host.type === 'tcp' ? '仅接入 Docker API，宿主使用量需要 SSH 采集' : '等待身份匹配的宿主采样；当前使用量未知') },
      uptimeSeconds: number(metrics?.uptime),
      cpu: { cores: number(metrics?.cpu?.cores) ?? number(info.NCPU), percent: number(metrics?.cpu?.percent), loadAverage: Array.isArray(metrics?.cpu?.loadavg) ? metrics.cpu.loadavg.slice(0, 3).map(number) : null },
      memory: { totalBytes: memoryTotal, availableBytes: number(metrics?.memory?.available), usedBytes: number(metrics?.memory?.used),
        usedPercent: number(metrics?.memory?.percent), capacitySource: observedMemoryTotal !== null ? observed.source : 'docker-engine' },
      disks: metrics?.disks || null, network: metrics?.network || null,
      docker: { available: true, engineId: info.ID || null, serverVersion: info.ServerVersion || null,
        containers: number(info.Containers), running: number(info.ContainersRunning), paused: number(info.ContainersPaused), stopped: number(info.ContainersStopped), images: number(info.Images) },
      containersAvailable, containersError: containersAvailable ? '' : '容器清单暂不可用，不代表节点没有容器',
      containerCount: rows?.length ?? null, containersTruncated: !!rows && rows.length > 200,
      containers: rows?.slice(0, 200).map(item => ({ id: item.Id, name: (item.Names?.[0] || '').replace(/^\//, ''), image: item.Image, state: item.State, status: item.Status })) ?? null,
      note: '容量来自目标 Docker Engine；实时使用量仅来自身份匹配且未过期的宿主采样。null 表示未知，不是零。',
    };
  } finally { clearTimeout(timer); controller.abort(); }
}

/** Retain legacy command identifiers, but return scoped observations rather
 * than executing a local CLI for a possibly remote Docker node. */
export async function runServerDiagnostic(command, hostId = getActiveHostId(), options) {
  if (!['uname', 'uptime', 'memory', 'disk', 'docker', 'containers', 'dockerDisk'].includes(command)) throw failure('不允许执行该服务器命令', 400);
  if (command === 'dockerDisk') {
    const data = await getSystemStorageDf(hostId);
    return { command, hostId, hostName: data.hostName, source: 'docker-engine', checkedAt: data.checkedAt, output: JSON.stringify(data) };
  }
  const data = await inspectServer(hostId, options);
  if (['uptime', 'memory', 'disk'].includes(command) && data.hostMetrics.status !== 'ready') {
    throw failure(`节点「${data.hostName}」的宿主采样不可用：${data.hostMetrics.reason}。未读取面板本机数据。`, 409);
  }
  if (command === 'containers' && !data.containersAvailable) throw failure(data.containersError);
  const value = { uname: { hostname: data.hostname, platform: data.platform }, uptime: { uptimeSeconds: data.uptimeSeconds, loadAverage: data.cpu.loadAverage },
    memory: data.memory, disk: data.disks, docker: data.docker, containers: { total: data.containerCount, truncated: data.containersTruncated, items: data.containers } }[command];
  return { command, hostId, hostName: data.hostName, checkedAt: data.checkedAt,
    source: ['uptime', 'memory', 'disk'].includes(command) ? data.hostMetrics.source : 'docker-engine',
    sampledAt: ['uptime', 'memory', 'disk'].includes(command) ? data.hostMetrics.sampledAt : data.checkedAt,
    output: JSON.stringify(value) };
}
