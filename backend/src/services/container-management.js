import { getActiveHost, getActiveHostId, getDockerForHost, getProjectDocker, assertProjectHostUnchanged } from './docker-hosts.js';
import { withProjectOperationLock } from './project-operation-lock.js';
import { invalidateScanCache } from './scanner.js';
import { addOperation } from '../lib/db.js';

const COMPOSE_PROJECT = 'com.docker.compose.project';
const COMPOSE_SERVICE = 'com.docker.compose.service';
const ACTIONS = new Set(['start', 'stop', 'restart']);

function fail(message, statusCode = 400, code = 'invalid_request') {
  return Object.assign(new Error(message), { statusCode, code });
}

function safeContainer(row) {
  return {
    id: row.Id,
    name: (row.Names?.[0] || '').replaceAll('/', ''),
    image: row.Image || '',
    imageId: row.ImageID || '',
    state: row.State || 'unknown',
    statusText: row.Status || '',
    created: row.Created || 0,

    ports: (row.Ports || []).filter((port) => port.PublicPort).map((port) => ({
      private: port.PrivatePort, public: port.PublicPort, ip: port.IP, type: port.Type,
    })),
    mounts: (row.Mounts || []).map((mount) => ({
      type: mount.Type, source: mount.Source, destination: mount.Destination, readWrite: mount.RW,
    })),
  };
}

/** 列出当前 Docker 节点的独立容器；Compose 容器由项目扫描器负责。 */
export async function listStandaloneContainers() {
  const hostId = getActiveHostId();
  const docker = getDockerForHost(hostId);
  const rows = await docker.listContainers({ all: true });
  if (hostId !== getActiveHostId()) throw fail('Docker 节点已切换，请刷新后重试', 409, 'host_changed');
  return {
    hostId,
    hostName: getActiveHost()?.name || hostId,
    containers: rows.filter((row) => !(row.Labels || {})[COMPOSE_PROJECT]).map(safeContainer),
  };
}

async function inspectCurrent(docker, id, expectedHostId, predicate) {
  if (getActiveHostId() !== expectedHostId) throw fail('Docker 节点已切换，操作已中止', 409, 'host_changed');
  const container = docker.getContainer(id);
  const data = await container.inspect();
  if (getActiveHostId() !== expectedHostId) throw fail('Docker 节点已切换，操作已中止', 409, 'host_changed');
  if (!predicate(data)) throw fail('容器归属或服务标签已变化，请刷新列表', 409, 'container_identity_changed');
  return { container, data };
}

export async function runStandaloneContainerAction({ id, action, expectedHostId }) {
  if (!ACTIONS.has(action)) throw fail('仅支持启动、停止和重启', 400, 'unsupported_action');
  if (!expectedHostId || expectedHostId !== getActiveHostId()) throw fail('Docker 节点已切换，请刷新后重试', 409, 'host_changed');
  const docker = getDockerForHost(expectedHostId);
  return withProjectOperationLock(`standalone:${expectedHostId}:${id}`, async () => {
    const { container, data } = await inspectCurrent(docker, id, expectedHostId, (item) => !(item.Config?.Labels || {})[COMPOSE_PROJECT]);
    const state = data.State?.Status;
    if (action === 'start') {
      if (state === 'paused') await container.unpause();
      else if (state !== 'running') await container.start();
    } else if (action === 'stop') {
      if (state === 'paused') await container.unpause();
      if (state === 'running' || state === 'paused') await container.stop({ t: 10 });
    } else if (action === 'restart') {
      if (state === 'paused') await container.unpause();
      if (state === 'running' || state === 'paused') await container.restart({ t: 10 });
      else await container.start();
    }
    const after = await container.inspect();
    if (getActiveHostId() !== expectedHostId) throw fail('Docker 节点已切换，无法确认操作结果', 409, 'host_changed');
    const expected = action === 'stop' ? 'exited' : 'running';
    const ok = after.State?.Status === expected;
    addOperation({ action: `container.${action}`, status: ok ? 'success' : 'failed', detail: `${data.Name?.replaceAll('/', '') || id}: ${after.State?.Status || 'unknown'}` });
    invalidateScanCache();
    return { ok: true, id, action, state: after.State.Status };
  });
}

/** Compose 服务级动作作用于服务当前全部副本；不执行 up，不创建或重建资源。 */
export async function runComposeServiceAction(project, serviceName, action) {
  if (!ACTIONS.has(action)) throw fail('仅支持启动、停止和重启', 400, 'unsupported_action');
  if (!project?.managed) throw fail('项目尚未纳管', 403, 'project_not_managed');
  if (typeof serviceName !== 'string' || !serviceName.trim() || serviceName.length > 128) throw fail('服务名称无效', 400, 'invalid_service');
  const replicas = project.containers.filter((item) => item.service === serviceName);
  if (!replicas.length) throw fail('未找到该服务的容器副本，请刷新项目', 404, 'service_not_found');
  const hostId = project.hostId || getActiveHostId();
  if (hostId !== getActiveHostId()) throw fail('Docker 节点已切换，请刷新后重试', 409, 'host_changed');
  const docker = getProjectDocker(project);
  return withProjectOperationLock(project.id, async () => {
    assertProjectHostUnchanged(project);
    const results = [];
    for (const replica of replicas) {
      const { container, data } = await inspectCurrent(docker, replica.id, hostId, (item) => {
        const labels = item.Config?.Labels || {};
        return labels[COMPOSE_PROJECT] === project.projectName && labels[COMPOSE_SERVICE] === serviceName;
      });
      const state = data.State?.Status;
      if (action === 'start') {
        if (state === 'paused') await container.unpause();
        else if (state !== 'running') await container.start();
      } else if (action === 'stop') {
        if (state === 'paused') await container.unpause();
        if (state === 'running' || state === 'paused') await container.stop({ t: 10 });
      } else if (action === 'restart') {
        if (state === 'paused') await container.unpause();
        if (state === 'running' || state === 'paused') await container.restart({ t: 10 });
        else await container.start();
      }
      const after = await container.inspect();
      const expected = action === 'stop' ? 'exited' : 'running';
      results.push({ id: replica.id, name: replica.name, state: after.State?.Status || 'unknown', ok: after.State?.Status === expected });
    }
    assertProjectHostUnchanged(project);
    const ok = results.every((item) => item.ok);
    addOperation({ projectId: project.id, projectName: project.projectName, action: `service.${action}`, status: ok ? 'success' : 'failed', detail: `${serviceName} · ${results.length} 个副本` });
    invalidateScanCache();
    if (!ok) throw fail('部分副本未达到预期状态，请检查服务详情', 502, 'postcondition_failed');
    return { ok: true, projectId: project.id, service: serviceName, action, replicas: results };
  });
}
