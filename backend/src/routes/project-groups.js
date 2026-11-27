import { getActiveHostId } from '../services/docker-hosts.js';
import { scanProjects } from '../services/scanner.js';
import { addOperation } from '../lib/db.js';
import { listProjectGroups, saveProjectGroup, deleteProjectGroup, assignProjectGroups } from '../services/project-groups.js';

export const groupAssignmentsSchema = { type: 'array', maxItems: 1000, items: { type: 'object', additionalProperties: false, required: ['projectId', 'groupId'], properties: { projectId: { type: 'string', minLength: 1, maxLength: 128 }, groupId: { anyOf: [{ type: 'string', minLength: 1, maxLength: 128 }, { type: 'null' }] } } } };
const groupBody = { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 40 }, pinned: { type: 'boolean' } } };
const guarded = fn => async (request, reply) => { try { return await fn(request); } catch (error) { return reply.code(error.statusCode || 500).send({ error: 'project_group_failed', message: error.message }); } };
export function registerProjectGroupRoutes(fastify) {
  fastify.get('/groups', async () => ({ groups: listProjectGroups() }));
  fastify.post('/groups', { schema: { body: { ...groupBody, required: ['name'] } } }, guarded(request => {
    const group = saveProjectGroup(request.body); addOperation({ action: 'projects.group.save', status: 'success', detail: group.name }); return group;
  }));
  fastify.patch('/groups/:id', { schema: { body: groupBody } }, guarded(request => {
    const group = saveProjectGroup({ ...request.body, id: request.params.id }); addOperation({ action: 'projects.group.save', status: 'success', detail: group.name }); return group;
  }));
  fastify.delete('/groups/:id', guarded(request => { const result = deleteProjectGroup(request.params.id); addOperation({ action: 'projects.group.delete', status: 'success', detail: request.params.id }); return result; }));
  fastify.put('/group-assignments', { schema: { body: { type: 'object', additionalProperties: false, required: ['expectedHostId', 'assignments'], properties: { expectedHostId: { type: 'string', minLength: 1, maxLength: 128 }, assignments: groupAssignmentsSchema } } } }, guarded(async request => {
    const hostId = request.body.expectedHostId;
    if (hostId !== getActiveHostId()) throw Object.assign(new Error('节点已切换，请刷新后重试'), { statusCode: 409 });
    const projects = await scanProjects(hostId);
    if (hostId !== getActiveHostId()) throw Object.assign(new Error('节点已切换，请刷新后重试'), { statusCode: 409 });
    const result = assignProjectGroups(projects, request.body.assignments);
    addOperation({ action: 'projects.group.assign', status: 'success', detail: `${hostId} · ${request.body.assignments.length} 个项目` }); return result;
  }));
}
