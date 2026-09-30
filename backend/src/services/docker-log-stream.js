import { demuxStream } from '../lib/docker-streams.js';
import { createLineDecoder } from '../lib/line-decoder.js';

export function parseLogLine(rawLine, type = 'stdout') {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s?(.*)$/.exec(rawLine);
  const data = match ? match[2] : rawLine;
  return {
    type, data, ts: match?.[1] || null,
    level: /(error|exception|fatal|panic|crash|failed)/i.test(data) ? 'error'
      : /(warn|deprecat)/i.test(data) ? 'warn' : 'info',
  };
}

/** 单容器与聚合日志共用的 TTY/多路复用解码和生命周期。取消可以发生在任一 await 期间。 */
export async function followContainerLogs({ container, tail = 200, signal, onLine, onError = () => {}, onEnd = () => {} }) {
  let stopped = false;
  let raw;
  let demux;
  const decoders = [];
  function stop() {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener('abort', stop);
    raw?.unpipe();
    raw?.destroy();
    demux?.destroy();
    demux?.stdout.destroy();
    demux?.stderr.destroy();
  }
  function checkCancelled() {
    if (stopped || signal?.aborted) {
      raw?.destroy();
      throw Object.assign(new Error('日志连接已取消'), { name: 'AbortError' });
    }
  }
  function finish(error) {
    if (stopped) return;
    for (const decoder of decoders) decoder.end();
    stop();
    try { if (error) onError(error); } finally { onEnd(); }
  }
  signal?.addEventListener('abort', stop, { once: true });
  try {
    checkCancelled();
    const inspection = await container.inspect();
    checkCancelled();
    raw = await container.logs({ follow: true, stdout: true, stderr: true, tail: String(Math.max(0, Math.min(Number(tail) || (Number(tail) === 0 ? 0 : 200), 5000))), timestamps: true });
    checkCancelled();
    raw.on('error', finish);
    raw.on('close', () => {
      if (!raw.readableEnded) finish(new Error('日志流意外关闭'));
    });
    function decode(stream, type) {
      const decoder = createLineDecoder(line => {
        if (!stopped && line.trim()) onLine(parseLogLine(line, type));
      });
      decoders.push(decoder);
      stream.on('data', chunk => decoder.write(chunk));
      stream.on('error', finish);
    }
    if (inspection?.Config?.Tty) {
      decode(raw, 'stdout');
      raw.on('end', () => finish());
    } else {
      demux = demuxStream();
      decode(demux.stdout, 'stdout');
      decode(demux.stderr, 'stderr');
      demux.on('error', finish);
      let ended = 0;
      const onStreamEnd = () => { if (++ended === 2) finish(); };
      demux.stdout.on('end', onStreamEnd);
      demux.stderr.on('end', onStreamEnd);
      raw.pipe(demux);
    }
    return { stop };
  } catch (error) {
    stop();
    throw error;
  }
}
