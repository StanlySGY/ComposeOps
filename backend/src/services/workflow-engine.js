import {
  createWorkflowDefinition,
  getWorkflowDefinition,
  listWorkflowDefinitions,
  updateWorkflowDefinition,
  deleteWorkflowDefinition,
  createWorkflowInstance,
  getWorkflowInstance,
  listWorkflowInstances,
  updateWorkflowInstance,
  updateWorkflowInstanceIfStatus,
  addWorkflowStep,
  updateWorkflowStep,
} from '../lib/db.js';
import { addEventRecord } from '../lib/db.js';
import { emitEvent } from './events.js';
import { getAgent } from './agent.js';
import { findProject } from './scanner.js';
import { prepareProjectAction } from './project-action-runner.js';

/**
 * 轻量工作流引擎:
 * - 定义(workflow_definitions)由节点编排组成,节点类型:trigger / condition / agent / approval / action / verify;
 * - 实例(workflow_instances)记录一次运行,步骤(workflow_steps)记录每个节点的执行结果;
 * - 支持手动触发与事件触发;approval 节点进入 waiting_approval 等待人工审批。
 *
 * 设计目标:Agent 成为工作流中的一个节点(agent 节点),而非工作流本身,实现 Agent 与编排解耦。
 */

const NODE_TYPES = new Set(['trigger', 'condition', 'agent', 'approval', 'action', 'verify']);

function validateNodes(nodes) {
  if (!Array.isArray(nodes)) throw Object.assign(new Error('节点编排必须是数组'), { statusCode: 400 });
  const ids = new Set();
  for (const node of nodes) {
    if (!node || typeof node !== 'object') throw Object.assign(new Error('节点格式无效'), { statusCode: 400 });
    if (!node.id) throw Object.assign(new Error('节点缺少 id'), { statusCode: 400 });
    if (ids.has(String(node.id))) throw Object.assign(new Error(`节点 ID 重复:${node.id}`), { statusCode: 400 });
    ids.add(String(node.id));
    if (!NODE_TYPES.has(node.type)) throw Object.assign(new Error(`未知节点类型:${node.type}`), { statusCode: 400 });
    const config = node.config && typeof node.config === 'object' ? node.config : {};
    if (node.type === 'condition' && !String(config.expression || '').trim()) {
      throw Object.assign(new Error(`条件节点 ${node.id} 缺少 expression`), { statusCode: 400 });
    }
    if (node.type === 'action' && !String(config.action || '').trim()) {
      throw Object.assign(new Error(`执行节点 ${node.id} 缺少 action`), { statusCode: 400 });
    }
    for (const edge of [node.next, node.onTrue, node.onFalse]) {
      if (edge !== undefined && edge !== null && typeof edge !== 'string') {
        throw Object.assign(new Error(`节点 ${node.id} 的跳转目标无效`), { statusCode: 400 });
      }
    }
  }
  for (const node of nodes) {
    for (const edge of [node.next, node.onTrue, node.onFalse]) {
      if (edge && !ids.has(edge)) throw Object.assign(new Error(`节点 ${node.id} 跳转目标不存在:${edge}`), { statusCode: 400 });
    }
  }
  return nodes;
}

export function createDefinition({ name, description = '', triggerType = 'manual', triggerConfig = {}, nodes = [], enabled = 1 }) {
  if (!name || !String(name).trim()) throw Object.assign(new Error('工作流名称不能为空'), { statusCode: 400 });
  validateNodes(nodes);
  return createWorkflowDefinition({ name: String(name).trim(), description, triggerType, triggerConfig, nodes, enabled });
}

export function updateDefinition(id, patch = {}) {
  if (patch.nodes !== undefined) validateNodes(patch.nodes);
  return updateWorkflowDefinition(id, patch);
}

export function listDefinitions() {
  return listWorkflowDefinitions();
}

export function getDefinition(id) {
  return getWorkflowDefinition(id);
}

export function removeDefinition(id) {
  return deleteWorkflowDefinition(id);
}

/** 启动一次工作流实例。event 触发时由事件中心调用。 */
export function startWorkflow(definitionId, context = {}) {
  const definition = getWorkflowDefinition(definitionId);
  if (!definition) throw Object.assign(new Error('工作流不存在'), { statusCode: 404 });
  if (!definition.enabled) throw Object.assign(new Error('工作流已停用'), { statusCode: 400 });

  const instance = createWorkflowInstance({
    definitionId,
    name: definition.name,
    status: 'running',
    context,
  });
  const startedAt = new Date().toISOString();
  updateWorkflowInstance(instance.id, { status: 'running', startedAt });

  // 异步执行,不阻塞调用方
  void runWorkflow(instance.id);
  return getWorkflowInstance(instance.id);
}

/** 执行工作流实例的节点编排。 */
async function runWorkflow(instanceId) {
  const instance = getWorkflowInstance(instanceId);
  if (!instance) return;
  const definition = getWorkflowDefinition(instance.definitionId);
  if (!definition) return;

  const nodes = definition.nodes || [];
  const explicitGraph = nodes.some((node) => node.next || node.onTrue || node.onFalse);
  let context = { ...(instance.context || {}) };
  const completedNodeIds = new Set(
    (instance.steps || []).filter((step) => step.status === 'success').map((step) => step.nodeId)
  );
  let currentStepId = null;

  try {
    let nodeIndex = 0;
    const visited = new Set();
    while (nodeIndex < nodes.length) {
      const node = explicitGraph ? nodes[nodeIndex] : nodes[nodeIndex];
      if (visited.has(node.id)) throw new Error(`工作流节点存在循环:${node.id}`);
      visited.add(node.id);
      // 审批通过后恢复执行时,跳过已完成节点。
      if (completedNodeIds.has(node.id)) {
        const nextId = explicitGraph ? resolveNextNode(node, context) : null;
        if (explicitGraph && nextId) {
          const nextIndex = nodes.findIndex((candidate) => candidate.id === nextId);
          if (nextIndex < 0) throw new Error(`工作流跳转目标不存在:${nextId}`);
          nodeIndex = nextIndex;
        } else {
          nodeIndex += 1;
        }
        continue;
      }
      const current = getWorkflowInstance(instanceId);
      if (!current || !['running', 'pending'].includes(current.status)) return;

      const stepId = addWorkflowStep({
        instanceId,
        nodeId: node.id,
        nodeType: node.type,
        status: 'running',
        input: { ...(node.config || {}), context },
      });
      currentStepId = stepId;
      updateWorkflowInstance(instanceId, { currentNode: node.id });
      const startedAt = new Date().toISOString();
      updateWorkflowStep(stepId, { startedAt });

      // approval 节点:暂停等待人工审批,不继续执行后续节点。
      if (node.type === 'approval') {
        updateWorkflowStep(stepId, { status: 'waiting_approval' });
        updateWorkflowInstance(instanceId, { status: 'waiting_approval' });
        emitEvent({ type: 'workflow', eventType: 'workflow', title: `工作流等待审批:${definition.name}`, detail: node.id, severity: 'warning' });
        return;
      }

      const result = await executeNode(node, context);
      const afterNode = getWorkflowInstance(instanceId);
      if (!afterNode || afterNode.status === 'cancelled') {
        if (afterNode?.status === 'cancelled') {
          updateWorkflowStep(stepId, { status: 'cancelled', error: '工作流已取消', finishedAt: new Date().toISOString() });
          currentStepId = null;
        }
        return;
      }
      context = { ...context, ...(result.context || {}) };
      updateWorkflowInstance(instanceId, { context });
      updateWorkflowStep(stepId, { status: 'success', output: result.output || {}, finishedAt: new Date().toISOString() });
      // 只有正在执行的节点才允许在 catch 中被标记为 failed。清空它可避免
      // 后续发现图循环时把已经成功落库的前一个节点改写成失败。
      currentStepId = null;
      emitEvent({ type: 'workflow', eventType: 'workflow', title: `工作流节点完成:${node.id}`, detail: node.type, severity: 'info' });
      const nextId = explicitGraph ? resolveNextNode(node, context) : null;
      if (explicitGraph && nextId) {
        const nextIndex = nodes.findIndex((candidate) => candidate.id === nextId);
        if (nextIndex < 0) throw new Error(`工作流跳转目标不存在:${nextId}`);
        nodeIndex = nextIndex;
      } else {
        nodeIndex += 1;
      }
    }
    const completed = updateWorkflowInstanceIfStatus(instanceId, ['running', 'pending'], { status: 'success', result: { summary: '工作流执行完成' }, finishedAt: new Date().toISOString() });
    if (!completed) return;
    addEventRecord({
      eventType: 'workflow',
      source: 'workflow',
      title: `工作流完成:${definition.name}`,
      detail: `实例 ${instanceId} 执行成功`,
      severity: 'info',
      status: 'resolved',
      payload: { instanceId, definitionId: definition.id },
    });
  } catch (error) {
    const current = getWorkflowInstance(instanceId);
    if (current?.status === 'cancelled') {
      if (currentStepId) updateWorkflowStep(currentStepId, { status: 'cancelled', error: '工作流已取消', finishedAt: new Date().toISOString() });
      return;
    }
    // 标记当前执行中的步骤为失败,避免停留在 running。
    if (currentStepId) {
      updateWorkflowStep(currentStepId, { status: 'failed', error: error.message, finishedAt: new Date().toISOString() });
    }
    const failed = updateWorkflowInstanceIfStatus(instanceId, ['running', 'pending'], { status: 'failed', result: { error: error.message }, finishedAt: new Date().toISOString() });
    if (!failed) return;
    addEventRecord({
      eventType: 'workflow',
      source: 'workflow',
      title: `工作流失败:${definition.name}`,
      detail: error.message,
      severity: 'danger',
      status: 'open',
      payload: { instanceId, definitionId: definition.id },
    });
    emitEvent({ type: 'workflow', eventType: 'workflow', title: `工作流失败:${definition.name}`, detail: error.message, severity: 'danger' });
  }
}

/** 执行单个节点。 */
async function executeNode(node, context) {
  switch (node.type) {
    case 'trigger':
      return { output: { triggered: true } };
    case 'condition': {
      const expr = node.config?.expression || '';
      const matched = evaluateCondition(expr, context);
      return {
        output: { matched },
        context: {
          conditionMatched: matched,
          conditionResults: { ...(context.conditionResults || {}), [node.id]: matched },
        },
      };
    }
    case 'agent': {
      // Agent 节点:真正调用 Agent 引擎做只读分析。
      // 使用 validator 角色(仅只读工具),避免在无 SSE 连接的工作流里阻塞等待确认。
      const prompt = node.config?.prompt || '请分析当前运维上下文并给出诊断结论与建议。';
      const projectId = node.config?.projectId || context.projectId || null;
      const agent = getAgent();
      const events = [];
      const result = await agent.executeWithLoop(
        prompt,
        {
          projectId,
          role: 'validator',
          webSearchEnabled: false,
          history: [],
        },
        (event) => events.push(event),
        null
      );
      if (!result.success) {
        throw Object.assign(new Error(result.finalContent || 'Agent 分析未完成'), { statusCode: 500 });
      }
      return {
        output: {
          agentResult: result.finalContent || '',
          success: true,
          events: events.filter((e) => ['trace', 'tool_result', 'done', 'error'].includes(e.type)).slice(-20),
        },
        context: { agentResult: result.finalContent || '' },
      };
    }
    case 'action': {
      // Action 节点:真正执行 Compose 项目操作(up/stop/restart/pull)。
      const action = node.config?.action || '';
      const projectId = node.config?.projectId || context.projectId || null;
      if (!projectId) throw Object.assign(new Error('action 节点缺少 projectId'), { statusCode: 400 });
      const project = await findProject(projectId);
      if (!project) throw Object.assign(new Error(`项目不存在:${projectId}`), { statusCode: 404 });
      const prepared = await prepareProjectAction(project, action);
      const outputLines = [];
      const exitCode = await prepared.run((stream, chunk) => outputLines.push(chunk));
      if (exitCode !== 0) {
        throw Object.assign(new Error(`操作 ${action} 失败(exit ${exitCode})`), { statusCode: 500 });
      }
      return {
        output: { action, projectId, exitCode, output: outputLines.map((chunk) => Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)).join('').slice(-4000) },
        context: { lastAction: action, lastProjectId: projectId },
      };
    }
    case 'verify': {
      // Verify 节点:只读验证项目状态(ps)。
      const projectId = node.config?.projectId || context.projectId || null;
      if (!projectId) return { output: { verified: true } };
      const project = await findProject(projectId);
      if (!project) return { output: { verified: false, reason: '项目不存在' } };
      const prepared = await prepareProjectAction(project, 'ps');
      const outputLines = [];
      const exitCode = await prepared.run((stream, chunk) => outputLines.push(chunk));
      return {
        output: { verified: exitCode === 0, exitCode, output: outputLines.map((chunk) => Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)).join('').slice(-2000) },
        context: { verified: exitCode === 0 },
      };
    }
    default:
      return { output: {} };
  }
}

function resolveNextNode(node, context) {
  if (node.type === 'condition') {
    const matched = Object.prototype.hasOwnProperty.call(context.conditionResults || {}, node.id)
      ? context.conditionResults[node.id]
      : context.conditionMatched === true;
    return (matched ? node.onTrue : node.onFalse) || node.next || null;
  }
  return node.next || null;
}

/** 简单条件求值:支持 `context.field == value` / `!=` / `>` / `<`。 */
export function evaluateCondition(expr, context = {}) {
  const match = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(String(expr || '').trim());
  if (!match) return false;
  const [, field, op, rawValue] = match;
  const path = field.startsWith('context.') ? field.slice('context.'.length) : field;
  const actual = path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), context);
  const expected = parseConditionLiteral(rawValue);
  switch (op) {
    case '==': return actual === expected || String(actual) === String(expected);
    case '!=': return !(actual === expected || String(actual) === String(expected));
    case '>': return Number(actual) > Number(expected);
    case '<': return Number(actual) < Number(expected);
    case '>=': return Number(actual) >= Number(expected);
    case '<=': return Number(actual) <= Number(expected);
    default: return false;
  }
}

function parseConditionLiteral(rawValue) {
  const value = String(rawValue || '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  return value;
}

export function listInstances({ status = '', limit = 50 } = {}) {
  return listWorkflowInstances({ status, limit });
}

export function getInstance(id) {
  return getWorkflowInstance(id);
}

/** 人工审批:推进等待审批的实例。 */
export function approveInstance(instanceId, { approved = true, note = '' } = {}) {
  const instance = getWorkflowInstance(instanceId);
  if (!instance) throw Object.assign(new Error('工作流实例不存在'), { statusCode: 404 });
  if (instance.status !== 'waiting_approval') throw Object.assign(new Error('该实例不在等待审批状态'), { statusCode: 400 });

  if (!approved) {
    return updateWorkflowInstanceIfStatus(instanceId, ['waiting_approval'], { status: 'cancelled', finishedAt: new Date().toISOString() })
      || getWorkflowInstance(instanceId);
  }

  // 找到等待审批的步骤,标记为通过,然后继续执行后续节点。
  const pendingStep = instance.steps.find((step) => step.status === 'waiting_approval');
  if (pendingStep) {
    updateWorkflowStep(pendingStep.id, { status: 'success', output: { approved: true, note }, finishedAt: new Date().toISOString() });
  }
  const resumed = updateWorkflowInstanceIfStatus(instanceId, ['waiting_approval'], { status: 'running' });
  if (!resumed) return getWorkflowInstance(instanceId);
  void runWorkflow(instanceId);
  return resumed;
}

export function cancelInstance(instanceId) {
  const instance = getWorkflowInstance(instanceId);
  if (!instance) throw Object.assign(new Error('工作流实例不存在'), { statusCode: 404 });
  const cancelled = updateWorkflowInstanceIfStatus(instanceId, ['pending', 'running', 'waiting_approval'], { status: 'cancelled', finishedAt: new Date().toISOString() });
  if (!cancelled) throw Object.assign(new Error('该实例已经结束，无法取消'), { statusCode: 409 });
  return cancelled;
}
