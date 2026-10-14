/**
 * Bound application-side SSE buffering when a client reads more slowly than
 * the producer. Writable streams retain their own high-water mark; this helper
 * adds a small explicit queue and destroys only the affected stream on overflow.
 */
export function createBoundedSseWriter(stream, { maxQueuedBytes = 256 * 1024, onOverflow = () => {} } = {}) {
  const queue = [];
  let queuedBytes = 0;
  let blocked = false;
  let ending = false;
  let finished = false;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });

  const settle = () => {
    if (finished) return;
    finished = true;
    stream.off('drain', flush);
    stream.off('finish', settle);
    stream.off('close', settle);
    stream.off('error', settle);
    resolveCompletion();
  };

  const overflow = () => {
    if (finished) return;
    queue.length = 0;
    queuedBytes = 0;
    try { onOverflow(); } catch { /* cleanup must not replace the stream failure */ }
    if (typeof stream.destroy === 'function') stream.destroy();
    else settle();
  };

  function flush() {
    if (finished) return;
    if (stream.destroyed || stream.writableEnded) {
      queue.length = 0;
      queuedBytes = 0;
      if (stream.destroyed) settle();
      return;
    }
    blocked = false;
    while (queue.length) {
      const frame = queue.shift();
      queuedBytes -= Buffer.byteLength(frame);
      let canContinue;
      try {
        canContinue = stream.write(frame);
      } catch {
        overflow();
        return;
      }
      if (!canContinue) {
        blocked = true;
        break;
      }
    }
    if (ending && queue.length === 0 && !blocked && !stream.writableEnded) stream.end();
  }

  function send(event) {
    if (finished || stream.destroyed || stream.writableEnded) return false;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    const frameBytes = Buffer.byteLength(frame);
    if (blocked || queue.length) {
      if (queuedBytes + frameBytes > maxQueuedBytes) {
        overflow();
        return false;
      }
      queue.push(frame);
      queuedBytes += frameBytes;
      return true;
    }
    try {
      if (!stream.write(frame)) blocked = true;
      return true;
    } catch {
      overflow();
      return false;
    }
  }

  function end() {
    if (finished) return completion;
    ending = true;
    if (stream.destroyed) settle();
    else if (!blocked && queue.length === 0 && !stream.writableEnded) stream.end();
    return completion;
  }

  stream.on('drain', flush);
  stream.once('finish', settle);
  stream.once('close', settle);
  stream.once('error', settle);

  return {
    send,
    end,
    get queuedBytes() { return queuedBytes; },
    get blocked() { return blocked; },
  };
}
