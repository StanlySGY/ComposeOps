import { setTimeout as delay } from 'node:timers/promises';
import { getProjectDocker, assertProjectHostUnchanged } from './docker-hosts.js';

async function readWithin(task, signal) {
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return task(); }), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

// This verifies container readiness only; it is not a business/HTTP acceptance.
// Every selected service and its pre-upgrade replica count must be represented.
export async function verifyImageUpgradeHealth(project, selected, {
  signal: callerSignal, expectedCounts = {}, timeoutMs = 15000, pollMs = 1500,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 15000) throw new TypeError('健康验收期限必须为 1–15000 毫秒');
  const signal = AbortSignal.any([...(callerSignal ? [callerSignal] : []), AbortSignal.timeout(timeoutMs)]);
  const docker = getProjectDocker(project);
  let services = selected.map(service => ({ service, ok: false, reason: '尚未完成容器检查' }));
  let readySamples = 0;
  try {
    for (;;) {
      assertProjectHostUnchanged(project);
      const containers = (await readWithin(() => docker.listContainers({ all: true,
        filters: { label: [`com.docker.compose.project=${project.projectName}`] }, abortSignal: signal,
      }), signal)).filter(item => item.Labels?.['com.docker.compose.project'] === project.projectName
        && item.Labels?.['com.docker.compose.project.working_dir'] === project.workingDir
        && !item.Labels?.['composeops.helper']
        && String(item.Labels?.['com.docker.compose.oneoff']).toLowerCase() !== 'true'
        && selected.includes(item.Labels?.['com.docker.compose.service']));
      const checks = new Map();
      let index = 0;
      async function worker() {
        while (index < containers.length) {
          signal.throwIfAborted();
          const item = containers[index++];
          try {
            const { State: state = {} } = await readWithin(() => docker.getContainer(item.Id).inspect({ abortSignal: signal }), signal);
            checks.set(item.Id, state.Status === 'running' && !state.Paused && !state.Restarting
              && (!state.Health || state.Health.Status === 'healthy'));
          } catch {
            signal.throwIfAborted();
            checks.set(item.Id, false);
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, containers.length) }, worker));
      services = selected.map(service => {
        const members = containers.filter(item => item.Labels['com.docker.compose.service'] === service);
        const expected = Math.max(1, expectedCounts[service] || 1);
        const ready = members.filter(item => checks.get(item.Id)).length;
        return { service, expected, found: members.length, ready,
          ok: members.length >= expected && ready === members.length,
          reason: members.length < expected ? `仅发现 ${members.length}/${expected} 个服务容器`
            : ready !== members.length ? `仅 ${ready}/${members.length} 个容器运行且健康` : '',
        };
      });
      assertProjectHostUnchanged(project);
      readySamples = services.length && services.every(item => item.ok) ? readySamples + 1 : 0;
      if (readySamples >= 2) return { ok: true, services };
      await delay(pollMs, undefined, { signal });
    }
  } catch (error) {
    callerSignal?.throwIfAborted();
    if (error.code === 'HOST_CHANGED') throw error;
    return { ok: false, services, message: signal.aborted
      ? '升级后容器健康验收超时；未确认的服务需人工核对'
      : '无法读取升级后容器状态；需检查节点连接后核对' };
  }
}
