import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { containerMemory } from '../src/lib/container-metrics.js';
import { hostSnapshot, parseHostProbe, counterRate } from '../src/lib/host-probe.js';
import { parseContainerStat } from '../src/services/stats.js';
const directory = mkdtempSync(path.join(os.tmpdir(), 'cockpit-test-'));
const { default: db } = await import('../src/lib/db.js');
const { groupInfrastructureContainers, storageAssociations, collectInfrastructure, infrastructureSnapshot } = await import('../src/services/infrastructure.js');
const { sampleContainers, mapLimited } = await import('../src/services/container-sampler.js');
const { getDockerForHost, upsertHost, deleteHost } = await import('../src/services/docker-hosts.js');
const { infrastructureHistory, saveInfrastructureMetrics, capacityForecast } = await import('../src/services/infrastructure-history.js');
const { compactMetrics } = await import('../src/services/metrics-retention.js');
after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

test('working set handles cgroup v1/v2, legacy cache, impossible cache and unlimited memory', () => {
  assert.equal(containerMemory({ usage: 100, stats: { inactive_file: 20, cache: 50 } }).used, 80);
  assert.equal(containerMemory({ usage: 100, stats: { total_inactive_file: 30, cache: 50 } }).used, 70);
  assert.equal(containerMemory({ usage: 100, stats: { cache: 40 } }).used, 60);
  assert.equal(containerMemory({ usage: 100, stats: { cache: 120 } }).used, 100);
  assert.equal(containerMemory({ usage: 100 }).percent, null);
});

const raw = (time = Date.now()) => ({ sampledAt: time, hostname: 'node', kernel: 'linux', bootId: 'boot', scope: 'linux', cpu: { total: 100, idle: 60, cores: 4 }, memory: { total: 1000, available: 400, swapTotal: 0, swapUsed: 0 }, network: [{ name: 'eth0', rx: 100, tx: 200 }], filesystems: [], diskCounters: [] });
test('first CPU sample is unknown, memory uses available; counter resets never create spikes', () => {
  assert.equal(parseContainerStat({ cpu_stats: { system_cpu_usage: 100, cpu_usage: { total_usage: 10 } } }).cpuReady, false);
  const a = raw(1000), b = raw(11000); b.cpu = { total: 200, idle: 130, cores: 4 }; b.network[0].rx = 300;
  assert.equal(hostSnapshot(a).cpu.percent, null);
  assert.equal(hostSnapshot(b, a).cpu.percent, 30);
  assert.equal(hostSnapshot(b, a).memory.percent, 60);
  assert.equal(hostSnapshot(b, a).network.rx, 20);
  b.bootId = 'new'; assert.equal(hostSnapshot(b, a).network.rx, null);
  assert.equal(counterRate(5, 100, 10), null);
});

test('Linux probe excludes pseudo filesystems and duplicated bind mounts, and selects routed network', () => {
  const result = parseHostProbe('\n@@stat\ncpu  10 0 10 80 0 0 0 0\ncpu0 10\n@@memory\nMemTotal: 1000 kB\nMemAvailable: 400 kB\n@@hostname\nnode\n@@kernel\n6.1-microsoft-WSL2\n@@boot\nboot\n@@network\n eth0: 100 0 0 0 0 0 0 0 200\n veth0: 900 0 0 0 0 0 0 0 900\n@@route\nIface Destination\neth0 00000000\n@@mounts\n1 0 8:1 / / rw - ext4 /dev/sda1 rw\n2 1 8:1 /app /srv/app rw - ext4 /dev/sda1 rw\n3 1 0:4 / /tmp rw - tmpfs tmpfs rw\n@@space\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 800 200 80% /\n/dev/sda1 1000 800 200 80% /srv/app\ntmpfs 100 1 99 1% /tmp\n@@inodes\nFilesystem Inodes IUsed IFree IUse% Mounted on\n/dev/sda1 1000 50 950 5% /');
  assert.equal(result.scope, 'wsl'); assert.equal(result.filesystems.length, 1); assert.equal(result.filesystems[0].aliases.length, 2);
  assert.equal(result.filesystems[0].inodePercent, 5); assert.deepEqual(result.network.map(n => n.name), ['eth0']);
});

test('replicas aggregate absolute memory and CPU; missing live samples stay unknown', () => {
  const base = { hostId: 'local', projectId: 'p', projectName: 'app', service: 'db', state: 'running', cpuHostPercent: 10, cpuPercent: 40, memUsage: 100 };
  const groups = groupInfrastructureContainers([{ ...base, id: 'old' }, { ...base, id: 'new', memUsage: 200 }]);
  assert.equal(groups.length, 1); assert.equal(groups[0].memUsage, 300); assert.equal(groups[0].cpuHostPercent, 20);
  assert.equal(groupInfrastructureContainers([base, { ...base, memUsage: undefined }])[0].memUsage, null);
});

test('mount association selects longest filesystem path and never duplicates shared volume per service', () => {
  const disks = [{ device: 'a', mountpoint: '/', type: 'ext4' }, { device: 'b', mountpoint: '/data', type: 'ext4' }];
  const c = { projectId: 'p', service: 'db', mounts: [{ Source: '/data/db', Name: 'shared', Type: 'volume' }] };
  const result = storageAssociations(disks, [c, c]);
  assert.equal(result[0].services.length, 0); assert.equal(result[1].services.length, 1);
});

test('history isolates hosts, preserves peaks/weight through retention and remains stable across replicas', async () => {
  const now = Date.now(), old = Math.floor((now - 2 * 86400000) / 300000) * 300000;
  saveInfrastructureMetrics('a', 'service:p:db', { memoryUsed: 100 }, old + 1000);
  saveInfrastructureMetrics('a', 'service:p:db', { memoryUsed: 300 }, old + 2000);
  saveInfrastructureMetrics('b', 'service:p:db', { memoryUsed: 900 }, old + 1000);
  await compactMetrics(db, now, true);
  const data = infrastructureHistory('a', { resource: 'service:p:db', metric: 'memoryUsed', hours: 72, now });
  assert.equal(data.points.length, 1); assert.equal(data.points[0].value, 200); assert.equal(data.points[0].max, 300); assert.equal(data.points[0].samples, 2);
  assert.equal(capacityForecast('a', { device: '8:1', type: 'ext4', free: 100 }, now), null);
  saveInfrastructureMetrics('a', 'disk:8:1:ext4', { diskPercent: 70 }, now - 60000);
  assert.equal(infrastructureHistory('a', { resource: 'disk:8:1:ext4', metric: 'diskPercent', hours: 1, now }).interval, 60000);
});

test('100-container sampling has bounded concurrency and shared reads; unavailable hosts are explicit', async () => {
  const docker = getDockerForHost('local');
  const original = { listContainers: docker.listContainers, info: docker.info, getContainer: docker.getContainer };
  let calls = 0, live = 0, maximum = 0;
  docker.listContainers = async () => { calls++; return Array.from({ length: 100 }, (_, i) => ({ Id: String(i), Names: [`/c${i}`], State: 'running', Labels: {} })); };
  docker.info = async () => ({ ID: 'engine', Name: 'node', KernelVersion: 'linux', NCPU: 4 });
  docker.getContainer = () => ({ stats: async () => { maximum = Math.max(maximum, ++live); await new Promise(resolve => setTimeout(resolve, 1)); live--; return { cpu_stats: { cpu_usage: { total_usage: 20 }, system_cpu_usage: 100, online_cpus: 4 }, precpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 50 }, memory_stats: { usage: 100, limit: 1000 } }; } });
  try {
    const samples = await Promise.all(Array.from({ length: 10 }, () => sampleContainers('local')));
    assert.equal(calls, 1); assert.equal(maximum, 6); assert.equal(samples[0].containers.length, 100);
    process.env.HOST_METRICS_FILE = path.join(directory, 'host.json'); writeFileSync(process.env.HOST_METRICS_FILE, JSON.stringify(raw()));
    await collectInfrastructure(); const snapshot = infrastructureSnapshot('local').nodes[0];
    assert.equal(snapshot.host.status, 'ready'); assert.equal(snapshot.host.cpu.percent, null);
    const count = db.prepare('SELECT COUNT(*) AS n FROM infrastructure_metrics').get().n;
    await collectInfrastructure(); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM infrastructure_metrics').get().n, count);
    writeFileSync(process.env.HOST_METRICS_FILE, JSON.stringify({ ...raw(), hostname: 'other-host' }));
    await collectInfrastructure(); assert.equal(infrastructureSnapshot('local').nodes[0].host.status, 'stale');
    assert.match(infrastructureSnapshot('local').nodes[0].host.reason, /身份/);
  } finally { Object.assign(docker, original); delete process.env.HOST_METRICS_FILE; }
  const host = upsertHost({ id: 'tcp-test', type: 'tcp', name: 'tcp', host: '127.0.0.1' });
  assert.equal(infrastructureSnapshot(host.id).nodes[0].status, 'pending');
  const remote = getDockerForHost(host.id);
  remote.listContainers = async () => [];
  remote.info = async () => ({ ID: 'remote', Name: 'remote', NCPU: 2 });
  await collectInfrastructure();
  assert.equal(infrastructureSnapshot(host.id).nodes[0].host.status, 'unavailable');
  assert.match(infrastructureSnapshot(host.id).nodes[0].host.reason, /Docker API/);
  upsertHost({ id: host.id, name: 'offline', type: 'tcp', host: '127.0.0.1' });
  getDockerForHost(host.id).listContainers = async () => { throw new Error('offline'); };
  getDockerForHost(host.id).info = async () => ({});
  await collectInfrastructure();
  assert.equal(infrastructureSnapshot(host.id).nodes[0].status, 'unavailable');
  deleteHost(host.id);
  await assert.rejects(async () => infrastructureSnapshot(host.id), /不存在/);
  let concurrent = 0, max = 0; await mapLimited(Array(50), 3, async () => { max = Math.max(max, ++concurrent); await Promise.resolve(); concurrent--; }); assert.equal(max, 3);
});


test('容器限额与健康元数据缓存，实时健康优先，失败不伪装无限额', async t => {
  const host = upsertHost({ id: 'limits-test', type: 'tcp', name: 'limits', host: '127.0.0.1' });
  t.after(() => deleteHost(host.id));
  const docker = getDockerForHost(host.id);
  let inspections = 0, status = 'Up (healthy)', state = 'running';
  t.mock.method(docker, 'listContainers', async () => [{ Id: 'limited', State: state, Status: status }]);
  t.mock.method(docker, 'info', async () => ({ NCPU: 4 }));
  t.mock.method(docker, 'getContainer', () => ({
    inspect: async () => { inspections++; return { HostConfig: { Memory: 1073741824, CpuQuota: 150000, CpuPeriod: 100000, CpusetCpus: '0-1' }, RestartCount: 3, State: { Health: { Status: 'healthy' }, OOMKilled: true } }; },
    stats: async () => ({ memory_stats: { usage: 10, limit: 1073741824 } }),
  }));
  let [row] = (await sampleContainers(host.id, 0)).containers;
  assert.equal(row.configuredMemory, 1073741824); assert.equal(row.configuredCpu, 1.5); assert.equal(row.cpuSet, '0-1');
  assert.equal(row.restartCount, 3); assert.equal(row.oomKilled, true); assert.equal(row.detailsReady, true);
  status = 'Up (unhealthy)';
  [row] = (await sampleContainers(host.id, 0)).containers;
  assert.equal(inspections, 1); assert.equal(row.health, 'unhealthy');
  status = 'Up (health: starting)';
  [row] = (await sampleContainers(host.id, 0)).containers;
  assert.equal(row.health, 'starting');
  state = 'exited';
  t.mock.method(docker, 'getContainer', () => ({ inspect: async () => { throw new Error('unavailable'); } }));
  [row] = (await sampleContainers(host.id, 0)).containers;
  assert.equal(row.detailsReady, false); assert.equal(row.configuredMemory, undefined);
});
