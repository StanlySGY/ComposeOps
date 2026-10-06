/**
 * 成本分析服务
 * 提供容器资源使用、存储占用、镜像大小分析
 */
import { getActivityDocker, getActiveHostId } from './docker-hosts.js';
import { scanProjects } from './scanner.js';
import { getSetting, setSetting } from '../lib/db.js';

// 成本扫描要逐容器拉 stats、跑 docker df,较慢;结果做 2 分钟 TTL 内存缓存(按活跃宿主分键),
// 成本页重复进入与后台预热不再反复全量扫描
const COST_CACHE_TTL_MS = 2 * 60 * 1000;
const costCache = new Map();
async function withCostCache(key, fetcher) {
  const cacheKey = `${getActiveHostId()}:${key}`;
  const hit = costCache.get(cacheKey);
  if (hit && Date.now() - hit.at < COST_CACHE_TTL_MS) return hit.value;
  const value = await fetcher();
  costCache.set(cacheKey, { at: Date.now(), value });
  if (costCache.size > 32) {
    const cutoff = Date.now() - COST_CACHE_TTL_MS;
    for (const [k, v] of costCache) if (v.at < cutoff) costCache.delete(k);
  }
  return value;
}

/**
 * 获取容器资源使用统计
 */
export function getContainerResourceStats() {
  return withCostCache('containers', fetchContainerResourceStats);
}
async function fetchContainerResourceStats() {
  try {
    const docker = getActivityDocker();
    const containers = await docker.listContainers({ all: true });
    const stats = [];
    for (const container of containers) {
      const projectName = container.Labels?.['com.docker.compose.project'] || 'unknown';
      const serviceName = container.Labels?.['com.docker.compose.service'] || container.Names[0]?.replace(/^\//, '');
      let cpuPercent = 0;
      let memoryUsage = 0;
      let memoryLimit = 0;
      if (container.State === 'running') {
        try {
          const containerObj = docker.getContainer(container.Id);
          const statStream = await containerObj.stats({ stream: false });
          const cpuDelta = statStream.cpu_stats.cpu_usage.total_usage - statStream.precpu_stats.cpu_usage.total_usage;
          const systemDelta = statStream.cpu_stats.system_cpu_usage - statStream.precpu_stats.system_cpu_usage;
          const cpuCount = statStream.cpu_stats.online_cpus || 1;
          if (systemDelta > 0) {
            cpuPercent = (cpuDelta / systemDelta) * cpuCount * 100;
          }
          memoryUsage = statStream.memory_stats.usage || 0;
          memoryLimit = statStream.memory_stats.limit || 0;
        } catch {
          // 无法获取统计信息，保持默认值
        }
      }
      stats.push({
        containerId: container.Id.substring(0, 12),
        containerName: serviceName,
        projectName,
        state: container.State,
        cpuPercent: Math.round(cpuPercent * 100) / 100,
        memoryUsageMB: Math.round(memoryUsage / 1024 / 1024 * 100) / 100,
        memoryLimitMB: Math.round(memoryLimit / 1024 / 1024 * 100) / 100,
        created: container.Created
      });
    }
    return stats;
  } catch {
    return [];
  }
}

/**
 * 获取镜像大小统计
 */
export function getImageSizeStats() {
  return withCostCache('images', fetchImageSizeStats);
}
async function fetchImageSizeStats() {
  try {
    const docker = getActivityDocker();
    const images = await docker.listImages();
    const stats = images.map(image => ({
      id: image.Id.replace(/^sha256:/, '').substring(0, 12),
      tags: image.RepoTags || ['<none>'],
      sizeMB: Math.round(image.Size / 1024 / 1024 * 100) / 100,
      created: image.Created
    }));
    stats.sort((a, b) => b.sizeMB - a.sizeMB);
    return stats;
  } catch {
    return [];
  }
}

/**
 * 获取存储使用统计
 */
export function getStorageStats() {
  return withCostCache('storage', fetchStorageStats);
}
async function fetchStorageStats() {
  try {
    const docker = getActivityDocker();
    const dfOutput = await docker.df();
    return {
      images: {
        active: dfOutput.Images?.filter(i => i.Containers > 0).length || 0,
        total: dfOutput.Images?.length || 0,
        sizeMB: Math.round((dfOutput.Images?.reduce((sum, i) => sum + (i.Size || 0), 0) || 0) / 1024 / 1024 * 100) / 100,
        reclaimableMB: Math.round((dfOutput.LayersSize || 0) / 1024 / 1024 * 100) / 100
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
  } catch {
    return {
      images: { active: 0, total: 0, sizeMB: 0, reclaimableMB: 0 },
      containers: { active: 0, total: 0, sizeMB: 0 },
      volumes: { active: 0, total: 0, sizeMB: 0 },
      buildCache: { sizeMB: 0, reclaimableMB: 0 }
    };
  }
}

/**
 * 获取项目成本汇总
 */
export function getProjectCostSummary() {
  return withCostCache('projects', fetchProjectCostSummary);
}
async function fetchProjectCostSummary() {
  const projects = (await scanProjects()).filter((project) => project.managed);
  const containerStats = await getContainerResourceStats();
  
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
export function getCostTrends(days = 7) {
  const raw = getSetting('cost.trends') || '[]';
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
export async function recordCostSnapshot() {
  const [containers, images, storage, _projects] = await Promise.all([
    getContainerResourceStats(),
    getImageSizeStats(),
    getStorageStats(),
    getProjectCostSummary()
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
  
  const trends = getCostTrends(30); // 保留 30 天
  trends.push(snapshot);
  
  // 限制最多 720 条记录（每小时一条，30 天）
  if (trends.length > 720) {
    trends.splice(0, trends.length - 720);
  }
  
  setSetting('cost.trends', JSON.stringify(trends));
  
  return snapshot;
}

/**
 * 获取完整成本分析报告
 */
export function getCostAnalysisReport() {
  return withCostCache('report', fetchCostAnalysisReport);
}
async function fetchCostAnalysisReport() {
  const [containers, images, storage, projects, trends] = await Promise.all([
    getContainerResourceStats(),
    getImageSizeStats(),
    getStorageStats(),
    getProjectCostSummary(),
    Promise.resolve(getCostTrends(7))
  ]);
  
  return {
    summary: {
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
