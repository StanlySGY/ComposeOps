// 所有可见项目共用一条 SSE；订阅变化合并重连，取消最后一个订阅立即释放。
import { onAuthEpochChange } from '../lib/auth-context.js';
const subscribers = new Set();
let controller = null;
let timer = null;
let generation = 0;
const CONNECT_TIMEOUT = 15_000;
const IDLE_TIMEOUT = 60_000;
const MAX_FRAME_CHARS = 2 * 1024 * 1024;
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

function reconnect(delay = 0) {
  generation += 1;
  controller?.abort();
  controller = null;
  clearTimeout(timer);
  timer = null;
  if (subscribers.size) timer = setTimeout(() => void connect(generation), delay);
}

async function connect(version) {
  timer = null;
  if (version !== generation || !subscribers.size) return;
  const current = new AbortController();
  controller = current;
  const ids = [...new Set([...subscribers].map(item => item.projectId))];
  const interval = Math.min(...[...subscribers].map(item => item.interval));
  let reader, deadline, timeoutError;
  const cancelReader = () => { void reader?.cancel().catch(() => {}); };
  current.signal.addEventListener('abort', cancelReader, { once: true });
  function armTimeout(ms) {
    clearTimeout(deadline);
    deadline = setTimeout(() => {
      timeoutError = new Error('指标连接超时，正在重新连接');
      current.abort();
    }, ms);
  }
  try {
    armTimeout(CONNECT_TIMEOUT);
    const response = await fetch('/api/v1/projects/stats/stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectIds: ids, interval }), signal: current.signal,
    });
    if (version !== generation || current.signal.aborted) {
      await response.body?.cancel().catch(() => {});
      if (timeoutError) throw timeoutError;
      return;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      if (version !== generation || current.signal.aborted) return;
      if (response.status === 401) {
        cancelSubscriptions();
        window.dispatchEvent(new Event('composeops:unauthorized'));
        return;
      }
      throw new Error('指标暂不可用，正在重新连接');
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', pendingCR = '';
    armTimeout(IDLE_TIMEOUT);
    while (!current.signal.aborted) {
      const { value, done } = await reader.read();
      if (timeoutError) throw timeoutError;
      if (done) break;
      if (value.byteLength) armTimeout(IDLE_TIMEOUT);
      // SSE permits CR, LF and CRLF. Preserve a trailing CR across chunks so
      // a split CRLF cannot be mistaken for an empty line.
      let text = pendingCR + decoder.decode(value, { stream: true });
      pendingCR = text.endsWith('\r') ? '\r' : '';
      if (pendingCR) text = text.slice(0, -1);
      buffer += text.replace(/\r\n?/g, '\n');
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const raw of frames) {
        if (version !== generation || current.signal.aborted) return;
        if (raw.length > MAX_FRAME_CHARS) throw new Error('指标帧超过处理上限，正在重新连接');
        const data = raw.split('\n').filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let frame;
        try { frame = JSON.parse(data); } catch { throw new Error('指标数据格式无效，正在重新连接'); }
        if (frame?.type === 'heartbeat') continue;
        if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.projectId !== 'string'
          || !['stats', 'error'].includes(frame.type) || (frame.type === 'stats' && !Array.isArray(frame.data))) {
          throw new Error('指标数据格式无效，正在重新连接');
        }
        for (const item of [...subscribers]) {
          if (version !== generation || current.signal.aborted) return;
          if (!subscribers.has(item)) continue;
          if (item.projectId === frame.projectId) {
            item.armFreshness();
            try { item.onFrame(frame); } catch { /* 单个视图不阻塞其他订阅 */ }
          }
        }
      }
      if (buffer.length > MAX_FRAME_CHARS) throw new Error('指标帧超过处理上限，正在重新连接');
    }
    if (!current.signal.aborted) throw new Error('指标连接已断开，正在重新连接');
  } catch (error) {
    if (version === generation && (!current.signal.aborted || timeoutError)) {
      for (const item of [...subscribers]) {
        if (version !== generation || !subscribers.has(item)) break;
        try { item.onFrame({ type: 'error', data: (timeoutError || error).message }); } catch { /* 视图已销毁 */ }
      }
    }
  } finally {
    clearTimeout(deadline);
    current.signal.removeEventListener('abort', cancelReader);
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (version === generation) reconnect(1500);
  }
}

export function streamProjectStats(projectId, onFrame, signal, interval = 2500) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const item = { projectId, onFrame, interval: Math.max(1000, Math.min(Number(interval) || 2500, 10000)) };
    let freshnessTimer;
    item.armFreshness = () => {
      clearTimeout(freshnessTimer);
      freshnessTimer = setTimeout(() => {
        if (!subscribers.has(item)) return;
        try { onFrame({ type: 'error', code: 'stale', data: '指标更新延迟，等待新采样' }); } catch { /* 视图已销毁 */ }
      }, IDLE_TIMEOUT);
    };
    const cancel = () => {
      signal?.removeEventListener('abort', cancel);
      clearTimeout(freshnessTimer);
      subscribers.delete(item);
      reconnect();
      reject(abortError());
    };
    item.cancel = cancel;
    signal?.addEventListener('abort', cancel, { once: true });
    subscribers.add(item);
    item.armFreshness();
    reconnect();
  });
}

function cancelSubscriptions() {
  for (const item of [...subscribers]) item.cancel();
}
if (typeof window !== 'undefined') window.addEventListener('composeops:host-changed', cancelSubscriptions);
onAuthEpochChange((_epoch, { identityChanged }) => {
  // New identities need new subscriptions. A password rotation preserves the
  // same view and projects, but must reconnect using its replacement cookie.
  if (identityChanged) cancelSubscriptions();
  else reconnect();
});
