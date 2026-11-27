export const resourcePeriods = [{ value: .25, label: '15 分钟' }, { value: 1, label: '1 小时' }, { value: 24, label: '24 小时' }, { value: 168, label: '7 天' }];
export function formatResourceBytes(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Math.max(0, Number(value));
  const power = n > 0 ? Math.max(0, Math.min(4, Math.floor(Math.log(n) / Math.log(1024)))) : 0;
  return `${(n / 1024 ** power).toFixed(power ? 1 : 0)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][power]}`;
}
export function metricValue(value, unit = '%') {
  if (value == null || !Number.isFinite(value)) return '—';
  return unit === '%' ? `${value.toFixed(1)}%` : `${formatResourceBytes(value)}${unit === 'bytes/s' ? '/s' : ''}`;
}
export function cockpitReturn(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^\/dashboard(?:\?|$)/.test(value)) return '/dashboard';
  const input = new URLSearchParams(value.split('?')[1] || ''), query = new URLSearchParams();
  for (const key of ['hostId', 'hours', 'metric', 'sort', 'q', 'resource', 'disk']) if (input.has(key)) query.set(key, input.get(key));
  return '/dashboard' + (query.size ? '?' + query.toString() : '');
}
export function serviceFocusLocation(item, returnTo) {
  return { path: '/services', query: { hostId: item.hostId, ...(item.projectId ? { focus: item.projectId } : {}), ...(item.service ? { service: item.service } : {}), ...(item.containerId || item.id ? { containerId: item.containerId || item.id } : {}), from: 'dashboard', returnTo: cockpitReturn(returnTo) } };
}
export function rankProjects(services, sort = 'cpu', query = '') {
  const keys = { cpu: 'cpuHostPercent', memory: 'memUsage', network: 'networkRx', disk: 'diskWrite' }, key = keys[sort] || keys.cpu;
  const groups = new Map();
  for (const row of services) {
    if (query && !`${row.projectName} ${row.name} ${(row.containers || []).map(c => c.name).join(' ')}`.toLowerCase().includes(query.toLowerCase())) continue;
    const id = row.projectId || 'standalone';
    if (!groups.has(id)) groups.set(id, { id, name: row.projectName || '独立容器', hostId: row.hostId, services: [] });
    groups.get(id).services.push(row);
  }
  return [...groups.values()].map(group => ({ ...group, value: group.services.every(row => row[key] != null) ? group.services.reduce((n, row) => n + row[key], 0) : null,
    services: [...group.services].sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1) || a.name.localeCompare(b.name)) }))
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.name.localeCompare(b.name));
}
/** Break the stroke at missing samples; never interpolate across an outage. */
export function trendSegments(points, interval, start, end, width = 640, height = 160) {
  const data = points.filter(p => Number.isFinite(p.value) && Number.isFinite(p.timestamp));
  const max = Math.max(1, ...data.map(p => p.max ?? p.value));
  const segments = []; let current = [], previous;
  for (const point of data) {
    if (previous && (point.firstSample ?? point.timestamp) - (previous.lastSample ?? previous.timestamp) > interval * 3) { if (current.length) segments.push(current); current = []; }
    const x = 42 + Math.max(0, Math.min(1, (point.timestamp - start) / Math.max(1, end - start))) * (width - 54);
    const y = height - 28 - Math.min(1, point.value / max) * (height - 44);
    current.push({ x, y, point }); previous = point;
  }
  if (current.length) segments.push(current);
  return { max, segments };
}
