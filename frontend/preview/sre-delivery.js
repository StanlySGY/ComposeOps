// Offline fixtures: these paths never dispatch Docker actions or call a model.
const now = Date.now(), oldImage = 'sha256:' + 'a'.repeat(64), newImage = 'sha256:' + 'b'.repeat(64);
const changes = [], plans = [], runs = [], retrospectives = [];
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
export function previewSreDeliveryFetch(path, method, body) {
  if (path === '/sre/operations' && method === 'GET') return response({ changes, recoveryPlans: plans, recoveryRuns: runs, retrospectives, insights: { changeOutcomes: { rolled_back: changes.filter(c => c.status === 'rolled_back').length }, drillOutcomes: { passed: runs.length } } });
  if (path === '/sre/changes/review' && method === 'POST') {
    const change = { id: 'demo-change-' + changes.length, status: 'reviewed', hostId: 'local', projectId: 'knowledge-base', profileId: body.profileId, createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 900000,
      fingerprint: 'offline-fixture', review: { projectName: 'knowledge-base', serviceName: 'wiki-api', old: { imageId: oldImage }, next: { imageId: newImage, requested: body.image }, inputFingerprint: 'offline-inputs', files: ['/projects/wiki/compose.yml'], rollbackScope: '仅恢复镜像，不回退数据卷。' }, result: {} };
    changes.unshift(change); return response({ change }, 201);
  }
  if (path.startsWith('/sre/changes/') && method === 'POST') {
    const change = changes.find(c => c.id === path.split('/')[3]); if (!change) return response({ message: '示例变更不存在' }, 404);
    if (path.endsWith('/approve')) { change.status = body.allowRollback ? 'rolled_back' : 'failed'; change.approvedBy = '演示管理员'; change.result = { allowRollback: body.allowRollback, forwardVerification: { passed: false }, ...(body.allowRollback ? { rollbackVerification: { passed: true } } : {}) }; change.error = '演示：新镜像 HTTP 验收未通过。'; }
    if (path.endsWith('/cancel')) change.status = 'cancelled';
    return response({ change });
  }
  if (path.startsWith('/sre/recovery/candidates')) return response({ projectName: 'knowledge-base', volumes: ['knowledge-base_data'], excluded: [{ service: 'wiki-api', type: 'bind', reason: '绑定挂载未覆盖' }] });
  if (path === '/sre/recovery/plans' && method === 'POST' || path.startsWith('/sre/recovery/plans/') && method === 'PUT') {
    const old = plans.find(p => p.id === path.split('/')[4]);
    const plan = { id: old?.id || 'demo-plan-' + plans.length, hostId: body.hostId, projectId: body.projectId, projectName: 'knowledge-base', version: (old?.version || 0) + 1, enabled: body.enabled !== false,
      config: { volumes: body.volumes, rpoMinutes: body.rpoMinutes, rtoMinutes: body.rtoMinutes, scheduleHours: body.scheduleHours, declaredVolumes: ['knowledge-base_data'], excluded: [{ type: 'bind' }] }, nextRunAt: body.scheduleHours ? now + body.scheduleHours * 3600000 : null };
    if (old) Object.assign(old, plan); else plans.unshift(plan); return response({ plan });
  }
  if (path.startsWith('/sre/recovery/plans/') && method === 'POST') {
    const plan = plans.find(p => p.id === path.split('/')[4]); if (!plan) return response({ message: '示例计划不存在' }, 404);
    if (path.endsWith('/pause')) { plan.enabled = false; return response({ plan }); }
    const run = { id: 'demo-drill-' + runs.length, planId: plan.id, status: 'passed', createdAt: Date.now(), requestedBy: '演示管理员', snapshot: { plan: structuredClone(plan) }, result: { scope: 'isolated_archive_extraction', businessRecoveryVerified: false, coveragePercent: 100, durationMs: 3000, cleanupComplete: true, rtoMet: true, volumes: [{ volume: 'knowledge-base_data', backupId: 7, backupAgeMs: 120000, rpoMet: true, files: 12, status: 'verified' }], resources: [{ kind: 'volume', id: 'demo-temporary-volume', state: 'removed' }] } };
    runs.unshift(run); return response({ run }, 202);
  }
  if (path === '/sre/retrospectives' && method === 'POST') {
    const retrospective = { id: 'demo-retro-' + retrospectives.length, createdAt: Date.now(), status: 'ready', evidence: { selection: '演示样本：不代表真实生产效果。', sources: [{ id: 'summary', kind: 'statistics', data: { incidents: 3, resolved: 2 } }] }, content: { interpretation: 'AI 分析需要人工核验；不会改变授权。', findings: [{ claim: '示例中有未完成验收的事件，暂不能宣称全部恢复。', evidenceIds: ['summary'], recommendation: '核对未完成事件的应用健康证据。' }] } };
    retrospectives.unshift(retrospective); return response({ retrospective });
  }
  return null;
}
