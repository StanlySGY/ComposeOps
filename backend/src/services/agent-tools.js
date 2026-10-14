/**
 * Agent 工具注册总入口。
 *
 * Agent 工具按域拆到 tools/ 下纯注册函数(registerComposeTools / registerConfigTools /
 * registerMaintenanceTools),由本文件统一组装。拆分只搬运、不改任何工具体。
 *
 * 只读探测与容器日志读取统一走 ../lib/docker-exec.js(白名单单一事实来源)。
 */

import { registerComposeTools } from './tools/compose-tools.js';
import { registerConfigTools } from './tools/config-tools.js';
import { registerMaintenanceTools } from './tools/maintenance-tools.js';
import { registerStorageTools } from './tools/storage-tools.js';
import { registerEventTools } from './tools/event-tools.js';
import { registerContextTools } from './tools/context-tools.js';
import { registerMemoryTools } from './tools/memory-tools.js';
import { registerInspectionTools } from './tools/inspection-tools.js';
import { registerGitopsTools } from './tools/gitops-tools.js';
import { registerTaskTools } from './tools/task-tools.js';
import { registerSkillTools } from './tools/skill-tools.js';
import { MACRO_TOOLS } from './agent-tool-categories.js';

/**
 * Agent 工具的风险单一事实来源。所有注册工具必须显式列出；新增工具时，
 * 缺少条目会在注册阶段失败，不能因遗漏元数据而静默落到 low。
 */
export const RISK_LEVELS = {
  'compose.up': 'high',
  'compose.stop': 'high',
  'compose.restart': 'medium',
  'compose.pull': 'low',
  'compose.logs': 'low',
  'compose.ps': 'low',
  'compose.scale': 'medium',
  'compose.exec': 'high',
  'config.inspect': 'low',
  'config.preview': 'low',
  'config.validate': 'low',
  'config.propose': 'low',
  'config.edit': 'high',
  'config.rollback': 'high',
  'config.diff': 'low',
  'environment.get': 'low',
  'environment.set': 'high',
  'volume.mount': 'high',
  'diagnostic.probe': 'low',
  'diagnostic.analyze': 'low',
  'network.inspect': 'low',
  'security.audit': 'low',
  'server.inspect': 'low',
  'server.command': 'low',
  'alert.create': 'medium',
  'alert.configure': 'medium',
  'alert.list': 'low',
  'alert.delete': 'medium',
  'maintenance.clean': 'critical',
  'maintenance.update': 'low',
  'metrics.query': 'low',
  'backup.trigger': 'low',
  'notification.test': 'medium',
  // 测试夹具同样走完整的注册校验路径。
  'test.approval': 'low',
  'test.noop': 'low',
  'cron.create': 'medium',
  'cron.list': 'low',
  'performance.baseline': 'low',
  'volume.backup': 'low',
  'volume.restore': 'critical',
  'volume.verify': 'low',
  'volume.list_backups': 'low',
  'event.list': 'low',
  'event.update': 'low',
  'event.diagnose': 'low',
  'project.list_managed': 'low',
  'web.search': 'low',
  'app.list': 'low',
  'app.deploy': 'critical',
  'memory.search': 'low',
  'memory.save': 'low',
  'memory.delete': 'medium',
  'memory.sleep': 'medium',
  'inspection.run': 'low',
  'inspection.status': 'low',
  'gitops.drift': 'low',
  'task.list': 'low',
  'task.output': 'low',
  'task.stop': 'medium',
  'skill.list': 'low',
  'skill.use': 'low',
};

/**
 * 动态风险评估:根据项目上下文提升工具风险等级。
 * @param {string} toolName - 工具名称
 * @param {object} params - 工具参数
 * @param {object} context - 执行上下文(包含 project)
 * @returns {string} 动态评估后的风险等级
 */
export function assessRisk(toolName, params, context) {
  // 未知工具必须拒绝信任：它可能是新加但尚未完成风险定级的写操作。
  const baseRisk = Object.prototype.hasOwnProperty.call(RISK_LEVELS, toolName)
    ? RISK_LEVELS[toolName]
    : MACRO_TOOLS[toolName]?.risk;
  if (!['low', 'medium', 'high', 'critical'].includes(baseRisk)) return 'critical';

  // 生产项目提升风险等级，避免相同动作在生产环境沿用较低风险。
  const project = context?.project;
  if (project && (project.tags?.includes('production') || /prod|production/i.test(project.projectName || ''))) {
    if (baseRisk === 'medium') return 'high';
    if (baseRisk === 'high') return 'critical';
  }

  return baseRisk;
}

/** 注册全部域工具到 agent。 */
export function registerAgentTools(agent) {
  registerComposeTools(agent);
  registerConfigTools(agent);
  registerMaintenanceTools(agent);
  registerStorageTools(agent);
  registerEventTools(agent);
  registerContextTools(agent);
  registerMemoryTools(agent);
  registerInspectionTools(agent);
  registerGitopsTools(agent);
  registerTaskTools(agent);
  registerSkillTools(agent);
  return agent;
}
