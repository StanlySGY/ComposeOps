import { listOnboarding, getOnboarding, onboardingContext, saveOnboarding, applyOnboarding } from '../services/sre-onboarding.js';
const actor = request => request.user?.username || request.user?.id || 'admin';
const id = { type: 'string', minLength: 1, maxLength: 160 }, params = { type: 'object', required: ['id'], properties: { id } };
const body = { type: 'object', additionalProperties: false, required: ['config'], properties: { config: { type: 'object' }, version: { type: 'integer', minimum: 1 }, hostId: id, projectId: id, requestId: { type: 'string', minLength: 16, maxLength: 80 } } };
export default async function onboardingRoutes(fastify) {
  fastify.get('/', async () => ({ drafts: listOnboarding() }));
  fastify.get('/context', { schema: { querystring: { type: 'object', required: ['projectId'], properties: { hostId: id, projectId: id } } } }, async request => onboardingContext(request.query));
  fastify.get('/:id', { schema: { params } }, async request => ({ draft: getOnboarding(request.params.id) }));
  fastify.post('/', { schema: { body } }, async request => ({ draft: await saveOnboarding(request.body, actor(request)) }));
  fastify.put('/:id', { schema: { params, body } }, async request => ({ draft: await saveOnboarding({ ...request.body, id: request.params.id }, actor(request)) }));
  fastify.post('/:id/apply', { schema: { params, body: { type: 'object', additionalProperties: false, required: ['version', 'fingerprint', 'confirm'], properties: {
    version: { type: 'integer', minimum: 1 }, fingerprint: { type: 'string', minLength: 64, maxLength: 64 }, confirm: { const: 'APPLY_APPLICATION_ONBOARDING' }, autonomyConfirm: { const: 'ENABLE_AUTONOMY' },
  } } } }, async request => ({ draft: await applyOnboarding(request.params.id, request.body, actor(request)) }));
}
