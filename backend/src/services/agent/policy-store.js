import { randomUUID, createHash } from 'node:crypto';
import db from '../../lib/db.js';
import { isSensitiveKey } from '../../lib/redaction.js';
import { redactSecretValue } from '../../lib/secret-redactor.js';

const EFFECTS = new Set(['deny', 'allow']);
const id = (prefix) => `${prefix}-${randomUUID()}`;
const text = (value, max) => String(redactSecretValue(String(value ?? '').trim())).slice(0, max);
const bool = (value) => value === false || value === 0 ? 0 : 1;

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function fingerprintAgentParams(params = {}) {
  const safe = redactSecretValue(stable(params && typeof params === 'object' && !Array.isArray(params) ? params : {}));
  return createHash('sha256').update(JSON.stringify(safe)).digest('hex');
}

function mapGroup(row) {
  return { id: row.id, name: row.name, description: row.description, enabled: Number(row.enabled) === 1,
    createdAt: row.created_at, updatedAt: row.updated_at, ruleCount: Number(row.rule_count || 0) };
}

function mapRule(row) {
  return { id: row.id, groupId: row.group_id, groupName: row.group_name, name: row.name,
    effect: row.effect, priority: Number(row.priority), enabled: Number(row.enabled) === 1,
    toolName: row.tool_name, projectId: row.project_id, parameters: parseJson(row.parameters_json, {}),
    reason: row.reason, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function listAgentPolicyGroups() {
  return db.prepare(`
    SELECT g.*, COUNT(r.id) AS rule_count
    FROM agent_policy_groups g LEFT JOIN agent_policy_rules r ON r.group_id = g.id
    GROUP BY g.id ORDER BY g.created_at ASC, g.id ASC
  `).all().map(mapGroup);
}

export function createAgentPolicyGroup(input = {}) {
  const name = text(input.name, 80);
  if (!name) throw Object.assign(new Error('策略组名称不能为空'), { statusCode: 400 });
  const groupId = id('policy-group');
  try {
    db.prepare('INSERT INTO agent_policy_groups(id, name, description, enabled) VALUES(?, ?, ?, ?)')
      .run(groupId, name, text(input.description, 500), bool(input.enabled));
  } catch (error) {
    if (/UNIQUE constraint failed: agent_policy_groups.name/.test(error.message)) {
      throw Object.assign(new Error('策略组名称已存在'), { statusCode: 409 });
    }
    throw error;
  }
  return listAgentPolicyGroups().find((group) => group.id === groupId);
}

export function updateAgentPolicyGroup(groupId, patch = {}) {
  const current = db.prepare('SELECT * FROM agent_policy_groups WHERE id = ?').get(String(groupId));
  if (!current) return null;
  const name = patch.name === undefined ? current.name : text(patch.name, 80);
  if (!name) throw Object.assign(new Error('策略组名称不能为空'), { statusCode: 400 });
  const description = patch.description === undefined ? current.description : text(patch.description, 500);
  const enabled = patch.enabled === undefined ? current.enabled : bool(patch.enabled);
  try {
    db.prepare("UPDATE agent_policy_groups SET name = ?, description = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name, description, enabled, String(groupId));
  } catch (error) {
    if (/UNIQUE constraint failed: agent_policy_groups.name/.test(error.message)) {
      throw Object.assign(new Error('策略组名称已存在'), { statusCode: 409 });
    }
    throw error;
  }
  return listAgentPolicyGroups().find((group) => group.id === String(groupId));
}

export function deleteAgentPolicyGroup(groupId) {
  return db.prepare('DELETE FROM agent_policy_groups WHERE id = ?').run(String(groupId)).changes > 0;
}

function normalizeParameters(parameters = {}) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw Object.assign(new Error('参数匹配必须是 JSON 对象'), { statusCode: 400 });
  }
  const entries = Object.entries(parameters);
  if (entries.length > 20) throw Object.assign(new Error('参数匹配最多 20 个字段'), { statusCode: 400 });
  const normalized = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) {
      throw Object.assign(new Error(`不合法的参数名: ${key}`), { statusCode: 400 });
    }
    if (isSensitiveKey(key)) throw Object.assign(new Error(`参数匹配不能保存敏感字段: ${key}`), { statusCode: 400 });
    if (!(value === null || ['string', 'number', 'boolean'].includes(typeof value))) {
      throw Object.assign(new Error(`参数 ${key} 只能匹配字符串、数字、布尔值或 null`), { statusCode: 400 });
    }
    if (typeof value === 'string' && value.length > 200) {
      throw Object.assign(new Error(`参数 ${key} 匹配值不能超过 200 个字符`), { statusCode: 400 });
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw Object.assign(new Error(`参数 ${key} 必须是有限数字`), { statusCode: 400 });
    }
    if (typeof value === 'string' && redactSecretValue(value) !== value) {
      throw Object.assign(new Error(`参数 ${key} 的值看起来包含凭据，已拒绝保存`), { statusCode: 400 });
    }
    normalized[key] = value;
  }
  return stable(normalized);
}

function validateRule(input, current = {}) {
  const value = { ...current, ...input };
  const name = text(value.name, 100);
  if (!name) throw Object.assign(new Error('规则名称不能为空'), { statusCode: 400 });
  const effect = String(value.effect || '');
  if (!EFFECTS.has(effect)) throw Object.assign(new Error('规则效果必须是 deny 或 allow'), { statusCode: 400 });
  const toolName = String(value.toolName || '*').trim();
  if (!(toolName === '*' || /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(toolName))) {
    throw Object.assign(new Error('工具范围须为 * 或一个完整工具名，不支持模糊匹配'), { statusCode: 400 });
  }
  const projectId = text(value.projectId || '*', 200) || '*';
  if (projectId !== '*' && /[\r\n\0]/.test(projectId)) {
    throw Object.assign(new Error('项目范围不合法'), { statusCode: 400 });
  }
  const priority = Number(value.priority ?? 100);
  if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) {
    throw Object.assign(new Error('优先级必须是 -1000 到 1000 的整数'), { statusCode: 400 });
  }
  return { name, effect, priority, enabled: bool(value.enabled), toolName, projectId,
    parameters: normalizeParameters(value.parameters ?? {}), reason: text(value.reason, 500) };
}

const RULE_SELECT = 'SELECT r.*, g.name AS group_name FROM agent_policy_rules r JOIN agent_policy_groups g ON g.id = r.group_id';
export function listAgentPolicyRules({ groupId, limit = 300 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 300, 500));
  if (groupId) return db.prepare(`${RULE_SELECT} WHERE r.group_id = ? ORDER BY r.priority ASC, r.created_at ASC LIMIT ?`)
    .all(String(groupId), safeLimit).map(mapRule);
  return db.prepare(`${RULE_SELECT} ORDER BY CASE r.effect WHEN 'deny' THEN 0 ELSE 1 END, r.priority ASC, r.created_at ASC LIMIT ?`)
    .all(safeLimit).map(mapRule);
}

export function createAgentPolicyRule(input = {}) {
  const groupId = String(input.groupId || '');
  if (!db.prepare('SELECT 1 FROM agent_policy_groups WHERE id = ?').get(groupId)) {
    throw Object.assign(new Error('策略组不存在'), { statusCode: 404 });
  }
  const rule = validateRule(input);
  const ruleId = id('policy-rule');
  db.prepare(`
    INSERT INTO agent_policy_rules(id, group_id, name, effect, priority, enabled, tool_name, project_id, parameters_json, reason)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ruleId, groupId, rule.name, rule.effect, rule.priority, rule.enabled, rule.toolName, rule.projectId, JSON.stringify(rule.parameters), rule.reason);
  return listAgentPolicyRules({ limit: 500 }).find((item) => item.id === ruleId);
}

export function updateAgentPolicyRule(ruleId, input = {}) {
  const row = db.prepare('SELECT * FROM agent_policy_rules WHERE id = ?').get(String(ruleId));
  if (!row) return null;
  const current = { groupId: row.group_id, name: row.name, effect: row.effect, priority: row.priority,
    enabled: row.enabled, toolName: row.tool_name, projectId: row.project_id,
    parameters: parseJson(row.parameters_json, {}), reason: row.reason };
  const rule = validateRule(input, current);
  const groupId = String(input.groupId ?? current.groupId);
  if (!db.prepare('SELECT 1 FROM agent_policy_groups WHERE id = ?').get(groupId)) {
    throw Object.assign(new Error('策略组不存在'), { statusCode: 404 });
  }
  db.prepare(`
    UPDATE agent_policy_rules SET group_id = ?, name = ?, effect = ?, priority = ?, enabled = ?, tool_name = ?,
      project_id = ?, parameters_json = ?, reason = ?, updated_at = datetime('now') WHERE id = ?
  `).run(groupId, rule.name, rule.effect, rule.priority, rule.enabled, rule.toolName, rule.projectId, JSON.stringify(rule.parameters), rule.reason, String(ruleId));
  return listAgentPolicyRules({ limit: 500 }).find((item) => item.id === String(ruleId));
}

export function deleteAgentPolicyRule(ruleId) {
  return db.prepare('DELETE FROM agent_policy_rules WHERE id = ?').run(String(ruleId)).changes > 0;
}

function ruleMatches(rule, { toolName, params, projectId }) {
  if (!rule.enabled) return false;
  if (rule.tool_name !== '*' && rule.tool_name !== toolName) return false;
  if (rule.project_id !== '*' && rule.project_id !== String(projectId || '')) return false;
  const constraints = parseJson(rule.parameters_json, {});
  return Object.entries(constraints).every(([key, value]) =>
    Object.hasOwn(params || {}, key) && JSON.stringify(stable(params[key])) === JSON.stringify(value));
}

/** 拒绝规则永远先于允许规则；匹配使用精确工具名/项目 ID/参数子集，不执行正则或命令解释。 */
export function evaluateAgentPolicy({ toolName, params = {}, projectId = '' } = {}) {
  const rows = db.prepare(`
    SELECT r.*, g.name AS group_name, g.enabled AS group_enabled
    FROM agent_policy_rules r JOIN agent_policy_groups g ON g.id = r.group_id
    WHERE r.enabled = 1 AND g.enabled = 1
    ORDER BY CASE r.effect WHEN 'deny' THEN 0 ELSE 1 END, r.priority ASC, r.created_at ASC, r.id ASC
  `).all();
  for (const row of rows) {
    if (!ruleMatches(row, { toolName: String(toolName || ''), params, projectId })) continue;
    return { decision: row.effect === 'deny' ? 'deny' : 'allow', ruleId: row.id,
      ruleName: row.name, groupId: row.group_id, groupName: row.group_name,
      reason: row.reason || (row.effect === 'deny' ? '命中拒绝规则，拒绝优先且不可由本次确认覆盖' : '命中显式允许规则') };
  }
  return { decision: 'no_match', ruleId: null, ruleName: '', groupId: null, groupName: '',
    reason: '没有命中持久化策略，沿用现有审批门默认行为' };
}

export function recordAgentAuditEvent({
  planId = null, executionId = null, eventType, actor = 'agent', toolName = '',
  decision = '', ruleId = null, ruleName = '', reason = '', parametersHash = null, details = {},
} = {}) {
  if (!eventType) throw new Error('审计事件类型不能为空');
  const safeDetails = redactSecretValue(details && typeof details === 'object' ? details : {});
  const serialized = JSON.stringify(safeDetails);
  const detailsJson = serialized.length > 12000 ? JSON.stringify({ truncated: true, preview: serialized.slice(0, 8000) }) : serialized;
  const eventId = id('audit');
  db.prepare(`
    INSERT INTO agent_audit_events(id, plan_id, execution_id, event_type, actor, tool_name, decision,
      rule_id, rule_name, reason, parameters_hash, details_json)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(eventId, planId || null, executionId || null, text(eventType, 80), text(actor || 'agent', 80),
    text(toolName, 128), text(decision, 80), ruleId || null, text(ruleName, 120),
    text(reason, 1000), parametersHash || null, detailsJson);
  return eventId;
}

export function listAgentAuditEvents({ planId, executionId, limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  let rows;
  if (executionId) rows = db.prepare('SELECT * FROM agent_audit_events WHERE execution_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?').all(String(executionId), safeLimit);
  else if (planId) rows = db.prepare('SELECT * FROM agent_audit_events WHERE plan_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?').all(String(planId), safeLimit);
  else rows = db.prepare('SELECT * FROM agent_audit_events ORDER BY created_at DESC, rowid DESC LIMIT ?').all(safeLimit);
  return rows.map((row) => ({ id: row.id, planId: row.plan_id, executionId: row.execution_id,
    eventType: row.event_type, actor: row.actor, toolName: row.tool_name, decision: row.decision,
    ruleId: row.rule_id, ruleName: row.rule_name, reason: row.reason,
    parametersHash: row.parameters_hash, details: parseJson(row.details_json, {}), createdAt: row.created_at }));
}
