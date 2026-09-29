/**
 * 工具分类与编排系统
 * 
 * 解决原有扁平化工具注册的问题，提供：
 * 1. 分层工具分类（lifecycle/config/diagnostic/maintenance）
 * 2. 工具依赖关系定义
 * 3. 前置/后置条件检查
 * 4. 宏工具（多步骤组合）
 */

import { findProject } from './scanner.js';
import { getActivityDocker } from './docker-hosts.js';

/** 工具分类定义 */
export const TOOL_CATEGORIES = {
  context: {
    label: '上下文与资料',
    description: '发现已纳管项目和可选的联网资料检索',
    icon: 'globe',
    risk: 'low',
    tools: ['project.list_managed', 'web.search', 'app.list', 'skill.list', 'skill.use']
  },
  memory: {
    label: '长期记忆',
    description: '读取、保存和删除用户明确授权的偏好与环境事实',
    icon: 'brain',
    risk: 'low',
    tools: ['memory.search', 'memory.save', 'memory.delete', 'memory.sleep']
  },
  lifecycle: {
    label: '生命周期管理',
    description: '容器和服务的启停、重启、扩缩容',
    icon: 'power',
    risk: 'medium',
    tools: ['compose.up', 'compose.stop', 'compose.restart', 'compose.pull', 'compose.scale']
  },
  task: {
    label: '后台任务',
    description: '查看、等待与终止转入后台的长操作(compose 构建拉取等)',
    icon: 'timer',
    risk: 'low',
    tools: ['task.list', 'task.output', 'task.stop']
  },
  config: {
    label: '配置管理',
    description: 'Compose 配置文件的编辑、校验、回滚',
    icon: 'file-edit',
    risk: 'high',
    tools: ['config.inspect', 'config.propose', 'config.edit', 'config.validate', 'config.preview', 'config.rollback', 'config.diff'],
    requires: ['lifecycle.stopped'] // 约束：修改配置前需要先停止服务
  },
  diagnostic: {
    label: '诊断分析',
    description: '日志查看、资源监控、健康检查',
    icon: 'stethoscope',
    risk: 'low',
    tools: ['diagnostic.probe', 'diagnostic.analyze', 'compose.logs', 'compose.ps', 'metrics.query', 'network.inspect', 'server.inspect', 'server.command']
  },
  maintenance: {
    label: '运维维护',
    description: '清理、备份、更新、告警',
    icon: 'wrench',
    risk: 'high',
    tools: ['maintenance.clean', 'maintenance.update', 'backup.trigger', 'alert.create', 'cron.create', 'cron.list', 'app.deploy']
  },
  security: {
    label: '安全审计',
    description: '安全扫描、权限检查、合规审计',
    icon: 'shield',
    risk: 'low',
    tools: ['security.audit', 'environment.get']
  },
  advanced: {
    label: '高级操作',
    description: '环境变量、卷挂载、网络配置',
    icon: 'settings',
    risk: 'high',
    tools: ['environment.set', 'volume.mount', 'compose.exec', 'performance.baseline']
  }
};

/** 工具依赖关系 */
export const TOOL_DEPENDENCIES = {
  'compose.scale': {
    requires: ['compose.up'], // 必须先启动服务才能扩缩容
    conflicts: ['compose.stop'] // 不能在停止状态下扩容
  },
  'config.edit': {
    recommends: ['config.validate'], // 建议先校验
    before: ['compose.stop'], // 编辑前建议先停止服务
    after: ['config.validate'] // 编辑后必须校验
  },
  'compose.up': {
    before: ['config.validate'], // 启动前必须校验配置
    after: ['diagnostic.probe'] // 启动后建议健康检查
  }
};

/**
 * 前置条件检查器
 */
export class PreconditionChecker {
  /**
   * 检查工具是否可以执行
   * @param {string} toolName - 工具名
   * @param {object} params - 参数
   * @param {object} context - 上下文
   * @returns {Promise<{allowed: boolean, reason?: string}>}
   */
  static async check(toolName, params, context) {
    const checks = PRECONDITIONS[toolName];
    if (!checks) return { allowed: true };

    for (const condition of checks) {
      try {
        const result = await condition.check(params, context);
        if (!result) {
          return { allowed: false, reason: condition.errorMessage };
        }
      } catch (error) {
        return { allowed: false, reason: `前置检查失败: ${error.message}` };
      }
    }

    return { allowed: true };
  }
}

/**
 * 后置条件验证器
 */
export class PostconditionValidator {
  /**
   * 验证工具执行后的结果
   * @param {string} toolName - 工具名
   * @param {object} params - 参数
   * @param {object} result - 执行结果
   * @param {object} context - 上下文
   * @returns {Promise<{valid: boolean, reason?: string}>}
   */
  static async validate(toolName, params, result, context) {
    // 后台任务(compose.up/pull background=true)尚未产生最终效果,
    // 此刻的容器状态不代表动作结果,客观验收改由任务完成后的通知环节承担。
    if (result && typeof result === 'object' && result.background === true) return { valid: true };
    const checks = POSTCONDITIONS[toolName];
    if (!checks) return { valid: true };

    for (const condition of checks) {
      try {
        const isValid = await condition.check(params, result, context);
        if (!isValid) {
          return { valid: false, reason: condition.errorMessage };
        }
      } catch (error) {
        return { valid: false, reason: `后置验证失败: ${error.message}` };
      }
    }

    return { valid: true };
  }
}

/** 前置条件定义 */
const PRECONDITIONS = {
  'compose.scale': [
    {
      check: async (params, context) => {
        if (!params.service) return false;
        const project = await findProject(context.projectId);
        if (!project) return false;
        
        // 检查服务是否存在且运行中
        const docker = await getActivityDocker();
        const containers = await docker.listContainers({
          filters: { label: [`com.docker.compose.project=${project.projectName}`] }
        });
        
        const serviceContainers = containers.filter(c => 
          c.Labels['com.docker.compose.service'] === params.service
        );
        
        return serviceContainers.length > 0 && serviceContainers.some(c => c.State === 'running');
      },
      errorMessage: '服务未运行，无法扩缩容。请先使用 compose.up 启动服务。'
    }
  ],
  'config.edit': [
    {
      check: async (params, context) => {
        // 建议：配置修改前服务应处于停止状态
        const project = await findProject(context.projectId);
        if (!project) return true; // 项目不存在时跳过检查
        
        const docker = await getActivityDocker();
        const containers = await docker.listContainers({
          filters: { label: [`com.docker.compose.project=${project.projectName}`] }
        });
        
        const runningCount = containers.filter(c => c.State === 'running').length;
        
        // 警告而非阻止
        if (runningCount > 0) {
          context.warnings = context.warnings || [];
          context.warnings.push(`有 ${runningCount} 个容器正在运行，配置修改后需要重启服务才能生效`);
        }
        return true;
      },
      errorMessage: null // 仅警告，不阻止
    }
  ],
  'volume.mount': [
    {
      check: async (params, context) => {
        if (!params.source) return false;
        
        // 安全检查：路径必须在项目目录内
        const project = await findProject(context.projectId);
        if (!project) return false;
        
        const { resolve, relative } = await import('path');
        const projectRoot = project.workingDir || project.path;
        if (!projectRoot || !String(params.source).startsWith('/')) return false;
        const absHostPath = resolve(projectRoot, params.source);
        const relPath = relative(projectRoot, absHostPath);
        
        // 不允许 .. 跳出项目目录
        return !relPath.startsWith('..') && !relPath.startsWith('/');
      },
      errorMessage: '挂载路径必须在项目目录内，不允许访问项目外的文件系统'
    }
  ]
};

/** 后置条件定义 */
const POSTCONDITIONS = {
  'compose.scale': [
    {
      check: async (params, result, context) => {
        if (params.replicas === undefined || params.replicas === null) return true;
        
        // 验证实际副本数是否符合预期
        const project = await findProject(context.projectId);
        if (!project) return false;
        
        const docker = await getActivityDocker();
        const containers = await docker.listContainers({
          filters: { 
            label: [
              `com.docker.compose.project=${project.projectName}`,
              `com.docker.compose.service=${params.service}`
            ]
          }
        });
        
        const runningCount = containers.filter(c => c.State === 'running').length;
        return runningCount === params.replicas;
      },
      errorMessage: '扩缩容后实际副本数与预期不符，请检查容器状态'
    }
  ],
  // runGate:重启后客观验收,不让 Agent 自证"修好了"
  'compose.restart': [
    {
      check: async (params, result, context) => {
        const project = await findProject(context.projectId);
        if (!project) return false;
        const docker = await getActivityDocker();
        const containers = await docker.listContainers({
          filters: { label: [`com.docker.compose.project=${project.projectName}`] }
        });
        return containers.some(c => c.State === 'running');
      },
      errorMessage: '重启后未检测到运行中的容器,请检查日志确认是否启动失败'
    }
  ],
  'compose.up': [
    {
      check: async (params, result, context) => {
        // 验证容器是否成功启动
        const project = await findProject(context.projectId);
        if (!project) return false;
        
        const docker = await getActivityDocker();
        const containers = await docker.listContainers({
          filters: { label: [`com.docker.compose.project=${project.projectName}`] }
        });
        
        // 至少有一个容器在运行
        return containers.some(c => c.State === 'running');
      },
      errorMessage: '服务启动后未检测到运行中的容器，请检查配置和日志'
    }
  ],
  'config.edit': [
    {
      check: async (params, result, context) => {
        // 配置修改后应该能通过校验
        const { validateComposeSemantics } = await import('./compose-validator.js');
        const project = await findProject(context.projectId);
        if (!project) return false;
        
        const content = project.mounted
          ? (await import('./compose-runner.js')).readCompose(project)
          : (await import('./compose-workspace.js')).readWorkspaceCompose(project);
        const compose = await content;
        const validation = await validateComposeSemantics(compose.content);
        
        return validation.valid;
      },
      errorMessage: '配置修改后校验失败，可能存在语法错误。请使用 config.rollback 回滚。'
    }
  ]
};

/**
 * 宏工具：预定义的多步骤操作组合
 */
export const MACRO_TOOLS = {
  'macro.safe_restart': {
    name: 'macro.safe_restart',
    description: '安全重启：备份配置 → 停止服务 → 验证配置 → 启动服务 → 健康检查',
    category: 'lifecycle',
    risk: 'high',
    requiredPermission: 'managed',
    requiresProject: true,
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '项目 ID' },
        healthCheck: { type: 'boolean', description: '是否执行健康检查', default: true }
      }
    },
    steps: [
      { tool: 'backup.trigger', params: (ctx) => ({ projectId: ctx.projectId }) },
      { tool: 'compose.stop', params: (ctx) => ({ projectId: ctx.projectId }) },
      { tool: 'config.validate', params: (ctx) => ({ projectId: ctx.projectId }) },
      { tool: 'compose.up', params: (ctx) => ({ projectId: ctx.projectId }) },
      { tool: 'diagnostic.probe', params: (ctx) => ({ projectId: ctx.projectId, containerId: ctx.containerId, command: 'ps aux' }), condition: (ctx) => ctx.healthCheck !== false && !!ctx.containerId }
    ]
  },
  'macro.config_update': {
    name: 'macro.config_update',
    description: '安全配置更新：备份 → 校验 → 编辑 → 再次校验 → 重启',
    category: 'config',
    risk: 'high',
    requiredPermission: 'editable',
    requiresProject: true,
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '项目 ID' },
        path: { type: 'string', description: 'YAML 点路径' },
        value: { type: 'string', description: '新值' },
        action: { type: 'string', enum: ['set', 'unset', 'append'], description: '编辑动作' }
      },
      required: ['path', 'action']
    },
    steps: [
      { tool: 'backup.trigger', params: (ctx) => ({ projectId: ctx.projectId }) },
      { tool: 'config.validate', params: (ctx) => ({ projectId: ctx.projectId }) },
      { tool: 'config.edit', params: (ctx) => ({ projectId: ctx.projectId, path: ctx.path, value: ctx.value, action: ctx.action }) },
      { tool: 'config.validate', params: (ctx) => ({ projectId: ctx.projectId }) },
      { tool: 'compose.restart', params: (ctx) => ({ projectId: ctx.projectId }) }
    ]
  },
  'macro.emergency_rollback': {
    name: 'macro.emergency_rollback',
    description: '应急回滚：停止服务 → 回滚配置 → 重新启动',
    category: 'maintenance',
    risk: 'critical',
    requiredPermission: 'editable',
    requiresProject: true,
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '项目 ID' }
      }
    },
    steps: [
      { tool: 'compose.stop', params: (ctx) => ({ projectId: ctx.projectId }) },
      { tool: 'config.rollback', params: (ctx) => ({ projectId: ctx.projectId }) },
      { tool: 'compose.up', params: (ctx) => ({ projectId: ctx.projectId }) },
      { tool: 'compose.logs', params: (ctx) => ({ projectId: ctx.projectId, tail: 50 }) }
    ]
  },
  'macro.full_cleanup': {
    name: 'macro.full_cleanup',
    description: '完整清理：停止所有服务 → 清理悬空镜像 → 清理卷 → 清理网络',
    category: 'maintenance',
    risk: 'critical',
    requiredPermission: 'admin',
    requiresProject: false,
    parameters: {
      type: 'object',
      properties: {
        includeVolumes: { type: 'boolean', description: '是否清理卷（危险）', default: false }
      }
    },
    steps: [
      { tool: 'maintenance.clean', params: { scope: 'images' } },
      { tool: 'maintenance.clean', params: { scope: 'volumes' }, condition: (ctx) => ctx.includeVolumes === true },
      { tool: 'maintenance.clean', params: { scope: 'networks' } }
    ]
  }
};

/**
 * 展开宏工具为实际步骤
 * @param {string} macroName - 宏工具名
 * @param {object} params - 参数
 * @returns {Array<{tool: string, params: object}>}
 */
export function expandMacro(macroName, params) {
  const macro = MACRO_TOOLS[macroName];
  if (!macro) {
    throw new Error(`未知的宏工具: ${macroName}`);
  }

  const steps = [];
  for (const step of macro.steps) {
    // 检查条件
    if (step.condition && !step.condition(params)) {
      continue;
    }

    // 解析动态参数
    const stepParams = typeof step.params === 'function'
      ? step.params(params)
      : { ...step.params, projectId: params.projectId };

    steps.push({
      tool: step.tool,
      params: stepParams
    });
  }

  return steps;
}

/**
 * 获取工具所属分类
 * @param {string} toolName - 工具名
 * @returns {string|null}
 */
export function getToolCategory(toolName) {
  for (const [categoryName, category] of Object.entries(TOOL_CATEGORIES)) {
    if (category.tools.includes(toolName)) {
      return categoryName;
    }
  }
  return null;
}

/**
 * 获取分类下的所有工具
 * @param {string} categoryName - 分类名
 * @returns {Array<string>}
 */
export function getToolsByCategory(categoryName) {
  const category = TOOL_CATEGORIES[categoryName];
  return category ? category.tools : [];
}
