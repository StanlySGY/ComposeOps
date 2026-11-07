// Runtime observations are distinct from process exit codes and business checks.
export function observeProjectOperation(project, action) {
  if (!project) return { state: 'unknown', title: '未找到项目', detail: '项目可能已移除或当前节点不可用，请回到服务列表确认。', containers: [] };
  const containers = (project.containers || []).map(({ id, name, state, health }) => ({ id, name, state, health }));
  if (!containers.length) return { state: 'unknown', title: '尚未发现容器', detail: '当前扫描没有容器记录，请检查操作输出和 Compose 配置。', containers };
  if (action === 'stop') {
    const stopped = containers.every(container => ['exited', 'created'].includes(container.state));
    return { state: stopped ? 'confirmed' : 'attention', title: stopped ? '已核对：容器全部停止' : '仍有容器尚未停止', detail: stopped ? `${containers.length} 个容器已停止，数据保留。` : '刷新状态再次核对，或打开项目查看具体容器。', containers };
  }
  const notRunning = containers.filter(container => container.state !== 'running').length;
  const unhealthy = containers.filter(container => container.health === 'unhealthy').length;
  const starting = containers.filter(container => container.health === 'starting').length;
  if (notRunning || unhealthy) return { state: 'attention', title: '状态仍需关注', detail: [notRunning && `${notRunning} 个容器未运行`, unhealthy && `${unhealthy} 个健康检查异常`].filter(Boolean).join(' · ') + '。可继续查看日志定位原因。', containers };
  if (starting) return { state: 'pending', title: '容器已运行，等待健康检查', detail: `${starting} 个容器还在初始化。稍后重新核对，无需重复执行操作。`, containers };
  return { state: 'confirmed', title: '已核对：当前容器全部运行', detail: `${containers.length} 个容器运行中${containers.every(container => container.health === 'healthy') ? '，健康检查通过' : '；部分容器未配置健康检查'}。请继续确认业务访问。`, containers };
}
