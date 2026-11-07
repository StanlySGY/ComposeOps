import { createHash } from 'node:crypto';

/**
 * Compose 项目 ID 的唯一规则。
 * 宿主、workingDir 与 Compose project name 共同决定项目。
 * legacyHostId 在 v20 迁移时固定一次，保留旧宿主的 ID 与历史引用。
 */
export function composeProjectId(workingDir, projectName, hostId = 'local', legacyHostId = 'local') {
  return createHash('sha256')
    // 旧 ID 仅属于升级时的活动节点；其它节点使用独立命名空间。
    .update(`${hostId === legacyHostId ? '' : `${hostId}\0`}${String(workingDir || '')}\0${String(projectName || '')}`)
    .digest('hex')
    .slice(0, 20);
}
