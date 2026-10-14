import {
  listHosts,
  upsertHost,
  deleteHost,
  pingHost,
  setActiveHost,
  getActiveHostId,
} from '../services/docker-hosts.js';
import { addOperation } from '../lib/db.js';

/**
 * 节点字段与 docker-hosts.js 的 upsertHost/probeHost 保持一致:
 * 1. type 不设 enum —— 服务端把未知值归一为 local(`type === 'ssh' ? ... : 'local'`),
 *    schema 若直接拒绝会改变既有语义;
 * 2. port 允许空串:前端 `v-model.number` 在输入框清空时发 '',服务端按 falsy 走默认端口;
 * 3. 密钥类字段(password/privateKey/tls)只设长度上限 —— PEM 私钥有数 KB,
 *    上限用于挡住畸形超大载荷,且这些字段永不出现在任何 response schema 里。
 */
const SECRET_MAX = 32768;
const secretField = { type: 'string', maxLength: SECRET_MAX };

const hostFields = {
  id: { type: 'string', maxLength: 64 },
  name: { type: 'string', maxLength: 200 },
  type: { type: 'string', maxLength: 16 },
  host: { type: 'string', maxLength: 255 },
  port: { anyOf: [{ type: 'integer', minimum: 1, maximum: 65535 }, { type: 'string', maxLength: 5 }] },
  username: { type: 'string', maxLength: 128 },
  hostFingerprint: { type: 'string', maxLength: 128 },
  password: secretField,
  privateKey: secretField,
  tls: {
    type: 'object',
    additionalProperties: false,
    properties: { ca: secretField, cert: secretField, key: secretField },
  },
};

const hostBody = { type: 'object', additionalProperties: false, properties: hostFields };

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
};

export default async function hostRoutes(fastify) {
  fastify.get('/', async () => ({ hosts: listHosts() }));

  fastify.post('/', { schema: { body: hostBody } }, async (request, reply) => {
    try {
      const host = upsertHost(request.body || {});
      addOperation({ action: 'hosts.save', status: 'success', detail: host.name });
      return reply.code(201).send({ host });
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: 'host_invalid', message: error.message });
    }
  });

  fastify.delete('/:id', { schema: { params: idParams } }, async (request, reply) => {
    try {
      const result = deleteHost(request.params.id);
      addOperation({ action: 'hosts.delete', status: 'success', detail: request.params.id });
      return result;
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: 'host_delete_failed', message: error.message });
    }
  });

  // probe 走 probeHost() 探测未落库的临时节点,字段集与 upsert 相同。
  fastify.post('/:id/ping', {
    schema: {
      params: idParams,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { probe: hostBody },
      },
    },
  }, async (request, reply) => {
    try {
      const result = await pingHost(request.params.id, request.body?.probe || null);
      if (request.body?.probe) delete result.host;
      return result;
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: 'host_ping_failed', message: error.message });
    }
  });

  fastify.put('/active', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { hostId: { type: 'string', maxLength: 64 } },
      },
    },
  }, async (request, reply) => {
    try {
      const result = setActiveHost(request.body?.hostId || 'local');
      addOperation({ action: 'hosts.switch', status: 'success', detail: result.activeHostId });
      return result;
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: 'host_switch_failed', message: error.message });
    }
  });

  fastify.get('/active', async () => ({ activeHostId: getActiveHostId() }));
}
