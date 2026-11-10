import { listBusinessRecovery, businessRecoveryCandidates, saveBusinessPlan, pauseBusinessPlan, queueBusinessBackup, queueBusinessRun, acknowledgeBusinessJob } from '../services/sre-business-recovery.js';
const actor = request => request.user?.username || request.user?.id || 'admin';
const id = { type: 'string', minLength: 1, maxLength: 160 };
const params = { type: 'object', required: ['id'], properties: { id } };
const planBody = { type: 'object', additionalProperties: false, required: ['config'], properties: { version: { type: 'integer', minimum: 1 }, projectId: id, hostId: id,
  config: { type: 'object' }, enabled: { type: 'boolean' }, confirm: { type: 'string', maxLength: 80 }, noConcurrentDdl: { type: 'boolean' } } };
export default async function businessRecoveryRoutes(fastify) {
  fastify.get('/', async () => listBusinessRecovery());
  fastify.get('/candidates', { schema: { querystring: { type: 'object', required: ['projectId'], properties: { hostId: id, projectId: id } } } }, async request => businessRecoveryCandidates(request.query));
  fastify.post('/plans', { schema: { body: planBody } }, async request => ({ plan: await saveBusinessPlan(request.body, actor(request)) }));
  fastify.put('/plans/:id', { schema: { params, body: planBody } }, async request => ({ plan: await saveBusinessPlan({ ...request.body, id: request.params.id }, actor(request)) }));
  fastify.post('/plans/:id/pause', { schema: { params } }, async request => ({ plan: pauseBusinessPlan(request.params.id, actor(request)) }));
  fastify.post('/plans/:id/backup', { schema: { params, body: { type: 'object', additionalProperties: false, required: ['confirm'], properties: { confirm: { const: 'CREATE_BUSINESS_BACKUP' }, drillAfter: { type: 'boolean' } } } } }, async (request, reply) => reply.code(202).send({ backup: queueBusinessBackup(request.params.id, actor(request), request.body.drillAfter === true) }));
  fastify.post('/plans/:id/run', { schema: { params, body: { type: 'object', additionalProperties: false, required: ['confirm', 'backupId'], properties: { confirm: { const: 'ISOLATED_BUSINESS_RECOVERY' }, backupId: id } } } }, async (request, reply) => reply.code(202).send({ run: queueBusinessRun(request.params.id, request.body.backupId, actor(request)) }));
  fastify.post('/:kind/:id/acknowledge', { schema: { params: { type: 'object', required: ['kind', 'id'], properties: { id, kind: { enum: ['backup', 'run'] } } }, body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 8, maxLength: 1000 } } } } }, async request => ({ job: await acknowledgeBusinessJob(request.params.kind, request.params.id, request.body.reason, actor(request)) }));
}
