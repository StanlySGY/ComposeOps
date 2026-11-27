import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const APP_VERSION = require('../../package.json').version;

import { readPanelMetrics } from '../services/panel-environment.js';
import { listHosts, getActiveHostId } from '../services/docker-hosts.js';
import { sampleContainers } from '../services/container-sampler.js';
import { infrastructureSnapshot, infrastructureStorage } from '../services/infrastructure.js';
import { infrastructureHistory } from '../services/infrastructure-history.js';
import { getMcpStatus, saveMcpConfig, revealMcpToken } from './mcp.js';

async function readContainerStats(host) {
  const sample = await sampleContainers(host.id);
  return sample.containers.filter(item => item.state === 'running').map(({ raw: _, netIO: __, blockIO: ___, ...item }) => ({ ...item, hostName: host.name }));
}

export default async function systemRoutes(fastify) {
  fastify.get('/capabilities', async () => ({
    version: APP_VERSION,
    shellEnabled: process.env.ENABLE_SHELL === '1',
    hostMetricsScope: process.env.HOST_METRICS === '1' ? 'host' : 'container',
  }));
  // GET /api/v1/system/metrics
  fastify.get('/metrics', async (request) => {
    const selected = request.query.hostId || getActiveHostId();
    const targets = listHosts().filter(item => selected === 'all' || item.id === selected);
    if (!targets.length) throw Object.assign(new Error('Docker 节点不存在'), { statusCode: 404 });
    const [environment, hosts] = await Promise.all([readPanelMetrics(), Promise.all(targets.map(async target => {
      try { return { id: target.id, name: target.name, ok: true, containers: await readContainerStats(target) }; }
      catch { return { id: target.id, name: target.name, ok: false, containers: [] }; }
    }))]);
    return { ...environment, hosts: hosts.map(({ containers: _, ...item }) => item), containers: hosts.flatMap(item => item.containers) };
  });

  fastify.get('/infrastructure', async request => infrastructureSnapshot(request.query.hostId || getActiveHostId()));
  fastify.get('/infrastructure/history', { schema: { querystring: { type: 'object', additionalProperties: false, properties: {
    hostId: { type: 'string', maxLength: 100 }, resource: { type: 'string', maxLength: 400 },
    metric: { type: 'string', enum: ['cpu', 'memory', 'memoryUsed', 'rx', 'tx', 'used', 'free', 'diskPercent', 'inodePercent', 'readRate', 'writeRate'] },
    hours: { type: 'number', minimum: .25, maximum: 720 },
  } } } }, async request => {
    const hostId = request.query.hostId || getActiveHostId();
    infrastructureSnapshot(hostId);
    return infrastructureHistory(hostId, request.query);
  });
  fastify.get('/infrastructure/storage', async request => infrastructureStorage(request.query.hostId || getActiveHostId()));

  // ---- MCP 服务管理(token/模式/开关) ----
  fastify.get('/mcp', async () => getMcpStatus());
  fastify.post('/mcp', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          mode: { type: 'string', enum: ['readonly', 'all'] },
          regenerateToken: { type: 'boolean' },
        },
      },
    },
  }, async (request) => saveMcpConfig(request.body || {}));
  // token 只经此端点明文返回一次,供粘贴进 MCP 客户端
  fastify.post('/mcp/reveal-token', async () => revealMcpToken());
}
