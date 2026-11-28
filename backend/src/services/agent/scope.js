import { hostConnectionRevision } from '../docker-hosts.js';
import { accountById, assertProjectGrant } from '../../lib/accounts.js';
const denied = () => Object.assign(new Error('账号权限或项目范围已变化，请重新登录并核对授权'), { statusCode: 403 });
export function assertAgentAuthority(context, ownerId, params = {}, write = false) {
  const owner = accountById(ownerId);
  if (!owner?.enabled) throw denied();
  if (!context.memberScope) { if (owner.role !== 'admin') throw Object.assign(new Error('任务发起者已失去管理员权限'), { statusCode: 403 }); return owner; }
  const scope = context.memberScope;
  if (owner.id !== scope.accountId || owner.revision !== scope.accountRevision || !['operator', 'viewer'].includes(owner.role)) throw denied();
  if (context.hostId !== scope.hostId || context.projectId !== scope.projectId) throw denied();
  if (params.hostId && params.hostId !== scope.hostId || params.projectId && params.projectId !== scope.projectId) throw denied();
  if (scope.hostRevision && scope.hostRevision !== hostConnectionRevision(scope.hostId)) throw denied();
  assertProjectGrant(owner, scope.hostId, scope.projectId, write);
  return owner;
}
