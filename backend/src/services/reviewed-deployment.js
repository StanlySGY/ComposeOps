import { getActiveHostId } from './docker-hosts.js';
import { readCompose } from './compose-runner.js';
import { readWorkspaceCompose } from './compose-workspace.js';

/** Optional guard for deployments initiated from a completed review; also checked after acquiring the operation lock. */
export async function assertReviewedDeployment(project, action, review, deps = {}) {
  if (review.expectedContent === undefined && review.expectedHostId === undefined) return;
  if (action !== 'up' || typeof review.expectedContent !== 'string' || !review.expectedHostId) {
    throw Object.assign(new Error('评审部署必须包含已检查的配置与节点，请重新评审'), { statusCode: 400 });
  }
  if (!project.editable || !project.managed || !project.mountEnabled) {
    throw Object.assign(new Error('项目的 Compose 权限已变化，请重新评审'), { statusCode: 409 });
  }
  const activeHostId = deps.activeHostId || getActiveHostId;
  const checkHost = () => {
    if (activeHostId() !== review.expectedHostId || project.host?.id !== review.expectedHostId) {
      throw Object.assign(new Error('节点已变化，本次未部署，请重新评审'), { statusCode: 409 });
    }
  };
  checkHost();
  const read = deps.read || (project.mounted ? readCompose : readWorkspaceCompose);
  const current = await read(project, 0);
  checkHost();
  if (current.content !== review.expectedContent) {
    throw Object.assign(new Error('Compose 配置已变化，本次未部署，请重新评审'), { statusCode: 409 });
  }
}
