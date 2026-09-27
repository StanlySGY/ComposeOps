import { queryContainerMetrics, configureAlert, listAlerts, deleteAlert, resolveManagedContainer } from '../services/agent-metrics.js';
import {
  queryHistoricalMetrics,
  getMetricsStats,
  detectAnomalies,
  evaluateAlertRules,
  applyRetentionPolicy,
} from '../services/metrics.js';

/**
 * 容器资源监控 API 路由
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function metricsRoutes(fastify) {
  // 查询容器资源指标
  fastify.get(
    '/container/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', description: '容器 ID 或名称' }
          }
        },
        querystring: {
          type: 'object',
          properties: {
            metric: { type: 'string', enum: ['cpu', 'memory', 'network', 'disk'], default: 'cpu' },
            period: { type: 'string', enum: ['1m', '5m', '1h', '1d'], default: '5m' }
          }
        }
      }
    },
    async (request) => {
      const { id } = request.params;
      const { metric = 'cpu', period = '5m' } = request.query;
      
      const data = await queryContainerMetrics(id, metric, period);
      return { data };
    }
  );

  // 配置告警规则
  fastify.post(
    '/alerts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['container', 'metric', 'threshold'],
          properties: {
            container: { type: 'string', description: '容器 ID 或名称' },
            metric: { type: 'string', enum: ['cpu', 'memory', 'network', 'disk'] },
            threshold: { type: 'number', description: '阈值' },
            duration: { type: 'string', maxLength: 16, pattern: '^[1-9][0-9]*(s|m|h|d)$', description: '持续时间', default: '5m' },
            action: { type: 'string', enum: ['notify', 'restart', 'scale'], default: 'notify' }
          }
        }
      }
    },
    async (request) => {
      const result = await configureAlert(request.body);
      return result;
    }
  );

  // 列出告警规则
  fastify.get(
    '/alerts',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            container: { type: 'string', description: '容器过滤（可选）' }
          }
        }
      }
    },
    async (request) => {
      const { container } = request.query;
      const alerts = await listAlerts(container);
      return { alerts };
    }
  );

  // 删除告警规则
  fastify.delete(
    '/alerts/:ruleId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['ruleId'],
          properties: {
            ruleId: { type: 'string' }
          }
        }
      }
    },
    async (request) => {
      const { ruleId } = request.params;
      const result = await deleteAlert(ruleId);
      return result;
    }
  );

  // 查询历史指标数据（新增）
  fastify.get(
    '/historical',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            containerId: { type: 'string', description: '容器 ID' },
            metricType: { type: 'string', description: '指标类型' },
            startTime: { type: 'integer', description: '开始时间戳（毫秒）' },
            endTime: { type: 'integer', description: '结束时间戳（毫秒）' },
            aggregation: { type: 'string', description: '聚合方式（auto 或秒数）', default: 'auto' },
          }
        }
      }
    },
    async (request) => {
      const { containerId, metricType, startTime, endTime, aggregation = 'auto' } = request.query;
      const { container } = await resolveManagedContainer(containerId);
      
      const metrics = queryHistoricalMetrics({
        containerId: container.id,
        metricType,
        startTime: startTime !== undefined ? parseInt(startTime, 10) : undefined,
        endTime: endTime !== undefined ? parseInt(endTime, 10) : undefined,
        aggregation: aggregation === 'auto' ? 'auto' : parseInt(aggregation, 10),
      });

      return { 
        metrics,
        count: metrics.length,
      };
    }
  );

  // 获取指标统计信息（新增）
  fastify.get(
    '/stats/:containerId/:metricType',
    {
      schema: {
        params: {
          type: 'object',
          required: ['containerId', 'metricType'],
          properties: {
            containerId: { type: 'string', description: '容器 ID' },
            metricType: { type: 'string', description: '指标类型' },
          }
        },
        querystring: {
          type: 'object',
          properties: {
            hours: { type: 'integer', description: '统计小时数', default: 24 },
          }
        }
      }
    },
    async (request) => {
      const { containerId, metricType } = request.params;
      const { hours = 24 } = request.query;
      const { container } = await resolveManagedContainer(containerId);

      const stats = getMetricsStats(container.id, metricType, parseInt(hours, 10));
      
      if (!stats) {
        return { 
          error: 'No data available',
          stats: null,
        };
      }

      return { stats };
    }
  );

  // 异常检测（新增）
  fastify.post(
    '/anomalies',
    {
      schema: {
        body: {
          type: 'object',
          required: ['containerId', 'metricType'],
          properties: {
            containerId: { type: 'string', description: '容器 ID' },
            metricType: { type: 'string', description: '指标类型' },
            hours: { type: 'integer', description: '检测小时数', default: 24 },
            startTime: { type: 'integer', description: '开始时间戳(毫秒,优先于 hours)' },
            endTime: { type: 'integer', description: '结束时间戳(毫秒,优先于 hours)' },
            algorithms: { 
              type: 'array', 
              items: { type: 'string', enum: ['z_score', 'moving_average', 'trend'] },
              description: '使用的算法',
              default: ['z_score', 'moving_average', 'trend'],
            },
          }
        }
      }
    },
    async (request, reply) => {
      const { containerId, metricType, hours = 24, startTime: requestedStart, endTime: requestedEnd, algorithms = ['z_score', 'moving_average', 'trend'] } = request.body;
      const { container } = await resolveManagedContainer(containerId);

      const endTime = Number.isFinite(Number(requestedEnd)) ? Number(requestedEnd) : Date.now();
      const requestedHours = Number(hours);
      const startTime = Number.isFinite(Number(requestedStart))
        ? Number(requestedStart)
        : endTime - (Number.isFinite(requestedHours) && requestedHours >= 0 ? requestedHours : 24) * 3600 * 1000;
      if (startTime > endTime) {
        return reply.code(400).send({ error: 'invalid_time_range', message: '指标时间范围无效' });
      }

      const metrics = queryHistoricalMetrics({
        containerId: container.id,
        metricType,
        startTime,
        endTime,
      });

      const anomalies = detectAnomalies(metrics, algorithms);

      return {
        anomalies,
        count: anomalies.length,
        timeRange: { start: startTime, end: endTime, hours: (endTime - startTime) / 3600000 },
      };
    }
  );

  // 评估智能告警规则（新增）
  fastify.get(
    '/evaluate-alerts/:containerId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['containerId'],
          properties: {
            containerId: { type: 'string', description: '容器 ID' },
          }
        }
      }
    },
    async (request) => {
      const { containerId } = request.params;
      const { container } = await resolveManagedContainer(containerId);
      const alerts = evaluateAlertRules(container.id);

      return {
        alerts,
        count: alerts.length,
      };
    }
  );

  // 执行数据保留策略（新增，管理员接口）
  fastify.post(
    '/retention-policy',
    async () => {
      const result = applyRetentionPolicy();
      return {
        success: true,
        result,
      };
    }
  );
}
