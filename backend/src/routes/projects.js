import { findProject, scanProjects } from '../services/scanner.js';
import { buildMountPlan } from '../services/mount-plan.js';
import { readCompose, saveCompose } from '../services/compose-runner.js';
import { pruneWorkspaceRunners, readWorkspaceCompose, saveWorkspaceCompose } from '../services/compose-workspace.js';
import { prepareProjectAction } from '../services/project-action-runner.js';
import { readProjectEnv, saveProjectEnv, applyProjectEnv, assertEnvAccess, listProjectEnvFiles, normalizeEnvFileName } from '../services/project-env.js';
import { getProjectUpdates, upgradeProject, rollbackProject } from '../services/image-updater.js';
import { readContainerStat } from '../services/stats.js';
import { validateComposeSemantics, previewComposeChange } from '../services/compose-validator.js';
import { listProjectDbContainers, runDbDump } from '../services/db-dumper.js';
import { scanProjectWebPorts, buildWebUiLinks } from '../services/project-ports.js';
import {
  addOperation,
  getComposeBackup,
  listComposeBackups,
  listProjectOperations,
  setProjectManagement,
  setProjectPreference,
} from '../lib/db.js';

async function projectOr404(id, reply) {
  const project = await findProject(id);
  if (!project) reply.code(404).send({ error: 'project_not_found', message: '项目不存在或当前不可见' });
  return project;
}

function requireManaged(project, reply) {
  if (!project.managed) {
    reply.code(403).send({ error: 'project_not_managed', message: '项目尚未加入管理，请先在项目纳管中勾选' });
    return false;
  }
  return true;
}

function requireEditable(project, reply) {
  if (!requireManaged(project, reply)) return false;
  if (!project.mountEnabled) {
    reply.code(403).send({ error: 'compose_access_not_enabled', message: '尚未为该项目启用 Compose 目录能力' });
    return false;
  }
  if (!project.editable) {
    reply.code(409).send({ error: 'compose_path_unavailable', message: 'Compose 项目路径缺失或权限范围过宽，无法安全挂载' });
    return false;
  }
  return true;
}

/**
 * 本文件的 schema 一律不接管服务端已有的语义,几处必须留手:
 * 1. projectIds/mountProjectIds 的数组元素刻意不声明 items.type —— coerceTypes 会把
 *    [123] 悄悄转成 ['123'],让处理函数的 `typeof id !== 'string'` 检查形同虚设,
 *    invalid_project_ids 也就永远返回不了;这里只收数组本身与长度上限(与处理函数的
 *    1000 对齐),元素类型仍由处理函数判定;
 * 2. content/favorite/note/containerId 都不设 required —— 处理函数各自返回
 *    invalid_content / invalid_favorite / invalid_note / missing_container 机器码;
 * 3. action 不设 enum:compose-runner 的 ACTIONS 是唯一事实来源,
 *    未知 action 由 assertProjectActionAllowed 抛出 unsupported_action;
 *    抄一份 enum 进 schema 只会多出一处必然漂移的规则;
 * 4. force 收 string —— 处理函数按 `=== '1'` 比较,声明成数字会让判断永远为假;
 * 5. interval/limit/fileIndex 越界由处理函数与 db.js 的 clamp 兜住,schema 只挡非数值。
 *
 * env 的 raw/entries 承载 .env 明文(可能含密钥),故本文件不声明任何 response schema,
 * 这些字段只走请求体。
 */
const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 128 } },
};

// backupId 收 string 而非 integer:处理函数 Number() 后交给 getComposeBackup,
// 查不到即 404 backup_not_found;声明成 integer 会把畸形 id 提前降级成 validation_failed。
const backupParams = {
  type: 'object',
  required: ['id', 'backupId'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 128 },
    backupId: { type: 'string', maxLength: 32 },
  },
};

// 元素类型交给处理函数:见文件头第 1 条。
const projectIdList = { type: 'array', maxItems: 1000 };

// YAML 正文与 .env 明文都可能很大,上限只用于挡住畸形巨包。
const CONTENT_MAX = 1048576;

// 只挡非数值:越界与缺省由处理函数的 `Number(x) || 0` 与下游读取器兜住(见文件头第 5 条)。
const fileIndexField = { type: 'number' };

export default async function projectRoutes(fastify) {
  fastify.get('/', async () => ({ projects: await scanProjects() }));

  fastify.get('/mount-plan', async () => buildMountPlan(await scanProjects()));

  fastify.put('/management', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { projectIds: projectIdList, mountProjectIds: projectIdList },
      },
    },
  }, async (request, reply) => {
    const projectIds = request.body?.projectIds;
    const mountProjectIds = request.body?.mountProjectIds ?? [];
    if (!Array.isArray(projectIds) || projectIds.length > 1000 ||
        projectIds.some((id) => typeof id !== 'string') ||
        !Array.isArray(mountProjectIds) || mountProjectIds.length > 1000 ||
        mountProjectIds.some((id) => typeof id !== 'string')) {
      return reply.code(400).send({ error: 'invalid_project_ids', message: '项目选择格式无效' });
    }
    const projects = await scanProjects();
    const discoveredIds = projects.map((project) => project.id);
    const discoveredSet = new Set(discoveredIds);
    if (projectIds.some((id) => !discoveredSet.has(id)) || mountProjectIds.some((id) => !discoveredSet.has(id))) {
      return reply.code(400).send({ error: 'unknown_project', message: '选择中包含当前未发现的项目' });
    }
    const selectedIds = [...new Set(projectIds)];
    const selectedMountIds = [...new Set(mountProjectIds)].filter((id) => selectedIds.includes(id));
    const result = setProjectManagement(discoveredIds, selectedIds, selectedMountIds);
    pruneWorkspaceRunners(selectedMountIds);
    addOperation({
      action: 'projects.management',
      status: 'success',
      detail: projects.filter((project) => selectedIds.includes(project.id)).map((project) => project.projectName).join(', '),
    });
    return result;
  });

  // 目录能力是纳管权限的子集。保留独立端点，便于设置页只调整挂载选择。
  fastify.put('/mounts', {
    schema: {
      body: { type: 'object', additionalProperties: false, properties: { projectIds: projectIdList } },
    },
  }, async (request, reply) => {
    const mountProjectIds = request.body?.projectIds;
    if (!Array.isArray(mountProjectIds) || mountProjectIds.length > 1000 ||
        mountProjectIds.some((id) => typeof id !== 'string')) {
      return reply.code(400).send({ error: 'invalid_project_ids', message: '项目选择格式无效' });
    }
    const projects = await scanProjects();
    const discoveredIds = projects.map((project) => project.id);
    const discoveredSet = new Set(discoveredIds);
    if (mountProjectIds.some((id) => !discoveredSet.has(id))) {
      return reply.code(400).send({ error: 'unknown_project', message: '选择中包含当前未发现的项目' });
    }
    const managedIds = projects.filter((project) => project.managed).map((project) => project.id);
    const selectedMountIds = [...new Set(mountProjectIds)].filter((id) => managedIds.includes(id));
    const result = setProjectManagement(discoveredIds, managedIds, selectedMountIds);
    pruneWorkspaceRunners(selectedMountIds);
    addOperation({ action: 'projects.mounts', status: 'success', detail: selectedMountIds.join(', ') });
    return result;
  });

  fastify.get('/:id', { schema: { params: idParams } }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (project) return project;
  });

  fastify.get('/:id/activity', {
    schema: {
      params: idParams,
      querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } } },
    },
  }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    if (!requireManaged(project, reply)) return;
    return {
      project: { id: project.id, projectName: project.projectName, editable: project.editable },
      operations: listProjectOperations(project.id, request.query.limit),
      backups: listComposeBackups(project.id),
    };
  });

  // favorite/note 的类型由处理函数判定并返回 invalid_favorite / invalid_note,
  // 故这里只声明键名占位(不写 type),否则 coerceTypes 会把非法值转成合法值放行。
  fastify.patch('/:id/preferences', {
    schema: {
      params: idParams,
      body: { type: 'object', additionalProperties: false, properties: { favorite: {}, note: {} } },
    },
  }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    const { favorite, note } = request.body || {};
    if (favorite !== undefined && typeof favorite !== 'boolean') {
      return reply.code(400).send({ error: 'invalid_favorite', message: '无效的收藏值' });
    }
    if (note !== undefined && typeof note !== 'string') {
      return reply.code(400).send({ error: 'invalid_note', message: '备注内容无效' });
    }
    return setProjectPreference(project.id, { favorite, note });
  });

  fastify.get('/:id/compose', {
    schema: {
      params: idParams,
      querystring: { type: 'object', properties: { fileIndex: fileIndexField } },
    },
  }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    if (!requireEditable(project, reply)) return;
    try {
      return project.mounted
        ? await readCompose(project, request.query.fileIndex || 0)
        : await readWorkspaceCompose(project, request.query.fileIndex || 0);
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ error: 'compose_read_failed', message: error.message });
    }
  });

  // content 不设 required/type:处理函数自己 typeof 判定并返回 invalid_content。
  fastify.post('/:id/compose/validate', {
    schema: {
      params: idParams,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { content: { type: 'string', maxLength: CONTENT_MAX }, fileIndex: fileIndexField },
      },
    },
  }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    if (!requireEditable(project, reply)) return;
    const { content, fileIndex } = request.body || {};
    if (typeof content !== 'string') {
      return reply.code(400).send({ error: 'invalid_content', message: '缺少校验内容' });
    }
    return { issues: validateComposeSemantics(content), fileIndex: Number(fileIndex) || 0 };
  });

  fastify.post('/:id/compose/preview', {
    schema: {
      params: idParams,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { content: { type: 'string', maxLength: CONTENT_MAX } },
      },
    },
  }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    if (!requireEditable(project, reply)) return;
    const { content } = request.body || {};
    if (typeof content !== 'string') {
      return reply.code(400).send({ error: 'invalid_content', message: '缺少预览内容' });
    }
    return { preview: previewComposeChange(content, project) };
  });

  // content 不设 required:缺失时 saveCompose 自己抛错并归到 compose_save_failed,
  // 抢先拦下会把 YAML_PARSE_ERROR 的 422 与行列号一起换成 validation_failed。
  fastify.put('/:id/compose', {
    schema: {
      params: idParams,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { content: { type: 'string', maxLength: CONTENT_MAX }, expectedContent: { type: 'string', maxLength: CONTENT_MAX }, fileIndex: fileIndexField },
      },
    },
  }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    if (!requireEditable(project, reply)) return;
    try {
      const result = project.mounted
        ? await saveCompose(project, request.body?.fileIndex || 0, request.body?.content, 'save', request.body?.expectedContent)
        : await saveWorkspaceCompose(project, request.body?.fileIndex || 0, request.body?.content, 'save', request.body?.expectedContent);
      addOperation({ projectId: project.id, projectName: project.projectName, action: 'compose.save', status: 'success' });
      return result;
    } catch (error) {
      addOperation({ projectId: project.id, projectName: project.projectName, action: 'compose.save', status: 'failed', detail: error.message });
      return reply.code(error.statusCode || (error.code === 'YAML_PARSE_ERROR' ? 422 : 500))
        .send({ error: 'compose_save_failed', message: error.message, line: error.line, column: error.column });
    }
  });

  fastify.get('/:id/backups', { schema: { params: idParams } }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    if (!requireManaged(project, reply)) return;
    return { backups: listComposeBackups(project.id) };
  });

  fastify.get('/:id/backups/:backupId', { schema: { params: backupParams } }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    if (!requireManaged(project, reply)) return;
    const backup = getComposeBackup(project.id, Number(request.params.backupId));
    if (!backup) return reply.code(404).send({ error: 'backup_not_found', message: '备份不存在或已被清理' });
    return backup;
  });

  fastify.post('/:id/backups/:backupId/restore', { schema: { params: backupParams } }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    if (!requireEditable(project, reply)) return;
    const backup = getComposeBackup(project.id, Number(request.params.backupId));
    if (!backup) return reply.code(404).send({ error: 'backup_not_found', message: '备份不存在或已被清理' });
    const fileIndex = project.composeFiles.indexOf(backup.filePath);
    if (fileIndex < 0) return reply.code(409).send({ error: 'backup_file_changed', message: '备份文件已变化,请刷新后重试' });
    try {
      // 记录回滚发起时看到的版本；若保存期间文件又变化，服务层在锁内拒绝覆盖。
      const current = project.mounted
        ? await readCompose(project, fileIndex)
        : await readWorkspaceCompose(project, fileIndex);
      if (project.mounted) await saveCompose(project, fileIndex, backup.content, 'restore', current.content);
      else await saveWorkspaceCompose(project, fileIndex, backup.content, 'restore', current.content);
      addOperation({ projectId: project.id, projectName: project.projectName, action: 'compose.restore', status: 'success', detail: `backup=${backup.id}` });
      return { ok: true };
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ error: 'restore_failed', message: error.message });
    }
  });

  // ---- 环境变量(.env 文件族:可读 .env / *.env / .env.example)----
  fastify.get('/:id/env/files', { schema: { params: idParams } }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    try {
      assertEnvAccess(project);
      return { files: await listProjectEnvFiles(project) };
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ error: 'env_files_failed', message: error.message });
    }
  });

  fastify.get('/:id/env', {
    schema: {
      params: idParams,
      querystring: { type: 'object', properties: { file: { type: 'string', maxLength: 128 } } },
    },
  }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    const file = normalizeEnvFileName(request.query?.file) || '.env';
    try {
      assertEnvAccess(project);
      return await readProjectEnv(project, file);
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ error: 'env_read_failed', message: error.message });
    }
  });

  // raw 刻意不给 default:saveProjectEnv 按 `raw != null` 二选一,
  // 补上默认值会让 entries 分支永远走不到。
  // entries 元素不封闭:parseDotenv 会附带 isSecret 等展示字段回传前端,
  // 封闭后 removeAdditional 会静默剥掉它们。
  fastify.put('/:id/env', {
    schema: {
      params: idParams,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', maxLength: 128 },
          raw: { type: 'string', maxLength: CONTENT_MAX },
          entries: {
            type: 'array',
            maxItems: 2000,
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', maxLength: 256 },
                value: { type: 'string', maxLength: 8192 },
                comment: { type: 'string', maxLength: 1024 },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    try {
      assertEnvAccess(project);
      const { raw, entries } = request.body || {};
      const file = normalizeEnvFileName(request.body?.file) || '.env';
      const result = await saveProjectEnv(project, { raw, entries }, file);
      return result;
    } catch (error) {
      addOperation({ projectId: project.id, projectName: project.projectName, action: 'env.save', status: 'failed', detail: error.message });
      return reply.code(error.statusCode || 500).send({ error: 'env_save_failed', message: error.message });
    }
  });

  // restart 不给 default:处理函数按 `!== false` 判定,缺省即视为重启,
  // 声明 default: true 只是把同一语义写第二遍。
  fastify.post('/:id/env/apply', {
    schema: {
      params: idParams,
      body: { type: 'object', additionalProperties: false, properties: { restart: { type: 'boolean' } } },
    },
  }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    try {
      assertEnvAccess(project);
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: 'env_apply_forbidden', message: error.message });
    }
    const restart = request.body?.restart !== false;
    if (!restart) return reply.send({ ok: true, restarted: false });

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
    const finish = (code) => {
      if (finished) return;
      finished = true;
      addOperation({ projectId: project.id, projectName: project.projectName, action: 'env.apply', status: code === 0 ? 'success' : 'failed', detail: output });
      send('exit', { code });
      reply.raw.end();
    };
    let child;
    applyProjectEnv(project, {
      onOutput: (type, text) => { output += text; send(type, text); },
      onChild: (process) => { child = process; },
    }).then(finish).catch((error) => {
      const text = `${error.message}\n`;
      output += text;
      send('stderr', text);
      finish(1);
    });
    reply.raw.on('close', () => {
      if (!finished && child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
    });
  });

  // ---- 项目容器实时资源指标流(SSE,2.5s 周期,客户端断开自动销毁) ----
  fastify.get('/:id/stats/stream', {
    schema: {
      params: idParams,
      querystring: { type: 'object', properties: { interval: { type: 'number' } } },
    },
  }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    if (!requireManaged(project, reply)) return;
    const interval = Math.max(1000, Math.min(Number(request.query.interval) || 2500, 10000));
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (frame) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
    let running = true;
    let timer = null;
    let inFlight = null;
    async function tick() {
      if (!running || inFlight) return;
      inFlight = (async () => {
        const containers = project.containers.filter((item) => item.state === 'running');
        const rows = await Promise.all(containers.map(async (item) => {
          try {
            const stat = await readContainerStat(item.id);
            return {
              containerId: item.id,
              name: item.name,
              ...stat,
            };
          } catch {
            return null;
          }
        }));
        send({ type: 'stats', data: rows.filter(Boolean), ts: Date.now() });
      })().catch((error) => {
        send({ type: 'error', data: error.message });
      }).finally(() => {
        inFlight = null;
      });
    }
    timer = setInterval(() => void tick(), interval);
    timer.unref?.();
    void tick();
    reply.raw.on('close', () => {
      running = false;
      if (timer) clearInterval(timer);
    });
  });

  // action 不设 enum:见文件头第 3 条,唯一事实来源是 compose-runner 的 ACTIONS。
  fastify.post('/:id/actions', {
    schema: {
      params: idParams,
      body: { type: 'object', additionalProperties: false, properties: { action: { type: 'string', maxLength: 32 } } },
    },
  }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    const action = request.body?.action;
    let prepared;
    try { prepared = await prepareProjectAction(project, action); }
    catch (error) { return reply.code(error.statusCode || 400).send({ error: 'unsupported_action', message: error.message }); }

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
    const finish = (code) => {
      if (finished) return;
      finished = true;
      addOperation({
        projectId: project.id,
        projectName: project.projectName,
        action: `${prepared.mode}.${action}`,
        status: code === 0 ? 'success' : 'failed',
        detail: output,
      });
      send('exit', { code });
      reply.raw.end();
    };
    let child;
    prepared.run((type, text) => { output += text; send(type, text); }, (process) => { child = process; })
      .then(finish)
      .catch((error) => { const text = `${error.message}\n`; output += text; send('stderr', text); finish(1); });
    reply.raw.on('close', () => {
      if (!finished && child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
    });
  });
  // ---- 镜像更新雷达 ----
  // force 收 string:处理函数按 `=== '1'` 比较,见文件头第 4 条。
  fastify.get('/:id/updates', {
    schema: {
      params: idParams,
      querystring: { type: 'object', properties: { force: { type: 'string', maxLength: 8 } } },
    },
  }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    try {
      return await getProjectUpdates(project, { force: request.query.force === '1' });
    } catch (error) {
      return reply.code(error.statusCode || 502).send({ error: 'updates_check_failed', message: error.message });
    }
  });

  fastify.post('/:id/upgrade', { schema: { params: idParams } }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
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
    upgradeProject(project, {
      onOutput: (type, text) => { output += text; send(type, text); },
      onChild: (process) => { child = process; },
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
      if (!finished && child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
    });
  });

  fastify.post('/:id/rollback', { schema: { params: idParams } }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
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
    let finished = false;
    const finish = (payload) => {
      if (finished) return;
      finished = true;
      send('result', payload);
      reply.raw.end();
    };
    let child;
    rollbackProject(project, {
      onOutput: (type, text) => { send(type, text); },
      onChild: (process) => { child = process; },
    }).then((result) => {
      send('exit', { code: result.code });
      finish({ ok: true, ...result });
    }).catch((error) => {
      finish({ ok: false, message: error.message });
    });
    reply.raw.on('close', () => {
      if (!finished && child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
    });
  });

  // ---- 数据库一键 Dump ----
  fastify.get('/:id/db-dump', { schema: { params: idParams } }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    return { containers: await listProjectDbContainers(project) };
  });

  // containerId 不设 required:处理函数自己返回 missing_container。
  fastify.post('/:id/db-dump', {
    schema: {
      params: idParams,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          containerId: { type: 'string', maxLength: 128 },
          dbName: { type: 'string', maxLength: 128 },
        },
      },
    },
  }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    const { containerId, dbName } = request.body || {};
    if (!containerId) return reply.code(400).send({ error: 'missing_container', message: '请选择要导出的数据库容器' });
    try {
      const result = await runDbDump(project, containerId, { dbName });
      if (result.exitCode !== 0) {
        result.stream.destroy();
        return reply.code(502).send({ error: 'dump_failed', message: '数据库导出命令执行失败,详见操作记录' });
      }
      reply.type('application/gzip');
      reply.header('Content-Disposition', `attachment; filename="${result.filename}"`);
      return reply.send(result.stream);
    } catch (error) {
      return reply.code(error.statusCode || 502).send({ error: 'db_dump_failed', message: error.message });
    }
  });

  // ---- WebUI 智能雷达 ----
  fastify.get('/:id/webui', { schema: { params: idParams } }, async (request, reply) => {
    const project = await projectOr404(request.params.id, reply);
    if (!project) return;
    const entries = scanProjectWebPorts(project);
    const links = buildWebUiLinks(request.headers.host, entries);
    return { projectId: project.id, projectName: project.projectName, links };
  });
}
