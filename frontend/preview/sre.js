import { previewSreDeliveryFetch } from './sre-delivery.js';
// Offline examples only. No HTTP probes, Docker operations or automatic repairs run here.
const now = Date.now();
const profiles = [{ id: 'demo-sre', version: 1, hostId: 'local', projectId: 'knowledge-base', projectName: 'knowledge-base', serviceName: 'wiki-api', enabled: true,
  config: { url: 'https://wiki.example/health', expectedStatus: 200, timeoutMs: 3000, maxLatencyMs: 1000, failureThreshold: 3, targetPercent: 99.9, windowDays: 7 },
  latest: { at: now, outcome: 'bad', statusCode: 503, reason: '示例：数据库连接失败' },
  statistics: { observedAvailabilityPercent: 98.5, coveragePercent: 92, unknownMs: 3600000, samples: 1200, budgetRemainingMs: -3000000 }, policy: null }];
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
export function previewSreFetch(path, method, body) {
  const delivery = previewSreDeliveryFetch(path, method, body); if (delivery) return delivery;
  if (path === '/sre/profiles' && method === 'GET') return response({ profiles, insights: { incidents: 3, resolved: 2, recoverySamples: 2, medianRecoveryMs: 600000, recurringTargets: 1, automaticDispatches: 0, manualDispatches: 2, effectOutcomes: { succeeded: 2, outcome_unknown: 1 } } });
  if (path === '/sre/targets' && method === 'GET') return response({ targets: [{ hostId: 'local', projectId: 'knowledge-base', projectName: 'knowledge-base', services: ['wiki-api', 'postgres'] }] });
  if (path === '/sre/profiles' && method === 'POST') {
    const profile = { ...body, id: 'demo-sre-' + profiles.length, projectName: 'knowledge-base', version: 1, statistics: { samples: 0, unknownMs: 0, budgetRemainingMs: 0 }, policy: null };
    profiles.push(profile); return response({ profile }, 201);
  }
  if (!path.startsWith('/sre/profiles/')) return null;
  const profile = profiles.find(item => item.id === path.split('/')[3]);
  if (!profile) return response({ message: '示例目标不存在' }, 404);
  if (path.endsWith('/autonomy') && method === 'PUT') {
    if (body.enabled && body.confirm !== 'ENABLE_AUTONOMY') return response({ message: '需要明确确认' }, 400);
    profile.policy = { ...profile.policy, ...body, id: 'demo-policy', version: (profile.policy?.version || 0) + 1, profileVersion: profile.version };
    return response({ policy: profile.policy });
  }
  if (path.endsWith('/pause') && method === 'POST') { profile.enabled = false; profile.version++; if (profile.policy) { profile.policy.enabled = false; profile.policy.version++; } return response({ profile }); }
  if (method === 'DELETE') { profiles.splice(profiles.indexOf(profile), 1); return response({ profile }); }
  if (method === 'PUT') { Object.assign(profile, { config: body.config, enabled: body.enabled, version: profile.version + 1 }); if (profile.policy) { profile.policy.enabled = false; profile.policy.version++; } return response({ profile }); }
  if (method === 'GET') return response({ profile });
  return null;
}
