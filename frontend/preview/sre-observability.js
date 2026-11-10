const now = Date.now();
const config = { version: 1, thresholds: { heartbeatSeconds: 90, queueMinutes: 10, executionMinutes: 30, databaseGiB: 10, walMiB: 1024, growthMiBPerHour: 512, diskFreePercent: 10, backupHours: 48, backupMinutes: 30, externalSeconds: 120, maintenanceUntil: 0 } };
const rules = new Map();
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
export function previewSreObservability(path, method, body, profiles) {
  if (path === '/sre/platform' && method === 'GET') return response({ config, stale: false,
    sample: { at: now, databaseBytes: 650000000, walBytes: 24000000, growthBytesPerHour: 15000000, diskFreePercent: 42,
      workers: ['sre-runtime', 'incident-observer', 'effect-worker', 'platform-monitor'].map(name => ({ name, state: 'idle', currentInstance: true, ageMs: 1000, heartbeatAt: now - 1000 })),
      queues: { changes: { queued: 0, executing: 0, oldestQueuedMs: 0, oldestExecutionMs: 0 } },
      backup: { state: 'succeeded', lastSuccessAt: now - 3600000, durationMs: 5000 }, external: { configured: true, at: now, location: 'same-host' } },
    history: Array.from({ length: 12 }, (_, i) => ({ at: now - (11 - i) * 300000, databaseBytes: 630000000 + i * 1800000, walBytes: 24000000 })),
    alerts: [{ key: 'profile:demo-sre:1:fast', scope: 'profile:demo-sre', title: '知识库 HTTP 错误预算消耗', state: 'firing', condition: 'bad', observedAt: now, detail: { example: true, shortBurnRate: 20, longBurnRate: 16, coverage: 0.98 } }],
    deliveries: [{ id: 'sample', alertKey: 'profile:demo-sre:1:fast', channel: 'webhook', status: 'sent', attempts: 1, updatedAt: now }] });
  if (path === '/sre/platform/config' && method === 'PUT') { Object.assign(config, { version: config.version + 1, thresholds: body.thresholds }); return response({ config }); }
  if (path === '/sre/platform/monitor-token' && method === 'POST') return response({ token: '0'.repeat(64) });
  const match = /^\/sre\/profiles\/([^/]+)\/alerts$/.exec(path);
  if (!match) return null;
  const id = decodeURIComponent(match[1]), profile = profiles.find(p => p.id === id);
  if (!profile) return null;
  if (!rules.has(id)) rules.set(id, { profileId: id, version: 0, profileVersion: profile.version, config: { enabled: false, minimumCoverage: 0.9, maintenanceUntil: 0, recoverMinutes: 5, fast: { shortMinutes: 5, longMinutes: 60, burnRate: 14.4 }, slow: { shortMinutes: 30, longMinutes: 360, burnRate: 6 } } });
  if (method === 'PUT') rules.set(id, { ...rules.get(id), ...body, version: rules.get(id).version + 1, profileVersion: profile.version });
  return response({ rule: rules.get(id), evidence: {} });
}
