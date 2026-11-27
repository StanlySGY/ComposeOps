import { createHash, randomUUID } from 'node:crypto';
import db, { getSetting, setSetting, getProjectPreference, getProjectMountEnabled, addOperation } from '../lib/db.js';
import { redactSecretValue } from '../lib/secret-redactor.js';
import { getDockerForHost } from './docker-hosts.js';
import { scanProjects, invalidateScanCache } from './scanner.js';
import { captureScheduledEngineHost, assertScheduledEngineHost, assertScheduledHost } from './scheduled-host-scope.js';
import { withProjectOperationLock, assertProjectOperationAllowed } from './project-operation-lock.js';
import { captureDeploymentInputs } from './reviewed-deployment.js';
import { spawnComposeCommand } from './compose-runner.js';
import { runWorkspaceComposeArgs } from './compose-workspace.js';
import { evaluateAgentPolicy, recordAgentAuditEvent } from './agent/policy-store.js';
import { readAlertRules, alertMatchesContainer } from './alert-rule-store.js';
import { parseContainerStat } from './stats.js';

export const RESOURCE_ALERT_LIMITS = Object.freeze({ durationMs: 7 * 86400000, cooldownMs: 600000, maxDaily: 3, maxReplicas: 5 });
const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ruleHash = rule => hash([rule.id, rule.projectId, rule.hostId, rule.service, rule.containerId, rule.containerIds, rule.metric, rule.threshold, rule.action, rule.createdAt, rule.target, rule.authorization]);
const automatic = rule => ['auto_restart', 'restart', 'scale'].includes(rule?.action);
const defaults = { scan: scanProjects, capture: captureDeploymentInputs, docker: getDockerForHost,
  captureHost: captureScheduledEngineHost, verifyHost: assertScheduledEngineHost, scale: runScale };

/** Read and effect requests have deadlines even if an underlying transport ignores abort. */
export async function boundedAlertCall(fn, timeoutMs = 8000) {
  const controller = new AbortController(); let timer;
  try {
    return await Promise.race([Promise.resolve().then(() => fn(controller.signal)), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('告警操作超时；已发出的动作结果可能未知')); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function assertPermission(rule, containerId = rule.containerId) {
  const preference = getProjectPreference(rule.projectId);
  if (!preference.managed) fail('项目已取消纳管，自动处置已暂停', 403);
  if (['stopped', 'maintenance'].includes(preference.operationalIntent)) fail('项目处于计划停机或维护状态，自动处置已暂停');
  assertProjectOperationAllowed(rule.projectId);
  if (rule.action === 'scale' && !getProjectMountEnabled(rule.projectId)) fail('Compose 目录能力已撤销，自动扩容已暂停', 403);
  const params = { projectId: rule.projectId, hostId: rule.target?.hostId, service: rule.service, serviceName: rule.service,
    containerId, container: containerId, action: rule.action };
  const tools = rule.action === 'scale' ? ['alert.configure', 'alert.create', 'compose.scale', 'compose.up'] : ['alert.configure', 'alert.create', 'container.restart', 'compose.restart'];
  for (const toolName of tools) {
    const policy = evaluateAgentPolicy({ toolName, projectId: rule.projectId, params });
    if (policy.decision === 'deny') fail('自动处置被拒绝策略阻止：' + policy.reason, 403);
  }
}

export function validateScaleDefinition(snapshot, service) {
  const definition = snapshot.effective?.services?.[service];
  if (!definition) fail('Compose 中不存在精确服务名，不能自动扩容');
  if (!/@sha256:[a-f0-9]{64}$/.test(definition.image || '') && !/^sha256:[a-f0-9]{64}$/.test(definition.image || '')) fail('自动扩容需要固定镜像摘要，请先将该服务 image 固定为 digest');
  if (definition.container_name || definition.volumes?.length || definition.volumes_from?.length || definition.configs?.length || definition.secrets?.length ||
      definition.devices?.length || definition.device_cgroup_rules?.length || definition.cap_add?.length || definition.privileged || definition.network_mode ||
      definition.pid || (definition.ipc && definition.ipc !== 'private') || (definition.deploy?.mode && definition.deploy.mode !== 'replicated') || definition.ports?.some(port => port.published)) {
    fail('自动扩容仅支持无挂载、无固定宿主端口且无特权/特殊网络的服务，请手动核对该服务');
  }
  return definition;
}

export async function captureAlertAuthorization(rule, project, input = {}, options = {}) {
  if (!automatic(rule)) return null;
  if (input.confirmAutomatic !== true) fail('请明确确认自动处置的期限、冷却与次数限制', 400);
  const deps = { ...defaults, ...options };
  rule.target = { hostId: project.hostId };
  assertPermission(rule);
  const target = await deps.captureHost(project.hostId, input.connectionRevision);
  const selected = project.containers.filter(item => alertMatchesContainer(rule, item));
  if (!selected.length || selected.some(item => item.state !== 'running')) fail('自动处置只能授权当前运行中的精确容器');
  if (selected.length > 20) fail('单条自动规则最多绑定 20 个容器');
  const now = Date.now();
  const authorization = { version: 1, approvedAt: now, expiresAt: now + RESOURCE_ALERT_LIMITS.durationMs,
    ...RESOURCE_ALERT_LIMITS, containerIds: selected.map(item => item.id) };
  if (rule.action === 'scale') {
    if (!project.editable || !selected[0].service || selected.some(item => item.service !== selected[0].service)) fail('自动扩容需要明确的 Compose 服务与目录能力');
    rule.service = selected[0].service;
    const snapshot = await deps.capture(project);
    validateScaleDefinition(snapshot, rule.service);
    authorization.configuration = snapshot.fingerprint;
  }
  rule.target = target;
  assertPermission(rule);
  await deps.verifyHost(target);
  return authorization;
}

const ledgerKey = rule => 'agent.resource_actions.' + hash([rule.target?.hostId, rule.target?.engineId, rule.projectId]);
function readLedger(rule) {
  let ledger;
  try { ledger = JSON.parse(getSetting(ledgerKey(rule), '[]')); } catch { fail('自动处置记录损坏，已停止执行'); }
  if (!Array.isArray(ledger) || ledger.some(item => !item.id || !Number.isFinite(item.at))) fail('自动处置记录无效，已停止执行');
  return ledger;
}
function budget(rule, now) {
  const ledger = readLedger(rule);
  const unresolved = ledger.find(item => ['started', 'unknown'].includes(item.status));
  if (unresolved) return { status: 'unknown', message: '该项目有执行中或结果未知的自动操作，需人工核对后解除暂停', executionId: unresolved.id, ruleId: unresolved.ruleId };
  const recent = ledger.filter(item => item.at > now - 86400000 && item.status !== 'cancelled');
  if (recent.length >= RESOURCE_ALERT_LIMITS.maxDaily) return { status: 'exhausted', message: '该项目已用完最近 24 小时的 3 次自动处置预算', remainingDaily: 0 };
  const latest = recent.at(-1);
  if (latest && now - latest.at < RESOURCE_ALERT_LIMITS.cooldownMs) return { status: 'cooldown', message: '该项目自动处置处于 10 分钟冷却期', nextAt: latest.at + RESOURCE_ALERT_LIMITS.cooldownMs, remainingDaily: 3 - recent.length };
  return { status: 'ready', message: '自动授权有效；仅容器层验收，不代表业务恢复', remainingDaily: 3 - recent.length };
}

export function alertActionState(rule, now = Date.now()) {
  if (!automatic(rule)) return { status: 'notify', message: '仅记录告警并通知' };
  if (rule.authorization?.version !== 1 || !rule.target?.engineId) return { status: 'authorization_required', message: '旧自动规则仅通知；请删除并重新确认授权' };
  try {
    const currentBudget = budget(rule, now);
    if (currentBudget.status === 'unknown') return currentBudget;
    if (!Number.isFinite(rule.authorization.expiresAt) || now >= rule.authorization.expiresAt) return { status: 'expired', message: '7 天自动授权已到期；规则继续通知' };
    assertScheduledHost(rule.target); assertPermission(rule);
    return { ...currentBudget, expiresAt: rule.authorization.expiresAt };
  } catch (error) { return { status: 'paused', message: String(redactSecretValue(error.message)) }; }
}

function requireCurrent(expected, containerId, isCurrent = () => true) {
  if (!isCurrent()) fail('告警监测已停止或重载，取消尚未发出的自动动作');
  const rule = readAlertRules().find(item => item.id === expected.id);
  if (!rule || ruleHash(rule) !== ruleHash(expected)) fail('告警规则已删除或变更，取消自动动作');
  if (!rule.authorization?.containerIds?.includes(containerId)) fail('容器不在已确认的固定授权范围内');
  const state = alertActionState(rule);
  if (state.status !== 'ready') fail(state.message);
  assertPermission(rule, containerId);
  return rule;
}

function reserve(rule, containerId, isCurrent) {
  return db.transaction(() => {
    requireCurrent(rule, containerId, isCurrent);
    const ledger = readLedger(rule).filter(item => item.at > Date.now() - 86400000 || ['started', 'unknown'].includes(item.status));
    const attempt = { id: 'resource_' + randomUUID(), ruleId: rule.id, containerId, action: rule.action, at: Date.now(), status: 'started' };
    ledger.push(attempt); setSetting(ledgerKey(rule), JSON.stringify(ledger));
    recordAgentAuditEvent({ executionId: attempt.id, eventType: 'resource_alert_reserved', actor: 'alert-monitor', toolName: rule.action === 'scale' ? 'compose.scale' : 'container.restart', decision: 'allow_bounded', details: { ruleId: rule.id, projectId: rule.projectId, target: rule.target, containerId, expiresAt: rule.authorization.expiresAt } });
    return attempt;
  })();
}

function finish(rule, attempt, status, message) {
  db.transaction(() => {
    const ledger = readLedger(rule), row = ledger.find(item => item.id === attempt.id);
    if (!row || row.status !== 'started') fail('自动处置记录已变化，无法确认执行结果');
    Object.assign(row, { status, message: String(redactSecretValue(message)).slice(0, 1000), finishedAt: Date.now() });
    setSetting(ledgerKey(rule), JSON.stringify(ledger));
    addOperation({ projectId: rule.projectId, action: 'resource-alert.' + rule.action, status: status === 'succeeded' ? 'success' : 'failed', detail: row.message });
    recordAgentAuditEvent({ executionId: attempt.id, eventType: 'resource_alert_' + status, actor: 'alert-monitor', toolName: rule.action === 'scale' ? 'compose.scale' : 'container.restart', decision: status, reason: row.message });
  })();
}

export async function acknowledgeAlertAction(ruleId, input = {}) {
  if (input.confirm !== 'CHECKED_RESOURCE_ACTION') fail('请先人工核对容器及业务的实际结果', 400);
  const rule = readAlertRules().find(item => item.id === ruleId);
  if (!rule?.target) fail('告警规则不存在', 404);
  return withProjectOperationLock(rule.projectId, () => db.transaction(() => {
    const ledger = readLedger(rule), attempt = ledger.find(item => item.id === input.executionId);
    if (!attempt || !['started', 'unknown'].includes(attempt.status)) fail('待核对记录已变化，请刷新');
    attempt.status = 'acknowledged'; attempt.acknowledgedAt = Date.now();
    setSetting(ledgerKey(rule), JSON.stringify(ledger));
    recordAgentAuditEvent({ executionId: attempt.id, eventType: 'resource_alert_acknowledged', actor: 'admin', decision: 'manually_checked', details: { ruleId, projectId: rule.projectId } });
    return { ok: true, actionState: alertActionState(rule) };
  })());
}

async function runScale(project, service, target, beforeExecute) {
  const args = ['up', '-d', '--no-recreate', '--no-deps', '--no-build', '--pull', 'never', '--scale', `${service}=${target}`, service];
  if (!project.mounted) {
    const code = await boundedAlertCall(signal => runWorkspaceComposeArgs(project, args, () => {}, { signal, timeoutMs: 60000, beforeExecute }), 65000);
    if (code !== 0) fail('自动扩容命令未成功，实际结果需人工核对');
    return;
  }
  await beforeExecute();
  await new Promise((resolve, reject) => {
    const child = spawnComposeCommand(project, args); let timedOut = false;
    child.stdout.resume(); child.stderr.resume();
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); reject(new Error('自动扩容命令超时，实际结果未知')); }, 60000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (!timedOut) code === 0 ? resolve() : reject(new Error('自动扩容命令失败，实际结果需人工核对')); });
  });
}

/** Every retry is a new incident; unknown outcomes are durable and never automatically replayed. */
export async function executeResourceAlertAction(rule, containerId, options = {}) {
  const deps = { ...defaults, ...options }, isCurrent = options.isCurrent || (() => true);
  return withProjectOperationLock(rule.projectId, async () => {
    requireCurrent(rule, containerId, isCurrent);
    await deps.verifyHost(rule.target);
    invalidateScanCache();
    const project = (await deps.scan(rule.target.hostId, { background: true })).find(item => item.id === rule.projectId);
    if (!project?.managed || project.hostId !== rule.target.hostId) fail('固定节点上未找到纳管项目');
    const item = project.containers.find(item => item.id === containerId);
    if (!item || item.state !== 'running' || !alertMatchesContainer(rule, item)) fail('固定容器已消失或不再运行，自动处置已暂停');
    const docker = deps.docker(rule.target.hostId), container = docker.getContainer(containerId);
    const before = await boundedAlertCall(signal => container.inspect({ abortSignal: signal }));
    if (before.Id !== containerId || !before.State?.Running || before.Config?.Labels?.['com.docker.compose.project'] !== project.projectName ||
        (item.service && before.Config?.Labels?.['com.docker.compose.service'] !== item.service)) fail('容器身份或状态不符合已确认目标');
    let current = before.RestartCount;
    if (rule.metric !== 'restart_count') {
      const stats = await boundedAlertCall(signal => container.stats({ stream: false, abortSignal: signal })), parsed = parseContainerStat(stats);
      current = rule.metric === 'cpu' ? (parsed.cpuReady ? parsed.cpuPercent : null)
        : parsed.memLimit > 0 && Number.isFinite(stats?.memory_stats?.usage) ? parsed.memPercent : null;
    }
    if (!Number.isFinite(current) || current < rule.threshold) fail('最新指标未知或已经恢复，取消本次自动动作');
    let replicaTarget, existingIds;
    if (rule.action === 'scale') {
      if (!project.editable) fail('项目 Compose 目录不可用');
      const snapshot = await deps.capture(project);
      validateScaleDefinition(snapshot, rule.service);
      if (snapshot.fingerprint !== rule.authorization.configuration) fail('Compose 或环境配置已变化，请重新授权自动扩容');
      const replicas = project.containers.filter(row => row.service === rule.service);
      if (replicas.some(row => row.state !== 'running')) fail('该服务有停止或异常副本，请先人工核对');
      replicaTarget = replicas.length + 1; existingIds = replicas.map(row => row.id);
      if (replicaTarget > RESOURCE_ALERT_LIMITS.maxReplicas) fail('已达到 5 个副本的自动扩容上限');
    }
    await deps.verifyHost(rule.target);
    requireCurrent(rule, containerId, isCurrent);
    const attempt = reserve(rule, containerId, isCurrent);
    let sent = false;
    const beforeExecute = async () => {
      await deps.verifyHost(rule.target);
      if (!isCurrent()) fail('告警监测已停止，取消动作');
      const latest = readAlertRules().find(item => item.id === rule.id);
      if (!latest || ruleHash(latest) !== ruleHash(rule)) fail('告警规则已删除或变化');
      assertScheduledHost(rule.target); assertPermission(rule, containerId);
      if (Date.now() >= rule.authorization.expiresAt) fail('自动授权已到期');
      sent = true;
    };
    try {
      if (rule.action === 'scale') {
        await deps.scale(project, rule.service, replicaTarget, beforeExecute);
        const rows = await boundedAlertCall(signal => docker.listContainers({ all: true, filters: { label: [`com.docker.compose.project=${project.projectName}`, `com.docker.compose.service=${rule.service}`] }, abortSignal: signal }));
        if (!Array.isArray(rows) || rows.length !== replicaTarget || rows.some(row => row.State !== 'running') || existingIds.some(id => !rows.some(row => row.Id === id))) fail('扩容后的副本或原容器状态未通过验收');
        for (const row of rows) {
          const info = await boundedAlertCall(signal => docker.getContainer(row.Id).inspect({ abortSignal: signal }));
          if (!info.State?.Running || (info.State.Health && info.State.Health.Status !== 'healthy')) fail('扩容后的容器健康尚未通过验收');
        }
      } else {
        await beforeExecute();
        await boundedAlertCall(signal => container.restart({ t: 10, abortSignal: signal }), 30000);
        const after = await boundedAlertCall(signal => container.inspect({ abortSignal: signal }));
        if (!after.State?.Running || !after.State.StartedAt || after.State.StartedAt === before.State.StartedAt ||
            (after.State.Health && after.State.Health.Status !== 'healthy')) fail('重启后的容器状态未通过验收，请人工检查');
      }
      await deps.verifyHost(rule.target);
      finish(rule, attempt, 'succeeded', '自动操作完成，容器层验收通过；未验证业务 HTTP/SQL');
      return { status: 'succeeded', executionId: attempt.id };
    } catch (error) {
      finish(rule, attempt, sent ? 'unknown' : 'cancelled', error.message);
      throw error;
    }
  });
}
