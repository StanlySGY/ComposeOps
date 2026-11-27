import { projects } from './fixtures.js';
const GiB = 1024 ** 3;
export function previewInfrastructure(path, params) {
  const now = Date.now();
  const containers = projects.flatMap(project => project.containers.map((item, i) => ({ ...item, hostId: 'local', projectId: project.id, projectName: project.projectName,
    cpuHostPercent: item.state === 'running' ? 3 + i * 2 : null, cpuPercent: item.state === 'running' ? 12 + i * 8 : null, memUsage: item.state === 'running' ? (i + 1) * .25 * GiB : null,
    networkRx: 35000, networkTx: 12000, diskRead: 4096, diskWrite: 2048 })));
  const disks = [{ device: '8:1', type: 'ext4', mountpoint: '/', total: 128 * GiB, used: 40 * GiB, free: 88 * GiB, percent: 31.25, inodePercent: 8, readRate: 4096, writeRate: 2048, services: [{ key: 'demo', projectId: projects[0].id, projectName: projects[0].projectName, service: projects[0].containers[1].service, containerId: projects[0].containers[1].id, source: '/var/lib/docker/volumes/demo/_data', volume: 'demo', type: 'volume' }] }];
  if (path.endsWith('/history')) {
    const hours = Number(params.get('hours') || 1), start = now - hours * 3600000;
    const percent = ['cpu', 'memory', 'diskPercent'].includes(params.get('metric'));
    return { hostId: 'local', start, end: now, interval: hours * 3600000 / 60, points: Array.from({ length: 60 }, (_, i) => ({ timestamp: start + i / 59 * (now - start), value: percent ? 25 + Math.sin(i / 4) * 8 : (250 + Math.sin(i / 4) * 80) * 1024, max: percent ? 37 : 380 * 1024, samples: 1, unit: percent ? '%' : 'bytes' })) };
  }
  if (path.endsWith('/storage')) return { hostId: 'local', status: 'ready', disks };
  return { checkedAt: now, interval: 10000, nodes: [{ hostId: 'local', name: '本机 · 示例', sampledAt: now, status: 'ready', engine: { cpus: 4 }, host: { sampledAt: now, status: 'ready', source: 'preview', scope: 'linux', cpu: { percent: 25, cores: 4 }, memory: { total: 8 * GiB, used: 3.4 * GiB, percent: 42.5, swapTotal: 2 * GiB, swapUsed: 0 }, network: { rx: 35000, tx: 12000, interfaces: [{ name: 'eth0' }] }, disks }, containers, services: containers.map(c => ({ ...c, key: `service:${c.projectId}:${c.service}`, name: c.service, total: 1, running: c.state === 'running' ? 1 : 0, containers: [c] })), alerts: [] }] };
}
