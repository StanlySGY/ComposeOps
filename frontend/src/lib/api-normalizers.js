function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function metricOrNull(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeStorageSection(value, extra = {}) {
  const section = objectOrEmpty(value);
  return {
    ...extra,
    count: numberOrZero(section.count),
    total: numberOrZero(section.total),
    reclaimable: numberOrZero(section.reclaimable),
    ...Object.fromEntries(Object.entries(section).filter(([key]) => !['count', 'total', 'reclaimable'].includes(key))),
  };
}

export function normalizeStorageDf(value) {
  const data = objectOrEmpty(value);
  const disk = objectOrEmpty(data.disk);
  return {
    hostId: String(data.hostId || ''),
    hostName: String(data.hostName || ''),
    hostRevision: String(data.hostRevision || ''),
    estimated: data.estimated === true,
    checkedAt: numberOrZero(data.checkedAt),
    images: normalizeStorageSection(data.images),
    containers: normalizeStorageSection(data.containers),
    volumes: normalizeStorageSection(data.volumes, { orphans: numberOrZero(data.volumes?.orphans) }),
    buildCache: normalizeStorageSection(data.buildCache),
    total: numberOrZero(data.total),
    reclaimable: numberOrZero(data.reclaimable),
    disk: Object.keys(disk).length ? { free: numberOrZero(disk.free), total: numberOrZero(disk.total) } : null,
  };
}

export function normalizeDockerUsage(value) {
  const normalized = normalizeStorageDf(value);
  return {
    ...normalized,
    containers: { ...normalized.containers, count: numberOrZero(value?.containers?.count) },
    hostId: String(value?.hostId || ''),
    unavailableHosts: arrayOrEmpty(value?.unavailableHosts),
  };
}

export function normalizeMetrics(value) {
  const data = objectOrEmpty(value);
  const host = objectOrEmpty(data.host);
  const cpu = objectOrEmpty(host.cpu);
  const memory = objectOrEmpty(host.memory);
  const network = objectOrEmpty(data.network);
  return {
    ...data,
    host: {
      ...host,
      cpu: { percent: metricOrNull(cpu.percent), cores: metricOrNull(cpu.cores), loadavg: arrayOrEmpty(cpu.loadavg).map(metricOrNull).concat([null, null, null]).slice(0, 3) },
      memory: { total: metricOrNull(memory.total), used: metricOrNull(memory.used), free: metricOrNull(memory.free), percent: metricOrNull(memory.percent) },
      uptime: metricOrNull(host.uptime),
    },
    network: { ...network, rx: metricOrNull(network.rx), tx: metricOrNull(network.tx) },
    containers: arrayOrEmpty(data.containers),
    disk: arrayOrEmpty(data.disk),
  };
}

const EMPTY_COST_SUMMARY = {
  totalProjects: 0,
  totalContainers: 0,
  runningContainers: 0,
  totalCPUPercent: 0,
  totalMemoryMB: 0,
  totalImagesMB: 0,
  storageTotalMB: 0,
  reclaimableMB: 0,
};

export function normalizeCostReport(value) {
  const data = objectOrEmpty(value);
  const summary = objectOrEmpty(data.summary);
  const storage = normalizeStorageDf(data.storage);
  return {
    ...data,
    summary: { ...Object.fromEntries(Object.keys(EMPTY_COST_SUMMARY).map((key) => [key, numberOrZero(summary[key])])), incomplete: summary.incomplete === true },
    storage: {
      ...storage,
      images: { ...storage.images, active: numberOrZero(data.storage?.images?.active), sizeMB: numberOrZero(data.storage?.images?.sizeMB), reclaimableMB: numberOrZero(data.storage?.images?.reclaimableMB) },
      containers: { ...storage.containers, active: numberOrZero(data.storage?.containers?.active), sizeMB: numberOrZero(data.storage?.containers?.sizeMB) },
      volumes: { ...storage.volumes, active: numberOrZero(data.storage?.volumes?.active), sizeMB: numberOrZero(data.storage?.volumes?.sizeMB) },
      buildCache: { ...storage.buildCache, sizeMB: numberOrZero(data.storage?.buildCache?.sizeMB), reclaimableMB: numberOrZero(data.storage?.buildCache?.reclaimableMB) },
    },
    containers: arrayOrEmpty(data.containers).map((item) => ({ ...objectOrEmpty(item), totalCPUPercent: numberOrZero(item?.totalCPUPercent), totalMemoryMB: numberOrZero(item?.totalMemoryMB) })),
    images: arrayOrEmpty(data.images),
    projects: arrayOrEmpty(data.projects).map((item) => ({ ...objectOrEmpty(item), containerCount: numberOrZero(item?.containerCount), runningCount: numberOrZero(item?.runningCount), totalCPUPercent: numberOrZero(item?.totalCPUPercent), totalMemoryMB: numberOrZero(item?.totalMemoryMB) })),
    trends: arrayOrEmpty(data.trends).map((item) => ({ ...objectOrEmpty(item), totalCPUPercent: numberOrZero(item?.totalCPUPercent), totalMemoryMB: numberOrZero(item?.totalMemoryMB) })),
  };
}

export function normalizeMountPlan(value) {
  const data = objectOrEmpty(value);
  const summary = objectOrEmpty(data.summary);
  return {
    ...data,
    summary: {
      total: numberOrZero(summary.total),
      managed: numberOrZero(summary.managed),
      operable: numberOrZero(summary.operable),
      unmanaged: numberOrZero(summary.unmanaged),
      pending: numberOrZero(summary.pending),
      unsupported: numberOrZero(summary.unsupported),
    },
    projects: arrayOrEmpty(data.projects),
    pendingProjects: arrayOrEmpty(data.pendingProjects),
    unsupportedProjects: arrayOrEmpty(data.unsupportedProjects),
    mounts: arrayOrEmpty(data.mounts),
    parentSuggestions: arrayOrEmpty(data.parentSuggestions),
  };
}

export function normalizeBackgroundJob(value) {
  const data = objectOrEmpty(value);
  const items = arrayOrEmpty(data.items);
  return {
    ...data,
    id: data.id || '',
    action: data.action || '',
    status: data.status || 'unknown',
    total: numberOrZero(data.total || items.length),
    completed: numberOrZero(data.completed),
    items,
  };
}

export function normalizeJobsResponse(value) {
  const data = objectOrEmpty(value);
  return { ...data, jobs: arrayOrEmpty(data.jobs).map(normalizeBackgroundJob) };
}
