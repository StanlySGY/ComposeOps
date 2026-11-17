import { addOperation, exportUserData, getSetting, getAiRetentionStatus, pruneAiData, importUserData, listOperations, setSetting } from '../lib/db.js';
import { getNotificationConfig, saveNotificationConfig, sendNotification } from '../services/notifications.js';
import { checkImageUpdates, getDockerUsage, pruneDocker } from '../services/maintenance.js';
import { restartAlertMonitor } from '../services/alert-monitor.js';
import { notificationConfigBody } from '../lib/schemas.js';

export default async function personalRoutes(fastify) {
  fastify.get('/preferences', async () => ({
    refreshInterval: Number(getSetting('ui.refresh_interval', '5')),
    logTail: Number(getSetting('ui.log_tail', '200')),
  }));

  // 数值越界由处理函数 clamp 到合法区间,schema 只挡非数值类型。
  fastify.put('/preferences', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          refreshInterval: { type: 'number' },
          logTail: { type: 'number' },
        },
      },
    },
  }, async (request) => {
    const refreshInterval = Math.max(3, Math.min(Number(request.body?.refreshInterval) || 5, 300));
    const logTail = Math.max(10, Math.min(Number(request.body?.logTail) || 200, 5000));
    setSetting('ui.refresh_interval', String(refreshInterval));
    setSetting('ui.log_tail', String(logTail));
    return { refreshInterval, logTail };
  });

  fastify.get('/notifications', async () => getNotificationConfig(true));
  fastify.put('/notifications', { schema: { body: notificationConfigBody } }, async (request, reply) => {
    try { const config = saveNotificationConfig(request.body); restartAlertMonitor(); return config; }
    catch (error) { return reply.code(400).send({ error: 'invalid_notification_config', message: error.message }); }
  });
  fastify.post('/notifications/test', { schema: { body: notificationConfigBody } }, async (request, reply) => {
    try {
      // 测试通知不应持久化配置,只验证渠道可达性
      const testConfig = request.body;
      const result = await sendNotification('ComposeOps 测试通知', '通知渠道配置成功。', testConfig);
      if (result.skipped) return { ok: false, skipped: true, message: '通知未发送：通知功能或所有通知渠道均未启用。' };
      return { ok: true, skipped: false, results: result.results || [] };
    } catch (error) {
      return reply.code(502).send({ error: 'notification_failed', message: error.message });
    }
  });

  fastify.get('/operations', {
    schema: {
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } },
      },
    },
  }, async (request) => ({ operations: listOperations(request.query.limit) }));
  fastify.get('/export', async (request, reply) => {
    reply.header('Content-Disposition', `attachment; filename="composeops-export-${Date.now()}.json"`);
    return exportUserData();
  });
  fastify.post('/import', async (request, reply) => {
    try {
      const result = importUserData(request.body);
      addOperation({ action: 'settings.import', status: 'success' });
      return result;
    } catch (error) {
      return reply.code(400).send({ error: 'import_failed', message: error.message });
    }
  });

  fastify.get('/maintenance/ai-retention', async () => getAiRetentionStatus());
  fastify.put('/maintenance/ai-retention', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['days'], properties: { days: { type: 'integer', minimum: 7, maximum: 3650 } } } },
  }, async (request) => {
    setSetting('retention.ai_days', String(request.body.days));
    return getAiRetentionStatus();
  });
  fastify.post('/maintenance/ai-retention/prune', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['days'], properties: { days: { type: 'integer', minimum: 7, maximum: 3650 } } } },
  }, async (request, reply) => {
    const current = getAiRetentionStatus();
    if (request.body.days !== current.days) return reply.code(409).send({ message: '保留期限已变化，请重新预览后确认。' });
    pruneAiData();
    return getAiRetentionStatus();
  });

  fastify.get('/maintenance/usage', {
    schema: { querystring: { type: 'object', properties: { hostId: { type: 'string', maxLength: 64 } } } },
  }, async (request, reply) => {
    try { return await getDockerUsage(request.query?.hostId); }
    catch (error) {
      if (error.code === 'HOST_UNAVAILABLE') return reply.code(503).send({ error: 'host_unavailable', message: '所选节点的 Docker 存储暂不可用，请稍后重试或检查节点连接。' });
      throw error;
    }
  });
  // confirmation 故意不设 const/required:处理函数自己校验 'PRUNE' 并返回
  // confirmation_required 机器码,schema 抢先拦下会把它降级成 validation_failed。
  fastify.post('/maintenance/prune', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          confirmation: { type: 'string', maxLength: 32 },
          options: {
            type: 'object',
            additionalProperties: false,
            properties: {
              images: { type: 'boolean' },
              buildCache: { type: 'boolean' },
              containers: { type: 'boolean' },
              volumes: { type: 'boolean' },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    if (request.body?.confirmation !== 'PRUNE') {
      return reply.code(400).send({ error: 'confirmation_required', message: '请输入 PRUNE 确认清理' });
    }
    const options = request.body?.options || {};
    const result = await pruneDocker(options);
    addOperation({ action: 'docker.prune', status: 'success', detail: JSON.stringify(options) });
    return { ok: true, result };
  });

  fastify.get('/updates', async () => {
    let lastResults = [];
    try { lastResults = JSON.parse(getSetting('updates.last_results', '[]')); } catch { /* 历史结果损坏时按空列表展示。 */ }
    return {
      autoEnabled: getSetting('updates.auto_enabled', '0') === '1',
      intervalHours: Number(getSetting('updates.interval_hours', '24')),
      lastCheck: Number(getSetting('updates.last_check', '0')) || null,
      lastResults: Array.isArray(lastResults) ? lastResults : [],
    };
  });
  // intervalHours 越界由处理函数 clamp 到 1..720,schema 只挡非数值类型。
  fastify.put('/updates', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          autoEnabled: { type: 'boolean' },
          intervalHours: { type: 'number' },
        },
      },
    },
  }, async (request) => {
    const autoEnabled = !!request.body?.autoEnabled;
    const intervalHours = Math.max(1, Math.min(Number(request.body?.intervalHours) || 24, 720));
    setSetting('updates.auto_enabled', autoEnabled ? '1' : '0');
    setSetting('updates.interval_hours', String(intervalHours));
    return { autoEnabled, intervalHours };
  });
  fastify.post('/updates/check', async () => {
    setSetting('updates.last_check', String(Date.now()));
    const results = await checkImageUpdates();
    addOperation({ action: 'images.check', status: 'success', detail: JSON.stringify(results) });
    return { results };
  });
}
