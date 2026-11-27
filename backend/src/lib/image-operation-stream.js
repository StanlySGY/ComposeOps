import { createBoundedSseWriter } from './bounded-sse-writer.js';

export async function streamImageOperation(reply, run) {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  reply.raw.flushHeaders?.();
  const controller = new AbortController();
  let child, finished = false, output = '', outputTruncated = false;
  const stop = handle => {
    if (typeof handle?.kill === 'function' && (handle.exitCode === undefined || handle.exitCode === null) && !handle.killed) {
      try { handle.kill('SIGTERM'); } catch { /* cancellation must still abort the next stage */ }
    }
  };
  const disconnect = () => {
    if (finished || controller.signal.aborted) return;
    controller.abort(); stop(child);
  };
  const writer = createBoundedSseWriter(reply.raw, { onOverflow: disconnect });
  const send = (type, data) => writer.send({ type, data });
  const onOutput = (type, value) => {
    if (controller.signal.aborted) return;
    const text = String(value);
    outputTruncated ||= output.length + text.length > 65536;
    output = (output + text).slice(-65536);
    for (let offset = 0; offset < text.length && !controller.signal.aborted; offset += 8192) send(type, text.slice(offset, offset + 8192));
  };
  reply.raw.once('close', disconnect);
  if (reply.raw.destroyed) disconnect();
  try {
    const result = await run({ signal: controller.signal, onOutput,
      onChild: handle => { child = handle; if (controller.signal.aborted) stop(handle); },
    });
    if (!controller.signal.aborted) {
      send('exit', { code: result.code });
      send('result', { ...result, ok: result.code === 0 && result.ok !== false && !result.degraded, output, outputTruncated });
    }
  } catch (error) {
    onOutput('stderr', `${error.message}\n`);
    if (!controller.signal.aborted) send('result', { ok: false, message: error.message, output, outputTruncated });
  } finally {
    finished = true;
    await writer.end();
    reply.raw.off('close', disconnect);
  }
}
