import { getActivityDocker } from './docker-hosts.js';
import { getNotificationConfig, sendNotification } from './notifications.js';
import { scanProjects } from './scanner.js';
import { recordAlertEventAndNotify } from './events.js';

const DEFAULT_EVENTS = ['exit', 'oom', 'unhealthy'];
const previousStates = new Map(); // containerId -> { status, health, exitCode, oom }

/** 组装告警事件配置(默认开启 exit/oom/unhealthy)。 */
export function getAlertEventConfig() {
  return { events: DEFAULT_EVENTS };
}

/**
 * 判断容器是否触发告警,并组装 payload。
 * 纯函数,便于单测。
 */
export function evaluateContainer(container, previous = null) {
  const events = [];
  const state = container.state || '';
  const health = container.health || null;
  const exitCode = Number(container.exitCode ?? container.exitCodeHint ?? 0);
  const oom = !!container.oomKilled;
  const restarts = Number(container.restartCount ?? 0);

  if (exitCode !== 0 && previous && previous.exitCode === 0) events.push('exit');
  else if (exitCode !== 0 && !previous) events.push('exit');
  if (oom && !(previous && previous.oom)) events.push('oom');
  if (health === 'unhealthy' && !(previous && previous.health === 'unhealthy')) events.push('unhealthy');
  if (restarts > (previous?.restarts || 0) + 2) events.push('crashloop');

  const filtered = events.filter((event) => event !== 'crashloop' || (events.includes('exit') && events.includes('oom')));
  return {
    container,
    triggered: filtered.length > 0,
    events: filtered,
    state,
    health,
    exitCode,
    oom,
    restarts,
  };
}

/** 加载容器最近 N 行日志(最多 8 行),失败返回空。 */
export async function containerTailLogs(containerId, lines = 8, docker = getActivityDocker()) {
  try {
    const container = docker.getContainer(containerId);
    const stream = await container.logs({ follow: false, stdout: true, stderr: true, tail: lines });
    const buffer = Buffer.isBuffer(stream) ? stream : await collect(stream);
    const raw = stripDockerMultiplex(buffer);
    return raw.split('\n').filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** 去掉 docker logs 的 multiplex 8 字节头。 */
export function stripDockerMultiplex(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 9) return buffer ? buffer.toString('utf8') : '';
  const frames = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const payloadSize = buffer.readUInt32BE(offset + 4);
    const payload = buffer.subarray(offset + 8, offset + 8 + payloadSize);
    frames.push(payload.toString('utf8'));
    offset += 8 + payloadSize;
  }
  return frames.join('');
}

async function inspectContainer(docker, containerId) {
  try {
    const inspection = await docker.getContainer(containerId).inspect();
    const state = inspection?.State || {};
    const health = state.Health?.Status || null;
    return {
      state: state.Status || '',
      exitCode: state.ExitCode ?? 0,
      oomKilled: !!state.OOMKilled,
      restartCount: Number(inspection?.RestartCount ?? 0),
      health: state.Health?.Status || (health === 'unhealthy' ? 'unhealthy' : null),
      statusText: inspection?.State?.Status || '',
    };
  } catch {
    return {};
  }
}

async function poll() {
  const config = getNotificationConfig(false);
  if (!config.enabled) return;
  let projects;
  try { projects = await scanProjects(); } catch { return; }
  const managedProjects = projects.filter((item) => item.managed);
  const managedIds = new Set(managedProjects.flatMap((project) => project.containers.map((item) => item.id)));
  for (const containerId of previousStates.keys()) {
    if (!managedIds.has(containerId)) previousStates.delete(containerId);
  }
  const docker = getActivityDocker();
  for (const project of managedProjects) {
    for (const container of project.containers) {
      const inspected = await inspectContainer(docker, container.id);
      const enriched = { ...container, ...inspected };
      const previous = previousStates.get(container.id);
      const result = evaluateContainer(enriched, previous);
      previousStates.set(container.id, {
        state: enriched.state || '',
        health: enriched.health || null,
        exitCode: Number(enriched.exitCode ?? (enriched.state === 'exited' ? 1 : 0)),
        oom: !!enriched.oomKilled,
        restarts: Number(enriched.restartCount ?? 0),
      });
      if (!result.triggered) continue;

      const events = result.events.filter((event) => configEvents(config).includes(event));
      for (const event of events) {
        const logs = await containerTailLogs(container.id, 8).catch(() => '');
        const title = buildTitle(project, container, event);
        const body = buildBody(project, container, event, logs);
        recordAlertEventAndNotify({
          key: `${container.id}:${event}`,
          title,
          detail: `${project.projectName} / ${container.name} · ${container.statusText || ''}`,
          priority: event === 'crashloop' ? 'warning' : 'danger',
          to: `/services?focus=${project.id}`,
          logs,
        });
        await sendNotification(title, body).catch(() => {});
      }
    }
  }
}

function configEvents(config) {
  const events = config.events;
  return Array.isArray(events) && events.length ? events : DEFAULT_EVENTS;
}

export function buildTitle(project, container, event) {
  const names = {
    exit: '容器异常退出',
    oom: '容器内存溢出 (OOMKilled)',
    unhealthy: '容器健康检查失败',
    crashloop: '容器崩溃循环 (CrashLoop)',
  };
  return `ComposeOps:${names[event] || '容器告警'} · ${project.projectName} / ${container.name}`;
}

export function buildBody(project, container, event, logs = '') {
  const lines = [
    `项目:${project.projectName}`,
    `容器:${container.name}`,
    `状态:${container.state || 'unknown'}`,
    `退出码:${container.exitCode ?? container.exitCodeHint ?? 'N/A'}`,
    `重启次数:${container.restartCount ?? container.restarts ?? 0}`,
  ];
  if (event === 'oom') lines.push(`OOMKilled:${container.oomKilled ? '是' : '否'}`);
  if (event === 'unhealthy') lines.push(`健康状态:${container.health}`);
  if (logs) lines.push(`--- 最近日志 ---\n${logs}`);
  return lines.join('\n');
}

let timer;
let running = false;

export function startHealthAlerter() {
  if (timer || process.env.DISABLE_BACKGROUND_JOBS === '1') return;
  timer = setInterval(() => { if (!running) { running = true; poll().finally(() => { running = false; }); } }, 60 * 1000);
  timer.unref();
  setTimeout(poll, 8000).unref();
}

export function stopHealthAlerter() {
  if (timer) clearInterval(timer);
  timer = null;
}
