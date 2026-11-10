import { listIncidents, getIncidentDetail, incidentError, incidentStats } from '../services/incident-store.js';
import { diagnoseIncident, incidentObserverStatus } from '../services/incident-observer.js';
import { proposeIncidentRestart } from '../services/incident-remediation.js';
import { getOpsEffectWorkerStatus } from '../services/ops-effect-worker.js';

const params = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 160 } } };
const noInput = { params, body: { type: 'object', additionalProperties: false } };
async function rejectParameters(request) {
  if (request.body && Object.keys(request.body).length) throw incidentError('该操作不接受客户端指定动作参数', 400);
}
export default async function incidentRoutes(fastify) {
  fastify.get('/', { schema: { querystring: { type: 'object', additionalProperties: false, properties: {
    hostId: { type: 'string', maxLength: 160 }, status: { type: 'string', enum: ['open', 'investigating', 'awaiting_approval', 'queued', 'executing', 'verifying', 'needs_attention', 'resolved'] },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  } } } }, async request => ({ incidents: listIncidents(request.query), stats: incidentStats(), observer: incidentObserverStatus(), worker: getOpsEffectWorkerStatus() }));
  fastify.get('/:id', { schema: { params } }, async request => getIncidentDetail(request.params.id));
  fastify.post('/:id/diagnose', { schema: noInput, preValidation: rejectParameters }, async request => ({ incident: await diagnoseIncident(request.params.id) }));
  fastify.post('/:id/propose-restart', { schema: noInput, preValidation: rejectParameters }, async (request, reply) => {
    const result = proposeIncidentRestart(request.params.id, request.user?.username || request.user?.id || 'admin');
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
}
