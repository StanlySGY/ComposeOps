import { setTimeout as delay } from 'node:timers/promises';
import { getActiveHostId, getDockerForHost, hostConnectionRevision, onHostsChange } from './docker-hosts.js';

const snapshots = new Map();
const CACHE_MS = 30000;
const SCAN_TIMEOUT_MS = 60000;
const invalidationListeners = new Set();
export function onDiskUsageInvalidated(listener) { invalidationListeners.add(listener); return () => invalidationListeners.delete(listener); }

export function invalidateDiskUsage(hostId) {
  for (const listener of invalidationListeners) listener(hostId);
  for (const [key, entry] of snapshots) {
    if (entry.hostId !== hostId) continue;
    snapshots.delete(key);
    entry.controller.abort();
  }
}
onHostsChange(invalidateDiskUsage);

function timeoutError() { return Object.assign(new Error('节点空间扫描超时，请稍后重试'), { statusCode: 503, code: 'DISK_SCAN_TIMEOUT' }); }

function missingContainerSnapshot(error) {
  return error?.statusCode === 500 && typeof error?.json?.message === 'string'
    && /^failed to retrieve container list: rw layer snapshot not found for container [a-f0-9]{64}$/i.test(error.json.message);
}

async function scanDiskUsage(docker, signal) {
  signal.throwIfAborted();
  try { return await docker.df({ abortSignal: signal }); }
  catch (error) {
    // Observed Engine read failure. Retry this exact response once within the
    // original deadline; persistent failures and unrelated 500s remain visible.
    if (!missingContainerSnapshot(error)) throw error;
    await delay(250, undefined, { signal });
    signal.throwIfAborted();
    return docker.df({ abortSignal: signal });
  }
}

/** Stable diagnostic categories only; never return raw upstream bodies or paths. */
export function diskUsageFailure(error) {
  const status = Number(error?.statusCode);
  if (error?.code === 'DISK_SCAN_TIMEOUT') return { code: 'scan_timeout', message: '存储扫描超过等待期限' };
  if (error?.code === 'DISK_SCAN_INVALID_RESPONSE') return { code: 'invalid_response', message: 'Docker 返回的空间统计格式无效' };
  if (error?.code === 'DISK_SCAN_SCOPE_CHANGED' || status === 409) return { code: 'scope_changed', message: '扫描期间节点连接已变化' };
  if (error?.name === 'AbortError') return { code: 'scan_cancelled', message: '存储扫描已取消，请重新读取' };
  if (status === 401 || status === 403) return { code: 'engine_access_denied', message: 'Docker 拒绝读取空间统计', upstreamStatus: status };
  if (missingContainerSnapshot(error)) return { code: 'engine_snapshot_unavailable', message: 'Docker 暂时无法读取容器存储快照，请稍后重试', upstreamStatus: status };
  if (Number.isInteger(status) && status >= 400 && status <= 599) return { code: 'engine_error', message: `Docker 空间扫描返回 HTTP ${status}`, upstreamStatus: status };
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(error?.code)) return { code: 'connection_error', message: 'Docker 连接中断或不可达' };
  return { code: 'scan_failed', message: 'Docker 空间扫描未完成' };
}

function awaitSnapshot(entry, timeoutMs, signal) {
  entry.waiters++;
  let timer, cancelled;
  const cancellation = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError()), timeoutMs);
    cancelled = () => reject(signal.reason);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
  });
  return Promise.race([entry.promise, cancellation]).finally(() => {
    clearTimeout(timer); signal?.removeEventListener('abort', cancelled); entry.waiters--;
    if (entry.pending && entry.waiters === 0) {
      if (snapshots.get(entry.hostId) === entry) snapshots.delete(entry.hostId);
      entry.controller.abort();
    }
  });
}

// The scan belongs to the node/connection. Each caller has its own wait budget;
// a short inspection must not start another scan or cancel another page's read.
export function readDockerDiskUsage(hostId = getActiveHostId(), { timeoutMs = SCAN_TIMEOUT_MS, signal } = {}) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SCAN_TIMEOUT_MS) throw Object.assign(new Error('空间统计等待期限无效'), { statusCode: 400 });
  const revision = hostConnectionRevision(hostId);
  const hit = snapshots.get(hostId);
  if (hit && hit.revision === revision && (hit.pending || Date.now() - hit.at < CACHE_MS)) return awaitSnapshot(hit, timeoutMs, signal);
  if (hit) { snapshots.delete(hostId); hit.controller.abort(); }
  const docker = getDockerForHost(hostId);
  const controller = new AbortController();
  const entry = { hostId, docker, revision, controller, pending: true, at: 0, waiters: 0 };
  const timer = setTimeout(() => controller.abort(timeoutError()), SCAN_TIMEOUT_MS);
  let aborted;
  const cancellation = new Promise((_, reject) => {
    aborted = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', aborted, { once: true });
  });
  const scan = Promise.resolve().then(() => scanDiskUsage(docker, controller.signal));
  entry.promise = Promise.race([scan, cancellation]).then(data => {
    controller.signal.throwIfAborted();
    if (hostConnectionRevision(hostId) !== revision) throw Object.assign(new Error('空间扫描期间节点连接已变化'), { statusCode: 409, code: 'DISK_SCAN_SCOPE_CHANGED' });
    const keys = ['Images', 'Containers', 'Volumes', 'BuildCache'];
    const emptyEngine = Number.isFinite(data?.LayersSize) && data.LayersSize === 0 && keys.every(key => Object.hasOwn(data, key) && data[key] === null);
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || (!keys.some(key => Array.isArray(data[key])) && !emptyEngine)
      || ['Images', 'Containers', 'Volumes', 'BuildCache'].some(key => data[key] != null && !Array.isArray(data[key]))) {
      throw Object.assign(new Error('Docker 空间统计响应无效，请重试或检查 Engine'), { statusCode: 502, code: 'DISK_SCAN_INVALID_RESPONSE' });
    }
    entry.at = Date.now();
    return data;
  }).catch(error => {
    if (snapshots.get(hostId) === entry) snapshots.delete(hostId);
    throw error;
  }).finally(() => { entry.pending = false; clearTimeout(timer); controller.signal.removeEventListener('abort', aborted); });
  snapshots.set(hostId, entry);
  // Evict only completed observations; active requests retain their cancellation.
  if (snapshots.size > 64) {
    for (const [oldKey, old] of snapshots) {
      if (!old.pending) snapshots.delete(oldKey);
      if (snapshots.size <= 64) break;
    }
  }
  return awaitSnapshot(entry, timeoutMs, signal);
}
