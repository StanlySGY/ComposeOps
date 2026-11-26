import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import {
  prepareFullRestore, executeFullRestore,
  maintenanceOverview,
  saveBackupSettings,
  prepareMaintenance,
  executeMaintenance,
  publicTargets,
  saveSyncTarget,
  startSync,
  update115Credentials,
  setSyncAutomatic,
  refreshTasks,
  recoverMaintenanceTask,
  fault,
} from '../services/container-maintenance.js';
import { request115Authorization, poll115Authorization } from '../services/maintenance-115.js';
import { recoveryKey } from '../services/maintenance-store.js';
import { imageCheckSettings, saveImageCheckSettings, testImageCheckProxy } from '../services/image-registry.js';
import { clearImageUpdateCache } from '../services/image-updater.js';

const ids = {
  type: 'array',
  minItems: 1,
  maxItems: 100,
  uniqueItems: true,
  items: { type: 'string', pattern: '^[a-f0-9]{12,64}$' },
};
const object = (properties) => ({ type: 'object', additionalProperties: false, properties });
export default async function maintenanceRoutes(app) {
  const sessions = new Map();
  const wrap = (handler) => async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return await handler(req, reply);
    } catch (error) {
      return reply
        .code(error.statusCode || 502)
        .send({
          error: 'maintenance_failed',
          message: error.statusCode ? error.message : '运维请求失败，请检查节点、执行器和远端服务状态',
        });
    }
  };
  const monitor = setInterval(() => {
    void refreshTasks().catch(() => {});
  }, 3000);
  monitor.unref();
  app.addHook('onClose', async () => clearInterval(monitor));
  app.get(
    '/',
    wrap(() => maintenanceOverview()),
  );
  app.put(
    '/settings',
    {
      schema: {
        body: {
          ...object({ backupPath: { type: 'string', minLength: 2, maxLength: 1024 } }),
          required: ['backupPath'],
        },
      },
    },
    wrap((req) => saveBackupSettings(req.body.backupPath)),
  );
  const proxySchema = {
    body: { ...object({ proxyUrl: { type: 'string', maxLength: 2048 } }), required: ['proxyUrl'] },
  };
  app.get('/image-check/settings', wrap(() => imageCheckSettings()));
  app.put('/image-check/settings', { schema: proxySchema }, wrap((req) => {
    const settings = saveImageCheckSettings(req.body);
    clearImageUpdateCache();
    return settings;
  }));
  app.post('/image-check/test', { schema: proxySchema }, wrap((req) => testImageCheckProxy(req.body)));
  app.post(
    '/plans',
    {
      schema: {
        body: {
          ...object({
            containerIds: ids,
            backupPath: { type: 'string', minLength: 2, maxLength: 1024 },
            action: { type: 'string', enum: ['backup'] },
          }),
          required: ['containerIds', 'backupPath', 'action'],
        },
      },
    },
    wrap((req) => prepareMaintenance(req.body)),
  );
  app.post(
    '/execute',
    {
      schema: {
        body: {
          ...object({
            token: { type: 'string', format: 'uuid' },
            confirmed: { type: 'boolean' },
            keySaved: { type: 'boolean' },
            makeDefault: { type: 'boolean' },
          }),
          required: ['token'],
        },
      },
    },
    wrap(async (req, reply) => reply.code(202).send(await executeMaintenance(req.body))),
  );
  app.post('/restore-plans', { schema: { body: { ...object({ backupId: { type: 'string', format: 'uuid' }, destination: { type: 'string', maxLength: 1024 }, expectedHostId: { type: 'string', maxLength: 128 } }), required: ['backupId', 'destination', 'expectedHostId'] } } }, wrap(req => prepareFullRestore(req.body)));
  app.post('/restore', { schema: { body: { ...object({ token: { type: 'string', format: 'uuid' }, confirmed: { type: 'boolean' }, start: { type: 'boolean' } }), required: ['token', 'confirmed'] } } }, wrap(async (req, reply) => reply.code(202).send(await executeFullRestore(req.body))));
  app.post(
    '/tasks/:id/recover',
    { schema: { body: { ...object({ confirmed: { type: 'boolean' } }), required: ['confirmed'] } } },
    wrap(async (req, reply) => {
      if (req.body.confirmed !== true) throw fault('请确认恢复原运行容器', 400);
      return reply.code(202).send(await recoverMaintenanceTask(req.params.id));
    }),
  );
  // 恢复密钥仅通过显式下载接口提供，不包含在概览、设置导出、备份或同步产物中。
  app.get(
    '/recovery-key',
    wrap((_req, reply) =>
      reply
        .header('Content-Disposition', 'attachment; filename="composeops-recovery.key"')
        .type('application/octet-stream')
        .send(recoveryKey()),
    ),
  );
  app.get(
    '/targets',
    wrap(() => ({ targets: publicTargets() })),
  );
  app.post(
    '/targets',
    {
      schema: {
        body: {
          ...object({
            id: { type: 'string', format: 'uuid' },
            type: { type: 'string', enum: ['115', 'webdav'] },
            name: { type: 'string', minLength: 1, maxLength: 100 },
            remotePath: { type: 'string', maxLength: 1024 },
            url: { type: 'string', maxLength: 2048 },
            user: { type: 'string', maxLength: 200 },
            password: { type: 'string', maxLength: 4000 },
            clientId: { type: 'string', maxLength: 30 },
            auto: { type: 'boolean' },
          }),
          required: ['type', 'name', 'remotePath'],
        },
      },
    },
    wrap((req) => saveSyncTarget(req.body)),
  );
  app.put(
    '/targets/:id/auto',
    { schema: { body: { ...object({ auto: { type: 'boolean' } }), required: ['auto'] } } },
    wrap((req) => ({ targets: setSyncAutomatic(req.params.id, req.body.auto) })),
  );
  app.post(
    '/sync',
    {
      schema: {
        body: {
          ...object({
            targetId: { type: 'string', format: 'uuid' },
            backupIds: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              uniqueItems: true,
              items: { type: 'string', format: 'uuid' },
            },
            test: { type: 'boolean' },
            confirmed: { type: 'boolean' },
          }),
          required: ['targetId', 'confirmed'],
        },
      },
    },
    wrap(async (req, reply) => {
      if (req.body.confirmed !== true) throw fault('请确认远端传输范围', 400);
      return reply.code(202).send(await startSync(req.body));
    }),
  );
  app.post(
    '/115/authorize',
    {
      schema: {
        body: { ...object({ targetId: { type: 'string', format: 'uuid' } }), required: ['targetId'] },
      },
    },
    wrap(async (req) => {
      const target = publicTargets().find((t) => t.id === req.body.targetId && t.type === '115');
      if (!target) throw fault('请先保存 115 同步目标', 404);
      for (const [id, s] of sessions) if (s.expiresAt < Date.now()) sessions.delete(id);
      if (sessions.size >= 20) throw fault('授权请求过多，请等待旧二维码过期', 429);
      const auth = await request115Authorization(target.clientId),
        id = randomUUID(),
        expiresAt = Date.now() + 3 * 60_000;
      sessions.set(id, { ...auth, expiresAt, targetId: target.id, clientId: target.clientId, lastPoll: 0 });
      return {
        id,
        expiresAt,
        qrImage: await QRCode.toDataURL(auth.device.qrcode, { width: 240, margin: 2 }),
        status: 'waiting',
      };
    }),
  );
  app.post(
    '/115/authorize/:id/poll',
    wrap(async (req) => {
      const session = sessions.get(req.params.id);
      if (!session || session.expiresAt < Date.now()) {
        sessions.delete(req.params.id);
        return { status: 'expired' };
      }
      if (
        !publicTargets().some(
          (t) => t.id === session.targetId && t.type === '115' && t.clientId === session.clientId,
        )
      ) {
        sessions.delete(req.params.id);
        return { status: 'expired' };
      }
      if (Date.now() - session.lastPoll < 2000) throw fault('请间隔至少 2 秒查询授权状态', 429);
      session.lastPoll = Date.now();
      const result = await poll115Authorization(session);
      if (result.status === 'authorized') {
        update115Credentials(session.targetId, result.credentials);
        sessions.delete(req.params.id);
      }
      return { status: result.status };
    }),
  );
}
