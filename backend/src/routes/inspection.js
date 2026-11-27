/**
 * AI 巡检路由(/ops/inspection/*)。
 *
 * 只读巡检的唯一 HTTP 入口:执行巡检、读报告、配置自动巡检。
 * 巡检本身不执行任何变更 —— 报告里的每条建议都带 tool 字段,
 * 由用户决定是否交给 Agent 去执行(走 Agent 的确认门)。
 */
import { runInspection, getInspectionOverview, saveInspectionSchedule, GRADE_LABELS } from '../services/inspection.js';
import { getInspection, listInspections, pruneInspections } from '../lib/db.js';
import { limitField, numericId } from '../lib/schemas.js';

export default async function inspectionRoutes(fastify) {
  // GET /api/v1/ops/inspection/overview —— 首页/巡检页顶部卡片
  fastify.get('/inspection/overview', {
    schema: { querystring: { type: 'object', properties: { limit: limitField(50) } } },
  }, async (request) => {
    const overview = getInspectionOverview(request.query?.limit || 20);
    return { ...overview, gradeLabels: GRADE_LABELS };
  });

  // GET /api/v1/ops/inspection/reports —— 报告历史(不含 findings 明细,列表不需要明细)
  fastify.get('/inspection/reports', {
    schema: { querystring: { type: 'object', properties: { limit: limitField(100) } } },
  }, async (request) => ({
    reports: listInspections(request.query?.limit || 20).map(({ findings: _findings, ...rest }) => rest),
  }));

  // GET /api/v1/ops/inspection/reports/:id —— 单份报告全文
  fastify.get('/inspection/reports/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: numericId } } },
  }, async (request, reply) => {
    const report = getInspection(request.params.id);
    if (!report) return reply.code(404).send({ error: 'inspection_not_found', message: '巡检报告不存在或已清理' });
    return { report };
  });

  // POST /api/v1/ops/inspection/run —— 立即巡检(只读,不需要确认门)
  fastify.post('/inspection/run', {
    schema: { body: { type: 'object', additionalProperties: false, properties: { persist: { type: 'boolean' }, hostId: { type: 'string', minLength: 1, maxLength: 100 } } } },
  }, async (request, reply) => {
    try {
      const report = await runInspection({ source: 'manual', persist: request.body?.persist !== false, hostId: request.body?.hostId });
      return { report };
    } catch (error) {
      return reply.code(error.statusCode || 502).send({ error: 'inspection_failed', message: error.message });
    }
  });

  // PUT /api/v1/ops/inspection/schedule —— 自动巡检开关与间隔
  fastify.put('/inspection/schedule', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { enabled: { type: 'boolean' }, intervalHours: { type: 'number', minimum: 1, maximum: 100000 },
          hostId: { type: 'string', minLength: 1, maxLength: 100 }, connectionRevision: { type: 'string', minLength: 1, maxLength: 100 } },
      },
    },
  }, async (request) => {
    return { schedule: saveInspectionSchedule(request.body || {}) };
  });

  // POST /api/v1/ops/inspection/prune —— 清理历史报告(days 越界由处理函数 clamp)
  fastify.post('/inspection/prune', {
    schema: { body: { type: 'object', additionalProperties: false, properties: { days: { type: 'number' } } } },
  }, async (request) => {
    const days = Math.max(7, Math.min(Number(request.body?.days) || 180, 3650));
    const result = pruneInspections(days);
    return { ok: true, removed: result.changes };
  });
}
