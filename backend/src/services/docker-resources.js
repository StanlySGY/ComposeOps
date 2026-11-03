import { getActivityDocker } from './docker-hosts.js';

/**
 * 细粒度 Docker 资源清单(镜像 / 卷 / 网络),用于"能看清该删什么再删"的
 * 自助清理,也是对 Portainer 最常用能力的吸纳。与 docker-storage.js 的
 * 聚合 system df 互为补充:这里逐项枚举 + 逐项状态标注,而非一锅端 prune。
 */

const NONE_TAG = '<none>:<none>';

/** dockerode listImages -> 规范化镜像条目。 */
function normalizeImage(image = {}) {
  const repoTags = Array.isArray(image.RepoTags) ? image.RepoTags : [];
  const tags = repoTags.filter((tag) => tag && tag !== NONE_TAG);
  const size = Number(image.Size) || 0;
  return {
    id: String(image.Id || ''),
    tags,
    size,
    created: image.Created ? Number(image.Created) * 1000 : null,
    containers: Number(image.Containers) || 0,
    dangling: tags.length === 0,
    inUse: (Number(image.Containers) || 0) > 0,
  };
}

/**
 * 从 Docker 全量容器列表统计卷引用。必须包含 stopped/exited 容器：
 * 只要容器仍存在并持有 Mounts，就不能把它的数据卷标为孤儿。
 */
export function countVolumeReferences(containers = []) {
  const references = new Map();
  for (const container of Array.isArray(containers) ? containers : []) {
    const containerId = String(container?.Id || container?.ID || container?.Names?.[0] || 'unknown-container');
    for (const mount of Array.isArray(container?.Mounts) ? container.Mounts : []) {
      if (mount?.Type !== 'volume' || !mount?.Name) continue;
      const name = String(mount.Name);
      if (!references.has(name)) references.set(name, new Set());
      references.get(name).add(containerId);
    }
  }
  return new Map([...references].map(([name, ids]) => [name, ids.size]));
}

/** dockerode listVolumes -> 规范化卷条目；引用状态以 Docker 容器 Mounts 为准。 */
function normalizeVolumes(listResult = {}, containers = []) {
  const volumes = Array.isArray(listResult.Volumes) ? listResult.Volumes : [];
  const referenceCounts = countVolumeReferences(containers);
  return volumes.map((volume) => {
    const name = String(volume.Name || '');
    const refCount = referenceCounts.get(name) || 0;
    const size = Number(volume.UsageData?.Size) || 0;
    const createdAt = volume.CreatedAt ? new Date(volume.CreatedAt).getTime() : null;
    return {
      name,
      driver: String(volume.Driver || ''),
      mountpoint: String(volume.Mountpoint || ''),
      scope: String(volume.Scope || 'local'),
      size,
      refCount,
      orphan: refCount === 0,
      createdAt,
    };
  });
}

/** dockerode listNetworks -> 规范化网络条目。 */
function normalizeNetwork(network = {}) {
  const driver = String(network.Driver || '');
  const containers = network.Containers && typeof network.Containers === 'object' ? network.Containers : {};
  const attached = Object.keys(containers).length;
  const builtin = ['bridge', 'host', 'none'].includes(driver);
  const createdAt = network.Created ? new Date(network.Created).getTime() : null;
  return {
    id: String(network.Id || ''),
    name: String(network.Name || ''),
    driver,
    scope: String(network.Scope || ''),
    internal: !!network.Internal,
    attached,
    builtin,
    unused: attached === 0 && !builtin,
    createdAt,
  };
}

/** GET /ops/storage/resources:一次性返回镜像 / 卷 / 网络清单及逐项状态。 */
export async function listDockerResources() {
  const docker = getActivityDocker();
  const [imagesRaw, volumesRaw, networksRaw, containersRaw] = await Promise.all([
    docker.listImages({ all: true }).catch((error) => { throw wrap(error); }),
    docker.listVolumes().catch((error) => { throw wrap(error); }),
    docker.listNetworks().catch((error) => { throw wrap(error); }),
    // 引用关系不完整时整个清单失败关闭，绝不能把未知卷降级标记为可删除。
    docker.listContainers({ all: true }).catch((error) => { throw wrap(error); }),
  ]);
  const images = imagesRaw.map(normalizeImage);
  const volumes = normalizeVolumes(volumesRaw, containersRaw);
  const networks = networksRaw.map(normalizeNetwork);
  const warnings = Array.isArray(volumesRaw?.Warnings) ? volumesRaw.Warnings : [];
  return {
    images,
    volumes,
    networks,
    warnings,
    counts: {
      images: images.length,
      danglingImages: images.filter((i) => i.dangling).length,
      volumes: volumes.length,
      orphanVolumes: volumes.filter((v) => v.orphan).length,
      networks: networks.length,
      unusedNetworks: networks.filter((n) => n.unused).length,
    },
    checkedAt: Date.now(),
  };
}

/**
 * DELETE /ops/storage/resources/:kind/:id:删除单个资源。
 * 默认不强制删除:列表加载后资源可能被新容器引用,由 Docker 拒绝删除可保护数据。
 */
export async function removeDockerResource(kind, id, _force = false) {
  const docker = getActivityDocker();
  if (kind === 'image') {
    const image = docker.getImage(id);
    await image.remove({ force: false });
    return { kind, id, removed: true };
  }
  if (kind === 'volume') {
    // 删除前再次查询所有容器（包括已停止容器），阻止过期列表或并发挂载导致误删。
    const containers = await docker.listContainers({ all: true }).catch((error) => { throw wrap(error); });
    const refCount = countVolumeReferences(containers).get(id) || 0;
    if (refCount > 0) {
      throw Object.assign(new Error(`数据卷仍被 ${refCount} 个容器引用，拒绝删除`), { statusCode: 409 });
    }
    // 不强制删除；Docker daemon 仍是最后一道并发竞态保护。
    await docker.getVolume(id).remove({ force: false });
    return { kind, id, removed: true };
  }
  if (kind === 'network') {
    await docker.getNetwork(id).remove();
    return { kind, id, removed: true };
  }
  throw Object.assign(new Error(`未知资源类型:${kind}`), { statusCode: 400 });
}

function wrap(error) {
  if (error?.statusCode) return error;
  return Object.assign(new Error(error?.message || 'docker 调用失败'), { statusCode: 502 });
}
