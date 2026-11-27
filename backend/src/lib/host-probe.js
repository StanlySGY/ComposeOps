import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
// Fixed commands only. Also works over SSH without Node, Python or an installed agent.
export const HOST_PROBE_COMMAND = [
  'export LC_ALL=C',
  ...Object.entries({ stat: '/proc/stat', memory: '/proc/meminfo', network: '/proc/net/dev', route: '/proc/net/route', disks: '/proc/diskstats', mounts: '/proc/self/mountinfo', uptime: '/proc/uptime', load: '/proc/loadavg', hostname: '/proc/sys/kernel/hostname', kernel: '/proc/sys/kernel/osrelease', boot: '/proc/sys/kernel/random/boot_id' })
    .flatMap(([key, file]) => [`printf '\\n@@${key}\\n'`, `cat ${file} 2>/dev/null`]),
  "printf '\\n@@space\\n'", 'df -P -k -l 2>/dev/null',
  "printf '\\n@@inodes\\n'", 'df -P -i -l 2>/dev/null',
].join('; ');

const num = value => Number.isFinite(Number(value)) ? Number(value) : null;
const unescapeMount = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

export function parseHostProbe(text, sampledAt = Date.now()) {
  const parts = {};
  for (const section of String(text).split(/\n@@/).slice(1)) {
    const index = section.indexOf('\n'); parts[section.slice(0, index)] = section.slice(index + 1).trim();
  }
  if (!parts.stat?.startsWith('cpu ') || !parts.memory?.includes('MemTotal:')) throw new Error('节点不支持 Linux 宿主指标');
  const ticks = parts.stat.split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
  const memory = Object.fromEntries(parts.memory.split('\n').map(line => { const [key, value] = line.split(/:\s*/); return [key, Number(value.split(' ')[0]) * 1024]; }));
  const interfaces = (parts.network || '').split('\n').flatMap(line => {
    const match = line.match(/^\s*([^:]+):\s*(.*)$/); if (!match) return [];
    const values = match[2].trim().split(/\s+/).map(Number); return [{ name: match[1], rx: values[0], tx: values[8] }];
  });
  const defaultInterfaces = new Set((parts.route || '').split('\n').slice(1).filter(line => line.trim().split(/\s+/)[1] === '00000000').map(line => line.trim().split(/\s+/)[0]));
  const selected = interfaces.filter(item => defaultInterfaces.size ? defaultInterfaces.has(item.name) : !/^(lo$|veth|docker|br-|virbr|tun|tap)/.test(item.name));
  const mounts = (parts.mounts || '').split('\n').flatMap(line => {
    const [head, tail] = line.split(' - '); if (!tail) return [];
    const fields = head.split(' '), end = tail.split(' ');
    return [{ device: fields[2], root: unescapeMount(fields[3]), mountpoint: unescapeMount(fields[4]), type: end[0], source: unescapeMount(end[1] || '') }];
  });
  const parseDf = section => (parts[section] || '').split('\n').slice(1).flatMap(line => {
    const match = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d-]+)%?\s+(.+)$/);
    return match ? [{ source: match[1], total: +match[2], used: +match[3], free: +match[4], percent: num(match[5]), mountpoint: unescapeMount(match[6]) }] : [];
  });
  const inodeRows = parseDf('inodes');
  const seen = new Set();
  const filesystems = parseDf('space').flatMap(row => {
    const mount = mounts.find(item => item.mountpoint === row.mountpoint);
    if (!mount || /^(tmpfs|devtmpfs|overlay|squashfs|proc|sysfs|cgroup2?|nsfs|tracefs|debugfs|ramfs|autofs|fusectl|efivarfs|securityfs|pstore|configfs|hugetlbfs|mqueue|devpts|bpf)$/.test(mount.type) || row.total <= 0) return [];
    const key = `${mount.device}:${mount.type}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const inode = inodeRows.find(item => item.mountpoint === row.mountpoint);
    return [{ ...mount, aliases: mounts.filter(item => item.device === mount.device && item.type === mount.type).map(item => ({ mountpoint: item.mountpoint, root: item.root })), total: row.total * 1024, used: row.used * 1024, free: row.free * 1024, percent: row.percent, inodePercent: inode?.total > 0 ? inode.percent : null }];
  });
  const diskCounters = (parts.disks || '').split('\n').flatMap(line => {
    const f = line.trim().split(/\s+/); if (f.length < 14 || /^(loop|ram)/.test(f[2])) return [];
    return [{ device: `${f[0]}:${f[1]}`, name: f[2], read: +f[5] * 512, write: +f[9] * 512 }];
  });
  return { sampledAt, hostname: parts.hostname, kernel: parts.kernel, bootId: parts.boot,
    scope: /microsoft|wsl/i.test(parts.kernel) ? 'wsl' : 'linux',
    cpu: { total: ticks.reduce((a, b) => a + b, 0), idle: (ticks[3] || 0) + (ticks[4] || 0), cores: parts.stat.split('\n').filter(line => /^cpu\d+ /.test(line)).length },
    memory: { total: memory.MemTotal, available: memory.MemAvailable ?? null, cached: memory.Cached || 0, swapTotal: memory.SwapTotal || 0, swapUsed: Math.max(0, (memory.SwapTotal || 0) - (memory.SwapFree || 0)) },
    network: selected, filesystems, diskCounters, uptime: num(parts.uptime?.split(' ')[0]), loadavg: (parts.load || '').split(' ').slice(0, 3).map(Number) };
}

export async function collectHostProbe() {
  const { stdout } = await run('sh', ['-c', HOST_PROBE_COMMAND], { timeout: 8000, maxBuffer: 2 * 1024 * 1024 });
  return parseHostProbe(stdout);
}

export function counterRate(value, previous, seconds) {
  return Number.isFinite(value) && Number.isFinite(previous) && value >= previous && seconds > 0 ? (value - previous) / seconds : null;
}

export function hostSnapshot(raw, previous) {
  const elapsed = previous?.bootId === raw.bootId ? (raw.sampledAt - previous.sampledAt) / 1000 : 0;
  const total = elapsed > 0 ? raw.cpu.total - previous.cpu.total : 0;
  const idle = elapsed > 0 ? raw.cpu.idle - previous.cpu.idle : 0;
  const cpu = total > 0 && idle >= 0 ? Math.max(0, Math.min(100, (total - idle) / total * 100)) : null;
  const interfaces = raw.network.map(item => { const last = previous?.network?.find(old => old.name === item.name); return { name: item.name, rx: counterRate(item.rx, last?.rx, elapsed), tx: counterRate(item.tx, last?.tx, elapsed) }; });
  const sum = key => interfaces.length && interfaces.every(item => item[key] != null) ? interfaces.reduce((n, item) => n + item[key], 0) : null;
  const disks = raw.filesystems.map(item => {
    const current = raw.diskCounters.find(disk => disk.device === item.device), last = previous?.diskCounters?.find(disk => disk.device === item.device);
    return { ...item, readRate: counterRate(current?.read, last?.read, elapsed), writeRate: counterRate(current?.write, last?.write, elapsed) };
  });
  const used = raw.memory.available == null ? null : Math.max(0, raw.memory.total - raw.memory.available);
  return { sampledAt: raw.sampledAt, hostname: raw.hostname, kernel: raw.kernel, scope: raw.scope, bootId: raw.bootId, uptime: raw.uptime,
    cpu: { percent: cpu, cores: raw.cpu.cores, loadavg: raw.loadavg },
    memory: { ...raw.memory, used, percent: used == null || !raw.memory.total ? null : used / raw.memory.total * 100 },
    network: { rx: sum('rx'), tx: sum('tx'), interfaces }, disks };
}
