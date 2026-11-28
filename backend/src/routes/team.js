import { collectDockerOutput } from '../lib/docker-streams.js';
import { listAccounts, saveAccount, grantsFor, assertProjectGrant, accountAudit } from '../lib/accounts.js';
import { getHost, getDockerForHost, hostConnectionRevision } from '../services/docker-hosts.js';
import { scanProjects, scanProjectInventory } from '../services/scanner.js';
import { withProjectOperationLock } from '../services/project-operation-lock.js';
import { redactSecrets, harvestSecretValues } from '../lib/secret-redactor.js';
import db from '../lib/db.js';

const fail = (message, statusCode = 403) => Object.assign(new Error(message), { statusCode });
const admin = request => { if (request.principal?.role !== 'admin') throw fail('仅管理员可管理成员'); };
export default async function teamRoutes(app) {
  app.get('/accounts', async request => { admin(request); return { accounts: listAccounts() }; });
  app.put('/accounts', { schema: { body: { type: 'object', additionalProperties: false, required: ['username', 'role', 'grants'], properties: {
    id: { type: 'string', maxLength: 128 }, revision: { type: 'integer', minimum: 1 }, username: { type: 'string', maxLength: 40 }, displayName: { type: 'string', maxLength: 80 },
    password: { type: 'string', maxLength: 200 }, role: { type: 'string', enum: ['admin', 'operator', 'viewer'] }, enabled: { type: 'boolean' },
    grants: { type: 'array', maxItems: 200, items: { type: 'object', required: ['hostId','projectId'], additionalProperties: false, properties: { hostId: { type: 'string', minLength: 1, maxLength: 128 }, projectId: { type: 'string', minLength: 1, maxLength: 256 } } } },
  } } } }, async request => { admin(request); return { account: saveAccount(request.body, request.principal.id) }; });
  app.get('/audit', async request => { admin(request); return { events: db.prepare('SELECT id,actor,action,target,details_json,created_at FROM account_audit ORDER BY id DESC LIMIT 200').all() }; });
  app.get('/catalog', async request => {
    admin(request);
    const inventory = await scanProjectInventory();
    return inventory;
  });
  app.get('/projects', async request => {
    const grants = grantsFor(request.principal.id), projects = [], unavailable = [];
    for (const hostId of [...new Set(grants.map(g => g.hostId))]) {
      try {
        const rows = await scanProjects(hostId);
        for (const project of rows) {
          if (!project.managed || !grants.some(g => g.hostId === hostId && g.projectId === project.id)) continue;
          assertProjectGrant(request.principal, hostId, project.id);
          projects.push({ id: project.id, hostId, hostName: getHost(hostId)?.name || hostId, projectName: project.projectName, groupName: project.groupName || '',
            containers: project.containers.map(c => ({ id: c.id, name: c.name, service: c.service, state: c.state, status: c.statusText, image: c.image })) });
        }
      } catch { unavailable.push({ hostId, message: '节点暂不可达或授权已更新，请刷新核对' }); }
    }
    return { projects, unavailable };
  });
  async function target(request, write = false) {
    const { hostId, projectId, containerId } = request.params;
    assertProjectGrant(request.principal, hostId, projectId, write);
    const revision = hostConnectionRevision(hostId);
    const project = (await scanProjects(hostId)).find(p => p.id === projectId && p.managed);
    if (!project || !project.containers.some(c => c.id === containerId)) throw fail('容器不属于已授权的纳管项目', 404);
    const docker = getDockerForHost(hostId), container = docker.getContainer(containerId);
    const inspection = await container.inspect();
    if (inspection.Id !== containerId || inspection.Config?.Labels?.['com.docker.compose.project'] !== project.projectName) throw fail('容器身份已变化，请刷新后重试', 409);
    if (revision !== hostConnectionRevision(hostId)) throw fail('节点连接已变化，请刷新后重试', 409);
    assertProjectGrant(request.principal, hostId, projectId, write);
    return { docker, container, project, revision };
  }
  app.get('/projects/:hostId/:projectId/containers/:containerId/logs', async request => {
    const { container } = await target(request);
    const buffer = await container.logs({ stdout: true, stderr: true, tail: 200, timestamps: true, follow: false });
    const bytes = Buffer.from(buffer);
    const multiplexed = bytes.length >= 8 && [0, 1, 2].includes(bytes[0]) && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0;
    const text = (multiplexed ? await collectDockerOutput(bytes) : bytes.toString('utf8')).slice(-128000);
    harvestSecretValues(text);
    assertProjectGrant(request.principal, request.params.hostId, request.params.projectId);
    return { logs: redactSecrets(text), truncated: bytes.length > 128000 };
  });
  app.post('/projects/:hostId/:projectId/containers/:containerId/action', { schema: { body: { type: 'object', additionalProperties: false, required: ['action', 'confirmContainerId'], properties: { action: { type: 'string', enum: ['start','stop','restart'] }, confirmContainerId: { type: 'string', maxLength: 128 } } } } }, async request => {
    if (request.body.confirmContainerId !== request.params.containerId) throw fail('请确认操作的容器', 400);
    return withProjectOperationLock(request.params.projectId, async () => {
      const { container } = await target(request, true);
      const action = request.body.action, identity = { ...request.params, action };
      accountAudit(request.principal.id, 'container_action_started', request.params.containerId, identity);
      try {
        await container[action](action === 'start' ? {} : { t: 10 });
        const state = (await container.inspect()).State;
        const passed = action === 'stop' ? state.Running === false : state.Running === true;
        accountAudit(request.principal.id, 'container_action_finished', request.params.containerId, { ...identity, verified: passed, status: state.Status });
        return { ok: passed, state: state.Status, verification: passed ? '容器运行状态已核对，业务健康请另行检查' : '容器状态未达到预期，请核对日志' };
      } catch (error) {
        accountAudit(request.principal.id, 'container_action_unknown', request.params.containerId, { ...identity, error: error.message });
        throw fail('操作结果未确认，请刷新状态并检查日志，不要连续重试', 502);
      }
    });
  });
}
