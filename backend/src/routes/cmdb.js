import {
  syncAssets,
  getAssetById,
  queryAssets,
  removeAsset,
  getTopology,
  addRelation,
  removeRelation,
} from '../services/cmdb.js';
import { addOperation } from '../lib/db.js';

/**
 * CMDB 统一资产中心:
 * - GET /assets 资产列表(支持 kind/hostId/query 过滤)
 * - POST /assets/sync 从 Docker 扫描重建资产与关系
 * - GET /topology 资产拓扑(供知识图谱读取)
 * - POST /relations 手动建立资产关系
 */

const assetQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', maxLength: 32 },
    hostId: { type: 'string', maxLength: 64 },
    query: { type: 'string', maxLength: 200 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    offset: { type: 'integer', minimum: 0, maximum: 100000 },
  },
};

export default async function cmdbRoutes(fastify) {
  fastify.get('/assets', { schema: { querystring: assetQuery } }, async (request) => {
    const { kind = '', hostId = '', query = '', limit, offset } = request.query || {};
    return { assets: queryAssets({ kind, hostId, query, limit, offset }) };
  });

  fastify.get('/assets/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 128 } } } },
  }, async (request, reply) => {
    const asset = getAssetById(request.params.id);
    if (!asset) return reply.code(404).send({ error: 'asset_not_found', message: '资产不存在' });
    return { asset };
  });

  fastify.delete('/assets/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 128 } } } },
  }, async (request, reply) => {
    const removed = removeAsset(request.params.id);
    if (!removed) return reply.code(404).send({ error: 'asset_not_found', message: '资产不存在' });
    addOperation({ action: 'cmdb.asset_delete', status: 'success', detail: request.params.id });
    return { ok: true };
  });

  fastify.post('/assets/sync', async () => {
    const result = await syncAssets();
    addOperation({ action: 'cmdb.sync', status: 'success', detail: `hosts=${result.hosts}, projects=${result.projects}` });
    return { ok: true, ...result };
  });

  fastify.get('/topology', { schema: { querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0, maximum: 100000 } } } } }, async (request) => getTopology(request.query || {}));

  fastify.post('/relations', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceId', 'targetId', 'relation'],
        properties: {
          sourceId: { type: 'string', maxLength: 128 },
          targetId: { type: 'string', maxLength: 128 },
          relation: { type: 'string', maxLength: 32 },
          properties: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { sourceId, targetId, relation, properties } = request.body;
      addRelation(sourceId, targetId, relation, properties);
      addOperation({ action: 'cmdb.relation_add', status: 'success', detail: `${sourceId} -> ${relation} -> ${targetId}` });
      return { ok: true };
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: 'relation_failed', message: error.message });
    }
  });

  fastify.delete('/relations/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 32 } } } },
  }, async (request, reply) => {
    const removed = removeRelation(request.params.id);
    if (!removed) return reply.code(404).send({ error: 'relation_not_found', message: '关系不存在' });
    return { ok: true };
  });
}
