function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
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
      cpu: { percent: numberOrZero(cpu.percent), cores: numberOrZero(cpu.cores), loadavg: arrayOrEmpty(cpu.loadavg).map(numberOrZero).concat([0, 0, 0]).slice(0, 3) },
      memory: { total: numberOrZero(memory.total), used: numberOrZero(memory.used), free: numberOrZero(memory.free), percent: numberOrZero(memory.percent) },
      uptime: numberOrZero(host.uptime),
    },
    network: { ...network, rx: numberOrZero(network.rx), tx: numberOrZero(network.tx) },
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
    summary: Object.fromEntries(Object.keys(EMPTY_COST_SUMMARY).map((key) => [key, numberOrZero(summary[key])])),
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
