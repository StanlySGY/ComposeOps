// Keep the summary and the destination about the same failing container.
export function projectAttention(project) {
  const containers = project.containers || [];
  const stopped = containers.filter(container => container.state !== 'running').length;
  const unhealthy = containers.filter(container => container.health === 'unhealthy').length;
  const label = project.status === 'partial' ? '部分运行'
    : project.status === 'running' ? (unhealthy ? '健康检查异常' : '运行中')
      : project.status === 'stopped' ? '已停止' : '状态异常';
  const details = [];
  if (stopped) details.push(`${stopped} 个未运行`);
  if (unhealthy) details.push(`${unhealthy} 个健康检查异常`);
  return { label, detail: details.length ? details.join(' · ') : `${containers.length} 个容器` };
}

export function projectLogTarget(project) {
  const containers = project.containers || [];
  const container = containers.find(item => item.state !== 'running')
    || containers.find(item => item.health === 'unhealthy');
  return {
    path: '/logs',
    query: { projectId: project.id, ...(container ? { containerId: container.id } : {}), from: 'dashboard' },
  };
}
