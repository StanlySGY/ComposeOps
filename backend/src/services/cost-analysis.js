/**
 * 成本分析服务
 * 提供容器资源使用、存储占用、镜像大小分析
 */
import { getDockerForHost, getActiveHostId, onHostsChange } from './docker-hosts.js';
import { scanProjects } from './scanner.js';
import { getSetting, setSetting } from '../lib/db.js';
import { readDockerDiskUsage } from './docker-disk-usage.js';

// 成本扫描要逐容器拉 stats、跑 docker df,较慢;结果做 2 分钟 TTL 内存缓存(按活跃宿主分键),
// 成本页重复进入与后台预热不再反复全量扫描
const COST_CACHE_TTL_MS = 2 * 60 * 1000;
const costCache = new Map();
const costPending = new Map();
onHostsChange(id => {
  for (const cache of [costCache, costPending]) {
    for (const key of cache.keys()) if (key.startsWith(`${id}:`)) cache.delete(key);
  }
});
async function withCostCache(key, fetcher, hostId) {
  const cacheKey = `${hostId}:${key}`;
  const hit = costCache.get(cacheKey);
  if (hit && Date.now() - hit.at < COST_CACHE_TTL_MS) return hit.value;
  if (costPending.has(cacheKey)) return costPending.get(cacheKey);
  const pending = fetcher(hostId).then(value => {
    if (costPending.get(cacheKey) === pending) costCache.set(cacheKey, { at: Date.now(), value });
    if (costCache.size > 64) costCache.delete(costCache.keys().next().value);
    return value;
  }).finally(() => { if (costPending.get(cacheKey) === pending) costPending.delete(cacheKey); });
  costPending.set(cacheKey, pending);
  return pending;
}
async function dockerRead(hostId, callback, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await callback(getDockerForHost(hostId), controller.signal); }
  catch (cause) { throw Object.assign(new Error('节点成本数据暂不可用，请检查连接后重试', { cause }), { statusCode: 503 }); }
  finally { clearTimeout(timer); }
}
async function mapConcurrent(items, fn) {
  const results = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, 6) }, async () => {
    while (index < items.length) { const current = index++; results[current] = await fn(items[current]); }
  }));
  return results;
}

/**
 * 获取容器资源使用统计
 */
export function getContainerResourceStats(hostId = getActiveHostId()) {
  return withCostCache('containers', fetchContainerResourceStats, hostId);
}
async function fetchContainerResourceStats(hostId) {
  return dockerRead(hostId, async (docker, abortSignal) => {
    const containers = await docker.listContainers({ all: true, abortSignal });
    return mapConcurrent(containers, async container => {
      const projectName = container.Labels?.['com.docker.compose.project'] || 'unknown';
      const serviceName = container.Labels?.['com.docker.compose.service'] || container.Names[0]?.replace(/^\//, '');
      let statsAvailable = container.State !== 'running';
      let cpuPercent = 0;
      let memoryUsage = 0;
      let memoryLimit = 0;
      if (container.State === 'running') {
        try {
          const containerObj = docker.getContainer(container.Id);
          const statStream = await containerObj.stats({ stream: false, abortSignal });
          const cpuDelta = statStream.cpu_stats.cpu_usage.total_usage - statStream.precpu_stats.cpu_usage.total_usage;
          const systemDelta = statStream.cpu_stats.system_cpu_usage - statStream.precpu_stats.system_cpu_usage;
          const cpuCount = statStream.cpu_stats.online_cpus || 1;
          if (systemDelta > 0) {
            cpuPercent = (cpuDelta / systemDelta) * cpuCount * 100;
          }
          memoryUsage = statStream.memory_stats.usage || 0;
          memoryLimit = statStream.memory_stats.limit || 0;
          statsAvailable = true;
        } catch {
          // 无法获取统计信息，保持默认值
        }
      }
      return {
        statsAvailable,
        containerId: container.Id.substring(0, 12),
        containerName: serviceName,
        projectName,
        state: container.State,
        cpuPercent: Math.round(cpuPercent * 100) / 100,
        memoryUsageMB: Math.round(memoryUsage / 1024 / 1024 * 100) / 100,
        memoryLimitMB: Math.round(memoryLimit / 1024 / 1024 * 100) / 100,
        created: container.Created
      };
    });
  });
}

/**
 * 获取镜像大小统计
 */
export function getImageSizeStats(hostId = getActiveHostId()) {
  return withCostCache('images', fetchImageSizeStats, hostId);
}
async function fetchImageSizeStats(hostId) {
  return dockerRead(hostId, async (docker, abortSignal) => {
    const images = await docker.listImages({ abortSignal });
    const stats = images.map(image => ({
      id: image.Id.replace(/^sha256:/, '').substring(0, 12),
      tags: image.RepoTags || ['<none>'],
      sizeMB: Math.round(image.Size / 1024 / 1024 * 100) / 100,
      created: image.Created
    }));
    stats.sort((a, b) => b.sizeMB - a.sizeMB);
    return stats;
  });
}

/**
 * 获取存储使用统计
 */
export function getStorageStats(hostId = getActiveHostId()) {
  return withCostCache('storage', fetchStorageStats, hostId);
}
async function fetchStorageStats(hostId) {
  try {
    const dfOutput = await readDockerDiskUsage(hostId);
    // LayersSize is total storage, not reclaimable storage. Match the Engine
    // disk-usage estimate by subtracting unique layers of referenced images.
    const layersSize = Math.max(0, Number(dfOutput.LayersSize) || 0);
    const usedUnique = (dfOutput.Images || []).filter(image => image.Containers > 0 && image.Size >= 0 && image.SharedSize >= 0)
      .reduce((sum, image) => sum + Math.max(0, (Number(image.Size) || 0) - Math.max(0, Number(image.SharedSize) || 0)), 0);
    return {
      images: {
        active: dfOutput.Images?.filter(i => i.Containers > 0).length || 0,
        total: dfOutput.Images?.length || 0,
        sizeMB: Math.round(layersSize / 1024 / 1024 * 100) / 100,
        reclaimableMB: Math.round(Math.max(0, layersSize - usedUnique) / 1024 / 1024 * 100) / 100
      },
      containers: {
        active: dfOutput.Containers?.filter(c => c.State === 'running').length || 0,
        total: dfOutput.Containers?.length || 0,
        sizeMB: Math.round((dfOutput.Containers?.reduce((sum, c) => sum + (c.SizeRw || 0), 0) || 0) / 1024 / 1024 * 100) / 100
      },
      volumes: {
        active: dfOutput.Volumes?.filter(v => v.UsageData?.RefCount > 0).length || 0,
        total: dfOutput.Volumes?.length || 0,
        sizeMB: Math.round((dfOutput.Volumes?.reduce((sum, v) => sum + (v.UsageData?.Size || 0), 0) || 0) / 1024 / 1024 * 100) / 100
      },
      buildCache: {
        sizeMB: Math.round((dfOutput.BuildCache?.reduce((sum, b) => sum + (b.Size || 0), 0) || 0) / 1024 / 1024 * 100) / 100,
        reclaimableMB: Math.round((dfOutput.BuildCache?.filter(b => b.InUse === false).reduce((sum, b) => sum + (b.Size || 0), 0) || 0) / 1024 / 1024 * 100) / 100
      }
    };
  } catch (cause) { throw Object.assign(new Error('节点成本数据暂不可用，请检查连接后重试', { cause }), { statusCode: 503 }); }
}

/**
 * 获取项目成本汇总
 */
export function getProjectCostSummary(hostId = getActiveHostId()) {
  return withCostCache('projects', fetchProjectCostSummary, hostId);
}
async function fetchProjectCostSummary(hostId) {
  // 成本页是只读视图,应覆盖服务页发现的全部 Compose 项目。纳管权限只限制
  // 控制与配置操作,不应该让未纳管项目在排行中消失。
  const [projects, containerStats] = await Promise.all([
    scanProjects(hostId, { background: true }), getContainerResourceStats(hostId),
  ]);
  
  const summary = projects.map(project => {
    const projectContainers = containerStats.filter(c => c.projectName === project.projectName);
    
    const totalCPU = projectContainers.reduce((sum, c) => sum + c.cpuPercent, 0);
    const totalMemory = projectContainers.reduce((sum, c) => sum + c.memoryUsageMB, 0);
    const runningCount = projectContainers.filter(c => c.state === 'running').length;
    
    return {
      projectId: project.id,
      projectName: project.projectName,
      containerCount: projectContainers.length,
      runningCount,
      totalCPUPercent: Math.round(totalCPU * 100) / 100,
      totalMemoryMB: Math.round(totalMemory * 100) / 100
    };
  });
  
  // 按内存使用排序
  summary.sort((a, b) => b.totalMemoryMB - a.totalMemoryMB);
  
  return summary;
}

/**
 * 获取成本趋势数据（历史记录）
 */
export function getCostTrends(days = 7, hostId = getActiveHostId()) {
  const legacy = hostId === getSetting('projects.legacy_host_id', 'local') ? getSetting('cost.trends') : null;
  const raw = getSetting(`cost.trends.${hostId}`) || legacy || '[]';
  try {
    const trends = JSON.parse(raw);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return trends.filter(t => t.timestamp >= cutoff);
  } catch {
    return [];
  }
}

/**
 * 记录成本快照
 */
export async function recordCostSnapshot(hostId = getActiveHostId()) {
  const [containers, images, storage, _projects] = await Promise.all([
    getContainerResourceStats(hostId),
    getImageSizeStats(hostId),
    getStorageStats(hostId),
    getProjectCostSummary(hostId)
  ]);
  
  const snapshot = {
    timestamp: Date.now(),
    totalContainers: containers.length,
    runningContainers: containers.filter(c => c.state === 'running').length,
    totalCPUPercent: Math.round(containers.reduce((sum, c) => sum + c.cpuPercent, 0) * 100) / 100,
    totalMemoryMB: Math.round(containers.reduce((sum, c) => sum + c.memoryUsageMB, 0) * 100) / 100,
    totalImagesMB: images.reduce((sum, i) => sum + i.sizeMB, 0),
    storageTotalMB: storage.images.sizeMB + storage.containers.sizeMB + storage.volumes.sizeMB
  };
  
  const trends = getCostTrends(30, hostId); // 保留 30 天
  trends.push(snapshot);
  
  // 限制最多 720 条记录（每小时一条，30 天）
  if (trends.length > 720) {
    trends.splice(0, trends.length - 720);
  }
  
  setSetting(`cost.trends.${hostId}`, JSON.stringify(trends));
  
  return snapshot;
}

/**
 * 获取完整成本分析报告
 */
export function getCostAnalysisReport(hostId = getActiveHostId()) {
  return withCostCache('report', fetchCostAnalysisReport, hostId);
}
async function fetchCostAnalysisReport(hostId) {
  const [containers, images, storage, projects, trends] = await Promise.all([
    getContainerResourceStats(hostId),
    getImageSizeStats(hostId),
    getStorageStats(hostId),
    getProjectCostSummary(hostId),
    Promise.resolve(getCostTrends(7, hostId))
  ]);
  
  return {
    summary: {
      incomplete: containers.some(c => !c.statsAvailable),
      totalProjects: projects.length,
      totalContainers: containers.length,
      runningContainers: containers.filter(c => c.state === 'running').length,
      totalCPUPercent: Math.round(containers.reduce((sum, c) => sum + c.cpuPercent, 0) * 100) / 100,
      totalMemoryMB: Math.round(containers.reduce((sum, c) => sum + c.memoryUsageMB, 0) * 100) / 100,
      totalImagesMB: Math.round(images.reduce((sum, i) => sum + i.sizeMB, 0) * 100) / 100,
      storageTotalMB: Math.round((storage.images.sizeMB + storage.containers.sizeMB + storage.volumes.sizeMB) * 100) / 100,
      reclaimableMB: Math.round((storage.images.reclaimableMB + storage.buildCache.reclaimableMB) * 100) / 100
    },
    containers,
    images: images.slice(0, 20), // 前 20 个最大镜像
    storage,
    projects,
    trends
  };
}

/**
 * 获取优化建议
 */
export async function getOptimizationSuggestions() {
  const report = await getCostAnalysisReport();
  const suggestions = [];
  
  // 检查可回收存储
  if (report.storage.images.reclaimableMB > 1000) {
    suggestions.push({
      type: 'storage',
      severity: 'high',
      title: '可回收悬空镜像层过多',
      description: `发现 ${Math.round(report.storage.images.reclaimableMB)} MB 可回收空间`,
      action: '运行 docker system prune 清理'
    });
  }
  
  if (report.storage.buildCache.reclaimableMB > 500) {
    suggestions.push({
      type: 'storage',
      severity: 'medium',
      title: '构建缓存占用较大',
      description: `构建缓存占用 ${Math.round(report.storage.buildCache.reclaimableMB)} MB`,
      action: '定期清理构建缓存'
    });
  }
  
  // 检查未使用容器
  const stoppedContainers = report.containers.filter(c => c.state !== 'running');
  if (stoppedContainers.length > 5) {
    suggestions.push({
      type: 'cleanup',
      severity: 'low',
      title: '存在多个已停止容器',
      description: `发现 ${stoppedContainers.length} 个已停止容器`,
      action: '清理不再使用的容器'
    });
  }
  
  // 检查大镜像
  const largeImages = report.images.filter(i => i.sizeMB > 1000);
  if (largeImages.length > 0) {
    suggestions.push({
      type: 'optimization',
      severity: 'medium',
      title: '存在超大镜像',
      description: `发现 ${largeImages.length} 个超过 1GB 的镜像`,
      action: '考虑使用精简基础镜像或多阶段构建'
    });
  }
  
  // 检查高内存使用项目
  const highMemProjects = report.projects.filter(p => p.totalMemoryMB > 2000);
  if (highMemProjects.length > 0) {
    suggestions.push({
      type: 'resource',
      severity: 'medium',
      title: '部分项目内存使用较高',
      description: `${highMemProjects.map(p => p.projectName).join(', ')} 内存使用超过 2GB`,
      action: '检查是否存在内存泄漏或考虑增加资源限制'
    });
  }
  
  return suggestions;
}
