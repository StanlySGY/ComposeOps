const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const bytes = value => finite(value) ? value : 0;
const sum = (items, key) => items.reduce((total, item) => total + bytes(item[key]), 0);

/** Engine 1.52 exposes aggregate usage; older versions need estimates from
 * LayersSize and individual records. Categories may share underlying layers. */
export function summarizeDockerDiskUsage(data) {
  const valid = (key, aggregate) => Array.isArray(data?.[key]) || data?.[key] === null
    || Array.isArray(data?.[aggregate]?.Items) || (finite(data?.[aggregate]?.TotalSize) && finite(data?.[aggregate]?.TotalCount));
  if (!data || !valid('Images', 'ImageUsage') || !valid('Containers', 'ContainerUsage')) {
    throw Object.assign(new Error('Docker 空间统计结构不完整，请重新读取'), { statusCode: 502 });
  }
  const images = data.ImageUsage?.Items || data.Images || [];
  const containers = data.ContainerUsage?.Items || data.Containers || [];
  const volumes = data.VolumeUsage?.Items || data.Volumes || [];
  const cache = data.BuildCacheUsage?.Items || data.BuildCache || [];
  const layers = finite(data.LayersSize) ? data.LayersSize : sum(images, 'Size');
  const usedUnique = images.filter(image => image.Containers > 0 && finite(image.Size) && finite(image.SharedSize))
    .reduce((total, image) => total + Math.max(0, image.Size - image.SharedSize), 0);
  const fallbackImages = finite(data.LayersSize) ? Math.max(0, layers - usedUnique) : sum(images.filter(image => image.Containers === 0), 'Size');
  function section(aggregate, fallback) {
    return {
      ...fallback,
      count: finite(aggregate?.TotalCount) ? aggregate.TotalCount : fallback.count,
      active: finite(aggregate?.ActiveCount) ? aggregate.ActiveCount : fallback.active,
      total: finite(aggregate?.TotalSize) ? aggregate.TotalSize : fallback.total,
      reclaimable: finite(aggregate?.Reclaimable) ? aggregate.Reclaimable : fallback.reclaimable,
    };
  }
  const result = {
    images: section(data.ImageUsage, { count: images.length, active: images.filter(i => i.Containers > 0).length, total: layers, reclaimable: fallbackImages }),
    containers: section(data.ContainerUsage, { count: containers.length, active: containers.filter(c => ['running', 'paused', 'restarting'].includes(c.State)).length,
      stopped: containers.filter(c => ['exited', 'created', 'dead'].includes(c.State)).length, total: sum(containers, 'SizeRw'),
      reclaimable: sum(containers.filter(c => ['exited', 'created', 'dead'].includes(c.State)), 'SizeRw') }),
    volumes: section(data.VolumeUsage, { count: volumes.length, active: volumes.filter(v => v.UsageData?.RefCount > 0).length,
      total: volumes.reduce((total, v) => total + bytes(v.UsageData?.Size), 0),
      reclaimable: volumes.filter(v => v.UsageData?.RefCount === 0).reduce((total, v) => total + bytes(v.UsageData?.Size), 0),
      orphans: volumes.filter(v => v.UsageData?.RefCount === 0).length,
      unknown: volumes.filter(v => !finite(v.UsageData?.RefCount) || !finite(v.UsageData?.Size)).length }),
    buildCache: section(data.BuildCacheUsage, { count: cache.length, active: cache.filter(c => c.InUse).length,
      total: sum(cache, 'Size'), reclaimable: sum(cache.filter(c => c.InUse === false), 'Size') }),
  };
  result.total = Object.values(result).reduce((total, section) => total + section.total, 0);
  result.reclaimable = Object.values(result).filter(value => value && typeof value === 'object').reduce((total, section) => total + section.reclaimable, 0);
  result.estimated = !['ImageUsage', 'ContainerUsage', 'VolumeUsage', 'BuildCacheUsage'].every(key => finite(data[key]?.TotalSize) && finite(data[key]?.Reclaimable));
  return result;
}
