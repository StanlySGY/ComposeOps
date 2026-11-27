/**
 * 维护 / 告警 / 指标域工具注册(maintenance.* alert.* metrics.query backup.trigger …)。
 * 由 agent-tools.js 拆分 —— 工具注册链与 helper 逐字节搬运。
 */
import { addComposeBackup, addPerformanceBaseline } from '../../lib/db.js';
import { createAlertRule, deleteAlertRule, listAlertRules } from '../alert-rules.js';
import { queryContainerMetrics } from '../agent-metrics.js';
import { readCompose } from '../compose-runner.js';
import { createJob, listJobs } from '../cron-scheduler.js';
import { getSystemStorageDf, pruneStorageResources } from '../docker-storage.js';
import { inspectServer, runServerDiagnostic } from '../server-diagnostics.js';
import { getProjectUpdates } from '../image-updater.js';
import { checkImageUpdates } from '../maintenance.js';
import { getNotificationConfig, sendNotification } from '../notifications.js';
import { findProject, scanProjects } from '../scanner.js';
import { readContainerStat } from '../stats.js';

/** 读取指定 Compose 文件当前内容(兼容 mounted / workspace)。 */
async function currentComposeContent(project, fileIndex = 0) {
  const index = Number(fileIndex) || 0;
  if (project.mounted) return (await readCompose(project, index)).content;
  const { readWorkspaceCompose } = await import('../compose-workspace.js');
  return (await readWorkspaceCompose(project, index)).content;
}

export function registerMaintenanceTools(agent) {
  agent
    .registerTool('server.inspect', {
      description: '查看当前 Docker 宿主服务器的总资源、系统信息、磁盘和容器概览(只读,不限定项目)',
      category: 'diagnostic',
      requiredPermission: 'readonly',
      confirmationRequired: false,
      requiresProject: false,
      parameters: { type: 'object', properties: {} },
      execute: async () => inspectServer(),
    })
    .registerTool('server.command', {
      description: '读取所选节点的系统、内存、磁盘与Docker诊断；仅允许固定类型，宿主采集不可用时明确报错，不回退面板本机',
      category: 'diagnostic',
      requiredPermission: 'readonly',
      confirmationRequired: false,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', enum: ['uname', 'uptime', 'memory', 'disk', 'docker', 'containers', 'dockerDisk'], description: '白名单命令名' } },
        required: ['command'],
      },
      execute: async params => runServerDiagnostic(params.command),
    })
    .registerTool('alert.create', {
      description: '创建固定容器资源告警。自动处置须确认：7天授权、项目级10分钟冷却、滚动24小时最多3次；未知结果暂停。扩容最多5副本，仅无挂载/固定端口且镜像固定摘要的服务。',
      category: 'maintenance',
      requiredPermission: 'managed',
      confirmationRequired: true,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          service: { type: 'string', description: '服务名' },
          metric: { type: 'string', enum: ['cpu', 'memory', 'restart_count'], description: '指标' },
          threshold: { type: 'number', description: '阈值' },
          action: { type: 'string', enum: ['notify', 'auto_restart', 'scale'], description: '触发动作' },
          confirmAutomatic: { type: 'boolean', description: '用户明确接受自动处置期限与预算后才为true，不能由模型自行默认为true' },
        },
        required: ['projectId', 'service', 'metric', 'threshold', 'action'],
      },
      execute: async (params) => {
        const rule = await createAlertRule({
          projectId: params.projectId,
          service: params.service,
          metric: params.metric,
          threshold: Number(params.threshold),
          action: params.action,
          confirmAutomatic: params.confirmAutomatic,
        }, { actor: 'agent' });
        return { ok: true, ruleId: rule.id, rule, note: '连续两个有效超限样本触发；自动授权7天，项目级10分钟冷却、24小时最多3次，结果未知需人工核对。关闭通知渠道不会撤销单独授权的自动动作。' };
      },
      undo: async (params, result) => {
        const outcome = await deleteAlertRule(result?.rule?.id);
        return { ok: true, removed: result?.rule?.id || null, deleted: outcome.deleted };
      },
    })
    .registerTool('maintenance.inspect', {
      description: '只读查看当前Docker节点空间与清理范围，返回hostId和hostRevision供确认清理使用；含未纳管资源',
      category: 'maintenance', requiredPermission: 'readonly', confirmationRequired: false, requiresProject: false,
      parameters: { type: 'object', properties: {} },
      execute: async () => getSystemStorageDf(),
    })
    .registerTool('maintenance.clean', {
      description: '按已预览节点清理悬空镜像、未引用匿名卷、未使用网络或构建缓存；包含未纳管资源，保留容器及命名卷。先调用maintenance.inspect，再确认具体范围',
      category: 'maintenance',
      requiredPermission: 'admin',
      confirmationRequired: true,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['images', 'volumes', 'networks', 'builder', 'all'], description: 'all包括悬空镜像、未引用匿名卷、未使用网络和构建缓存' },
          expectedHostId: { type: 'string', description: 'maintenance.inspect返回的hostId' },
          hostRevision: { type: 'string', description: 'maintenance.inspect返回的hostRevision，原样传递' },
        },
        required: ['scope', 'expectedHostId', 'hostRevision'],
      },
      execute: async params => {
        const scope = params.scope;
        if (!['images', 'volumes', 'networks', 'builder', 'all'].includes(scope)) throw new Error('不支持的清理范围');
        const result = await pruneStorageResources({
          images: scope === 'images' || scope === 'all', volumes: scope === 'volumes' || scope === 'all',
          networks: scope === 'networks' || scope === 'all', buildCache: scope === 'builder' || scope === 'all', allBuildCache: true,
        }, params, scope);
        return { ...result, scope, reclaimedBytes: Object.values(result.reclaimed).reduce((total, value) => total + value, 0) };
      },
    })
    .registerTool('maintenance.update', {
      description: '检查纳管项目镜像是否有远程更新',
      category: 'maintenance',
      requiredPermission: 'readonly',
      confirmationRequired: false,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string', description: '项目 ID(可选,缺省全局检查)' } },
      },
      execute: async (params) => {
        if (params.projectId) {
          const project = await findProject(params.projectId);
          if (!project) throw Object.assign(new Error('项目不存在或当前不可见'), { statusCode: 404 });
          return getProjectUpdates(project, { force: true });
        }
        return { results: await checkImageUpdates() };
      },
    })
    .registerTool('metrics.query', {
      description: '查询容器资源指标(CPU/内存/网络/磁盘)及历史趋势',
      category: 'diagnostic',
      requiredPermission: 'readonly',
      confirmationRequired: false,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: {
          container: { type: 'string', description: '容器名称或 ID' },
          metric: { type: 'string', enum: ['cpu', 'memory', 'network', 'disk'], description: '指标类型(默认 cpu)' },
          period: { type: 'string', description: '历史时间段(如 5m/1h/24h,默认 5m)' },
        },
        required: ['container'],
      },
      execute: async (params) => queryContainerMetrics(params.container, params.metric || 'cpu', params.period || '5m'),
    })
    .registerTool('alert.configure', {
      description: '按精确容器配置资源告警。自动处置须确认7天授权、项目级10分钟冷却与24小时3次预算；未知结果暂停。扩容限固定摘要、无挂载/固定端口服务，最多5副本。',
      category: 'maintenance',
      requiredPermission: 'admin',
      confirmationRequired: true,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: {
          container: { type: 'string', description: '容器名称或 ID' },
          metric: { type: 'string', enum: ['cpu', 'memory', 'restart_count'], description: '监控指标' },
          threshold: { type: 'number', description: '阈值(cpu/内存为 0-100 百分比,重启次数为次数)' },
          action: { type: 'string', enum: ['notify', 'auto_restart', 'scale'], description: '触发动作(默认 notify)' },
          confirmAutomatic: { type: 'boolean', description: '用户明确确认自动处置的期限和预算后传true' },
        },
        required: ['container', 'metric', 'threshold'],
      },
      execute: async (params) => {
        const rule = await createAlertRule({
          container: params.container,
          metric: params.metric,
          threshold: Number(params.threshold),
          action: params.action || 'notify',
          confirmAutomatic: params.confirmAutomatic,
        }, { actor: 'agent' });
        return { ok: true, ruleId: rule.id, rule, note: '连续两个有效超限样本触发；自动授权7天，项目级10分钟冷却、24小时最多3次，结果未知需人工核对。关闭通知渠道不会撤销单独授权的自动动作。' };
      },
    })
    .registerTool('alert.list', {
      description: '列出已配置的告警规则(含 Agent 创建的规则,附项目/容器可读名)',
      category: 'maintenance',
      requiredPermission: 'readonly',
      confirmationRequired: false,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: {
          container: { type: 'string', description: '容器名称或 ID(可选,用于过滤)' },
        },
      },
      execute: async (params) => ({ rules: await listAlertRules({ container: params.container }) }),
    })
    .registerTool('alert.delete', {
      description: '删除告警规则',
      category: 'maintenance',
      requiredPermission: 'admin',
      confirmationRequired: true,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: {
          ruleId: { type: 'string', description: '规则 ID' },
        },
        required: ['ruleId'],
      },
      execute: async (params) => deleteAlertRule(params.ruleId),
    })
    .registerTool('backup.trigger', {
      description: '手动为项目 Compose 配置创建备份快照',
      category: 'maintenance',
      requiredPermission: 'editable',
      confirmationRequired: false,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          fileIndex: { type: 'number', description: 'Compose 文件索引(默认 0)' },
        },
        required: ['projectId'],
      },
      execute: async (params, context) => {
        const fileIndex = Number(params.fileIndex) || 0;
        const content = await currentComposeContent(context.project, fileIndex);
        const filePath = context.project.composeFiles[fileIndex];
        const backupId = addComposeBackup(context.project.id, filePath, content, 'agent:backup.trigger');
        return { ok: true, backupId, filePath };
      },
    })
    .registerTool('notification.test', {
      description: '发送测试通知以验证通知渠道配置',
      category: 'maintenance',
      requiredPermission: 'managed',
      confirmationRequired: true,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: { message: { type: 'string', description: '自定义测试消息(可选)' } },
      },
      execute: async (params) => {
        const config = getNotificationConfig(false);
        if (!config.enabled) throw new Error('通知功能尚未启用');
        const message = String(params.message || '这是一条来自 AI Agent 的测试通知');
        await sendNotification('ComposeOps Agent 测试通知', message, config);
        return { ok: true, type: config.type };
      },
    })
    .registerTool('cron.create', {
      description: '创建独立定时任务，不是顺序流程。清理/巡检固定节点，先server.inspect获取hostId/connectionRevision；清理保留容器与卷。备份/拉取可传scope=project与projectId固定项目，未限定项目则覆盖全部节点纳管项目；镜像检查始终全节点',
      category: 'maintenance',
      requiredPermission: 'managed',
      confirmationRequired: true,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '任务名称' },
          type: { type: 'string', enum: ['db-backup', 'prune-safe', 'prune-all', 'images-check', 'pull-images', 'volume-backup', 'inspection'], description: '任务类型' },
          cron: { type: 'string', description: '5 段 cron 表达式(分 时 日 月 周)' },
          scope: { type: 'string', enum: ['all', 'host', 'project'], description: '项目备份或拉取须明确传project；all明确覆盖所有节点，host用于清理/巡检' },
          projectId: { type: 'string', description: '限定项目时必填，真实扫描得到的项目ID' },
          hostId: { type: 'string', description: '清理/巡检/项目计划必填，server.inspect返回的节点ID' },
          connectionRevision: { type: 'string', description: '清理/巡检/项目计划必填，server.inspect返回的连接修订' },
        },
        required: ['name', 'type', 'cron'],
      },
      execute: async (params) => {
        if ((params.projectId || params.scope === 'project' || ['prune-safe', 'prune-all', 'inspection'].includes(params.type)) && (!params.hostId || !params.connectionRevision)) {
          throw Object.assign(new Error('请先调用 server.inspect 核对节点，再传入 hostId 和 connectionRevision 创建计划'), { statusCode: 409 });
        }
        return createJob({ name: params.name, type: params.type, cron: params.cron, hostId: params.hostId, connectionRevision: params.connectionRevision, scope: params.scope, projectId: params.projectId });
      },
    })
    .registerTool('cron.list', {
      description: '列出当前服务器已有的定时任务及最近执行状态',
      category: 'maintenance',
      requiredPermission: 'readonly',
      confirmationRequired: false,
      requiresProject: false,
      parameters: { type: 'object', properties: {} },
      execute: async () => listJobs(),
    })
    .registerTool('performance.baseline', {
      description: '记录当前纳管项目资源使用基线(CPU/内存/IO)',
      category: 'maintenance',
      requiredPermission: 'managed',
      confirmationRequired: false,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: { label: { type: 'string', description: '基线标签(可选)' } },
      },
      execute: async (params) => {
        const projects = (await scanProjects()).filter((project) => project.managed);
        const snapshot = [];
        for (const project of projects) {
          for (const container of project.containers.filter((item) => item.state === 'running')) {
            try {
              snapshot.push({ project: project.projectName, container: container.name, ...(await readContainerStat(container.id)) });
            } catch {
              snapshot.push({ project: project.projectName, container: container.name, error: '无法读取统计' });
            }
          }
        }
        const baseline = { label: String(params.label || ''), capturedAt: new Date().toISOString(), snapshot };
        const id = addPerformanceBaseline(baseline.label, baseline);
        return { id, ...baseline };
      },
    });
  return agent;
}
