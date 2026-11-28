/** Incremental management command shared by HTTP and Agent. Other projects keep their grants. */
import db, { getProjectPreference, getProjectMountEnabled, setProjectPreference, addOperation } from '../lib/db.js';
import { scanProjects, invalidateScanCache } from './scanner.js';
import { getHost, hostConnectionRevision } from './docker-hosts.js';
import { validateGroupAssignments, writeAssignments } from './project-groups.js';
import { pruneWorkspaceRunners } from './compose-workspace.js';
import { withProjectOperationLock } from './project-operation-lock.js';

export const projectManagementSchema = { type: 'object', additionalProperties: false, required: ['hostId', 'projectId', 'managed', 'mountEnabled'], properties: {
  hostId: { type: 'string', minLength: 1, maxLength: 128 }, projectId: { type: 'string', minLength: 1, maxLength: 128 },
  managed: { type: 'boolean' }, mountEnabled: { type: 'boolean' }, groupId: { type: ['string', 'null'], maxLength: 128 },
} };
const fail = message => { throw Object.assign(new Error(message), { statusCode: 409 }); };
export async function updateManagedProject(input, { scan = scanProjects, prune = pruneWorkspaceRunners } = {}) {
  const { hostId, projectId, managed, mountEnabled } = input;
  if (!getHost(hostId)) fail('Docker 节点不存在');
  if (typeof managed !== 'boolean' || typeof mountEnabled !== 'boolean' || !managed && mountEnabled) fail('纳管和目录授权无效');
  const revision = hostConnectionRevision(hostId);
  return withProjectOperationLock(projectId, async () => {
    const projects = await scan(hostId), project = projects.find(row => row.id === projectId && row.hostId === hostId);
    if (!project || revision !== hostConnectionRevision(hostId)) fail('项目不存在或节点配置已变化，请重新扫描');
    if (mountEnabled && !project.mounted && !project.workspaceAvailable) fail('此项目尚不具备安全的 Compose 目录能力');
    const assignments = input.groupId === undefined ? [] : [{ projectId, groupId: input.groupId }];
    validateGroupAssignments(projects, assignments);
    db.transaction(() => {
      writeAssignments(projects, assignments);
      setProjectPreference(projectId, { managed, mountEnabled });
      db.prepare('UPDATE project_preferences SET host_id=? WHERE project_id=?').run(hostId, projectId);
    })();
    invalidateScanCache();
    const retained = db.prepare('SELECT project_id FROM project_preferences WHERE mount_enabled=1').all().map(row => row.project_id);
    await prune(retained, hostId);
    addOperation({ action: 'projects.management', status: 'success', detail: `${hostId} · ${project.projectName} · ${managed ? '纳管' : '取消纳管'}` });
    return { hostId, projectId, ...getProjectPreference(projectId), mountEnabled: getProjectMountEnabled(projectId) };
  });
}
