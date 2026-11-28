/** Render the CMDB snapshot without guessing cross-node relationships from names. */
export function buildCmdbGraph(assets = [], relations = []) {
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const byKind = kind => assets.filter(asset => asset.kind === kind);
  const outgoing = new Map(), incoming = new Map();
  for (const relation of relations) {
    if (!byId.has(relation.sourceId) || !byId.has(relation.targetId)) continue;
    if (!outgoing.has(relation.sourceId)) outgoing.set(relation.sourceId, []);
    if (!incoming.has(relation.targetId)) incoming.set(relation.targetId, []);
    outgoing.get(relation.sourceId).push(relation);
    incoming.get(relation.targetId).push(relation);
  }
  const hosts = byKind('host').map(asset => ({
    id: asset.id, hostId: asset.hostId, name: asset.displayName || asset.name,
    type: asset.properties?.type || 'unknown', status: asset.status,
  }));
  const hostById = new Map(hosts.map(host => [host.hostId, host]));
  const volumes = byKind('volume');
  const projects = byKind('project').map(asset => {
    const containers = (incoming.get(asset.id) || [])
      .filter(r => r.relation === 'runs_on' && byId.get(r.sourceId).kind === 'container')
      .map(r => byId.get(r.sourceId))
      .filter(container => container.hostId === asset.hostId)
      .map(container => {
        const volumeAssets = (outgoing.get(container.id) || [])
          .filter(r => r.relation === 'mounts')
          .map(r => byId.get(r.targetId))
          .filter(volume => volume.kind === 'volume' && volume.hostId === asset.hostId);
        return { id: container.id, name: container.displayName || container.name, state: container.status,
          volumeIds: [...new Set(volumeAssets.map(volume => volume.id))], volumes: [...new Set(volumeAssets.map(volume => volume.name))] };
      });
    return { id: asset.name, assetId: asset.id, hostId: asset.hostId,
      projectName: asset.displayName || asset.name, workingDir: asset.properties?.composeFile || '', status: asset.status, containers };
  });
  const label = text => String(text || '未命名资产');
  const node = (key, title, sub, state) => ({ key, fullLabel: label(title), label: label(title).length > 22 ? `${label(title).slice(0, 21)}…` : label(title), sub, state });
  const nodes = [
    ...hosts.map(host => node(host.id, host.name, '台账节点', 'host')),
    ...projects.map(project => node(project.assetId, project.projectName, `${project.containers.length} 个服务容器`, 'project')),
    ...volumes.map(volume => node(volume.id, volume.displayName || volume.name, hostById.get(volume.hostId)?.name || '归属节点未载入', 'volume')),
  ];
  const edges = [], seen = new Set();
  const addEdge = (source, target) => {
    const key = JSON.stringify([source, target]);
    if (!seen.has(key)) { seen.add(key); edges.push({ source, target }); }
  };
  for (const project of projects) {
    const host = hostById.get(project.hostId);
    if (host) addEdge(host.id, project.assetId);
    for (const container of project.containers) for (const volumeId of container.volumeIds) addEdge(project.assetId, volumeId);
  }
  return { hosts, projects, volumes, nodes, edges };
}
