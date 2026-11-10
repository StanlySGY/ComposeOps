import http from 'node:http';
import https from 'node:https';
import db, { getProjectPreference } from '../lib/db.js';
import { getHost, getDockerForHost } from './docker-hosts.js';
import { hostRevision, withReadTimeout } from './incident-observer.js';
import { getSreProfile, listSreProfiles, PROBE_INTERVAL_MS } from './sre-profiles.js';

// Explicit administrator-supplied health endpoints may be private LAN addresses.
// No redirects, credentials, headers, cookies, proxy inheritance or response bodies.
export function runHttpProbe(config, { now = () => Date.now() } = {}) {
  const started = now();
  return new Promise(resolve => {
    let settled = false, request, timer;
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      request?.destroy();
      resolve({ ...result, latencyMs: Math.max(0, now() - started) });
    };
    try {
      const url = new URL(config.url);
      request = (url.protocol === 'https:' ? https : http).request(url, { method: 'GET', agent: false,
        headers: { 'User-Agent': 'ComposeOps-Health/1', Accept: '*/*' }, maxHeaderSize: 16384 }, response => {
        const latency = now() - started;
        const ok = response.statusCode === config.expectedStatus && latency <= config.maxLatencyMs;
        finish({ outcome: ok ? 'good' : 'bad', statusCode: response.statusCode,
          reason: response.statusCode !== config.expectedStatus ? 'HTTP 状态码未达标' : latency > config.maxLatencyMs ? '响应延迟超出目标' : '' });
        response.destroy();
      });
      request.once('error', () => finish({ outcome: 'bad', statusCode: null, reason: '无法连接健康检查地址或 TLS 验证失败' }));
      timer = setTimeout(() => finish({ outcome: 'bad', statusCode: null, reason: '健康检查请求超时' }), config.timeoutMs);
      request.end();
    } catch { finish({ outcome: 'unknown', statusCode: null, reason: '健康检查配置无法执行' }); }
  });
}
export function latestProbe(profile) {
  const rows = db.prepare('SELECT * FROM sre_probe_samples WHERE profile_id=? AND version=? ORDER BY sampled_at DESC LIMIT ?')
    .all(profile.id, profile.version, profile.config.failureThreshold);
  const row = rows[0];
  if (!row) return null;
  let streak = 0, previous = row.sampled_at;
  for (const sample of rows) {
    if (sample.outcome !== 'bad' || previous - sample.sampled_at > PROBE_INTERVAL_MS * 2) break;
    streak++; previous = sample.sampled_at;
  }
  return { id: row.id, at: row.sampled_at, outcome: row.outcome, latencyMs: row.latency_ms, statusCode: row.status_code, reason: row.reason,
    consecutiveFailures: streak, fault: streak >= profile.config.failureThreshold };
}
export function recordProbeSample(profile, result, at = Date.now()) {
  const current = getSreProfile(profile.id);
  if (!current.enabled || current.version !== profile.version) return null;
  db.prepare('INSERT OR IGNORE INTO sre_probe_samples(profile_id,version,sampled_at,outcome,latency_ms,status_code,reason) VALUES(?,?,?,?,?,?,?)')
    .run(profile.id, profile.version, at, result.outcome, result.latencyMs ?? null, result.statusCode ?? null, result.reason || '');
  db.prepare('DELETE FROM sre_probe_samples WHERE sampled_at<?').run(at - 31 * 86400000);
  return latestProbe(profile);
}
export function probeSnapshot(profile, snapshot, now = Date.now()) {
  const sample = latestProbe(profile);
  const stale = !sample || now - sample.at > PROBE_INTERVAL_MS * 2;
  const unavailable = !profile.enabled || stale || sample.outcome === 'unknown';
  return { ...snapshot, probe: { profileId: profile.id, version: profile.version, sampleId: sample?.id, at: sample?.at,
    outcome: unavailable ? 'unknown' : sample.outcome, latencyMs: sample?.latencyMs, statusCode: sample?.statusCode, reason: sample?.reason || '' },
    healthy: snapshot.healthy && !unavailable && sample.outcome === 'good',
    fault: snapshot.fault || (!unavailable && sample.fault ? '应用健康探针持续失败' : ''),
    error: unavailable ? '应用探针未启用或缺少新鲜有效观测' : snapshot.error };
}
export function probeStatistics(profile, now = Date.now()) {
  const from = Math.max(profile.updatedAt, now - profile.config.windowDays * 86400000);
  const rows = db.prepare('SELECT sampled_at,outcome FROM sre_probe_samples WHERE profile_id=? AND version=? AND sampled_at>=? AND sampled_at<=? ORDER BY sampled_at')
    .all(profile.id, profile.version, from - PROBE_INTERVAL_MS, now);
  let goodMs = 0, badMs = 0;
  rows.forEach((row, index) => {
    const span = Math.max(0, Math.min(now, rows[index + 1]?.sampled_at ?? now, row.sampled_at + PROBE_INTERVAL_MS) - Math.max(from, row.sampled_at));
    if (row.outcome === 'good') goodMs += span;
    if (row.outcome === 'bad') badMs += span;
  });
  const elapsedMs = Math.max(0, now - from), observedMs = goodMs + badMs, unknownMs = Math.max(0, elapsedMs - observedMs);
  const budgetMs = elapsedMs * (1 - profile.config.targetPercent / 100);
  return { from, to: now, samples: rows.length, goodMs, badMs, unknownMs, elapsedMs,
    coveragePercent: elapsedMs ? observedMs / elapsedMs * 100 : null,
    observedAvailabilityPercent: observedMs ? goodMs / observedMs * 100 : null,
    guaranteedAvailabilityPercent: elapsedMs ? goodMs / elapsedMs * 100 : null,
    budgetMs, budgetRemainingMs: budgetMs - badMs - unknownMs, targetPercent: profile.config.targetPercent };
}
export function createProbeRunner({ probe = runHttpProbe, now = () => Date.now(), hostForId = getHost, dockerForHost = getDockerForHost } = {}) {
  let pending = null;
  return { runOnce: ({ isCurrent = () => true } = {}) => {
    if (pending) return pending;
    pending = (async () => {
      // Account for timer/response jitter so a 30 s target does not silently become 45 s.
      const queue = listSreProfiles().filter(profile => profile.enabled && (!latestProbe(profile) || now() - latestProbe(profile).at >= PROBE_INTERVAL_MS - 250));
      const engines = new Map();
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length && isCurrent()) {
          const profile = queue.shift();
          let result;
          if (!getProjectPreference(profile.projectId).managed || !hostForId(profile.hostId) || hostRevision(hostForId(profile.hostId)) !== profile.hostRevision) {
            result = { outcome: 'unknown', reason: '项目已取消纳管或节点身份已变化' };
          } else {
            try {
              if (!engines.has(profile.hostId)) engines.set(profile.hostId, withReadTimeout(dockerForHost(profile.hostId).info()));
              const engine = await engines.get(profile.hostId);
              result = engine.ID === profile.engineId ? await probe(profile.config) : { outcome: 'unknown', reason: '应用所属 Docker Engine 已变化' };
            } catch { result = { outcome: 'unknown', reason: '无法核对节点或执行探针' }; }
          }
          if (isCurrent()) recordProbeSample(profile, result, now());
        }
      }));
    })().finally(() => { pending = null; });
    return pending;
  } };
}
