import { getDockerForHost, onHostsChange } from './docker-hosts.js';
import { getSetting } from '../lib/db.js';
import { composeProjectId } from './project-id.js';
import { parseContainerStat } from './stats.js';
import { counterRate } from '../lib/host-probe.js';

const cache = new Map();
onHostsChange(id => cache.delete(id));
export async function mapLimited(items, limit, task) {
  let index = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    while (index < items.length) { const i = index++; results[i] = await task(items[i], i); }
  }));
  return results;
}

export async function sampleContainers(hostId, maxAge = 10000) {
  const docker = getDockerForHost(hostId);
  let state = cache.get(hostId);
  if (!state || state.docker !== docker) { state = { docker }; cache.set(hostId, state); }
  if (state.pending) return state.pending;
  if (state.value && Date.now() - state.value.sampledAt < maxAge) return state.value;
  const previous = new Map((state.value?.containers || []).map(item => [item.id, item]));
  state.pending = (async () => {
    const signal = AbortSignal.timeout(8000);
    const [list, info] = await Promise.all([docker.listContainers({ all: true, abortSignal: signal }), docker.info({ abortSignal: signal })]);
    state.details ||= new Map();
    const present = new Set(list.map(item => item.Id));
    for (const id of state.details.keys()) if (!present.has(id)) state.details.delete(id);
    const rows = await mapLimited(list, 6, async item => {
      const labels = item.Labels || {};
      const projectName = labels['com.docker.compose.project'] || '';
      const workingDir = labels['com.docker.compose.project.working_dir'] || '';
      const projectId = projectName ? composeProjectId(workingDir, projectName, hostId, getSetting('projects.legacy_host_id', 'local')) : '';
      let details = state.details.get(item.Id);
      if (!details || Date.now() - details.at > 60000 || details.state !== item.State) {
        try {
          signal.throwIfAborted();
          const inspect = await docker.getContainer(item.Id).inspect({ abortSignal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
          const config = inspect.HostConfig || {};
          details = { at: Date.now(), state: item.State, value: { detailsReady: true, detailsAt: Date.now(),
            configuredMemory: Number(config.Memory) > 0 ? Number(config.Memory) : null,
            configuredCpu: Number(config.NanoCpus) > 0 ? Number(config.NanoCpus) / 1e9 : Number(config.CpuQuota) > 0 && Number(config.CpuPeriod) > 0 ? Number(config.CpuQuota) / Number(config.CpuPeriod) : null,
            cpuSet: config.CpusetCpus || '', restartCount: inspect.RestartCount ?? null, oomKilled: !!inspect.State?.OOMKilled,
            health: inspect.State?.Health?.Status || null, stateError: inspect.State?.Error ? '容器启动错误，查看日志排查' : '' } };
          state.details.set(item.Id, details);
        } catch { details = { value: { detailsReady: false } }; }
      }
      const currentHealth = /\((?:health: )?(healthy|unhealthy|starting)\)/.exec(item.Status || '')?.[1];
      const identity = { id: item.Id, hostId, projectId, projectName, service: labels['com.docker.compose.service'] || '', name: (item.Names?.[0] || item.Id.slice(0, 12)).replace(/^\//, ''), image: item.Image, state: item.State, status: item.Status, mounts: item.Mounts || [], workingDir, ...details.value, health: currentHealth || details.value.health || null };
      if (item.State !== 'running') return { ...identity, sampledAt: Date.now(), metricsPending: true };
      try {
        signal.throwIfAborted();
        const raw = await docker.getContainer(item.Id).stats({ stream: false, 'one-shot': true, abortSignal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) });
        const sampledAt = Date.now(), last = previous.get(item.Id);
        if (!raw.precpu_stats?.system_cpu_usage && last?.raw?.cpu_stats) raw.precpu_stats = last.raw.cpu_stats;
        const stat = parseContainerStat(raw), elapsed = last ? (sampledAt - last.sampledAt) / 1000 : 0;
        const netIO = raw.networks && Object.keys(raw.networks).length ? stat.netIO : { rxBytes: null, txBytes: null };
        const blockIO = Array.isArray((raw.blkio_stats || raw.blkioio_stats)?.io_service_bytes_recursive) ? stat.blockIO : { readBytes: null, writeBytes: null };
        return { ...identity, sampledAt, raw, cpuPercent: stat.cpuReady ? stat.cpuPercent : null,
          cpuHostPercent: stat.cpuReady && info.NCPU > 0 ? stat.cpuPercent / info.NCPU : null,
          memUsage: Number.isFinite(raw.memory_stats?.usage) ? stat.memUsage : null, memLimit: stat.memLimit, memPercent: stat.memLimit ? stat.memPercent : null,
          networkRx: counterRate(netIO.rxBytes, last?.netIO?.rxBytes, elapsed), networkTx: counterRate(netIO.txBytes, last?.netIO?.txBytes, elapsed),
          diskRead: counterRate(blockIO.readBytes, last?.blockIO?.readBytes, elapsed), diskWrite: counterRate(blockIO.writeBytes, last?.blockIO?.writeBytes, elapsed), netIO, blockIO };
      } catch { return { ...identity, sampledAt: Date.now(), metricsPending: true, error: '容器指标暂不可用' }; }
    });
    const result = { hostId, sampledAt: Date.now(), engine: { id: info.ID, hostname: info.Name, kernel: info.KernelVersion, cpus: info.NCPU, memory: info.MemTotal, dockerRoot: info.DockerRootDir }, containers: rows };
    if (cache.get(hostId) === state) state.value = result;
    return result;
  })();
  const pending = state.pending;
  return pending.finally(() => { if (state.pending === pending) state.pending = null; });
}
