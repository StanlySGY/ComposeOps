const plans = [], backups = [], runs = [];
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
export function previewSreBusiness(path, method, body) {
  if (path === '/sre/business-recovery' && method === 'GET') return response({ plans, backups, runs });
  if (path.startsWith('/sre/business-recovery/candidates')) return response({ supported: true, projectName: 'knowledge-base', services: [{ serviceName: 'postgres' }, { serviceName: 'wiki-api', stateless: true }], limitations: '这是离线示例，不会创建真实容器、备份或应用。' });
  if (path === '/sre/business-recovery/plans' && method === 'POST' || /^\/sre\/business-recovery\/plans\/[^/]+$/.test(path) && method === 'PUT') {
    const old = plans.find(row => row.id === path.split('/').at(-1)), plan = { ...body, id: old?.id || 'business-demo-' + plans.length, projectName: 'knowledge-base', version: (old?.version || 0) + 1, nextRunAt: null };
    if (old) Object.assign(old, plan); else plans.push(plan); return response({ plan });
  }
  if (path.startsWith('/sre/business-recovery/plans/') && method === 'POST') {
    const plan = plans.find(row => row.id === path.split('/')[4]); if (!plan) return response({ message: '示例计划不存在' }, 404);
    if (path.endsWith('/pause')) { plan.enabled = false; plan.version++; return response({ plan }); }
    if (path.endsWith('/backup')) {
      const backup = { id: 'backup-demo-' + backups.length, planId: plan.id, version: plan.version, status: 'verified', createdAt: Date.now(), snapshot: { plan: structuredClone(plan) }, result: { sha256: '离线虚构校验值', bytes: 1024, snapshotAt: Date.now() } };
      backups.unshift(backup); return response({ backup }, 202);
    }
    if (path.endsWith('/run')) {
      const run = { id: 'run-demo-' + runs.length, planId: plan.id, version: plan.version, status: 'failed', createdAt: Date.now(), snapshot: { plan: structuredClone(plan) }, error: '离线虚构示例：业务数据已还原，但 HTTP 业务断言未通过。', result: { backupId: body.backupId, assertions: [{ passed: true, table: plan.config.assertions[0].table }], httpChecks: [{ passed: false }], businessRecoveryVerified: false, cleanupComplete: true, backupAgeMs: 120000, rpoMet: true, resources: [] } };
      runs.unshift(run); return response({ run }, 202);
    }
  }
  return null;
}
