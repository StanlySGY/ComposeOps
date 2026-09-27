import { createHash } from 'node:crypto';

/**
 * Compose 项目 ID 的唯一规则。
 * workingDir 与 Compose project name 共同决定项目,避免同名项目互相覆盖纳管配置。
 */
export function composeProjectId(workingDir, projectName) {
  return createHash('sha256')
    .update(`${String(workingDir || '')}\0${String(projectName || '')}`)
    .digest('hex')
    .slice(0, 20);
}
