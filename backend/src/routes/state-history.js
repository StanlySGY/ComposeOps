import {
  listStateHistory,
  listStateContainers,
  listStateExits,
  getStateUptime,
  pruneStateHistory,
} from '../services/state-history.js';

/**
 * 容器状态历史路由(uptime-kuma 式服务端持久化):
 * - GET /history 状态转换明细(按项目/容器/动作过滤)
 * - GET /containers 每个容器窗口内的最近一次转换
 * - GET /uptime 窗口可用率报表(逐容器 + 汇总)
 * - GET /exits 最近退出明细(异常退出优先)
 * - POST /prune 清理超过保留天数的历史
 */

const DAY_SECONDS = 86400;

const historyQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', maxLength: 64 },
    containerId: { type: 'string', maxLength: 128 },
    action: { type: 'string', maxLength: 32 },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
  },
};

const windowQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', maxLength: 64 },
    days: { type: 'integer', minimum: 1, maximum: 365 },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
  },
};

const uptimeQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', maxLength: 64 },
    days: { type: 'integer', minimum: 1, maximum: 365 },
  },
};

export default async function stateHistoryRoutes(fastify) {
  fastify.get('/history', { schema: { querystring: historyQuery } }, async (request) => {
    const { projectId = '', containerId = '', action = '', limit = 200 } = request.query || {};
    return { history: listStateHistory({ projectId, containerId, action, limit }) };
  });

  fastify.get('/containers', { schema: { querystring: windowQuery } }, async (request) => {
    const { projectId = '', days = 7, limit = 500 } = request.query || {};
    const since = Math.floor(Date.now() / 1000) - days * DAY_SECONDS;
    return { containers: listStateContainers({ projectId, since, limit }) };
  });

  fastify.get('/uptime', { schema: { querystring: uptimeQuery } }, async (request) => {
    const { projectId = '', days = 7 } = request.query || {};
    const until = Math.floor(Date.now() / 1000);
    return getStateUptime({ projectId, since: until - days * DAY_SECONDS, until });
  });

  fastify.get('/exits', { schema: { querystring: windowQuery } }, async (request) => {
    const { projectId = '', days = 7, limit = 100 } = request.query || {};
    return listStateExits({ projectId, days, limit });
  });

  fastify.post('/prune', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { days: { type: 'number' } },
      },
    },
  }, async (request) => {
    const days = Math.max(1, Math.min(Number(request.body?.days) || 90, 365));
    return { ok: true, removed: pruneStateHistory(days).changes };
  });
}
