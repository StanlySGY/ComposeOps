import { getActiveHostId, getDockerForHost } from './docker-hosts.js';
import { readDockerDiskUsage, invalidateDiskUsage } from './docker-disk-usage.js';
import { summarizeDockerDiskUsage } from '../lib/docker-storage-summary.js';
import { storageHostScope, assertStorageHostScope } from './storage-host-scope.js';
import { assertScheduledPruneHost, captureScheduledHost, assertScheduledHost } from './scheduled-host-scope.js';

function emptyDf() {
  return {
    images: { count: 0, total: 0, reclaimable: 0 },
    containers: { count: 0, total: 0, reclaimable: 0 },
    volumes: { count: 0, total: 0, reclaimable: 0, orphans: 0 },
    buildCache: { count: 0, total: 0, reclaimable: 0 },
    total: 0,
    reclaimable: 0,
  };
}

/**
 * 兼容多版本 docker system df 输出的解析器(纯函数,便于单测)。
 * 支持:
 *  - NDJSON:每行一个独立 JSON 对象(新版 Docker 常见),自动按 Type 聚合;
 *  - 单块 JSON:旧版 --format json 的 { "Images": [...], ... } 结构;
 *  - 带 WARNING / ANSI 前缀脏输出:先清洗再解析;
 *  - 空输出 / 全部失败:返回全 0 结构(绝不抛错)。
 * @param {string} raw docker 命令 stdout 原文
 * @returns {object} 与 parseDockerDf 相同的统计结构
 */
export function parseDockerDfOutput(raw) {
  const text = String(raw || '');
  // 1) 尝试整体 JSON
  const whole = tryParseJson(text);
  if (whole && (whole.Images || whole.Containers || whole.Volumes || whole.BuildCache)) {
    return parseDockerDf(whole);
  }
  // 2) NDJSON 逐行解析(每行可能是独立对象或数组)
  const lines = text
    .split(/\r?\n/)
    // eslint-disable-next-line no-control-regex -- 有意匹配 ANSI 转义序列
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter((line) => line && !/^WARNING/i.test(line) && !/^[=\s]*$/.test(line));
  if (lines.length) {
    const merged = mergeNdjsonLines(lines);
    if (merged) return parseDockerDf(merged);
    // 3) 纯文本表格回退(无 --format 的输出)
    const table = parseDockerDfTextTable(text);
    if (table) return table;
  }
  // 4) 兜底:全 0 结构,杜绝 500
  console.debug('[docker-storage] docker system df 输出无法解析,返回空统计', text.slice(0, 200));
  return emptyDf();
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function mergeNdjsonLines(lines) {
  const merged = { Images: [], Containers: [], Volumes: [], BuildCache: [] };
  let matched = false;
  for (const line of lines) {
    let obj = tryParseJson(line);
    if (!obj) continue;
    if (Array.isArray(obj)) {
      for (const item of obj) if (item && typeof item === 'object') assignDfItem(merged, item);
      matched = true;
    } else if (typeof obj === 'object') {
      // NDJSON:新版 docker system df --format json 每行带 Type/Size/Reclaimable
      if (obj.Type) {
        assignDfItem(merged, obj);
        matched = true;
      } else if (obj.Images || obj.Containers || obj.Volumes || obj.BuildCache) {
        assignDfItem(merged, obj);
        matched = true;
      }
    }
  }
  return matched ? merged : null;
}

function assignDfItem(merged, item) {
  if (item.Images) { merged.Images = merged.Images.concat(Array.isArray(item.Images) ? item.Images : []); return; }
  if (item.Containers) { merged.Containers = merged.Containers.concat(Array.isArray(item.Containers) ? item.Containers : []); return; }
  if (item.Volumes) { merged.Volumes = merged.Volumes.concat(Array.isArray(item.Volumes) ? item.Volumes : []); return; }
  if (item.BuildCache) { merged.BuildCache = merged.BuildCache.concat(Array.isArray(item.BuildCache) ? item.BuildCache : []); return; }
  // NDJSON 行:映射为 parseDockerDf 可识别的内部结构
  // Docker CLI emits human-readable byte strings in NDJSON on current releases
  // (for example "28.76GB" and "25.81GB (89%)"); older releases emit numbers.
  const type = String(item.Type || '').toLowerCase().replace(/[^a-z]/g, '');
  const size = dfBytes(item.Size);
  const reclaim = dfBytes(item.Reclaimable);
  const totalCount = dfCount(item.TotalCount ?? item.Total);
  const activeCount = dfCount(item.Active ?? item.ActiveCount);
  if (type === 'images') {
    // 整块汇总:拆为可回收(Containers=0)与在用(Containers=1)两条
    merged.Images.push({ Size: reclaim, Containers: 0 });
    if (size - reclaim > 0) merged.Images.push({ Size: size - reclaim, Containers: 1 });
    recordDfSummary(merged, 'images', totalCount, activeCount);
  } else if (type === 'containers') {
    merged.Containers.push({ SizeRw: reclaim, State: 'exited' });
    if (size - reclaim > 0) merged.Containers.push({ SizeRw: size - reclaim, State: 'running' });
    recordDfSummary(merged, 'containers', totalCount, activeCount);
  } else if (type === 'volumes' || type === 'localvolumes') {
    merged.Volumes.push({ Name: String(item.Name || 'volume'), UsageData: { Size: reclaim, RefCount: 0 } });
    if (size - reclaim > 0) merged.Volumes.push({ Name: String(item.Name || 'volume') + '-used', UsageData: { Size: size - reclaim, RefCount: 1 } });
    recordDfSummary(merged, 'volumes', totalCount, activeCount);
  } else if (type === 'buildcache') {
    merged.BuildCache.push({ Size: reclaim, InUse: false });
    if (size - reclaim > 0) merged.BuildCache.push({ Size: size - reclaim, InUse: true });
    recordDfSummary(merged, 'buildCache', totalCount, activeCount);
  }
}

function dfBytes(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  return parseHumanBytes(value).total;
}

function dfCount(value) {
  if (value === undefined || value === null || value === '') return null;
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : null;
}

function recordDfSummary(merged, key, total, active) {
  if (total === null && active === null) return;
  merged.summary ||= {};
  const previous = merged.summary[key] || { count: 0, active: 0 };
  merged.summary[key] = {
    count: previous.count + (total ?? 0),
    active: previous.active + (active ?? 0),
    hasCount: previous.hasCount || total !== null,
    hasActive: previous.hasActive || active !== null,
  };
}

/**
 * 纯文本表格回退解析:docker system df(无 --format)输出形如:
 *   TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
 *   Images          5         2         1.2GB     800MB (66.6%)
 *   Containers      3         1         50MB      10MB (20%)
 *   Local Volumes   2         1         5MB       5MB (100%)
 *   Build Cache     4         0         0B        0B
 */
export function parseDockerDfTextTable(text) {
  const lines = String(text || '').split(/\r?\n/)
    // eslint-disable-next-line no-control-regex -- 有意匹配 ANSI 转义序列
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter((line) => line && !/^WARNING/i.test(line));
  const headerIdx = lines.findIndex((line) => /TYPE.*TOTAL.*ACTIVE.*SIZE.*RECLAIMABLE/i.test(line));
  if (headerIdx < 0) return null;
  const stats = emptyDf();
  const setter = {
    Images: (total, size, reclaim) => { stats.images.count = total; stats.images.total = size; stats.images.reclaimable = reclaim; },
    Containers: (total, size, reclaim) => { stats.containers.count = total; stats.containers.total = size; stats.containers.reclaimable = reclaim; },
    'Local Volumes': (total, size, reclaim) => { stats.volumes.count = total; stats.volumes.total = size; stats.volumes.reclaimable = reclaim; },
    'Build Cache': (total, size, reclaim) => { stats.buildCache.count = total; stats.buildCache.total = size; stats.buildCache.reclaimable = reclaim; },
  };
  for (const line of lines.slice(headerIdx + 1)) {
    const parts = line.split(/\s{2,}|\t+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 5) continue;
    const typeKey = parts[0];
    if (!(typeKey in setter)) continue;
    const total = Number(parts[1]) || 0;
    // 列序:TOTAL ACTIVE SIZE RECLAIMABLE
    const size = parseHumanBytes(parts[3] || '0B');
    const reclaim = parseHumanBytes(parts[4] || '0B');
    setter[typeKey](total, size.total, reclaim.total);
  }
  stats.total = stats.images.total + stats.containers.total + stats.volumes.total + stats.buildCache.total;
  stats.reclaimable = stats.images.reclaimable + stats.containers.reclaimable + stats.volumes.reclaimable + stats.buildCache.reclaimable;
  return stats;
}

/** "1.2GB" / "800MB" / "0B" → 字节数 */
function parseHumanBytes(value) {
  // 容忍尾部 "(66.6%)" 等括号内容:仅匹配前缀数字+单位
  const m = /^([\d.]+)\s*([KMGTP]?B)?/i.exec(String(value).trim());
  if (!m) return { total: 0, reclaimable: 0 };
  const num = Number(m[1]) || 0;
  const unit = (m[2] || 'B').toUpperCase();
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit] || 1;
  return { total: num * mult, reclaimable: num * mult };
}

/** 解析 docker system df --format json 为结构化统计(纯输出,便于单测)。 */
export function parseDockerDf(data = {}) {
  const summary = data.summary || {};
  const imagesTotal = sum(data.Images, 'Size') || 0;
  const imagesReclaimable = sum((data.Images || []).filter((item) => Number(item.Containers) <= 0), 'Size');
  const containersTotal = sum(data.Containers, 'SizeRw') || 0;
  const containersReclaimable = sum((data.Containers || []).filter((item) => item.State !== 'running'), 'SizeRw');
  const volumes = (data.Volumes || []).map((volume) => ({
    name: volume.Name || '',
    size: Number(volume.UsageData?.Size) || 0,
    refCount: Number(volume.UsageData?.RefCount) || 0,
    orphan: !(Number(volume.UsageData?.RefCount) > 0),
  }));
  const volumesTotal = sum(volumes, 'size');
  const volumesReclaimable = sum(volumes.filter((volume) => volume.orphan), 'size');
  const buildCache = (data.BuildCache || []).map((cache) => ({
    id: cache.ID || '',
    size: Number(cache.Size) || 0,
    inUse: !!cache.InUse,
  }));
  const buildCacheTotal = sum(buildCache, 'size');
  const buildCacheReclaimable = sum(buildCache.filter((cache) => !cache.inUse), 'size');
  const total = imagesTotal + containersTotal + volumesTotal + buildCacheTotal;
  const reclaimable = imagesReclaimable + containersReclaimable + volumesReclaimable + buildCacheReclaimable;
  return {
    images: { count: summary.images?.hasCount ? summary.images.count : data.Images?.length || 0, total: imagesTotal, reclaimable: imagesReclaimable },
    containers: { count: summary.containers?.hasCount ? summary.containers.count : data.Containers?.length || 0, total: containersTotal, reclaimable: containersReclaimable },
    volumes: { count: summary.volumes?.hasCount ? summary.volumes.count : volumes.length, total: volumesTotal, reclaimable: volumesReclaimable, orphans: summary.volumes?.hasCount && summary.volumes?.hasActive ? Math.max(0, summary.volumes.count - summary.volumes.active) : volumes.filter((v) => v.orphan).length },
    buildCache: { count: summary.buildCache?.hasCount ? summary.buildCache.count : buildCache.length, total: buildCacheTotal, reclaimable: buildCacheReclaimable },
    total,
    reclaimable,
  };
}

function sum(items, key) {
  return (items || []).reduce((total, item) => total + (Number(item?.[key]) || 0), 0);
}

/** Same node-scoped Engine snapshot as maintenance/cost; unavailable is an error. */
export async function getSystemStorageDf(hostId = getActiveHostId(), { background = false } = {}) {
  const scope = background ? captureScheduledHost(hostId) : storageHostScope(hostId);
  try {
    const snapshot = await readDockerDiskUsage(hostId);
    if (background) assertScheduledHost(scope); else assertStorageHostScope(scope);
    return { ...summarizeDockerDiskUsage(snapshot), ...scope, disk: null, checkedAt: Date.now() };
  } catch (error) {
    if (error.statusCode) throw error;
    throw Object.assign(new Error('目标节点空间统计暂不可用，请检查节点连接后重试'), { statusCode: 503 });
  }
}

/** Prune only the displayed host. Stopped containers retain their writable
 * layer and volume references; removing them is a separate explicit action. */
export async function pruneStorage(mode = 'safe', scope = {}) {
  if (!['safe', 'volumes', 'builder', 'all', 'scheduled'].includes(mode)) throw Object.assign(new Error('不支持的清理模式'), { statusCode: 400 });
  return pruneStorageResources({ images: mode === 'safe' || mode === 'scheduled',
    buildCache: ['safe', 'builder', 'all', 'scheduled'].includes(mode),
    allBuildCache: mode !== 'safe', volumes: mode === 'volumes' || mode === 'all' }, scope, mode);
}

const pruningHosts = new Set();

// Engine API < 1.42 prunes named volumes as well. Refuse that behavior rather
// than relying on a default whose meaning differs across daemon versions.
async function requireAnonymousVolumePrune(docker) {
  const controller = new AbortController();
  let timer;
  try {
    const version = await Promise.race([
      Promise.resolve().then(() => docker.version({ abortSignal: controller.signal })),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(Object.assign(new Error('无法确认节点的数据卷清理能力，请检查连接后重试'), { statusCode: 503 }));
      }, 10000); }),
    ]);
    const match = /^(\d+)\.(\d+)$/.exec(version?.ApiVersion || '');
    const requested = /^v?(\d+)\.(\d+)$/.exec(docker.modem?.version || version?.ApiVersion || '');
    if (![match, requested].every(v => v && (Number(v[1]) > 1 || (Number(v[1]) === 1 && Number(v[2]) >= 42)))) {
      throw Object.assign(new Error('此节点不支持限定匿名卷的批量清理，请在资源页逐项核对删除'), { statusCode: 409 });
    }
  } finally { clearTimeout(timer); }
}

export async function pruneStorageResources(selection, { expectedHostId, hostRevision } = {}, mode = 'custom') {
  if (!expectedHostId || !hostRevision) throw Object.assign(new Error('请先读取目标节点空间统计，再确认清理'), { statusCode: 409 });
  const scope = { ...storageHostScope(expectedHostId), hostRevision };
  assertStorageHostScope(scope);
  return performPrune(selection, scope, mode, () => assertStorageHostScope(scope));
}

/** Internal scheduler entry: the durable target is validated independently of
 * the interactive active-node selection. Containers and all volumes are kept. */
export async function pruneScheduledStorage(type, target) {
  if (!['prune-safe', 'prune-all'].includes(type)) throw Object.assign(new Error('不支持的定时清理类型'), { statusCode: 400 });
  await assertScheduledPruneHost(target);
  return performPrune({ images: true, buildCache: true, allBuildCache: type === 'prune-all' }, target, type, () => assertScheduledPruneHost(target));
}

async function performPrune(selection, scope, mode, verifyScope) {
  if (pruningHosts.has(scope.hostId)) throw Object.assign(new Error('该节点已有清理正在执行，请等待结果后重新读取'), { statusCode: 409 });
  const docker = getDockerForHost(scope.hostId);
  const reclaimed = { images: 0, containers: 0, volumes: 0, buildCache: 0, networks: 0 };
  pruningHosts.add(scope.hostId);
  try {
    if (selection.volumes) await requireAnonymousVolumePrune(docker);
    await verifyScope();
    if (selection.images) {
      const images = await docker.pruneImages({ filters: { dangling: ['true'] } });
      reclaimed.images = sumBytes(images?.SpaceReclaimed);
    }
    if (selection.buildCache) {
      await verifyScope();
      const builder = await pruneBuildCache(docker, !!selection.allBuildCache);
      reclaimed.buildCache = sumBytes(builder?.SpaceReclaimed);
    }
    if (selection.volumes) {
      await verifyScope();
      const volumes = await docker.pruneVolumes({ filters: { all: ['false'] } });
      reclaimed.volumes = sumBytes(volumes?.SpaceReclaimed);
    }
    if (selection.networks) {
      await verifyScope();
      await docker.pruneNetworks();
    }
    await verifyScope();
    const total = Object.values(reclaimed).reduce((sum, value) => sum + value, 0);
    return { ...scope, mode, reclaimedMB: Math.round(total / 1024 / 1024 * 10) / 10, reclaimed };
  } catch (error) {
    error.partialReclaimed = reclaimed;
    throw error;
  } finally { pruningHosts.delete(scope.hostId); invalidateDiskUsage(scope.hostId); }
}

function sumBytes(value) {
  return Number(value) || 0;
}


/** dockerode's pruneBuilder omits options in the installed version. Keep the
 * authenticated modem transport, but explicitly pass the Engine query flags. */
export function pruneBuildCache(docker, all = false) {
  return new Promise((resolve, reject) => docker.modem.dial({
    path: '/build/prune?', method: 'POST', options: { all },
    statusCodes: { 200: true, 400: 'invalid parameters', 409: 'prune already running', 500: 'server error' },
  }, (error, data) => error ? reject(error) : resolve(data)));
}
