import os from 'node:os';
import { readFile, stat, statfs } from 'node:fs/promises';

const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const sum = values => values.every(value => finite(value) !== null) ? values.reduce((a, b) => a + b, 0) : null;

export function parsePanelNetwork(devices, routes) {
  const routed = new Set(String(routes).split('\n').slice(1)
    .map(line => line.trim().split(/\s+/)).filter(row => row[1] === '00000000').map(row => row[0]));
  const interfaces = String(devices).split('\n').flatMap(line => {
    const colon = line.indexOf(':'); if (colon < 0) return [];
    const name = line.slice(0, colon).trim(), fields = line.slice(colon + 1).trim().split(/\s+/);
    if (routed.size ? !routed.has(name) : /^(lo$|veth|docker|br-|virbr|tun|tap)/.test(name)) return [];
    const rx = finite(Number(fields[0])), tx = finite(Number(fields[8]));
    return fields.length >= 16 && rx !== null && tx !== null ? [{ name, rx, tx }] : [];
  });
  return interfaces.length ? { interfaces, rxTotal: sum(interfaces.map(item => item.rx)), txTotal: sum(interfaces.map(item => item.tx)),
    scope: routed.size ? 'default-route' : 'non-virtual-interfaces' } : null;
}

function bounded(read, timeoutMs) {
  let timer;
  return Promise.race([Promise.resolve().then(read), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('面板环境读取超时')), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

/** The panel's OS namespace is deliberately separate from any selected Docker
 * host. Share concurrent reads and never run a blocking df subprocess. */
export function createPanelMetricsReader({ system = os, read = readFile, fileStat = stat, diskStat = statfs,
  now = Date.now, cacheMs = 1000, timeoutMs = 1500 } = {}) {
  let previousCpu, previousNet, cached, pending;
  return function readPanelMetrics() {
    if (pending) return pending;
    if (cached && now() - cached.sampledAt < cacheMs) return Promise.resolve(cached);
    pending = (async () => {
      const sampledAt = now();
      const host = { scope: 'panel-environment', sampledAt,
        note: '面板所在操作系统视角，可能包含共享宿主资源，不代表 ComposeOps 容器配额；内存按总量减空闲量计算。',
        cpu: { percent: null, cores: null, loadavg: [null, null, null] },
        memory: { total: null, used: null, free: null, percent: null }, uptime: null, hostname: null, platform: null };
      try {
        const cpus = system.cpus();
        const total = sum(cpus.flatMap(cpu => Object.values(cpu.times))), idle = sum(cpus.map(cpu => cpu.times.idle));
        const old = previousCpu;
        const delta = old && total !== null && old.total !== null ? total - old.total : null;
        const idleDelta = old && idle !== null && old.idle !== null ? idle - old.idle : null;
        host.cpu = { cores: cpus.length || null, loadavg: system.loadavg().slice(0, 3).map(finite),
          percent: old && old.cores === cpus.length && delta > 0 && idleDelta >= 0 && idleDelta <= delta
            ? Math.round((delta - idleDelta) / delta * 1000) / 10 : null };
        previousCpu = { total, idle, cores: cpus.length };
      } catch { previousCpu = null; }
      try {
        const total = finite(system.totalmem()), free = finite(system.freemem());
        const used = total !== null && free !== null && free <= total ? total - free : null;
        host.memory = { total, free, used, percent: total > 0 && used !== null ? Math.round(used / total * 1000) / 10 : null };
        host.uptime = finite(system.uptime()); host.hostname = system.hostname(); host.platform = `${system.type()} ${system.release()}`;
      } catch { /* Keep unknown fields explicit; OS metadata is optional. */ }

      const [netRead, diskRead] = await Promise.allSettled([
        bounded(async () => {
          const signal = AbortSignal.timeout(timeoutMs);
          const [devices, routes] = await Promise.all([read('/proc/net/dev', { encoding: 'utf8', signal }), read('/proc/net/route', { encoding: 'utf8', signal }).catch(() => '')]);
          return parsePanelNetwork(devices, routes);
        }, timeoutMs),
        bounded(async () => {
          const results = await Promise.allSettled(['/', '/var/lib/docker'].map(async mountpoint => {
            const [metadata, fs] = await Promise.all([fileStat(mountpoint), diskStat(mountpoint)]);
            const total = finite(fs.blocks * fs.bsize), free = finite(fs.bavail * fs.bsize), used = finite((fs.blocks - fs.bfree) * fs.bsize);
            if (!(total > 0) || free === null || used === null) throw new Error('文件系统数据不可用');
            return { device: metadata.dev, mountpoint, total, used, free, percent: used + free > 0 ? Math.round(used / (used + free) * 1000) / 10 : null };
          }));
          const seen = new Set();
          return results.flatMap(result => {
            if (result.status !== 'fulfilled' || seen.has(result.value.device)) return [];
            seen.add(result.value.device); return [result.value];
          });
        }, timeoutMs),
      ]);
      const current = netRead.status === 'fulfilled' ? netRead.value : null;
      const sameInterfaces = current && previousNet && current.interfaces.map(item => item.name).sort().join('\0') === previousNet.interfaces.map(item => item.name).sort().join('\0');
      const seconds = previousNet ? (sampledAt - previousNet.sampledAt) / 1000 : 0;
      const rate = key => {
        if (!sameInterfaces || seconds <= 0) return null;
        const deltas = current.interfaces.map(item => item[key] - previousNet.interfaces.find(old => old.name === item.name)[key]);
        const total = sum(deltas);
        return total === null ? null : Math.round(total / seconds);
      };
      const network = { rx: rate('rx'), tx: rate('tx'), rxTotal: current?.rxTotal ?? null, txTotal: current?.txTotal ?? null,
        interfaces: current?.interfaces.map(item => item.name) || [], scope: current?.scope || null,
        status: !current ? 'unavailable' : sameInterfaces && seconds > 0 ? 'ready' : 'pending' };
      previousNet = current ? { ...current, sampledAt } : null;
      const disk = diskRead.status === 'fulfilled' ? diskRead.value : [];
      cached = { sampledAt, host, disk, diskStatus: disk.length ? 'ready' : 'unavailable', network };
      return cached;
    })().finally(() => { pending = null; });
    return pending;
  };
}

export const readPanelMetrics = createPanelMetricsReader();
