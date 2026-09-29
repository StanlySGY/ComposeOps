import {
  queryEvents,
  updateEvent,
  pruneEvents,
  eventStats,
} from '../services/event-center.js';

/**
 * 统一事件中心路由:
 * - GET /events 事件列表(按类型/级别/状态过滤)
 * - GET /events/stats 事件统计
 * - PATCH /events/:id 状态流转(open/acknowledged/resolved/closed, read)
 * - POST /events/prune 清理过期事件
 */

const eventQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    eventType: { type: 'string', maxLength: 32 },
    severity: { type: 'string', maxLength: 16 },
    status: { type: 'string', maxLength: 16 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
  },
};

export default async function eventCenterRoutes(fastify) {
  fastify.get('/events', { schema: { querystring: eventQuery } }, async (request) => {
    const { eventType = '', severity = '', status = '', limit } = request.query || {};
    return { events: queryEvents({ eventType, severity, status, limit }) };
  });

  fastify.get('/events/stats', async () => ({ stats: eventStats() }));

  fastify.patch('/events/:id', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 32 } } },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', maxLength: 16 },
          read: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const rawId = String(request.params.id || '');
    const id = Number(rawId);
    const validLegacy = /^legacy-alert-\d+$/.test(rawId);
    if ((!Number.isInteger(id) || id <= 0) && !validLegacy) return reply.code(400).send({ error: 'invalid_event_id', message: '无效的事件 ID' });
    const { status, read } = request.body || {};
    const event = updateEvent(validLegacy ? rawId : id, { status, read });
    if (!event) return reply.code(404).send({ error: 'event_not_found', message: '事件不存在' });
    return { event };
  });

  fastify.post('/events/prune', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { days: { type: 'number' } },
      },
    },
  }, async (request) => {
    const days = Math.max(1, Math.min(Number(request.body?.days) || 30, 365));
    const result = pruneEvents(days);
    return { ok: true, removed: result.changes };
  });
}
