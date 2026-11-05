// Shared labels keep the header, breadcrumbs and browser tab in agreement.
export const PAGE_DETAILS = {
  dashboard: { label: '运维总览', group: '工作台' },
  services: { label: '服务总览', group: '运行' },
  compose: { label: 'Compose 配置', group: '运行', parent: 'services' },
  logs: { label: '实时日志', group: '运行', parent: 'services' },
  shell: { label: '容器终端', group: '运行', parent: 'services' },
  agent: { label: 'AI 智能运维 Agent', group: '运行' },
  'agent-history': { label: 'Agent 执行历史', group: '观测', parent: 'agent' },
  monitor: { label: '实时监控', group: '观测' },
  inspection: { label: 'AI 巡检中心', group: '观测' },
  topology: { label: '服务拓扑', group: '观测' },
  events: { label: '事件中心', group: '观测' },
  'ops-center': { label: '任务中心', group: '自动化' },
  'ops-tickets': { label: '长期任务', group: '自动化' },
  'maintenance-plan': { label: '运维计划', group: '自动化' },
  workflows: { label: '工作流', group: '自动化' },
  cron: { label: '定时任务', group: '自动化' },
  gitops: { label: 'GitOps', group: '自动化' },
  review: { label: '变更与回滚', group: '自动化' },
  cmdb: { label: '资产中心', group: '资源' },
  'node-groups': { label: '节点组管理', group: '资源' },
  marketplace: { label: '应用市场', group: '资源' },
  resources: { label: '存储清理', group: '资源' },
  cost: { label: '成本分析', group: '资源' },
  settings: { label: '系统设置', group: '系统' },
};

export function pageDetails(route) {
  return PAGE_DETAILS[route?.name] || { label: '运维控制台', group: '工作台' };
}

// Only trust a recognized in-app route. Never send a back action to an external
// page, an unknown route, or a forged protocol-relative URL.
export function historyTarget(router, value, current) {
  if (typeof value !== 'string' || !value.startsWith('/') || /^\/[/\\]/.test(value)) return null;
  const resolved = router.resolve(value);
  return PAGE_DETAILS[resolved.name] && resolved.fullPath !== current.fullPath ? resolved : null;
}

export function fallbackTarget(router, route) {
  const source = ['services', 'topology'].includes(route.query?.from) ? route.query.from : null;
  const name = source || pageDetails(route).parent || 'dashboard';
  if (route.name === name) return null;
  const projectId = typeof route.query?.projectId === 'string' ? route.query.projectId : '';
  return router.resolve({ name, query: name === 'services' && projectId ? { focus: projectId } : {} });
}
