import { readFile, stat } from 'node:fs/promises';
import db, { addAlertEvent, getSetting, getProjectPreference } from '../lib/db.js';
import { listProjectGroups, projectGroupMetadata } from './project-groups.js';
import { HOST_PROBE_COMMAND, parseHostProbe, hostSnapshot } from '../lib/host-probe.js';
import { getHost, listHosts, onHostsChange } from './docker-hosts.js';
import { sshExec } from './remote-shell.js';
import { mapLimited, sampleContainers } from './container-sampler.js';
import { capacityForecast, diskResource, saveInfrastructureMetrics, serviceResource } from './infrastructure-history.js';

const latest = new Map(), previous = new Map(), alerts = new Map(), diskWrites = new Map();
const hostRevisions = new Map();
let running, timer;
onHostsChange(id => {
  hostRevisions.set(id, (hostRevisions.get(id) || 0) + 1);
  latest.delete(id); previous.delete(id); diskWrites.delete(id); diskWrites.delete(`${id}:host`);
  for (const key of alerts.keys()) if (key.startsWith(`${id}:`)) alerts.delete(key);
});
const numericSum = (items, key) => items.length && items.every(item => Number.isFinite(item[key])) ? items.reduce((n, item) => n + item[key], 0) : null;

export function groupInfrastructureContainers(containers) {
  const groups = new Map();
  for (const item of containers) {
    const key = item.projectId ? serviceResource(item.projectId, item.service || '未标记服务') : `container:${item.id}`;
    if (!groups.has(key)) groups.set(key, { key, hostId: item.hostId, projectId: item.projectId, projectName: item.projectName, service: item.service, name: item.projectName ? (item.service || item.projectName) : item.name, containers: [] });
    groups.get(key).containers.push(item);
  }
  return [...groups.values()].map(group => {
    const active = group.containers.filter(item => item.state === 'running');
    return { ...group, running: active.length, total: group.containers.length,
      ...Object.fromEntries(['cpuHostPercent', 'cpuPercent', 'memUsage', 'networkRx', 'networkTx', 'diskRead', 'diskWrite'].map(key => [key, active.length ? numericSum(active, key) : null])) };
  });
}

export function storageAssociations(disks, containers) {
  return disks.map(disk => {
    const aliases = disk.aliases || [{ mountpoint: disk.mountpoint }];
    const matches = [];
    for (const item of containers) for (const mount of item.mounts || []) {
      if (!mount.Source?.startsWith('/')) continue;
      const candidates = disks.flatMap(other => (other.aliases || [{ mountpoint: other.mountpoint }]).map(alias => ({ disk: other, mountpoint: alias.mountpoint })))
        .filter(alias => mount.Source === alias.mountpoint || mount.Source.startsWith(alias.mountpoint.replace(/\/$/, '') + '/'))
        .sort((a, b) => b.mountpoint.length - a.mountpoint.length);
      if (candidates[0]?.disk !== disk) continue;
      const key = `${item.projectId ? `${item.projectId}:${item.service}` : item.id}:${mount.Name || mount.Source}`;
      if (!matches.some(match => match.key === key)) matches.push({ key, projectId: item.projectId, projectName: item.projectName, service: item.service, containerId: item.id, containerName: item.name, volume: mount.Name || '', source: mount.Source, destination: mount.Destination, type: mount.Type });
    }
    return { ...disk, aliases, services: matches };
  });
}

async function readHost(host, engine, isCurrent = () => true) {
  let raw;
  if (host.type === 'ssh') {
    const result = await sshExec(getHost(host.id), ['sh', '-c', HOST_PROBE_COMMAND], { timeoutMs: 10000 });
    if (result.code !== 0) throw new Error('SSH 宿主采集失败');
    raw = parseHostProbe(result.stdout);
  } else if (host.type === 'local' && process.env.HOST_METRICS_FILE) {
    const file = process.env.HOST_METRICS_FILE;
    if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error('宿主采集文件超出大小限制');
    raw = JSON.parse(await readFile(file, 'utf8'));
  } else return { status: 'unavailable', reason: host.type === 'tcp' ? '仅接入 Docker API；配置 SSH 节点后可采集宿主资源' : '宿主采集未接入，请配置独立采集服务', sampledAt: null };
  if (!raw || !Number.isFinite(raw.sampledAt) || !raw.bootId || !raw.cpu || !raw.memory || !Array.isArray(raw.network) || !Array.isArray(raw.filesystems) || !Array.isArray(raw.diskCounters)) throw new Error('宿主采集数据格式不完整');
  if (raw.sampledAt > Date.now() + 30000) throw new Error('宿主采样时钟超前，请校准时间');
  // The same-host collector must correspond to the Docker engine, not another machine.
  if (!engine.hostname || raw.hostname !== engine.hostname || raw.kernel !== engine.kernel) throw new Error('宿主采集身份与 Docker 节点不一致');
  const old = previous.get(host.id);
  let value;
  if (old?.raw.sampledAt === raw.sampledAt) value = old.value;
  else { value = hostSnapshot(raw, old?.raw); if (isCurrent()) previous.set(host.id, { raw, value }); }
  return { ...value, status: Date.now() - raw.sampledAt > 30000 ? 'stale' : 'ready', source: host.type === 'ssh' ? 'ssh' : 'host-agent', reason: '' };
}

function recordNode(node) {
  const { hostId, host, services } = node;
  if (host.status === 'ready') {
    const last = diskWrites.get(`${hostId}:host`);
    if (last !== host.sampledAt) {
      saveInfrastructureMetrics(hostId, 'host', { cpu: host.cpu.percent, memory: host.memory.percent, memoryUsed: host.memory.used, rx: host.network.rx, tx: host.network.tx }, host.sampledAt);
      diskWrites.set(`${hostId}:host`, host.sampledAt);
    }
    if (host.sampledAt - (diskWrites.get(hostId) || 0) >= 60000) {
      for (const disk of host.disks) saveInfrastructureMetrics(hostId, diskResource(disk), { used: disk.used, free: disk.free, diskPercent: disk.percent, inodePercent: disk.inodePercent, readRate: disk.readRate, writeRate: disk.writeRate }, host.sampledAt);
      diskWrites.set(hostId, host.sampledAt);
    }
  }
  if (latest.get(hostId)?.sampledAt === node.sampledAt) return;
  for (const service of services) saveInfrastructureMetrics(hostId, service.key, { cpu: service.cpuHostPercent, memoryUsed: service.memUsage, rx: service.networkRx, tx: service.networkTx, readRate: service.diskRead, writeRate: service.diskWrite }, node.sampledAt);
}

function evaluateNodeAlerts(node) {
  if (node.host.status !== 'ready') { for (const key of alerts.keys()) if (key.startsWith(`${node.hostId}:`)) alerts.delete(key); return []; }
  const host = node.host;
  const candidates = [
    { key: 'cpu', active: host.cpu.percent >= Number(getSetting('monitor.host.cpu_threshold', 90)), title: 'CPU 持续高负载', detail: `整机 CPU ${host.cpu.percent?.toFixed(1)}%` },
    { key: 'memory', active: host.memory.percent >= Number(getSetting('monitor.host.memory_threshold', 90)), title: '内存持续紧张', detail: `宿主内存 ${host.memory.percent?.toFixed(1)}%` },
    ...host.disks.flatMap(disk => [
      { key: `disk:${disk.device}`, active: disk.percent >= Number(getSetting('monitor.host.disk_threshold', 85)), title: `${disk.mountpoint} 可用空间不足`, detail: `已用 ${disk.percent}%`, disk: disk.device },
      { key: `inode:${disk.device}`, active: disk.inodePercent >= 90, title: `${disk.mountpoint} inode 即将耗尽`, detail: `inode 已用 ${disk.inodePercent}%`, disk: disk.device },
    ]),
  ];
  const visible = [];
  for (const candidate of candidates) {
    const key = `${node.hostId}:${candidate.key}`;
    if (!candidate.active) { alerts.delete(key); continue; }
    const state = alerts.get(key) || { since: Date.now(), emitted: false };
    alerts.set(key, state);
    const sustained = Date.now() - state.since >= 120000;
    visible.push({ ...candidate, since: state.since, sustained });
    if (sustained && !state.emitted) {
      const targetDisk = host.disks.find(disk => disk.device === candidate.disk);
      const query = new URLSearchParams({ hostId: node.hostId, metric: candidate.disk ? 'disk' : candidate.key, ...(targetDisk ? { resource: diskResource(targetDisk) } : {}) });
      addAlertEvent({ key: `infrastructure:${key}`, title: `${node.name} · ${candidate.title}`, detail: `${candidate.detail}，持续至少 2 分钟`, to: `/dashboard?${query}` });
      state.emitted = true;
    }
  }
  return visible;
}

export async function collectInfrastructure() {
  if (running) return running;
  running = mapLimited(listHosts(), 3, async item => {
    const host = getHost(item.id);
    const revision = hostRevisions.get(item.id) || 0;
    const isCurrent = () => !!getHost(item.id) && revision === (hostRevisions.get(item.id) || 0);
    try {
      const sample = await sampleContainers(item.id);
      if (!isCurrent()) return;
      let hostMetrics;
      try { hostMetrics = await readHost(host, sample.engine, isCurrent); }
      catch (error) { hostMetrics = { ...(latest.get(item.id)?.host || {}), status: 'stale', reason: error.message }; }
      const containers = sample.containers.map(({ raw: _, netIO: __, blockIO: ___, ...row }) => row);
      if (hostMetrics.disks) hostMetrics.disks = storageAssociations(hostMetrics.disks, containers);
      const node = { hostId: item.id, name: item.name, sampledAt: sample.sampledAt, status: 'ready', engine: sample.engine, host: hostMetrics, containers, services: groupInfrastructureContainers(containers) };
      if (isCurrent()) {
        recordNode(node); node.alerts = evaluateNodeAlerts(node); latest.set(item.id, node);
      }
      return node;
    } catch (error) {
      // A failed old connection must not recreate a removed node's cache or
      // overwrite the pending state of a node whose credentials just changed.
      if (!isCurrent()) return;
      const old = latest.get(item.id);
      latest.set(item.id, { ...(old || { hostId: item.id, name: item.name, host: { status: 'unavailable', reason: 'Docker 节点暂不可达' }, containers: [], services: [] }), status: old ? 'stale' : 'unavailable', error: 'Docker 节点暂不可达', alerts: [] });
      for (const key of alerts.keys()) if (key.startsWith(`${item.id}:`)) alerts.delete(key);
      return { hostId: item.id, status: 'unavailable', error: error.message };
    }
  }).finally(() => { running = null; });
  return running;
}

export function infrastructureSnapshot(hostId = 'all') {
  const hosts = listHosts().filter(host => hostId === 'all' || host.id === hostId);
  if (!hosts.length) throw Object.assign(new Error('Docker 节点不存在'), { statusCode: 404 });
  return { checkedAt: Date.now(), interval: 10000, groups: listProjectGroups(), nodes: hosts.map(host => {
    const node = latest.get(host.id);
    if (!node) return { hostId: host.id, name: host.name, status: 'pending', host: { status: 'unavailable', reason: '等待首次采样' }, containers: [], services: [], alerts: [] };
    const result = structuredClone(node);
    result.services = result.services.map(service => ({ ...service,
      ...(service.projectId ? { ...projectGroupMetadata(service.projectId), managed: !!getProjectPreference(service.projectId).managed, operationalIntent: getProjectPreference(service.projectId).operationalIntent } : { managed: false, groupId: null }) }));
    if (Date.now() - result.sampledAt > 30000) result.status = 'stale';
    if (Date.now() - result.host.sampledAt > 30000 && result.host.status === 'ready') result.host.status = 'stale';
    return result;
  }) };
}

export function infrastructureStorage(hostId) {
  const node = infrastructureSnapshot(hostId).nodes[0];
  return { hostId, status: node.host.status, disks: (node.host.disks || []).map(disk => ({ ...disk, forecast: capacityForecast(hostId, disk) })) };
}

export function startInfrastructureCollection() {
  if (timer) return stopInfrastructureCollection;
  const tick = () => collectInfrastructure().catch(error => console.error('服务器指标采集失败:', error.message));
  void tick(); timer = setInterval(tick, 10000); timer.unref?.();
  return stopInfrastructureCollection;
}
export function stopInfrastructureCollection() { clearInterval(timer); timer = null; }

export function infrastructureFootprint() {
  return db.prepare('SELECT COUNT(*) AS samples, MIN(timestamp) AS oldest FROM infrastructure_metrics').get();
}
