import { getSystemStorageDf, pruneStorage } from '../services/docker-storage.js';
import { listDockerResources, removeDockerResource } from '../services/docker-resources.js';
import { listBlueprints, deployBlueprint } from '../services/app-blueprints.js';
import { checkAllUpdates } from '../services/image-updater.js';
import { getNotificationConfig, saveNotificationConfig, sendNotification } from '../services/notifications.js';
import { getAlertEventConfig } from '../services/health-alerter.js';
import {
  listProjectVolumes, createVolumeBackup, restoreVolumeBackup, deleteVolumeBackup,
  listBackups, streamBackupToReply, verifyVolumeBackup,
} from '../services/volume-backup.js';
import { findProject } from '../services/scanner.js';
import { previewDeploy } from '../services/deploy-preview.js';
import { addOperation } from '../lib/db.js';
import { listAlertEvents, updateAlertEvent, pruneAlertEvents } from '../services/events.js';
import { isGuardianEnabled, setGuardianEnabled, diagnoseAlertEvent } from '../services/guardian.js';
import { getAiConfig } from '../services/ai.js';
import { notificationConfigBody } from '../lib/schemas.js';

/**
 * 本文件的 schema 一律不收紧服务端已有的归一化语义:
 * 1. mode/confirm 不设 enum/const —— 处理函数把未知 mode 归一为 safe,并自己返回
 *    confirmation_required 机器码,schema 抢先拦下会改变语义或降级错误码;
 * 2. days/limit 只挡非数值,越界由 db.js 的 clamp 兜住;
 * 3. blueprints/deploy 的 values 是蓝图自带的模板变量表(键由蓝图定义,无法枚举),
 *    故整个 body 保持开放 —— 声明 additionalProperties: false 会被 removeAdditional
 *    静默剥掉所有变量,部署出一份缺变量的 compose。
 */
const alertEventBody = {
  type: 'object',
  additionalProperties: false,
  properties: { read: { type: 'boolean' }, muted: { type: 'boolean' } },
};

export default async function opsRoutes(fastify) {
  // ---- 镜像更新雷达:全局检测 ----
  fastify.post('/updates/check-all', async (request, reply) => {
    try {
      const result = await checkAllUpdates();
      addOperation({ action: 'images.radar', status: 'success', detail: `${result.projects.length} 个项目已检查` });
      return result;
    } catch (error) {
      return reply.code(502).send({ error: 'updates_radar_failed', message: error.message });
    }
  });

  // ---- Docker 磁盘空间可视化与安全清理 ----
  fastify.get('/storage/df', async (request, reply) => {
    try {
      return await getSystemStorageDf();
    } catch (error) {
      return reply.code(error.statusCode || 502).send({ error: 'storage_df_failed', message: error.message });
    }
  });

  fastify.post('/storage/prune', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', maxLength: 16 },
          confirm: { type: 'string', maxLength: 32 },
        },
      },
    },
  }, async (request, reply) => {
    const mode = ['safe', 'volumes', 'builder', 'all'].includes(request.body?.mode) ? request.body.mode : 'safe';
    if ((mode === 'volumes' || mode === 'all') && request.body?.confirm !== 'PRUNE') {
      return reply.code(400).send({ error: 'confirmation_required', message: '深度清理需要二次确认(输入 PRUNE)' });
    }
    try {
      const result = await pruneStorage(mode);
      addOperation({ action: `storage.prune.${mode}`, status: 'success', detail: `${result.reclaimedMB} MB` });
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(502).send({ error: 'storage_prune_failed', message: error.message });
    }
  });

  // ---- 细粒度资源清单与逐项删除(镜像 / 卷 / 网络) ----
  fastify.get('/storage/resources', async (request, reply) => {
    try {
      return await listDockerResources();
    } catch (error) {
      return reply.code(error.statusCode || 502).send({ error: 'resources_list_failed', message: error.message });
    }
  });

  // kind 不设 enum:处理函数自己归一 image|volume|network 并返回 400。
  // 资源可能在前端确认后被新容器引用;服务层一律非强制删除以保护运行中资源与持久数据。
  fastify.delete('/storage/resources/:kind/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['kind', 'id'],
        properties: { kind: { type: 'string', maxLength: 16 }, id: { type: 'string', minLength: 1, maxLength: 200 } },
      },
    },
  }, async (request, reply) => {
    const { kind, id } = request.params;
    if (!['image', 'volume', 'network'].includes(kind)) {
      return reply.code(400).send({ error: 'unknown_resource_kind', message: `未知资源类型:${kind}` });
    }
    try {
      const result = await removeDockerResource(kind, id, false);
      addOperation({ action: `resource.remove.${kind}`, status: 'success', detail: id });
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(error.statusCode || 502).send({ error: 'resource_remove_failed', message: error.message });
    }
  });

  // ---- 数据卷备份:helper 容器 tar 方案,仅命名卷 ----
  fastify.get('/storage/volume-volumes', {
    schema: { querystring: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string', maxLength: 128 } } } },
  }, async (request, reply) => {
    try {
      const project = await findProject(request.query.projectId);
      if (!project) return reply.code(404).send({ error: 'project_not_found', message: '项目不存在或当前不可见' });
      if (!project.managed) return reply.code(403).send({ error: 'project_not_managed', message: '项目尚未加入管理' });
      return { volumes: await listProjectVolumes(project) };
    } catch (error) {
      return reply.code(error.statusCode || 502).send({ error: 'volume_list_failed', message: error.message });
    }
  });

  fastify.get('/storage/volume-backups', {
    schema: { querystring: { type: 'object', properties: { projectId: { type: 'string', maxLength: 128 } } } },
  }, async (request) => ({ backups: await listBackups(request.query.projectId || '') }));

  // volume 名不设 enum:由服务端校验字符集与 compose 归属。
  fastify.post('/storage/volume-backups', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['projectId', 'volume'],
        properties: { projectId: { type: 'string', maxLength: 128 }, volume: { type: 'string', maxLength: 128 } },
      },
    },
  }, async (request, reply) => {
    try {
      const { projectId, volume } = request.body || {};
      const project = await findProject(projectId);
      if (!project) return reply.code(404).send({ error: 'project_not_found', message: '项目不存在或当前不可见' });
      if (!project.managed) return reply.code(403).send({ error: 'project_not_managed', message: '项目尚未加入管理' });
      const volumes = await listProjectVolumes(project);
      const match = volumes.find((item) => item.name === volume);
      if (!match) return reply.code(404).send({ error: 'volume_not_found', message: 'compose 中未引用该卷' });
      if (match.skip) return reply.code(400).send({ error: 'volume_not_supported', message: match.skip });
      if (match.exists === false) return reply.code(404).send({ error: 'volume_missing', message: '该卷尚未在当前宿主上创建' });
      return await createVolumeBackup(project, volume);
    } catch (error) {
      return reply.code(error.statusCode || 502).send({ error: 'volume_backup_failed', message: error.message });
    }
  });

  fastify.post('/storage/volume-backups/:id/restore', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } },
  }, async (request, reply) => {
    try {
      return await restoreVolumeBackup(request.params.id);
    } catch (error) {
      return reply.code(error.statusCode || 502).send({ error: 'volume_restore_failed', message: error.message });
    }
  });

  // 还原演练：不动原卷，把备份解包到一次性临时卷验证可用性（只读安全，无需确认门）
  fastify.post('/storage/volume-backups/:id/verify', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } },
  }, async (request, reply) => {
    try {
      return await verifyVolumeBackup(request.params.id);
    } catch (error) {
      return reply.code(error.statusCode || 502).send({ error: 'volume_verify_failed', message: error.message });
    }
  });

  fastify.delete('/storage/volume-backups/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } },
  }, async (request, reply) => {
    try {
      return await deleteVolumeBackup(request.params.id);
    } catch (error) {
      return reply.code(error.statusCode || 502).send({ error: 'volume_backup_delete_failed', message: error.message });
    }
  });

  fastify.get('/storage/volume-backups/:id/download', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } },
  }, async (request, reply) => {
    try {
      return await streamBackupToReply(request.params.id, reply);
    } catch (error) {
      if (reply.raw.headersSent) {
        reply.raw.destroy();
        return reply;
      }
      return reply.code(error.statusCode || 502).send({ error: 'volume_backup_download_failed', message: error.message });
    }
  });

  // ---- 应用模板市场 ----
  fastify.get('/blueprints', async () => ({ blueprints: await listBlueprints() }));

  // ---- 部署预言:up 前静态推演会发生什么(只读,无需确认门) ----
  fastify.post('/deploy-preview', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['projectId'],
        properties: {
          projectId: { type: 'string', maxLength: 128 },
          ai: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const project = await findProject(request.body?.projectId);
      if (!project) return reply.code(404).send({ error: 'project_not_found', message: '项目不存在或当前不可见' });
      return await previewDeploy(project, { ai: request.body?.ai === true });
    } catch (error) {
      return reply.code(error.statusCode || 502).send({ error: 'deploy_preview_failed', message: error.message });
    }
  });

  // values 刻意不声明子属性:蓝图变量名由蓝图自己定义,一旦收紧就会被剥空。
  // blueprintId 缺失仍由处理函数返回 missing_blueprint_id,故这里不设 required。
  fastify.post('/blueprints/deploy', {
    schema: {
      body: {
        type: 'object',
        properties: {
          blueprintId: { type: 'string', maxLength: 200 },
          values: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const { blueprintId, values } = request.body || {};
    if (!blueprintId) return reply.code(400).send({ error: 'missing_blueprint_id', message: '缺少 blueprintId 参数' });
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (type, data) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };
    let output = '';
    let finished = false;
    const finish = (payload) => {
      if (finished) return;
      finished = true;
      send('result', payload);
      reply.raw.end();
    };
    let child;
    let disconnected = false;
    const stopChild = (candidate) => {
      if (!candidate || finished || typeof candidate.kill !== 'function') return;
      const running = candidate.exitCode === undefined
        ? candidate.killed !== true
        : candidate.exitCode === null && candidate.killed !== true;
      if (running) candidate.kill('SIGTERM');
    };
    deployBlueprint(blueprintId, values || {}, {
      onOutput: (type, text) => { output += text; send(type, text); },
      onChild: (process) => {
        child = process;
        if (disconnected) stopChild(process);
      },
    }).then((result) => {
      send('exit', { code: result.code });
      finish({ ok: true, ...result, output });
    }).catch((error) => {
      const text = `${error.message}\n`;
      output += text;
      send('stderr', text);
      finish({ ok: false, message: error.message, output });
    });
    reply.raw.on('close', () => {
      disconnected = true;
      stopChild(child);
    });
  });

  // ---- 健康告警事件配置(与通知配置合并存储) ----
  fastify.get('/notifications/events', async () => {
    const config = getNotificationConfig(false);
    return { events: config.events || getAlertEventConfig().events };
  });

  fastify.put('/notifications/events', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { events: notificationConfigBody.properties.events },
      },
    },
  }, async (request) => {
    const config = saveNotificationConfig({ events: request.body?.events });
    return { events: config.events || [] };
  });

  // 与 personal.js 的 /notifications 共用同一份键集:此处会真的落库,漏键即存不上。
  fastify.post('/notifications/test', { schema: { body: notificationConfigBody } }, async (request, reply) => {
    try {
      const config = saveNotificationConfig(request.body || {});
      await sendNotification('ComposeOps 测试通知', '多渠道告警配置成功。', getNotificationConfig(false));
      return { ok: true, config };
    } catch (error) {
      return reply.code(502).send({ error: 'notification_failed', message: error.message });
    }
  });

  // ---- 告警事件(EventCenter 数据源) ----
  fastify.get('/alert-events', {
    schema: {
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } },
      },
    },
  }, async (request) => {
    return { events: listAlertEvents(request.query?.limit) };
  });

  // id 不声明为 integer:处理函数自己 Number.isInteger 校验并返回 invalid_event_id。
  fastify.patch('/alert-events/:id', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 32 } } },
      body: alertEventBody,
    },
  }, async (request, reply) => {
    const id = Number(request.params?.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_event_id', message: '无效的事件 ID' });
    const { read, muted } = request.body || {};
    const event = updateAlertEvent(id, { read, muted });
    if (!event) return reply.code(404).send({ error: 'event_not_found', message: '事件不存在' });
    return { event };
  });

  // days 越界由处理函数 clamp 到 1..90,schema 只挡非数值类型。
  fastify.post('/alert-events/prune', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { days: { type: 'number' } },
      },
    },
  }, async (request) => {
    const days = Math.max(1, Math.min(Number(request.body?.days) || 7, 90));
    const result = pruneAlertEvents(days);
    return { ok: true, removed: result.changes };
  });

  // ---- 守护模式:告警事件的 AI 自动诊断 ----
  fastify.get('/guardian', async () => ({
    enabled: isGuardianEnabled(),
    aiConfigured: !!getAiConfig().apiKey,
  }));

  fastify.put('/guardian', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['enabled'],
        properties: { enabled: { type: 'boolean' } },
      },
    },
  }, async (request) => ({ ok: true, enabled: setGuardianEnabled(request.body?.enabled === true) }));

  // 手动触发单条事件的 AI 诊断(自动触发同样走这里的服务函数,带脱敏与落库)
  fastify.post('/alert-events/:id/diagnose', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 32 } } } },
  }, async (request, reply) => {
    const id = Number(request.params?.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_event_id', message: '无效的事件 ID' });
    const event = listAlertEvents(200).find((item) => Number(item.id) === id);
    if (!event) return reply.code(404).send({ error: 'event_not_found', message: '事件不存在或已清理' });
    try {
      return await diagnoseAlertEvent(event);
    } catch (error) {
      return reply.code(error.statusCode || 502).send({ error: 'guardian_diagnosis_failed', message: error.message });
    }
  });
}
