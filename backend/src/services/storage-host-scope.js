import { randomUUID } from 'node:crypto';
import { getActiveHostId, getHost, onHostsChange, onActiveHostChange } from './docker-hosts.js';
const revisions = new Map();
onHostsChange(id => revisions.set(id, randomUUID()));
onActiveHostChange(() => { for (const id of revisions.keys()) revisions.set(id, randomUUID()); });
export function storageHostScope(id = getActiveHostId()) {
  const host = getHost(id);
  if (!host) throw Object.assign(new Error('请选择一个存在的 Docker 节点'), { statusCode: 404 });
  if (!revisions.has(id)) revisions.set(id, randomUUID());
  return { hostId: id, hostName: host.name, hostRevision: revisions.get(id) };
}
export function assertStorageHostScope(scope) {
  if (getActiveHostId() !== scope.hostId || !getHost(scope.hostId)
    || storageHostScope(scope.hostId).hostRevision !== scope.hostRevision) {
    throw Object.assign(new Error('目标节点或连接配置已变化，请刷新空间统计后重新确认'), { statusCode: 409, code: 'STORAGE_HOST_CHANGED' });
  }
}
