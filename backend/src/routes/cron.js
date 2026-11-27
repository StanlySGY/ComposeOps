import {
  listJobs,
  createJob,
  updateJob,
  deleteJob,
  runJobNow,
  listHistory,
  JOB_TYPES,
} from '../services/cron-scheduler.js';
import { previewSchedule } from '../lib/cron-expression.js';
import { addOperation } from '../lib/db.js';
import { captureScheduledHost, listScheduledHosts } from '../services/scheduled-host-scope.js';

/**
 * 字段约束与 cron-scheduler.js 的校验保持一致:
 * 名称超长由服务端 slice(0, 60) 截断而非拒绝,故这里只设宽松上限兜底,不改变既有语义。
 */
const jobFields = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  cron: { type: 'string', minLength: 1, maxLength: 120 },
  type: { type: 'string', enum: Object.keys(JOB_TYPES) },
  enabled: { type: 'boolean' },
  scope: { type: 'string', enum: ['all', 'host', 'project'] },
  projectId: { type: 'string', minLength: 1, maxLength: 300 },
  hostId: { type: 'string', minLength: 1, maxLength: 100 },
  connectionRevision: { type: 'string', minLength: 1, maxLength: 100 },
};

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
};

export default async function cronRoutes(fastify) {
  fastify.get('/preview', {
    schema: { querystring: { type: 'object', required: ['cron'], properties: { cron: { type: 'string', minLength: 1, maxLength: 120 } } } },
  }, async (request, reply) => {
    try { return previewSchedule(request.query.cron); }
    catch (error) { return reply.code(400).send({ error: 'invalid_cron', message: error.message }); }
  });

  fastify.get('/', async () => ({ jobs: await listJobs(), types: JOB_TYPES, targets: listScheduledHosts(), currentTarget: captureScheduledHost(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));

  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'cron', 'type'],
        additionalProperties: false,
        properties: jobFields,
      },
    },
  }, async (request, reply) => {
    try {
      const job = await createJob(request.body || {});
      addOperation({ action: 'cron.create', status: 'success', projectId: job.target?.projectId, projectName: job.target?.projectName, detail: `${job.name} (${job.cron}) · ${job.scope === 'project' ? `仅 ${job.target.hostName}/${job.target.projectName}` : job.scope === 'host' ? job.target.hostName : '全部节点的纳管项目'}` });
      return job;
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: 'cron_create_failed', message: error.message });
    }
  });

  // PUT 是补丁语义:前端存在只发 { enabled } 的开关调用,故所有字段可选、不设 required。
  fastify.put('/:id', {
    schema: {
      params: idParams,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: jobFields,
      },
    },
  }, async (request, reply) => {
    try {
      const job = await updateJob(request.params.id, request.body || {});
      addOperation({ action: 'cron.update', status: 'success', projectId: job.target?.projectId, projectName: job.target?.projectName, detail: `${job.name} · ${job.scope === 'project' ? `仅 ${job.target.hostName}/${job.target.projectName}` : job.scope === 'host' ? job.target?.hostName || '待确认节点' : '全部节点的纳管项目'}` });
      return job;
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: 'cron_update_failed', message: error.message });
    }
  });

  fastify.delete('/:id', { schema: { params: idParams } }, async (request, reply) => {
    try {
      const result = await deleteJob(request.params.id);
      addOperation({ action: 'cron.delete', status: 'success', detail: request.params.id });
      return result;
    } catch (error) {
      return reply.code(error.statusCode || 404).send({ error: 'cron_delete_failed', message: error.message });
    }
  });

  fastify.post('/:id/run', { schema: { params: idParams } }, async (request, reply) => {
    try {
      const result = await runJobNow(request.params.id);
      addOperation({ action: 'cron.run', status: 'success', detail: result.summary || '' });
      return result;
    } catch (error) {
      addOperation({ action: 'cron.run', status: 'failed', detail: error.message });
      return reply.code(error.statusCode || 502).send({ error: 'cron_run_failed', message: error.message });
    }
  });

  fastify.get('/history', {
    schema: {
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } },
      },
    },
  }, async (request) => ({ history: await listHistory(request.query.limit) }));
}
