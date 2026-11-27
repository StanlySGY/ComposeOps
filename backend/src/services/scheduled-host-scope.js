import { getActiveHostId, getDockerForHost, getHost, hostConnectionRevision, listHosts } from './docker-hosts.js';

export function captureScheduledHost(hostId = getActiveHostId(), expectedRevision) {
  const host = getHost(hostId);
  if (!host) throw Object.assign(new Error('计划的目标节点不存在，请重新选择'), { statusCode: 409 });
  const connectionRevision = hostConnectionRevision(hostId);
  if (expectedRevision && expectedRevision !== connectionRevision) throw Object.assign(new Error('目标节点配置已变化，请刷新后重新确认'), { statusCode: 409 });
  return { hostId, hostName: host.name, connectionRevision };
}

export function assertScheduledHost(target) {
  if (!target?.hostId || !target.connectionRevision) throw Object.assign(new Error('此旧计划尚未绑定执行节点，请编辑并确认目标后启用'), { statusCode: 409 });
  return captureScheduledHost(target.hostId, target.connectionRevision);
}

export function listScheduledHosts() {
  return listHosts().map(host => captureScheduledHost(host.id));
}

async function readEngineId(hostId) {
  const controller = new AbortController(); let timer;
  try {
    const info = await Promise.race([
      Promise.resolve().then(() => getDockerForHost(hostId).info({ abortSignal: controller.signal })),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('读取超时')); }, 8000); }),
    ]);
    if (!info?.ID) throw new Error('缺少Engine身份');
    return info.ID;
  } catch { throw Object.assign(new Error('无法验证计划目标的 Docker Engine 身份，请检查连接后重试'), { statusCode: 503 }); }
  finally { clearTimeout(timer); }
}

export async function captureScheduledPruneHost(hostId, expectedRevision) {
  const target = captureScheduledHost(hostId, expectedRevision);
  const engineId = await readEngineId(target.hostId);
  assertScheduledHost(target);
  return { ...target, engineId };
}

export async function assertScheduledPruneHost(target) {
  assertScheduledHost(target);
  if (!target.engineId) throw Object.assign(new Error('清理计划尚未确认 Docker Engine 身份，请编辑并重新保存'), { statusCode: 409 });
  const engineId = await readEngineId(target.hostId);
  assertScheduledHost(target);
  if (engineId !== target.engineId) throw Object.assign(new Error('清理计划的 Docker Engine 身份已变化，请核对后重新保存'), { statusCode: 409 });
}
