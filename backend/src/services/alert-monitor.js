import { listHosts, getProjectDocker } from './docker-hosts.js';
import { getSetting, setSetting, getProjectPreference } from '../lib/db.js';
import { scanProjectInventory } from './scanner.js';
import { getNotificationConfig, sendNotification } from './notifications.js';
import { checkImageUpdates } from './maintenance.js';
import { recordAlertEventAndNotify } from './events.js';
import { containerMetricValues } from '../lib/container-metric-values.js';
import { readAlertRules, alertMatchesContainer } from './alert-rule-store.js';
import { executeResourceAlertAction, boundedAlertCall, alertActionState } from './resource-alert-actions.js';
import { getSystemStorageDf } from './docker-storage.js';

const previousStates = new Map();
const agentRuleStates = new Map();
const dockerStorageHigh = new Map();
let timer;
let initialTimer;
let generation = 0;
let running = false;

/** 读取 AI Agent 创建的告警规则(与 agent-tools.js 的存储键保持一致)。 */
export const readAgentAlertRules = readAlertRules;

function agentRuleKey(rule, containerId) {
  return `${rule.id}:${containerId}`;
}

/**
 * Require consecutive samples to enter/leave an incident. A sustained high
 * value alerts once; two normal samples re-arm the rule for the next incident.
 * Invalid readings never count as either high or normal samples.
 */
export function observeAgentAlertState(rule, containerId, current, threshold = rule?.threshold, { now = Date.now(), maxGapMs = 120000 } = {}) {
  const key = agentRuleKey(rule, containerId);
  const value = Number(current);
  const limit = Number(threshold);
  if (current == null || threshold == null || typeof current === 'boolean' || typeof threshold === 'boolean' || String(current).trim() === '' || String(threshold).trim() === '' || !Number.isFinite(value) || !Number.isFinite(limit)) {
    const previous = agentRuleStates.get(key);
    if (previous) agentRuleStates.set(key, { ...previous, highSamples: 0, normalSamples: 0 });
    return false;
  }

  const ruleId = String(rule.id || '');
  const containerKey = String(containerId);
  const ruleSignature = JSON.stringify([
    String(rule.projectId || ''),
    String(rule.service || ''),
    String(rule.metric || ''),
    limit,
    String(rule.action || 'notify'),
  ]);
  const stored = agentRuleStates.get(key);
  const saved = stored && now - stored.sampledAt > maxGapMs ? { ...stored, highSamples: 0, normalSamples: 0 } : stored;
  // Editing the rule starts a fresh incident state instead of carrying the old threshold history.
  const previous = !saved || saved.signature !== ruleSignature ? {
    ruleId,
    projectId: String(rule.projectId || ''),
    containerId: containerKey,
    signature: ruleSignature,
    active: false,
    highSamples: 0,
    normalSamples: 0,
  } : saved;

  if (value >= limit) {
    const highSamples = Math.min(2, previous.highSamples + 1);
    const triggered = !previous.active && highSamples >= 2;
    agentRuleStates.set(key, {
      ...previous,
      ruleId,
      projectId: String(rule.projectId || ''),
      containerId: containerKey,
      active: previous.active || triggered,
      highSamples,
      normalSamples: 0,
      sampledAt: now,
    });
    return triggered;
  }

  const normalSamples = Math.min(2, previous.normalSamples + 1);
  agentRuleStates.set(key, {
    ...previous,
    ruleId,
    projectId: String(rule.projectId || ''),
    containerId: containerKey,
    active: previous.active && normalSamples < 2,
    highSamples: 0,
    normalSamples,
    sampledAt: now,
  });
  return false;
}

function pruneAgentAlertStates(rules, projectIds, runningContainerIds, complete = true) {
  const activeRuleIds = new Set(rules
    .filter((rule) => projectIds.has(String(rule.projectId)))
    .map((rule) => String(rule.id || '')));
  for (const [key, state] of agentRuleStates) {
    if (!complete && rules.some(rule => String(rule.id || '') === state.ruleId) && !projectIds.has(state.projectId) && getProjectPreference(state.projectId).managed) continue;
    if (!activeRuleIds.has(state.ruleId) || !runningContainerIds.has(state.containerId)) {
      agentRuleStates.delete(key);
    }
  }
}

async function applyAgentAlertAction(rule, project, container, current, isCurrent) {
  if (!isCurrent()) return;
  const title = `ComposeOps:Agent 告警 · ${project.projectName} / ${container.name}`;
  const body = [
    `项目:${project.projectName}`,
    `容器:${container.name}`,
    `指标:${rule.metric}`,
    `当前:${current}`,
    `阈值:${rule.threshold}`,
  ].join('\n');
  recordAlertEventAndNotify({
    key: `${project.hostId}:${container.id}:agent:${rule.id}`,
    title,
    detail: `${project.projectName} / ${container.name} · ${rule.metric}=${current} (阈值 ${rule.threshold})`,
    priority: 'warning',
    to: '/logs?' + new URLSearchParams({ projectId: project.id, containerId: container.id, hostId: project.hostId || 'local', from: 'events' }),
  });
  await boundedAlertCall(() => sendNotification(title, body), 10000).catch(error => console.warn('[alert-monitor] 通知投递未完成:', error.message));
  if (rule.action !== 'notify' && isCurrent()) {
    try {
      const state = alertActionState(rule);
      if (state.status !== 'ready') throw new Error(state.message);
      await executeResourceAlertAction(rule, container.id, { isCurrent });
    } catch (error) {
      recordAlertEventAndNotify({ key: `${project.hostId}:${container.id}:agent-action:${rule.id}`, title: 'ComposeOps:自动处置未完成',
        detail: `${project.projectName} / ${container.name}：${error.message}`, priority: 'warning', to: '/monitor?tab=history' });
      console.warn('[alert-monitor] 自动处置未完成:', error.message);
    }
  }
}

/** 评估 AI Agent 创建的阈值规则:CPU/内存/重启次数,超限触发 notify/auto_restart/scale。 */
export async function evaluateAgentRules(project, container, stats, { isCurrent = () => true, apply = applyAgentAlertAction } = {}) {
  const rules = readAgentAlertRules().filter(rule => rule.projectId === project.id && (!rule.hostId || rule.hostId === project.hostId) && alertMatchesContainer(rule, container));
  if (!rules.length) return;
  const parsed = containerMetricValues(stats);
  let restartCount = null;
  if (rules.some(rule => rule.metric === 'restart_count')) {
    try {
      const inspected = await boundedAlertCall(signal => getProjectDocker(project).getContainer(container.id).inspect({ abortSignal: signal }));
      if (Number.isFinite(inspected?.RestartCount)) restartCount = inspected.RestartCount;
    } catch (err) { console.error(`[alert-monitor] Failed to inspect container ${container.id}:`, err.message); }
  }

  for (const rule of rules) {
    if (!isCurrent()) return;
    let current = null;
    if (rule.metric === 'cpu') current = parsed.cpu;
    else if (rule.metric === 'memory') current = parsed.memory;
    else if (rule.metric === 'restart_count') current = restartCount;
    if (!observeAgentAlertState(rule, container.id, current, rule.threshold, { maxGapMs: Math.max(120000, (Number(getNotificationConfig(false).intervalSeconds) || 30) * 2000) })) continue;
    await apply(rule, project, container, Math.round(current * 10) / 10, isCurrent);
  }
}

async function poll(expectedGeneration) {
  if (running || generation !== expectedGeneration) return;
  running = true;
  const deadline = Date.now() + 45000;
  const isCurrent = () => generation === expectedGeneration && Date.now() < deadline;
  let observed = 0, failed = 0, pending = 0;
  try {
    const config = getNotificationConfig(false);
    const inventory = await scanProjectInventory(), projects = inventory.projects;
    if (!isCurrent()) return;
    failed += inventory.nodeErrors.length;
    const unavailable = new Set(inventory.nodeErrors.map(node => node.hostId));
    const managedProjects = projects.filter(item => item.managed);
    const managedContainerIds = new Set(managedProjects.flatMap(project => project.containers.map(item => `${project.hostId}:${item.id}`)));
    const managedProjectIds = new Set(managedProjects.map(project => String(project.id)));
    const runningContainerIds = new Set(managedProjects.flatMap(project => project.containers.filter(item => item.state === 'running').map(item => String(item.id))));
    const rules = readAgentAlertRules();
    pruneAgentAlertStates(rules, managedProjectIds, runningContainerIds, inventory.complete);
    for (const containerId of previousStates.keys()) {
      if (!unavailable.has(containerId.split(':')[0]) && !managedContainerIds.has(containerId)) previousStates.delete(containerId);
    }
    // Notification channels and explicit rule authorizations are independent.
    // Only sample relevant containers, with bounded concurrent reads.
    const queue = managedProjects.flatMap(project => project.containers.filter(item => item.state === 'running' &&
      (config.enabled || rules.some(rule => rule.projectId === project.id && alertMatchesContainer(rule, item))))
      .map(item => ({ project, item })));
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length && isCurrent()) {
        const { project, item } = queue.shift(), key = `${project.hostId}:${item.id}`;
        const memHigh = !!previousStates.get(key)?.memHigh;
        try {
          const stats = await boundedAlertCall(signal => getProjectDocker(project).getContainer(item.id).stats({ stream: false, abortSignal: signal }));
          if (!isCurrent()) return;
          observed++;
          await evaluateAgentRules(project, item, stats, { isCurrent });
          if (!config.enabled || !isCurrent()) continue;
          const parsed = containerMetricValues(stats);
          // Unknown memory readings preserve the incident; they cannot resolve it.
          if (parsed.memory === null) continue;
          const nextMemHigh = parsed.memory >= config.memoryThreshold;
          if (nextMemHigh && !memHigh) {
            recordAlertEventAndNotify({
              key: `${project.hostId}:${item.id}:memory`, title: 'ComposeOps:容器内存告警',
              detail: `${project.projectName} / ${item.name}: ${parsed.memory.toFixed(1)}%`, priority: 'warning',
              to: '/logs?' + new URLSearchParams({ projectId: project.id, containerId: item.id, hostId: project.hostId || 'local', from: 'events' }),
            });
            await boundedAlertCall(() => sendNotification('ComposeOps：容器内存告警', `${project.projectName} / ${item.name}: ${parsed.memory.toFixed(1)}%`), 10000)
              .catch(error => console.warn('[alert-monitor] 通知投递未完成:', error.message));
          }
          if (isCurrent()) previousStates.set(key, { memHigh: nextMemHigh });
        } catch (error) {
          failed++;
          console.error(`[alert-monitor] Failed to check stats for ${project.projectName}/${item.name}:`, error.message);
        }
      }
    }));
    pending = queue.length;
    if (config.enabled) {
      const hosts = [...listHosts()];
      await Promise.all(Array.from({ length: Math.min(4, hosts.length) }, async () => {
        while (hosts.length && isCurrent()) {
          const host = hosts.shift();
          try {
            const usage = await getSystemStorageDf(host.id, { background: true });
            if (!isCurrent()) return;
            const bytes = usage.images.total + usage.buildCache.total;
            if (!Number.isFinite(bytes)) continue;
            const storageHigh = bytes >= config.dockerStorageThresholdGb * 1024 ** 3;
            if (storageHigh && !dockerStorageHigh.get(host.id)) {
              recordAlertEventAndNotify({ key: `docker-storage:${host.id}`, title: 'ComposeOps:Docker 空间告警',
                detail: `${host.name}：镜像与构建缓存占用 ${(bytes / 1024 ** 3).toFixed(1)} GB（Engine 统计，非文件系统余量）`, priority: 'warning', to: '/settings?tab=maintenance' });
              await boundedAlertCall(() => sendNotification('ComposeOps：Docker 空间告警', `${host.name}：镜像与构建缓存占用 ${(bytes / 1024 ** 3).toFixed(1)} GB`), 10000)
                .catch(error => console.warn('[alert-monitor] 通知投递未完成:', error.message));
            }
            if (isCurrent()) dockerStorageHigh.set(host.id, storageHigh);
          } catch (error) { failed++; console.warn('[alert-monitor] Docker 空间读取失败:', error.message); }
        }
      }));
      pending += hosts.length;
    }
    const autoUpdate = getSetting('updates.auto_enabled', '0') === '1';
    const intervalHours = Math.max(1, Number(getSetting('updates.interval_hours', '24')) || 24);
    const lastCheck = Number(getSetting('updates.last_check', '0')) || 0;
    if (isCurrent() && autoUpdate && Date.now() - lastCheck >= intervalHours * 3600000) {
      setSetting('updates.last_check', String(Date.now()));
      await checkImageUpdates().catch(error => console.warn('[alert-monitor] 镜像检查未完成:', error.message));
    }
  } catch (error) {
    failed++;
    console.error('[alert-monitor] 本轮采集未完成:', error.message);
  } finally {
    if (generation === expectedGeneration) setSetting('agent.alert_monitor_status', JSON.stringify({ observed, failed, pending, at: Date.now(), complete: failed === 0 && pending === 0 && Date.now() < deadline }));
    // eslint-disable-next-line require-atomic-updates -- 单线程事件循环下的互斥标志
    running = false;
  }
}

export function startAlertMonitor() {
  if (timer || process.env.DISABLE_BACKGROUND_JOBS === '1') return;
  const interval = Math.max(30, getNotificationConfig(false).intervalSeconds) * 1000;
  const currentGeneration = ++generation;
  timer = setInterval(() => { void poll(currentGeneration); }, interval);
  timer.unref();
  initialTimer = setTimeout(() => { initialTimer = null; void poll(currentGeneration); }, 5000);
  initialTimer.unref();
}

export function stopAlertMonitor() {
  generation++;
  if (timer) clearInterval(timer);
  if (initialTimer) clearTimeout(initialTimer);
  timer = null;
  initialTimer = null;
}

export function restartAlertMonitor() {
  stopAlertMonitor();
  startAlertMonitor();
}
