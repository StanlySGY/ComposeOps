export const operationalIntentLabels = { unknown: '未标注', running: '预期运行', stopped: '计划停机', maintenance: '维护中' };

export function containerHasFailure(container) {
  const exitCode = container.exitCode ?? /Exited \((\d+)\)/.exec(container.statusText || container.status || '')?.[1];
  return container.health === 'unhealthy' || ['restarting', 'dead'].includes(container.state) ||
    container.oomKilled === true || !!container.stateError ||
    (container.state === 'exited' && exitCode != null && Number(exitCode) !== 0);
}

export function needsAttention(project) {
  const containers = project.containers || [];
  if (containers.some(containerHasFailure)) return true;
  const intent = project.operationalIntent || 'unknown';
  if (intent === 'running') return !containers.length || containers.some(item => item.state !== 'running');
  if (intent === 'stopped') return containers.some(item => item.state === 'running');
  if (intent === 'maintenance') return false;
  return project.status === 'partial' || (!['running', 'stopped'].includes(project.status) && containers.length > 0);
}

export function isHealthyProject(project) {
  return project.status === 'running' && (project.containers || []).length > 0 &&
    !['stopped', 'maintenance'].includes(project.operationalIntent) && !needsAttention(project);
}

// Keep the summary and the destination about the same failing container.
export function projectAttention(project) {
  const containers = project.containers || [];
  const stopped = containers.filter(container => container.state !== 'running').length;
  const unhealthy = containers.filter(container => container.health === 'unhealthy').length;
  let label = project.status === 'partial' ? '部分运行'
    : project.status === 'running' ? (unhealthy ? '健康检查异常' : '运行中')
      : project.status === 'stopped' ? '已停止' : '状态异常';
  if (!needsAttention(project)) {
    if (project.operationalIntent === 'maintenance') label = '维护中';
    else if (project.status === 'stopped') label = project.operationalIntent === 'stopped' ? '计划停机' : '已停止 · 意图未标注';
  } else if (project.operationalIntent === 'running' && project.status === 'stopped') label = '应运行但已停止';
  else if (project.operationalIntent === 'stopped' && containers.some(item => item.state === 'running')) label = '计划停机但仍在运行';
  else if (containers.some(containerHasFailure) && project.status === 'stopped') label = '容器异常退出';
  const details = [];
  if (stopped) details.push(`${stopped} 个未运行`);
  if (unhealthy) details.push(`${unhealthy} 个健康检查异常`);
  return { label, detail: details.length ? details.join(' · ') : `${containers.length} 个容器` };
}

export function projectLogTarget(project) {
  const containers = project.containers || [];
  const container = containers.find(containerHasFailure) || containers.find(item => item.state !== 'running');
  return {
    path: '/logs',
    query: { projectId: project.id, ...(container ? { containerId: container.id } : {}), from: 'dashboard' },
  };
}
