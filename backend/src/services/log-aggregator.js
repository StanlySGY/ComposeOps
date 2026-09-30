import { getActivityDocker } from './docker-hosts.js';
import { followContainerLogs } from './docker-log-stream.js';

/**
 * 聚合日志:给单个项目同时订阅多个容器的实时输出,按行拆分并通过回调推送。
 * 每个容器用 demuxStream 拆分 stdout/stderr,并统一打上 containerName 与时间戳。
 */
export async function aggregateProjectLogs({ project, containerIds = [], tail = 200, signal, onLine = () => {}, onError = () => {}, onEnd = () => {} }) {
  const docker = getActivityDocker();
  const targets = (project.containers || []).filter((container) => {
    if (!containerIds.length) return true;
    return containerIds.some((id) => container.id === id || container.id.startsWith(id) || container.name === id);
  });
  const streams = [];
  let stopped = false;
  let initializing = true;
  let remaining = targets.length;
  let count = 0;
  const controller = new AbortController();
  function stop() {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener('abort', stop);
    controller.abort();
    for (const stream of streams) stream.stop();
    streams.length = 0;
  }
  const reportEnd = () => {
    if (!initializing && !remaining && !stopped) {
      stop();
      onEnd();
    }
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();

  await Promise.all(targets.map(async (container) => {
    try {
      const stream = await followContainerLogs({
        container: docker.getContainer(container.id), tail, signal: controller.signal,
        onLine: line => { if (!stopped) onLine({ containerId: container.id, containerName: container.name, ...line }); },
        onError: error => { if (!stopped) onError({ containerId: container.id, containerName: container.name, message: error.message }); },
        onEnd: () => { remaining -= 1; reportEnd(); },
      });
      if (stopped) stream.stop();
      else { streams.push(stream); count += 1; }
    } catch (error) {
      remaining -= 1;
      if (!stopped && error.name !== 'AbortError') onError({ containerId: container.id, containerName: container.name, message: error.message });
    }
  }));
  initializing = false;
  reportEnd();
  return { count, stop };
}

/** 为容器分配稳定的调色板索引(hash by name)。 */
export function colorIndexFor(name = '') {
  let hash = 0;
  for (const char of String(name)) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash);
}
