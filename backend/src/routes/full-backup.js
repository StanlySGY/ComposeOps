import { previewFullBackup } from '../services/full-backup-plan.js';

export default async function fullBackupRoutes(fastify, options = {}) {
  const preview = options.previewFullBackup || previewFullBackup;
  fastify.get('/storage/full-backup-plan', {
    schema: { querystring: {
      type: 'object', required: ['projectId'], additionalProperties: false,
      properties: { projectId: { type: 'string', minLength: 1, maxLength: 128 } },
    } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try { return await preview(request.query.projectId); }
    catch (error) {
      const expected = error.code === 'FULL_BACKUP_PREFLIGHT';
      return reply.code(expected ? error.statusCode : 502).send({ error: 'full_backup_plan_failed',
        message: expected ? error.message : '备份范围读取失败，请检查当前 Docker 节点后重试' });
    }
  });
}
