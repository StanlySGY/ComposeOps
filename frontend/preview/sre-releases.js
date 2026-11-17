const releases = [];
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
export function previewSreReleases(path, method, body, profiles = []) {
  if (path === '/sre/releases' && method === 'GET') return response({ releases });
  if (path === '/sre/releases/review' && method === 'POST') {
    const services = body.services.map(row => ({ ...row, serviceName: profiles.find(profile => profile.id === row.profileId)?.serviceName || 'unknown', old: { imageId: 'sha256:' + 'a'.repeat(64) }, next: { imageId: 'sha256:' + 'b'.repeat(64) } })).sort((a, b) => Number(b.serviceName === 'postgres') - Number(a.serviceName === 'postgres'));
    const release = { id: 'release-demo-' + releases.length, status: 'reviewed', hostId: 'local', createdAt: Date.now(), fingerprint: 'offline-demo', result: {}, review: { projectName: 'knowledge-base', services, order: services.map(row => row.serviceName), graph: { edges: [{ service: 'wiki-api', dependency: 'postgres', reason: '虚构依赖示例' }] }, rollbackScope: '离线虚构示例，不执行真实操作。' } };
    releases.unshift(release); return response({ change: release }, 201);
  }
  const release = releases.find(row => row.id === path.split('/')[3]);
  if (release && method === 'POST') {
    if (path.endsWith('/approve')) { release.status = body.allowRollback ? 'rolled_back' : 'failed'; release.approvedBy = '示例用户'; release.result = { allowRollback: body.allowRollback, steps: release.review.services.map((row, index) => ({ serviceName: row.serviceName, passed: index === 0, exitCode: 0, evidence: [{ at: Date.now() }] })), rollbackSteps: body.allowRollback ? [...release.review.services].reverse().map(row => ({ serviceName: row.serviceName, passed: true, exitCode: 0 })) : [] }; release.error = '离线示例：中间服务未通过 HTTP 验收。'; }
    else if (path.endsWith('/cancel')) release.status = 'cancelled';
    else return null;
    return response({ change: release });
  }
  return null;
}
