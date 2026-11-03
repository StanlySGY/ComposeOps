/** 将镜像探测结果分类，避免把本地策略问题误报为仓库不可达。 */
export function buildImageUpdateSummary(projects) {
  const results = Array.isArray(projects) ? projects : [];
  const images = results.flatMap((project) => Array.isArray(project?.images) ? project.images : []);
  const updatedProjects = results.filter((project) => project?.hasUpdate).length;
  const registryFailures = images.filter((image) => image?.status === 'failed' && Boolean(image.registry)).length;
  const configFailures = images.filter((image) => image?.status === 'failed' && !image.registry).length;
  const policyRequired = images.filter((image) => image?.status === 'needs_policy').length;
  const unresolved = images.filter((image) => image?.status === 'unresolved').length;
  const parts = ['镜像检查完成：' + results.length + ' 个项目', updatedProjects + ' 个项目有更新'];
  if (registryFailures) parts.push(registryFailures + ' 个仓库探测失败');
  if (configFailures) parts.push(configFailures + ' 项配置检查失败');
  if (policyRequired) parts.push(policyRequired + ' 个服务需明确设置 pull_policy');
  if (unresolved) parts.push(unresolved + ' 个镜像引用需人工确认');
  return parts.join('，');
}
