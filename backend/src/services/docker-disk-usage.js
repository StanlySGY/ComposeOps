import { getActiveHostId, getDockerForHost, onHostsChange } from './docker-hosts.js';

const snapshots = new Map();
const CACHE_MS = 30000;

export function invalidateDiskUsage(hostId) {
  for (const [key, entry] of snapshots) {
    if (entry.hostId !== hostId) continue;
    snapshots.delete(key);
    entry.controller.abort();
  }
}
onHostsChange(invalidateDiskUsage);

// Docker df walks container filesystems. Share the scan between maintenance
// and cost views, and give large hosts a bounded minute to finish a cold read.
export function readDockerDiskUsage(hostId = getActiveHostId(), { timeoutMs = 60000 } = {}) {
  const docker = getDockerForHost(hostId);
  const key = JSON.stringify([hostId, timeoutMs]);
  const hit = snapshots.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < CACHE_MS)) return hit.promise;
  const controller = new AbortController();
  const entry = { hostId, docker, controller, pending: true, at: 0 };
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  entry.promise = Promise.resolve().then(() => docker.df({ abortSignal: controller.signal })).then(data => {
    controller.signal.throwIfAborted();
    entry.pending = false;
    entry.at = Date.now();
    return data;
  }).catch(error => {
    if (snapshots.get(key) === entry) snapshots.delete(key);
    throw error;
  }).finally(() => clearTimeout(timer));
  snapshots.set(key, entry);
  // Evict only completed observations; active requests retain their cancellation.
  if (snapshots.size > 64) {
    for (const [oldKey, old] of snapshots) {
      if (!old.pending) snapshots.delete(oldKey);
      if (snapshots.size <= 64) break;
    }
  }
  return entry.promise;
}
