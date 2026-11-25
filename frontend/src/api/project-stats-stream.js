// 所有可见项目共用一条 SSE；订阅变化合并重连，取消最后一个订阅立即释放。
const subscribers = new Set();
let controller = null;
let timer = null;
let generation = 0;
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
  try {
    const response = await fetch('/api/v1/projects/stats/stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectIds: ids, interval }), signal: current.signal,
    });
    if (!response.ok || !response.body) throw new Error('指标暂不可用，正在重新连接');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!current.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop();
        for (const raw of frames) {
          if (version !== generation || current.signal.aborted) return;
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          let frame;
          try { frame = JSON.parse(line.slice(5)); } catch { continue; }
          for (const item of subscribers) {
            if (item.projectId === frame.projectId) {
              try { item.onFrame(frame); } catch { /* 单个视图不阻塞其他订阅 */ }
            }
          }
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  } catch (error) {
    if (version === generation && !current.signal.aborted) {
      for (const item of subscribers) {
        try { item.onFrame({ type: 'error', data: error.message }); } catch { /* 视图已销毁 */ }
      }
    }
  } finally {
    if (version === generation) reconnect(1500);
  }
}

export function streamProjectStats(projectId, onFrame, signal, interval = 2500) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const item = { projectId, onFrame, interval: Math.max(1000, Math.min(Number(interval) || 2500, 10000)) };
    const cancel = () => {
      signal?.removeEventListener('abort', cancel);
      subscribers.delete(item);
      reconnect();
      reject(abortError());
    };
    item.cancel = cancel;
    signal?.addEventListener('abort', cancel, { once: true });
    subscribers.add(item);
    reconnect();
  });
}

if (typeof window !== 'undefined') window.addEventListener('composeops:host-changed', () => {
  // 旧节点的订阅身份不能复用到新节点，视图刷新后会重新订阅。
  for (const item of [...subscribers]) item.cancel();
});
