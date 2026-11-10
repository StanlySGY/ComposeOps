const drafts = [];
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
export function previewSreOnboarding(path, method, body, profiles) {
  if (path === '/sre/onboarding' && method === 'GET') return response({ drafts });
  if (path.startsWith('/sre/onboarding/context')) return response({ hostId: 'local', projectId: 'knowledge-base', projectName: 'knowledge-base', services: ['wiki-api', 'postgres'], profiles, recoveryPlans: [],
    recovery: { supported: true, services: [], limitations: '离线示例：创建和提交仅在本页内存生效，不探测或修改真实应用。' }, notifications: { ready: false, enabled: false, channels: [] }, autonomyDefault: false });
  if (path === '/sre/onboarding' && method === 'POST' || /^\/sre\/onboarding\/[^/]+$/.test(path) && method === 'PUT') {
    const old = drafts.find(row => row.id === path.split('/')[3]), draft = { id: old?.id || 'onboard-demo-' + drafts.length, hostId: body.hostId, projectId: body.projectId, projectName: 'knowledge-base', config: body.config,
      status: 'draft', version: (old?.version || 0) + 1, fingerprint: '0'.repeat(64), progress: old?.progress || {} };
    if (old) Object.assign(old, draft); else drafts.unshift(draft); return response({ draft });
  }
  if (path.startsWith('/sre/onboarding/') && path.endsWith('/apply') && method === 'POST') {
    const draft = drafts.find(row => row.id === path.split('/')[3]); if (!draft) return null;
    draft.status = 'complete'; draft.progress = { health: { status: 'configured' }, recovery: { status: draft.config.recovery.mode === 'later' ? 'deferred' : 'configured', reason: draft.config.recovery.reason },
      alerts: { status: 'configured' }, notifications: { status: 'deferred', reason: '离线示例：未配置真实通知渠道' }, autonomy: { status: 'configured', enabled: draft.config.autonomy.enabled } }; return response({ draft });
  }
  return null;
}
