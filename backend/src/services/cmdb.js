import {
  upsertAsset,
  getAsset,
  listAssets,
  deleteAsset,
  addAssetRelation,
  listAssetRelations,
  deleteAssetRelation,
} from '../lib/db.js';
import { listHosts, getActiveHostId, getActivityDocker } from './docker-hosts.js';
import { scanProjects } from './scanner.js';

/**
 * CMDB 统一资产模型:
 * - 把分散的 Docker Host / Project / Container / Volume / Network 收敛为统一 asset 实体;
 * - 提供资产同步(从 Docker 扫描结果重建)与拓扑关系查询;
 * - 知识图谱直接读取本服务,不再维护第二套实体。
 */

/** 从当前 Docker 扫描结果同步资产与关系(幂等 upsert)。 */
export async function syncAssets() {
  const activeHostId = getActiveHostId();
  const hosts = listHosts();
  const projects = await scanProjects().catch(() => []);
  const docker = getActivityDocker();
  const [volumeResult, networkResult] = await Promise.all([
    docker.listVolumes().catch(() => ({ Volumes: [] })),
    docker.listNetworks().catch(() => []),
  ]);

  // 1. Host 资产
  for (const host of hosts) {
    upsertAsset({
      id: `host:${host.id}`,
      kind: 'host',
      name: host.id,
      displayName: host.name,
      hostId: host.id,
      status: host.status === 'online' ? 'online' : 'offline',
      properties: { type: host.type, version: host.version || '', containerCount: host.containerCount || 0, latencyMs: host.latencyMs || 0 },
      source: 'docker',
    });
  }

  // 2. Project 资产 + 关系(project runs_on host)
  for (const project of projects) {
    const projectId = project.id || project.projectName || project.name;
    if (!projectId) continue;
    upsertAsset({
      id: `project:${projectId}`,
      kind: 'project',
      name: projectId,
      displayName: project.projectName || project.name || projectId,
      hostId: activeHostId,
      status: project.status || 'unknown',
      properties: { composeFile: project.composeFile || '', containerCount: project.containerCount || 0 },
      source: 'scanner',
    });
    addAssetRelation(`project:${projectId}`, `host:${activeHostId}`, 'runs_on');

    // 3. Container 资产 + 关系(container runs_on project)
    for (const container of project.containers || []) {
      const containerId = container.id || container.containerId;
      if (!containerId) continue;
      upsertAsset({
        id: `container:${containerId}`,
        kind: 'container',
        name: containerId,
        displayName: container.name || containerId,
        hostId: activeHostId,
        status: container.state || container.status || 'unknown',
        properties: { image: container.image || '', project: projectId },
        source: 'scanner',
      });
      addAssetRelation(`container:${containerId}`, `project:${projectId}`, 'runs_on');
    }
  }

  for (const volume of volumeResult?.Volumes || []) {
    if (!volume?.Name) continue;
    upsertAsset({
      id: `volume:${activeHostId}:${volume.Name}`,
      kind: 'volume',
      name: volume.Name,
      displayName: volume.Name,
      hostId: activeHostId,
      status: 'available',
      properties: { driver: volume.Driver || '', mountpoint: volume.Mountpoint || '', scope: volume.Scope || '' },
      source: 'docker',
    });
    addAssetRelation(`volume:${activeHostId}:${volume.Name}`, `host:${activeHostId}`, 'runs_on');
  }
  for (const network of networkResult || []) {
    if (!network?.Id && !network?.Name) continue;
    const networkName = network.Name || network.Id;
    upsertAsset({
      id: `network:${activeHostId}:${networkName}`,
      kind: 'network',
      name: networkName,
      displayName: networkName,
      hostId: activeHostId,
      status: Object.keys(network.Containers || {}).length ? 'connected' : 'available',
      properties: { driver: network.Driver || '', scope: network.Scope || '', internal: !!network.Internal },
      source: 'docker',
    });
    addAssetRelation(`network:${activeHostId}:${networkName}`, `host:${activeHostId}`, 'runs_on');
  }

  return { hosts: hosts.length, projects: projects.length, volumes: (volumeResult?.Volumes || []).length, networks: (networkResult || []).length };
}

export function getAssetById(id) {
  return getAsset(id);
}

export function queryAssets({ kind = '', hostId = '', query = '', limit = 500, offset = 0 } = {}) {
  return listAssets({ kind, hostId, query, limit, offset });
}

export function removeAsset(id) {
  return deleteAsset(id);
}

export function getTopology({ limit = 500, offset = 0 } = {}) {
  const assets = listAssets({ limit, offset });
  const assetIds = assets.map((asset) => asset.id);
  const relations = assetIds.length ? listAssetRelations({ limit, offset: 0, assetIds }) : [];
  return { assets, relations };
}

export function addRelation(sourceId, targetId, relation, properties = {}) {
  if (!getAsset(sourceId) || !getAsset(targetId)) {
    throw Object.assign(new Error('资产不存在'), { statusCode: 404 });
  }
  addAssetRelation(sourceId, targetId, relation, properties);
  return { ok: true };
}

export function removeRelation(id) {
  return deleteAssetRelation(id);
}
