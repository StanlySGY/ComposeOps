import { queryContainerMetrics, resolveManagedContainer } from '../services/agent-metrics.js';
import { createAlertRule, listAlertRules, deleteAlertRule, ALERT_METRICS, ALERT_ACTIONS } from '../services/alert-rules.js';
import { acknowledgeAlertAction } from '../services/resource-alert-actions.js';
import { getSetting } from '../lib/db.js';
import {
  queryHistoricalMetricWindow,
  normalizeMetricQuery,
  HISTORY_METRIC_TYPES,
  getMetricsStats,
  detectAnomalies,
  evaluateAlertRules,
  applyRetentionPolicy,
  previewRetentionPolicy,
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

  // 配置告警规则(统一存储 agent.alert_rules,由告警引擎评估)
  fastify.post(
    '/alerts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['container', 'metric', 'threshold'],
          properties: {
            container: { type: 'string', description: '容器 ID 或名称' },
            metric: { type: 'string', enum: [...ALERT_METRICS] },
            threshold: { type: 'number', description: '阈值(CPU/内存为百分比,重启次数为次数)' },
            action: { type: 'string', enum: [...ALERT_ACTIONS, 'restart'], default: 'notify', description: 'restart 会归一化为 auto_restart' },
            confirmAutomatic: { type: 'boolean' }
          }
        }
      }
    },
    async (request) => {
      const rule = await createAlertRule(request.body);
      return { ruleId: rule.id, rule };
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
      const alerts = await listAlertRules({ container });
      let monitor = null;
      try { monitor = JSON.parse(getSetting('agent.alert_monitor_status', 'null')); } catch { /* unknown */ }
      return { alerts, monitor };
    }
  );

  fastify.post('/alerts/:ruleId/acknowledge', {
    schema: { body: { type: 'object', required: ['confirm', 'executionId'], properties: { confirm: { type: 'string', const: 'CHECKED_RESOURCE_ACTION' }, executionId: { type: 'string', minLength: 1 } } } },
  }, request => acknowledgeAlertAction(request.params.ruleId, request.body));

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
      const result = await deleteAlertRule(ruleId);
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
          required: ['containerId', 'metricType'],
          properties: {
            containerId: { type: 'string', minLength: 1, description: '容器 ID' },
            metricType: { type: 'string', enum: [...HISTORY_METRIC_TYPES], description: '指标类型' },
            startTime: { type: 'integer', description: '开始时间戳（毫秒）' },
            endTime: { type: 'integer', description: '结束时间戳（毫秒）' },
            aggregation: { type: 'string', pattern: '^(auto|[0-9]{1,5})$', description: '聚合方式（auto 或秒数，结果最多2000点）', default: 'auto' },
          }
        }
      }
    },
    async (request) => {
      const { containerId, metricType, startTime, endTime, aggregation = 'auto' } = request.query;
      const options = normalizeMetricQuery({ containerId, metricType, startTime, endTime, aggregation: aggregation === 'auto' ? aggregation : Number(aggregation) });
      const { project, container } = await resolveManagedContainer(containerId);
      const { metrics, sampling } = queryHistoricalMetricWindow({
        ...options,
        hostId: project.hostId,
        containerId: container.id,
      });

      return { 
        metrics,
        count: metrics.length,
        sampling,
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
            metricType: { type: 'string', enum: [...HISTORY_METRIC_TYPES], description: '指标类型' },
          }
        },
        querystring: {
          type: 'object',
          properties: {
            hours: { type: 'integer', minimum: 1, maximum: 720, description: '统计小时数', default: 24 },
          }
        }
      }
    },
    async (request) => {
      const { containerId, metricType } = request.params;
      const { hours = 24 } = request.query;
      const { project, container } = await resolveManagedContainer(containerId);

      const stats = getMetricsStats(container.id, metricType, parseInt(hours, 10), project.hostId);
      
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
            metricType: { type: 'string', enum: ['cpu', 'memory'], description: '指标类型，仅支持CPU与内存占用率' },
            hours: { type: 'integer', minimum: 1, maximum: 720, description: '检测小时数', default: 24 },
            startTime: { type: 'integer', description: '开始时间戳(毫秒,优先于 hours)' },
            endTime: { type: 'integer', description: '结束时间戳(毫秒,优先于 hours)' },
            algorithms: { 
              type: 'array', minItems: 1, maxItems: 3, uniqueItems: true,
              items: { type: 'string', enum: ['z_score', 'moving_average', 'trend'] },
              description: '使用的算法',
              default: ['z_score', 'moving_average', 'trend'],
            },
          }
        }
      }
    },
    async (request) => {
      const { containerId, metricType, hours = 24, startTime: requestedStart, endTime: requestedEnd, algorithms = ['z_score', 'moving_average', 'trend'] } = request.body;
      const endTime = requestedEnd === undefined ? Date.now() : requestedEnd;
      const startTime = requestedStart === undefined ? Math.max(0, endTime - hours * 3600000) : requestedStart;
      const options = normalizeMetricQuery({ containerId, metricType, startTime, endTime });
      const { project, container } = await resolveManagedContainer(containerId);
      const { metrics, sampling } = queryHistoricalMetricWindow({
        ...options,
        hostId: project.hostId,
        containerId: container.id,
      });

      const anomalies = detectAnomalies(metrics, algorithms);

      return {
        anomalies,
        count: anomalies.length,
        timeRange: { start: startTime, end: endTime, hours: (endTime - startTime) / 3600000 },
        sampling,
        analysis: { basis: sampling.aggregated || metrics.some(row => row.sample_count > 1) ? 'bucket-means' : 'raw-samples', points: metrics.length,
          sufficientSamples: metrics.length >= 10, meaning: '历史统计线索，未发现异常不代表业务健康；聚合后的均值可能平滑尖峰。' },
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
      const { project, container } = await resolveManagedContainer(containerId);
      const alerts = evaluateAlertRules(container.id, project.hostId);

      return {
        alerts,
        count: alerts.length,
      };
    }
  );

  fastify.get('/retention-policy', async () => ({ preview: previewRetentionPolicy() }));

  // 执行数据保留策略（新增，管理员接口）
  fastify.post(
    '/retention-policy',
    async () => {
      const result = await applyRetentionPolicy();
      return {
        success: true,
        result,
      };
    }
  );
}
