import { getActivityDocker } from './docker-hosts.js';

/**
 * 聚合日志:给单个项目同时订阅多个容器的实时输出,按行拆分并通过回调推送。
 * 每个容器用 demuxStream 拆分 stdout/stderr,并统一打上 containerName 与时间戳。
 */
export async function aggregateProjectLogs({ project, containerIds = [], onLine = () => {} }) {
  const docker = getActivityDocker();
  const targets = (project.containers || []).filter((container) => {
    if (!containerIds.length) return true;
    return containerIds.some((id) => container.id === id || container.id.startsWith(id) || container.name === id);
  });
  const streams = [];
  let stopped = false;

  await Promise.all(targets.map(async (container) => {
    try {
      const rawStream = await docker.getContainer(container.id).logs({
        follow: true,
        stdout: true,
        stderr: true,
        tail: 200,
        timestamps: true,
      });
      const { demuxStream } = await import('../lib/docker-streams.js');
      const demux = demuxStream();
      rawStream.pipe(demux);

      const emit = (type, chunk) => {
        if (stopped) return;
        const text = chunk.toString('utf8');
        // docker 日志行:前缀是 RFC3339 时间戳 + 空格
        for (const rawLine of text.split('\n')) {
          if (!rawLine.trim()) continue;
          let data = rawLine;
          let ts = null;
          const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s?(.*)$/.exec(rawLine);
          if (match) { ts = match[1]; data = match[2]; }
          onLine({
            containerId: container.id,
            containerName: container.name,
            type,
            ts,
            data,
            level: /(error|exception|fatal|panic|crash|failed)/i.test(data) ? 'error'
              : /(warn|deprecat)/i.test(data) ? 'warn' : 'info',
          });
        }
      };
      demux.stdout.on('data', (chunk) => emit('stdout', chunk));
      demux.stderr.on('data', (chunk) => emit('stderr', chunk));
      rawStream.on('error', () => {});
      rawStream.on('end', () => {});
      streams.push(rawStream);
    } catch {
      // 单个容器失败不影响整体
    }
  }));

  return {
    stop() {
      stopped = true;
      for (const stream of streams) {
        try { stream.destroy(); } catch { /* 流已结束时忽略重复销毁。 */ }
      }
      streams.length = 0;
    },
  };
}

/** 为容器分配稳定的调色板索引(hash by name)。 */
export function colorIndexFor(name = '') {
  let hash = 0;
  for (const char of String(name)) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash);
}
