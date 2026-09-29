/**
 * 维护 / 告警 / 指标域工具注册(maintenance.* alert.* metrics.query backup.trigger …)。
 * 由 agent-tools.js 拆分 —— 工具注册链与 helper 逐字节搬运。
 */
import { addComposeBackup, addPerformanceBaseline } from '../../lib/db.js';
import { createAlertRule, deleteAlertRule, listAlertRules } from '../alert-rules.js';
import { queryContainerMetrics } from '../agent-metrics.js';
import { readCompose } from '../compose-runner.js';
import { createJob, listJobs } from '../cron-scheduler.js';
import { getActivityDocker } from '../docker-hosts.js';
import { getProjectUpdates } from '../image-updater.js';
import { checkImageUpdates } from '../maintenance.js';
import { getNotificationConfig, sendNotification } from '../notifications.js';
import { findProject, scanProjects } from '../scanner.js';
import { readContainerStat } from '../stats.js';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

function sumSpace(reclaimed) {
  return Object.values(reclaimed || {}).reduce((total, value) => total + (Number(value) || 0), 0);
}

function runSafeHostCommand(command) {
  const commands = {
    uname: ['uname', ['-a']],
    uptime: ['uptime', []],
    memory: ['free', ['-h']],
    disk: ['df', ['-h', '/', '/var/lib/docker']],
    docker: ['docker', ['info', '--format', '{{json .}}']],
    containers: ['docker', ['ps', '-a', '--format', '{{json .}}']],
    dockerDisk: ['docker', ['system', 'df']],
  };
  const selected = commands[command];
  if (!selected) throw Object.assign(new Error('不允许执行该服务器命令'), { statusCode: 400 });
  try {
    return execFileSync(selected[0], selected[1], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }).trim();
  } catch (error) {
    throw Object.assign(new Error(`服务器命令执行失败: ${error.message}`), { statusCode: 502 });
  }
}

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
      execute: async () => {
        const docker = getActivityDocker();
        const [info, containers] = await Promise.all([
          docker.info().catch(() => null),
          docker.listContainers({ all: true }).catch(() => []),
        ]);
        const totalMemory = os.totalmem();
        const freeMemory = os.freemem();
        return {
          scope: 'host',
          hostname: os.hostname(),
          platform: `${os.type()} ${os.release()}`,
          uptimeSeconds: os.uptime(),
          cpu: { cores: os.cpus().length, loadAverage: os.loadavg() },
          memory: { totalBytes: totalMemory, freeBytes: freeMemory, usedBytes: totalMemory - freeMemory, usedPercent: +((totalMemory - freeMemory) / totalMemory * 100).toFixed(1) },
          docker: info ? { serverVersion: info.ServerVersion, containers: info.Containers, running: info.ContainersRunning, paused: info.ContainersPaused, stopped: info.ContainersStopped, images: info.Images } : { available: false },
          containers: containers.map((item) => ({ id: item.Id, name: (item.Names?.[0] || '').replace(/^\//, ''), image: item.Image, state: item.State, status: item.Status })).slice(0, 200),
          note: '这是服务器级只读概览,可继续使用 server.command 查询白名单内的原始命令输出。',
        };
      },
    })
    .registerTool('server.command', {
      description: '执行服务器只读诊断命令(仅允许 uname/uptime/free/df/docker info/ps/system df,不可执行任意命令)',
      category: 'diagnostic',
      requiredPermission: 'readonly',
      confirmationRequired: false,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', enum: ['uname', 'uptime', 'memory', 'disk', 'docker', 'containers', 'dockerDisk'], description: '白名单命令名' } },
        required: ['command'],
      },
      execute: async (params) => ({ command: params.command, output: runSafeHostCommand(params.command) }),
    })
    .registerTool('alert.create', {
      description: '创建容器资源告警规则(CPU/内存/重启次数阈值)',
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
        });
        return { ok: true, ruleId: rule.id, rule, note: '规则已保存,由告警引擎按轮询周期评估(内置 10 分钟冷却)' };
      },
      undo: async (params, result) => {
        const outcome = await deleteAlertRule(result?.rule?.id);
        return { ok: true, removed: result?.rule?.id || null, deleted: outcome.deleted };
      },
    })
    .registerTool('maintenance.clean', {
      description: '清理未使用的镜像/卷/网络/构建缓存',
      category: 'maintenance',
      requiredPermission: 'admin',
      confirmationRequired: true,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['images', 'volumes', 'networks', 'all'], description: '清理范围' },
        },
        required: ['scope'],
      },
      execute: async (params) => {
        const docker = getActivityDocker();
        const scope = params.scope;
        const reclaimed = {};
        if (scope === 'images' || scope === 'all') {
          const res = await docker.pruneImages({ filters: { dangling: ['false'] } });
          reclaimed.images = sumSpace(res?.SpaceReclaimed ? { SpaceReclaimed: res.SpaceReclaimed } : {});
        }
        if (scope === 'volumes' || scope === 'all') {
          const res = await docker.pruneVolumes();
          reclaimed.volumes = sumSpace({ SpaceReclaimed: res?.SpaceReclaimed });
        }
        if (scope === 'networks' || scope === 'all') {
          const res = await docker.pruneNetworks();
          reclaimed.networks = sumSpace({ SpaceReclaimed: res?.SpaceReclaimed });
        }
        if (scope === 'all') {
          const res = await docker.pruneBuilds();
          reclaimed.buildCache = sumSpace({ SpaceReclaimed: res?.SpaceReclaimed });
        }
        const total = Object.values(reclaimed).reduce((acc, value) => acc + (Number(value) || 0), 0);
        return { scope, reclaimedBytes: total, reclaimedMB: Math.round((total / 1024 / 1024) * 10) / 10, reclaimed };
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
      description: '按容器配置资源告警规则(cpu/内存百分比或重启次数阈值,超限触发通知、自动重启或扩容;规则进入统一告警引擎)',
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
        },
        required: ['container', 'metric', 'threshold'],
      },
      execute: async (params) => {
        const rule = await createAlertRule({
          container: params.container,
          metric: params.metric,
          threshold: Number(params.threshold),
          action: params.action || 'notify',
        });
        return { ok: true, ruleId: rule.id, rule, note: '规则已保存,由告警引擎按轮询周期评估(内置 10 分钟冷却)' };
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
      confirmationRequired: false,
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
      description: '创建定时任务(镜像检查/数据库备份/数据卷备份/安全或深度清理/定时拉取镜像/AI 巡检)',
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
        },
        required: ['name', 'type', 'cron'],
      },
      execute: async (params) => createJob({ name: params.name, type: params.type, cron: params.cron }),
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
