import { OperationsAgent } from './engine.js';
import { assertAgentAuthority } from './scope.js';
import { scanProjects } from '../scanner.js';
import { getDockerForHost, hostConnectionRevision } from '../docker-hosts.js';
import { collectDockerOutput } from '../../lib/docker-streams.js';
import { harvestSecretValues, redactSecrets } from '../../lib/secret-redactor.js';
import { validateParams } from './planning.js';
import { withProjectOperationLock } from '../project-operation-lock.js';
import { runDurableEffect } from './run-store.js';
import { evaluateAgentPolicy } from './policy-store.js';

const fail = (message, statusCode = 403) => Object.assign(new Error(message), { statusCode });
export async function memberProject(context, write = false) {
  assertAgentAuthority(context, context.initiator, {}, write);
  const revision = hostConnectionRevision(context.hostId);
  const project = (await scanProjects(context.hostId)).find(p => p.id === context.projectId && p.managed);
  if (!project) throw fail('授权项目当前不可用', 404);
  assertAgentAuthority(context, context.initiator, {}, write);
  if (revision !== hostConnectionRevision(context.hostId)) throw fail('节点连接已变化，请重新核对', 409);
  return { project, revision };
}
/** A separate registry contains no macros, shell, config, global memory, or arbitrary-host tools. */
export class MemberAgent extends OperationsAgent {
  constructor() {
    super(); this.tools.clear(); this.memberOnly = true;
    for (const name of ['compose.ps', 'compose.logs', 'compose.up', 'compose.stop', 'compose.restart']) {
      const readOnly = ['compose.ps', 'compose.logs'].includes(name);
      this.registerTool(name, {
        description: { 'compose.ps': '读取当前授权项目现有容器状态', 'compose.logs': '读取当前项目指定容器最近 200 行脱敏日志', 'compose.up': '启动当前项目指定的已有容器，不创建容器', 'compose.stop': '停止当前项目指定容器', 'compose.restart': '重启当前项目指定容器' }[name],
        storedScope: true, requiredPermission: 'readonly', confirmationRequired: !readOnly, readOnly,
        parameters: { type: 'object', additionalProperties: false, required: name === 'compose.ps' ? [] : ['containerId'], properties: { containerId: { type: 'string', minLength: 1, maxLength: 128 } } },
        execute: async () => { throw fail('必须通过成员任务执行'); },
      });
    }
  }
  getTool(name) { return this.tools.get(name) || null; }
  listTools() { return [...this.tools.values()].map(({ execute: _execute, ...tool }) => tool); }
  async executeTool(name, params, context) {
    const tool = this.getTool(name);
    if (!tool || !context.memberScope || !context.durableRunId) throw fail('工具未授权');
    validateParams(tool.parameters, params);
    assertAgentAuthority(context, context.initiator, params, !tool.readOnly);
    const policy = evaluateAgentPolicy({ toolName: name, params, projectId: context.projectId });
    if (policy.decision === 'deny') throw fail('管理员策略拒绝该操作');
    const perform = async () => {
      const { project, revision } = await memberProject(context, !tool.readOnly);
      if (name === 'compose.ps') return { projectId: project.id, name: project.projectName, containers: project.containers.map(c => ({ id: c.id, name: c.name, service: c.service, state: c.state, status: c.statusText })) };
      if (!project.containers.some(c => c.id === params.containerId)) throw fail('容器不属于当前授权项目');
      const container = getDockerForHost(context.hostId).getContainer(params.containerId);
      const inspected = await container.inspect();
      if (inspected.Id !== params.containerId || inspected.Config?.Labels?.['com.docker.compose.project'] !== project.projectName) throw fail('容器身份已变化', 409);
      assertAgentAuthority(context, context.initiator, params, !tool.readOnly);
      if (revision !== hostConnectionRevision(context.hostId)) throw fail('节点连接已变化', 409);
      if (name === 'compose.logs') {
        const bytes = Buffer.from(await container.logs({ stdout: true, stderr: true, follow: false, timestamps: true, tail: 200 }));
        const multiplexed = bytes.length >= 8 && [0,1,2].includes(bytes[0]) && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0;
        const text = (multiplexed ? await collectDockerOutput(bytes) : bytes.toString('utf8')).slice(-16000);
        harvestSecretValues(text); assertAgentAuthority(context, context.initiator);
        return { logs: redactSecrets(text), truncated: bytes.length > 16000 };
      }
      return runDurableEffect(context.durableRunId, name, { hostId: context.hostId, projectId: context.projectId, containerId: params.containerId }, async () => {
        assertAgentAuthority(context, context.initiator, params, true);
        const action = { 'compose.up': 'start', 'compose.stop': 'stop', 'compose.restart': 'restart' }[name];
        await container[action](action === 'start' ? {} : { t: 10 });
        const state = (await container.inspect()).State;
        const ok = action === 'stop' ? state.Running === false : state.Running === true;
        return { ok, state: state.Status, verification: { status: ok ? 'passed' : 'failed', reason: '已核对容器运行状态；业务健康需另行验收' } };
      });
    };
    const result = tool.readOnly ? await perform() : await withProjectOperationLock(context.projectId, perform);
    return { success: result.ok !== false, result, postconditionStatus: result.verification?.status || 'passed' };
  }
}
let agent;
export const getMemberAgent = () => agent ||= new MemberAgent();
