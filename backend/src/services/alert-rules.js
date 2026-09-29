/**
 * 统一告警规则存储:Agent 工具(alert.create/configure)与 REST(/metrics/alerts)共用。
 *
 * 历史坑:工具曾把规则写进独立的 `alert_rules` 键,而评估引擎(alert-monitor)只读
 * `agent.alert_rules`,导致"创建了规则却永不触发"。这里收敛为单一存储、单一规则形状,
 * 与 alert-monitor 的 evaluateAgentRules 消费格式(projectId + service + metric/action)对齐。
 */
import { getSetting, setSetting } from '../lib/db.js';
import { scanProjects } from './scanner.js';
import { resolveManagedContainer } from './agent-metrics.js';

export const ALERT_METRICS = new Set(['cpu', 'memory', 'restart_count']);
export const ALERT_ACTIONS = new Set(['notify', 'auto_restart', 'scale']);

export function readAlertRules() {
  try {
    const parsed = JSON.parse(getSetting('agent.alert_rules', '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeAlertRules(rules) {
  setSetting('agent.alert_rules', JSON.stringify(rules));
}

function newRuleId() {
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 创建告警规则。定位方式二选一:
 * - projectId + service:Agent 的 alert.create 传入(不触 Docker)。
 * - container:容器名/ID,REST 与 alert.configure 传入,解析到纳管项目 + 容器。
 * 校验全部发生在任何外部依赖之前,便于纯单测覆盖。
 */
export async function createAlertRule(input = {}) {
  const { projectId, service, container, metric, threshold, action = 'notify' } = input;
  const numericThreshold = Number(threshold);
  if (!ALERT_METRICS.has(metric)) {
    throw Object.assign(new Error('不支持的告警指标类型,可选 cpu/memory/restart_count'), { statusCode: 400 });
  }
  if (threshold === '' || threshold === null || threshold === undefined || !Number.isFinite(numericThreshold)) {
    throw Object.assign(new Error('告警阈值必须是有限数字'), { statusCode: 400 });
  }
  if (['cpu', 'memory'].includes(metric) && (numericThreshold < 0 || numericThreshold > 100)) {
    throw Object.assign(new Error('CPU 和内存告警阈值必须在 0 到 100 之间'), { statusCode: 400 });
  }
  if (metric === 'restart_count' && numericThreshold < 0) {
    throw Object.assign(new Error('重启次数阈值不能小于 0'), { statusCode: 400 });
  }
  // 兼容旧调用方的 restart 动作名(评估引擎里叫 auto_restart)。
  const normalizedAction = action === 'restart' ? 'auto_restart' : action;
  if (!ALERT_ACTIONS.has(normalizedAction)) {
    throw Object.assign(new Error('不支持的告警动作,可选 notify/auto_restart/scale'), { statusCode: 400 });
  }

  const rule = {
    id: newRuleId(),
    projectId: null,
    service: '',
    containerId: null,
    metric,
    threshold: numericThreshold,
    action: normalizedAction,
    createdAt: new Date().toISOString(),
  };
  if (container) {
    const { project, container: managedContainer } = await resolveManagedContainer(container);
    rule.projectId = project.id;
    rule.service = managedContainer.name;
    rule.containerId = managedContainer.id;
  } else {
    if (!projectId || !service) {
      throw Object.assign(new Error('需要提供 projectId + service 或 container 之一'), { statusCode: 400 });
    }
    rule.projectId = String(projectId);
    rule.service = String(service);
  }

  const rules = readAlertRules();
  rules.push(rule);
  writeAlertRules(rules);
  return rule;
}

/** 服务名与容器名的匹配(与 alert-monitor 的评估口径一致,支持服务名前缀)。 */
function containerMatchesService(container, service) {
  const name = String(container.name || '').toLowerCase();
  const wanted = String(service || '').toLowerCase();
  return name === wanted || name.startsWith(`${wanted}.`) || name.startsWith(`${wanted}-`) || name.includes(wanted);
}

/**
 * 列出规则:仅纳管项目可见(评估引擎也只评估纳管项目),附项目/容器可读名。
 * @param {{ container?: string }} options container 传入时按该容器过滤。
 */
export async function listAlertRules({ container } = {}) {
  const projects = (await scanProjects()).filter((project) => project.managed);
  const byId = new Map(projects.map((project) => [project.id, project]));
  let rules = readAlertRules()
    .filter((rule) => byId.has(rule.projectId))
    .map((rule) => {
      const project = byId.get(rule.projectId);
      const matched = rule.containerId
        ? project.containers.find((item) => item.id === rule.containerId)
        : project.containers.find((item) => containerMatchesService(item, rule.service));
      return {
        ...rule,
        projectName: project.projectName || rule.projectId,
        containerName: matched?.name || rule.service,
        containerId: matched?.id || rule.containerId,
      };
    });
  if (container) {
    const { container: managedContainer } = await resolveManagedContainer(container);
    rules = rules.filter((rule) => rule.containerId === managedContainer.id);
  }
  return rules;
}

/** 删除规则,返回 { deleted } 与旧 REST 契约一致(0 或 1)。 */
export async function deleteAlertRule(ruleId) {
  const rules = readAlertRules();
  const next = rules.filter((item) => item.id !== ruleId);
  if (next.length === rules.length) return { deleted: 0 };
  writeAlertRules(next);
  return { deleted: rules.length - next.length };
}
