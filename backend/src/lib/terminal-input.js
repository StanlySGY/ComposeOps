// BusyBox lineedit's escape decoder waits up to 50 ms for additional bytes after
// a cursor report. Immediately following keystrokes can be consumed as part of
// that report. Keep a short boundary at the Docker stream, not just in the UI.
export function createTerminalInput(write, overflow, { delayMs = 100 } = {}) {
  let timer = null, pending = [], bytes = 0, closed = false;
  function close() { closed = true; clearTimeout(timer); timer = null; pending = []; bytes = 0; }
  function send(value) {
    if (closed) return;
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (timer) {
      if (bytes + data.length > 64 * 1024) { close(); overflow(); return; }
      pending.push(data); bytes += data.length; return;
    }
    write(data);
    const text = data.toString();
    if (text.startsWith('\x1b[') && /^\d+;\d+R$/.test(text.slice(2))) {
      timer = setTimeout(() => {
        timer = null;
        const batch = pending; pending = []; bytes = 0;
        for (const item of batch) send(item);
      }, delayMs);
      timer.unref?.();
    }
  }
  return { send, close };
}
