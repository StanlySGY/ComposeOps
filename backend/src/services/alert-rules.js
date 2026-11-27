/**
 * 统一告警规则存储:Agent 工具(alert.create/configure)与 REST(/metrics/alerts)共用。
 *
 * 历史坑:工具曾把规则写进独立的 `alert_rules` 键,而评估引擎(alert-monitor)只读
 * `agent.alert_rules`,导致"创建了规则却永不触发"。这里收敛为单一存储、单一规则形状,
 * 与 alert-monitor 的 evaluateAgentRules 消费格式(projectId + service + metric/action)对齐。
 */
import db from '../lib/db.js';
import { scanProjects } from './scanner.js';
import { resolveManagedContainer } from './agent-metrics.js';
import { getActiveHostId } from './docker-hosts.js';
import { readAlertRules, writeAlertRules, alertMatchesContainer } from './alert-rule-store.js';
import { captureAlertAuthorization, alertActionState } from './resource-alert-actions.js';
import { recordAgentAuditEvent } from './agent/policy-store.js';
export { readAlertRules, writeAlertRules } from './alert-rule-store.js';

export const ALERT_METRICS = new Set(['cpu', 'memory', 'restart_count']);
export const ALERT_ACTIONS = new Set(['notify', 'auto_restart', 'scale']);

function newRuleId() {
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 创建告警规则。定位方式二选一:
 * - projectId + service:Agent 的 alert.create 传入,必须解析真实纳管目标。
 * - container:容器名/ID,REST 与 alert.configure 传入,解析到纳管项目 + 容器。
 * 校验全部发生在任何外部依赖之前,便于纯单测覆盖。
 */
export async function createAlertRule(input = {}, { actor = 'admin' } = {}) {
  const hostId = getActiveHostId();
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
  let project;
  if (container) {
    const resolved = await resolveManagedContainer(container), managedContainer = resolved.container;
    project = resolved.project;
    rule.projectId = project.id;
    rule.service = managedContainer.service || managedContainer.name;
    rule.containerId = managedContainer.id;
  } else {
    if (!projectId || !service) {
      throw Object.assign(new Error('需要提供 projectId + service 或 container 之一'), { statusCode: 400 });
    }
    project = (await scanProjects(hostId)).find(item => item.id === String(projectId));
    if (!project?.managed) throw Object.assign(new Error('项目不存在或尚未纳管'), { statusCode: 403 });
    rule.projectId = project.id;
    rule.service = String(service).trim();
    const matched = project.containers.filter(item => alertMatchesContainer(rule, item));
    if (!matched.length) throw Object.assign(new Error('未找到精确服务名或容器名，请刷新项目后重试'), { statusCode: 404 });
    rule.containerIds = matched.map(item => item.id);
    if (matched.length === 1) rule.containerId = matched[0].id;
  }
  rule.hostId = project.hostId;
  const authorization = await captureAlertAuthorization(rule, project, input);
  const savedRule = { ...rule, ...(authorization ? { authorization: { ...authorization, actor } } : {}) };
  if (getActiveHostId() !== hostId) throw Object.assign(new Error('创建期间节点已切换，请刷新目标后重试'), { statusCode: 409 });
  db.transaction(() => {
    const rules = readAlertRules();
    if (rules.length >= 200) throw Object.assign(new Error('告警规则已达 200 条上限，请先整理旧规则'), { statusCode: 409 });
    rules.push(savedRule); writeAlertRules(rules);
    if (authorization) recordAgentAuditEvent({ executionId: rule.id, eventType: 'resource_alert_authorized', actor, toolName: 'alert.configure', decision: 'allow_bounded',
      details: { ruleId: rule.id, projectId: rule.projectId, action: rule.action, target: rule.target, authorization: savedRule.authorization } });
  })();
  return { ...savedRule, actionState: alertActionState(savedRule) };
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
      const matched = project.containers.find(item => alertMatchesContainer(rule, item));
      const actionState = alertActionState(rule);
      if (!matched && actionState.status === 'ready') Object.assign(actionState, { status: 'paused', message: '固定容器已消失；请为新容器重新配置规则' });
      return {
        ...rule,
        actionState,
        projectName: project.projectName || rule.projectId,
        containerName: matched?.name || rule.service,
        containerId: matched?.id || rule.containerId,
      };
    });
  if (container) {
    const { container: managedContainer } = await resolveManagedContainer(container);
    rules = rules.filter((rule) => alertMatchesContainer(rule, managedContainer));
  }
  return rules;
}

/** 删除规则,返回 { deleted } 与旧 REST 契约一致(0 或 1)。 */
export async function deleteAlertRule(ruleId) {
  return db.transaction(() => {
    const rules = readAlertRules(), rule = rules.find(item => item.id === ruleId);
    if (rule?.target && alertActionState(rule).status === 'unknown') throw Object.assign(new Error('该项目有结果待核对的自动操作，请先人工核对后再删除规则'), { statusCode: 409 });
    const next = rules.filter(item => item.id !== ruleId);
    if (next.length === rules.length) return { deleted: 0 };
    writeAlertRules(next);
    return { deleted: rules.length - next.length };
  })();
}
