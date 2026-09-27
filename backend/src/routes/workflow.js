import {
  createDefinition,
  updateDefinition,
  listDefinitions,
  getDefinition,
  removeDefinition,
  startWorkflow,
  listInstances,
  getInstance,
  approveInstance,
  cancelInstance,
} from '../services/workflow-engine.js';
import { addOperation } from '../lib/db.js';

/**
 * 工作流中心:
 * - GET /definitions 工作流定义列表
 * - POST /definitions 创建工作流
 * - POST /definitions/:id/run 手动触发一次运行
 * - GET /instances 运行实例列表
 * - POST /instances/:id/approve 人工审批
 * - POST /instances/:id/cancel 取消
 */

const nodeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type'],
  properties: {
    id: { type: 'string', maxLength: 64 },
    type: { type: 'string', maxLength: 16 },
    config: { type: 'object' },
    next: { type: 'string', maxLength: 64 },
    onTrue: { type: 'string', maxLength: 64 },
    onFalse: { type: 'string', maxLength: 64 },
  },
};

const definitionBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', maxLength: 100 },
    description: { type: 'string', maxLength: 500 },
    triggerType: { type: 'string', maxLength: 16 },
    triggerConfig: { type: 'object' },
    nodes: { type: 'array', items: nodeSchema },
    enabled: { type: 'boolean' },
  },
};

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', maxLength: 128 } },
};

export default async function workflowRoutes(fastify) {
  fastify.get('/definitions', async () => ({ definitions: listDefinitions() }));

  fastify.get('/definitions/:id', { schema: { params: idParams } }, async (request, reply) => {
    const definition = getDefinition(request.params.id);
    if (!definition) return reply.code(404).send({ error: 'workflow_not_found', message: '工作流不存在' });
    return { definition };
  });

  fastify.post('/definitions', { schema: { body: definitionBody } }, async (request, reply) => {
    try {
      const definition = createDefinition(request.body || {});
      addOperation({ action: 'workflow.create', status: 'success', detail: definition.name });
      return reply.code(201).send({ definition });
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: 'workflow_invalid', message: error.message });
    }
  });

  fastify.put('/definitions/:id', { schema: { params: idParams, body: definitionBody } }, async (request, reply) => {
    try {
      const definition = updateDefinition(request.params.id, request.body || {});
      if (!definition) return reply.code(404).send({ error: 'workflow_not_found', message: '工作流不存在' });
      return { definition };
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: 'workflow_invalid', message: error.message });
    }
  });

  fastify.delete('/definitions/:id', { schema: { params: idParams } }, async (request, reply) => {
    const removed = removeDefinition(request.params.id);
    if (!removed) return reply.code(404).send({ error: 'workflow_not_found', message: '工作流不存在' });
    addOperation({ action: 'workflow.delete', status: 'success', detail: request.params.id });
    return { ok: true };
  });

  fastify.post('/definitions/:id/run', { schema: { params: idParams } }, async (request, reply) => {
    try {
      const instance = startWorkflow(request.params.id, request.body?.context || {});
      addOperation({ action: 'workflow.run', status: 'success', detail: instance.id });
      return { instance };
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: 'workflow_run_failed', message: error.message });
    }
  });

  fastify.get('/instances', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', maxLength: 32 },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
    },
  }, async (request) => {
    const { status = '', limit } = request.query || {};
    return { instances: listInstances({ status, limit }) };
  });

  fastify.get('/instances/:id', { schema: { params: idParams } }, async (request, reply) => {
    const instance = getInstance(request.params.id);
    if (!instance) return reply.code(404).send({ error: 'instance_not_found', message: '工作流实例不存在' });
    return { instance };
  });

  fastify.post('/instances/:id/approve', {
    schema: {
      params: idParams,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          approved: { type: 'boolean' },
          note: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { approved = true, note = '' } = request.body || {};
      const instance = approveInstance(request.params.id, { approved, note });
      addOperation({ action: 'workflow.approve', status: 'success', detail: `${request.params.id}:${approved ? '通过' : '拒绝'}` });
      return { instance };
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: 'workflow_approve_failed', message: error.message });
    }
  });

  fastify.post('/instances/:id/cancel', { schema: { params: idParams } }, async (request, reply) => {
    try {
      const instance = cancelInstance(request.params.id);
      return { instance };
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: 'workflow_cancel_failed', message: error.message });
    }
  });
}
