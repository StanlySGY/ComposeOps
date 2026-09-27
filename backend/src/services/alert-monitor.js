import { getActivityDocker } from './docker-hosts.js';
import { getSetting, setSetting } from '../lib/db.js';
import { scanProjects } from './scanner.js';
import { getNotificationConfig, sendNotification } from './notifications.js';
import { checkImageUpdates } from './maintenance.js';
import { recordAlertEventAndNotify } from './events.js';
import { parseContainerStat } from './stats.js';
import { spawnComposeCommand } from './compose-runner.js';
import { runWorkspaceComposeArgs } from './compose-workspace.js';
import { withProjectOperationLock } from './project-operation-lock.js';

const previousStates = new Map();
const agentCooldowns = new Map();
let dockerStorageHigh = false;
let timer;
let running = false;

/** 读取 AI Agent 创建的告警规则(与 agent-tools.js 的存储键保持一致)。 */
export function readAgentAlertRules() {
  try {
    const parsed = JSON.parse(getSetting('agent.alert_rules', '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function agentRuleKey(rule, containerId) {
  return `${rule.id}:${containerId}`;
}

function canTriggerAgentRule(rule, containerId, cooldownMs = 10 * 60 * 1000) {
  const key = agentRuleKey(rule, containerId);
  const last = agentCooldowns.get(key) || 0;
  if (Date.now() - last < cooldownMs) return false;
  agentCooldowns.set(key, Date.now());
  return true;
}

/** 读取服务名归一化(支持容器名前缀匹配)。 */
function containerMatchesService(container, service) {
  const name = String(container.name || '').toLowerCase();
  const wanted = String(service || '').toLowerCase();
  return name === wanted || name.startsWith(`${wanted}.`) || name.startsWith(`${wanted}-`) || name.includes(wanted);
}

async function applyAgentAlertAction(rule, project, container, current) {
  const title = `ComposeOps:Agent 告警 · ${project.projectName} / ${container.name}`;
  const body = [
    `项目:${project.projectName}`,
    `容器:${container.name}`,
    `指标:${rule.metric}`,
    `当前:${current}`,
    `阈值:${rule.threshold}`,
  ].join('\n');
  recordAlertEventAndNotify({
    key: `${container.id}:agent:${rule.metric}`,
    title,
    detail: `${project.projectName} / ${container.name} · ${rule.metric}=${current} (阈值 ${rule.threshold})`,
    priority: 'warning',
    to: `/services?focus=${project.id}`,
  });
  await sendNotification(title, body).catch(() => {});

  // 自动处置动作持项目操作锁:自动 restart/scale 与用户手动 stop/升级并发会互相踩踏。
  if (rule.action === 'auto_restart') {
    await withProjectOperationLock(project.id, () =>
      getActivityDocker().getContainer(container.id).restart().catch(() => {}));
  } else if (rule.action === 'scale') {
    await withProjectOperationLock(project.id, () => scaleServiceByOne(project, rule.service).catch(() => {}));
  }
}

/** scale 动作:在该服务副本数基础上 +1(受 Compose 目录能力约束)。 */
async function scaleServiceByOne(project, service) {
  if (!project?.editable) throw new Error('项目未启用 Compose 目录能力,无法自动扩容');
  const running = (project.containers || []).filter((item) => item.state === 'running' && containerMatchesService(item, service)).length;
  const target = Math.max(2, running + 1);
  const args = ['up', '-d', '--scale', `${service}=${target}`];
  if (project.mounted) {
    await new Promise((resolve, reject) => {
      const child = spawnComposeCommand(project, args);
      child.stdout.on('data', () => {});
      child.stderr.on('data', () => {});
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`compose scale 退出码 ${code}`))));
    });
  } else {
    const code = await runWorkspaceComposeArgs(project, args, () => {});
    if (code !== 0) throw new Error(`compose scale 退出码 ${code}`);
  }
}

/** 评估 AI Agent 创建的阈值规则:CPU/内存/重启次数,超限触发 notify/auto_restart/scale。 */
async function evaluateAgentRules(project, container, stats) {
  const rules = readAgentAlertRules().filter((rule) => rule.projectId === project.id);
  if (!rules.length) return;
  const parsed = parseContainerStat(stats);
  let restartCount = 0;
  try {
    const inspected = await getActivityDocker().getContainer(container.id).inspect();
    restartCount = Number(inspected?.RestartCount) || 0;
  } catch (err) {
    console.error(`[alert-monitor] Failed to inspect container ${container.id}:`, err.message);
  }

  for (const rule of rules) {
    if (!containerMatchesService(container, rule.service)) continue;
    let current = null;
    if (rule.metric === 'cpu') current = parsed.cpuPercent;
    else if (rule.metric === 'memory') current = parsed.memPercent;
    else if (rule.metric === 'restart_count') current = restartCount;
    if (current == null || current < Number(rule.threshold)) continue;
    if (!canTriggerAgentRule(rule, container.id)) continue;
    await applyAgentAlertAction(rule, project, container, Math.round(current * 10) / 10);
  }
}

async function poll() {
  if (running) return;
  running = true;
  try {
    const config = getNotificationConfig(false);
    const projects = await scanProjects();
    const managedProjects = projects.filter((item) => item.managed);
    const managedContainerIds = new Set(managedProjects.flatMap((project) => project.containers.map((item) => item.id)));
    for (const containerId of previousStates.keys()) {
      if (!managedContainerIds.has(containerId)) previousStates.delete(containerId);
    }
    if (config.enabled) {
      const activity = getActivityDocker();
      for (const project of managedProjects) {
        for (const item of project.containers) {
          const previous = previousStates.get(item.id);
          const previousState = typeof previous === 'string' ? previous : previous?.state;
          const memHigh = typeof previous === 'object' && !!previous?.memHigh;
          if (previousState === 'running' && item.state !== 'running') {
            recordAlertEventAndNotify({
              key: `${item.id}:exit`,
              title: 'ComposeOps:容器已退出',
              detail: `${project.projectName} / ${item.name} · ${item.statusText}`,
              priority: 'danger',
              to: `/services?focus=${project.id}`,
            });
            await sendNotification('ComposeOps：容器已退出', `${project.projectName} / ${item.name}\n${item.statusText}`)
              .catch(() => {});
          }
          let nextMemHigh = false;
          if (item.state === 'running') {
            try {
              const stats = await activity.getContainer(item.id).stats({ stream: false });
              const usage = stats.memory_stats?.usage || 0;
              const limit = stats.memory_stats?.limit || 0;
              const percent = limit ? usage / limit * 100 : 0;
              await evaluateAgentRules(project, item, stats);
              nextMemHigh = percent >= config.memoryThreshold;
              if (nextMemHigh && !memHigh) {
                recordAlertEventAndNotify({
                  key: `${item.id}:memory`,
                  title: 'ComposeOps:容器内存告警',
                  detail: `${project.projectName} / ${item.name}: ${percent.toFixed(1)}%`,
                  priority: 'warning',
                  to: `/services?focus=${project.id}`,
                });
                await sendNotification('ComposeOps：容器内存告警', `${project.projectName} / ${item.name}: ${percent.toFixed(1)}%`)
                  .catch(() => {});
              }
            } catch (err) {
              nextMemHigh = memHigh;
              console.error(`[alert-monitor] Failed to check stats for ${project.projectName}/${item.name}:`, err.message);
            }
          }
          previousStates.set(item.id, { state: item.state, memHigh: nextMemHigh });
        }
      }
      const usage = await activity.df().then((data) => {
        const images = (data.Images || []).reduce((total, item) => total + (Number(item.Size) || 0), 0);
        const cache = (data.BuildCache || []).reduce((total, item) => total + (Number(item.Size) || 0), 0);
        return images + cache;
      }).catch(() => null);
      const previousDockerStorageHigh = dockerStorageHigh;
      const storageHigh = usage != null && usage >= config.dockerStorageThresholdGb * 1024 ** 3;
      if (storageHigh && !previousDockerStorageHigh) {
        recordAlertEventAndNotify({
          key: 'docker-storage',
          title: 'ComposeOps:Docker 空间告警',
          detail: `镜像与构建缓存占用 ${(usage / 1024 ** 3).toFixed(1)} GB`,
          priority: 'warning',
          to: '/settings?tab=maintenance',
        });
        await sendNotification('ComposeOps：Docker 空间告警', `镜像与构建缓存占用 ${(usage / 1024 ** 3).toFixed(1)} GB`)
          .catch(() => {});
      }
      // eslint-disable-next-line require-atomic-updates -- 单线程事件循环下的边沿状态标志
      if (usage != null) dockerStorageHigh = storageHigh;
    } else {
      // 通知渠道未启用时,仍评估带自动处置的 Agent 规则(auto_restart / scale)。
      const activity = getActivityDocker();
      for (const project of managedProjects) {
        for (const item of project.containers) {
          if (item.state !== 'running') continue;
          try {
            const stats = await activity.getContainer(item.id).stats({ stream: false });
            await evaluateAgentRules(project, item, stats);
          } catch (err) {
            console.error(`[alert-monitor] Failed to evaluate agent rules for ${project.projectName}/${item.name}:`, err.message);
          }
        }
      }
    }

    const autoUpdate = getSetting('updates.auto_enabled', '0') === '1';
    const intervalHours = Math.max(1, Number(getSetting('updates.interval_hours', '24')) || 24);
    const lastCheck = Number(getSetting('updates.last_check', '0')) || 0;
    if (autoUpdate && Date.now() - lastCheck >= intervalHours * 3600000) {
      setSetting('updates.last_check', String(Date.now()));
      await checkImageUpdates().catch(() => {});
    }
  } finally {
    // eslint-disable-next-line require-atomic-updates -- 单线程事件循环下的互斥标志
    running = false;
  }
}

export function startAlertMonitor() {
  if (timer || process.env.DISABLE_BACKGROUND_JOBS === '1') return;
  const interval = Math.max(30, getNotificationConfig(false).intervalSeconds) * 1000;
  timer = setInterval(poll, interval);
  timer.unref();
  setTimeout(poll, 5000).unref();
}

export function stopAlertMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function restartAlertMonitor() {
  stopAlertMonitor();
  startAlertMonitor();
}
