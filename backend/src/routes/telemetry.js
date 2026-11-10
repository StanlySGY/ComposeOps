import { gunzipSync } from 'node:zlib';
import { authenticateTelemetry, ingestOtlp } from '../services/sre-telemetry.js';

export default async function telemetryRoutes(fastify, { authenticate = authenticateTelemetry } = {}) {
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const credential = await authenticate(request.headers.authorization);
    // Fastify gives each request its own object; no other hook writes this field.
    // eslint-disable-next-line require-atomic-updates
    request.telemetryCredential = credential;
    if (request.headers['content-encoding'] && !['identity', 'gzip'].includes(request.headers['content-encoding'])) return reply.code(415).send({ error: 'unsupported_encoding' });
  });
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (request, body, done) => {
    try {
      const buffer = request.headers['content-encoding'] === 'gzip' ? gunzipSync(body, { maxOutputLength: 1024 * 1024 }) : body;
      done(null, JSON.parse(buffer.toString('utf8')));
    } catch { done(Object.assign(new Error('遥测 JSON 或压缩内容无效，解压后不得超过 1 MiB'), { statusCode: 400 })); }
  });
  for (const signal of ['traces', 'logs']) fastify.post('/' + signal, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    try { ingestOtlp(request.body, signal, request.telemetryCredential); return {}; }
    catch (error) { if (error.statusCode === 429) reply.header('Retry-After', '60'); throw error; }
  });
}
