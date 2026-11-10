/** 资源深链只在此编码：projectId/containerId/hostId/from/tab/job。 */
export const RETURN_ROUTES = {
  oncall: ['AI 值守', '/oncall'],
  reliability: ['应用可靠性', '/reliability'],
  dashboard: ['总览', '/dashboard'], services: ['服务列表', '/services'],
  topology: ['服务拓扑', '/topology'], events: ['事件中心', '/events'],
  inspection: ['巡检报告', '/inspection'], monitor: ['实时监控', '/monitor'],
  resources: ['资源管理', '/resources'], settings: ['设置', '/settings'],
  agent: ['AI 助手', '/agent'], gitops: ['GitOps', '/gitops'],
  marketplace: ['应用市场', '/marketplace'],
  cost: ['成本分析', '/cost'], 'maintenance-plan': ['运维计划', '/maintenance-plan'], 'node-groups': ['节点组', '/node-groups'],
  'ops-center': ['任务中心', '/ops-center'], review: ['变更与回滚', '/review'],
};
export function returnTarget(from) {
  const entry = RETURN_ROUTES[String(from || '')];
  return entry ? { label: `返回${entry[0]}`, path: entry[1] } : null;
}
export function deepLink(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'from' && !returnTarget(value)) continue;
    query.set(key, String(value));
  }
  return path + (query.size ? `?${query}` : '');
}

export function eventDestination(event) {
  const to = event?.payload?.to || event?.payload?.target || event?.target || '';
  return /^\/(?!\/)[a-z][a-z0-9/-]*(?:\?[^\\]*)?$/.test(to) ? to : '';
}
export function eventContainerLink(event, path) {
  const target = eventDestination(event);
  if (!target.startsWith('/logs?')) return '';
  const query = Object.fromEntries(new URLSearchParams(target.split('?')[1]));
  return deepLink(path, { ...query, from: 'events' });
}
