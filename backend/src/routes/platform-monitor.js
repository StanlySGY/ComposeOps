import { authenticatePlatformMonitor, recordExternalCheck, platformSnapshot } from '../services/sre-platform.js';

/** Dedicated read/check-in credential. It cannot access operational APIs. No cookies are accepted. */
export default async function platformMonitorRoutes(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!authenticatePlatformMonitor(request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
  });
  fastify.post('/', { bodyLimit: 1024, schema: { body: { type: 'object', additionalProperties: false, required: ['location'], properties: { location: { enum: ['same-host', 'separate-host'] } } } } }, async (request, reply) => {
    recordExternalCheck(request.body.location);
    const result = platformSnapshot(), sample = result.sample;
    const degraded = result.stale || result.alerts.some(row => row.scope === 'platform' && row.state === 'firing' && !row.suppressed);
    reply.code(degraded ? 503 : 200);
    return { status: degraded ? 'degraded' : 'ok', at: Date.now(), sampleAt: sample?.at ?? null,
      stale: result.stale, alerts: result.alerts.filter(row => row.scope === 'platform' && row.state === 'firing').map(row => ({ key: row.key, title: row.title, condition: row.condition, suppressed: row.suppressed })) };
  });
}
