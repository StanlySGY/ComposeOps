import { assertAuthEpoch, getAuthEpoch, onAuthEpochChange } from '../lib/auth-context.js';
import { userError } from '../lib/user-error.js';

// Shared transport ownership for AI, deployment controls and job subscriptions.
// Cancelling this reader only detaches the browser; it never stops a server job.
export async function streamJsonEvents(url, init, onFrame, signal, {
  label = '任务', maxFrameChars = 2 * 1024 * 1024, onConnected, onSettled, acceptFinalFrame = false,
  frameError = `${label}消息帧过大，已中断接收；请核对实际任务状态`,
  bufferError = `${label}消息帧超过接收上限，已中断接收；请核对实际任务状态`,
} = {}) {
  const epoch = getAuthEpoch(), controller = new AbortController();
  let response, reader, ended = false, cancellation;
  const cancelReader = () => {
    if (reader && !cancellation) cancellation = reader.cancel().catch(() => {});
    return cancellation;
  };
  const abort = () => { controller.abort(signal?.reason); void cancelReader(); };
  const unsubscribe = onAuthEpochChange(abort);
  signal?.addEventListener('abort', abort, { once: true });
  const current = () => { assertAuthEpoch(epoch); controller.signal.throwIfAborted(); };
  try {
    if (signal?.aborted) abort();
    current();
    response = await fetch(url, { ...init, signal: controller.signal });
    current();
    if (!response.ok || !response.body) {
      const payload = (await response.json().catch(() => null)) || {};
      current();
      const error = userError(payload.message || payload.error || `${label}请求失败`, { status: response.status, code: payload.code || payload.error });
      if (response.status === 401) window.dispatchEvent(new Event('composeops:unauthorized'));
      throw error;
    }
    onConnected?.();
    current();
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', pendingCR = '';
    function dispatch(raw) {
      current();
      if (raw.length > maxFrameChars) throw new Error(frameError);
      const data = raw.split('\n').filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) return;
      let value;
      try { value = JSON.parse(data); } catch { return; }
      // Consumer errors are not malformed JSON. Propagate and close the reader.
      onFrame(value);
      current();
    }
    function drain(text, final = false) {
      text = pendingCR + text;
      pendingCR = !final && text.endsWith('\r') ? '\r' : '';
      if (pendingCR) text = text.slice(0, -1);
      buffer += text.replace(/\r\n?/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        dispatch(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
      if (buffer.length > maxFrameChars) throw new Error(bufferError);
      if (final && acceptFinalFrame && buffer.trim()) dispatch(buffer);
      if (final) buffer = '';
    }
    while (true) {
      const { value, done } = await reader.read();
      current();
      if (done) { drain(decoder.decode(), true); ended = true; break; }
      drain(decoder.decode(value, { stream: true }));
    }
  } finally {
    unsubscribe();
    signal?.removeEventListener('abort', abort);
    if (reader) {
      if (!ended) await cancelReader();
      reader.releaseLock();
    } else if (response?.body) await response.body.cancel().catch(() => {});
    if (epoch === getAuthEpoch()) onSettled?.();
  }
}
