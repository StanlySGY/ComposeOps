import { listHosts, getHost, hostConnectionRevision, upsertHost, pingHost, deleteHost } from '../docker-hosts.js';
import { scanProjects } from '../scanner.js';
import { listProjectGroups, saveProjectGroup, deleteProjectGroup, assignProjectGroups } from '../project-groups.js';
import { updateManagedProject, projectManagementSchema } from '../project-management.js';
import { addOperation } from '../../lib/db.js';

const id = { type: 'string', minLength: 1, maxLength: 128 };
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const schema = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const hostView = host => ({ id: host.id, name: host.name, type: host.type, host: host.host, port: host.port,
  username: host.username, hostFingerprint: host.hostFingerprint, active: host.active, status: host.status,
  connectionRevision: hostConnectionRevision(host.id), hasCredentials: !!(host.hasPassword || host.hasPrivateKey || host.tls?.key) });
export function projectView(project) {
  return { id: project.id, hostId: project.hostId, name: project.projectName, managed: !!project.managed, mountEnabled: !!project.mountEnabled,
    editable: !!project.editable, composeMode: project.composeMode, groupId: project.groupId || null, groupName: project.groupName,
    canEnableCompose: !!(project.mounted || project.workspaceAvailable), services: [...new Set((project.containers || []).map(row => row.service).filter(Boolean))] };
}
export function registerManagementTools(agent) {
  const register = (name, description, parameters, execute, write = false) => agent.registerTool(name, {
    description, parameters, execute, category: 'management', productDomain: 'management', readOnly: !write,
    requiredPermission: 'admin', confirmationRequired: write, requiresProject: false,
  });
  register('host.list', '列出节点 ID、连接版本和凭据是否已配置；不返回任何密码或私钥。跨节点操作必须使用明确 hostId。', schema({}), async () => ({ hosts: listHosts().map(hostView) }));
  register('host.ping', '检测已保存节点的连接；不切换全局节点。', schema({ hostId: id }, ['hostId']), async p => {
    const result = await pingHost(p.hostId); return { ...result, host: result.host ? hostView(result.host) : undefined };
  });
  register('host.save', '接入或修改 SSH/TCP 节点。仅使用已保存节点的凭据引用 credentialFromHostId 和其 connectionRevision（填入 credentialRevision），禁止在聊天输入密码/私钥；首次凭据在设置页录入。更新必须提供节点当前连接版本。', schema({
    id, name: text(200), type: { enum: ['ssh', 'tcp'] }, host: text(255), port: { type: 'integer', minimum: 1, maximum: 65535 },
    username: text(128), hostFingerprint: text(128), credentialFromHostId: id, credentialRevision: id, expectedRevision: id,
  }, ['name', 'type', 'host']), async p => {
    if (p.id === 'local') throw new Error('不能改写内置本地节点');
    const previous = p.id ? getHost(p.id) : null;
    if (p.id && (!previous || p.expectedRevision !== hostConnectionRevision(p.id))) throw new Error('节点不存在或连接版本已变化');
    const source = p.credentialFromHostId ? getHost(p.credentialFromHostId) : previous;
    if (p.credentialFromHostId && (!source || p.credentialRevision !== hostConnectionRevision(p.credentialFromHostId))) throw new Error('凭据来源节点不存在或版本已变化，请提供 host.list 返回的 credentialRevision');
    if (source && source.type !== p.type) throw new Error('凭据来源节点类型不匹配');
    if (p.type === 'ssh' && !(source?.password || source?.privateKey)) throw new Error('请先在设置页安全录入 SSH 凭据，然后引用该节点 ID');
    const host = upsertHost({ ...p, ...(source ? { password: source.password, privateKey: source.privateKey, tls: source.tls } : {}) });
    addOperation({ action: 'hosts.save', status: 'success', detail: host.name }); return hostView(host);
  }, true);
  register('host.delete', '移除已保存节点连接配置，不删除远端容器。需要确认当前连接版本。', schema({ hostId: id, expectedRevision: id }, ['hostId', 'expectedRevision']), async p => {
    if (hostConnectionRevision(p.hostId) !== p.expectedRevision) throw new Error('节点版本已变化');
    const result = deleteHost(p.hostId); addOperation({ action: 'hosts.delete', status: 'success', detail: p.hostId }); return result;
  }, true);
  register('project.discover', '扫描指定节点上的 Compose 项目，含尚未纳管的项目；只用于发现和申请纳管，不能直接操作未纳管项目。', schema({ hostId: id }, ['hostId']), async p => ({ hostId: p.hostId, projects: (await scanProjects(p.hostId)).map(projectView) }));
  register('project.manage', '增量更新一个项目的纳管、Compose 目录授权与可选分组。不会撤销其他项目授权；必须先 project.discover 获取准确 ID。', projectManagementSchema, p => updateManagedProject(p), true);
  register('group.list', '列出用户命名的项目分组。', schema({}), async () => ({ groups: listProjectGroups() }));
  register('group.save', '新建命名分组或修改已有分组名称、置顶。省略 id 表示新建。', schema({ id, name: text(40), pinned: { type: 'boolean' } }, ['name']), async p => {
    const group = saveProjectGroup(p); addOperation({ action: 'projects.group.save', status: 'success', detail: group.name }); return group;
  }, true);
  register('group.delete', '删除分组并将组内项目移至未分组；不取消纳管、不删除服务。', schema({ id }, ['id']), async p => {
    const result = deleteProjectGroup(p.id); addOperation({ action: 'projects.group.delete', status: 'success', detail: p.id }); return result;
  }, true);
  register('group.assign', '将指定节点的一个项目归组，groupId=null 表示移至未分组。', schema({ hostId: id, projectId: id,
    groupId: { type: ['string', 'null'], minLength: 1, maxLength: 128 } }, ['hostId', 'projectId', 'groupId']), async p => {
    const revision = hostConnectionRevision(p.hostId), projects = await scanProjects(p.hostId);
    if (hostConnectionRevision(p.hostId) !== revision) throw new Error('节点连接已变化，请重新扫描');
    const result = assignProjectGroups(projects, [{ projectId: p.projectId, groupId: p.groupId }]);
    addOperation({ action: 'projects.group.assign', status: 'success', detail: `${p.hostId} · ${p.projectId}` }); return result;
  }, true);
}
