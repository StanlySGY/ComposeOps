/** 只展示确实存在升级前 Compose 备份的项目，避免把普通停机项目误报为可回滚。 */
export function getRollbackableProjects(projects, backups) {
  const projectIdsWithUpgradeBackup = new Set(
    (Array.isArray(backups) ? backups : [])
      .filter((backup) => (backup?.reason === 'upgrade' || (typeof backup?.reason === 'string' && backup.reason.startsWith('upgrade:'))) && typeof backup.projectId === 'string' && backup.projectId)
      .map((backup) => backup.projectId),
  );

  return (Array.isArray(projects) ? projects : []).filter((project) => (
    project?.managed === true
    && project?.editable === true
    && project.status !== 'running'
    && projectIdsWithUpgradeBackup.has(project.id)
  ));
}
