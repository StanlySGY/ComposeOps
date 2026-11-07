import { createHash } from 'node:crypto';

const CRON_INTERVAL_MS = 15000;
let cronTimer = null;
let cronRunning = false;

function boundedText(value, limit = 2000) {
  return String(value ?? '').slice(0, limit);
}

function eventIdentity(event) {
  const supplied = event.eventId ?? event.eventKey ?? event.key ?? event.id;
  if (supplied !== undefined && supplied !== null && String(supplied)) return boundedText(supplied, 240);
  const stable = JSON.stringify([
    event.source, event.eventType, event.hostId, event.projectId, event.containerId,
    event.action, event.title, event.detail, event.timestamp,
  ]);
  return createHash('sha256').update(stable).digest('hex').slice(0, 40);
}

function normalizeEvent(event = {}) {
  const source = boundedText(event.source || (event.type === 'container_event' ? 'docker' : event.type) || 'system', 64);
  const eventType = boundedText(event.eventType || (event.type === 'container_event' ? 'container' : 'event'), 64);
  const identity = eventIdentity(event);
  return {
    eventId: identity,
    source,
    eventType,
    action: boundedText(event.action, 80),
    severity: boundedText(event.severity || event.priority || 'info', 16),
    status: boundedText(event.status || 'open', 24),
    title: boundedText(event.title, 240),
    detail: boundedText(event.detail, 2000),
    hostId: event.hostId || null,
    hostName: boundedText(event.hostName, 160),
    projectId: event.projectId || null,
    projectName: boundedText(event.projectName || event.project?.projectName, 160),
    containerId: event.containerId || null,
    containerName: boundedText(event.containerName, 160),
    healthStatus: boundedText(event.healthStatus, 32),
    timestamp: Number(event.timestamp || event.ts || Date.now()),
    key: boundedText(event.key, 240),
  };
}

function asList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function matchesDefinition(definition, event) {
  if (!definition.enabled || definition.triggerType !== 'event') return false;
  const config = definition.triggerConfig || {};
  const eventTypes = asList(config.eventTypes ?? config.eventType);
  const sources = asList(config.sources ?? config.source);
  const actions = asList(config.actions ?? config.action);
  const severities = asList(config.severities ?? config.severity);
  if (!eventTypes.length) return false;
  if (!eventTypes.includes('*') && !eventTypes.includes(event.eventType)) return false;
  if (sources.length && !sources.includes('*') && !sources.includes(event.source)) return false;
  if (actions.length && !actions.includes('*') && !actions.includes(event.action)) return false;
  if (severities.length && !severities.includes('*') && !severities.includes(event.severity)) return false;
  if (config.projectId && String(config.projectId) !== String(event.projectId || '')) return false;
  if (Array.isArray(config.projectIds) && config.projectIds.length && !config.projectIds.map(String).includes(String(event.projectId || ''))) return false;
  return true;
}

/** Deterministic routing: no LLM decides whether an event may start a workflow. */
export async function routeWorkflowEvent(rawEvent) {
  const event = normalizeEvent(rawEvent);
  if (event.source === 'workflow' || event.eventType === 'workflow') return { matched: 0, started: [] };
  try {
    const { listDefinitions, startWorkflow } = await import('./workflow-engine.js');
    const definitions = listDefinitions().filter((definition) => matchesDefinition(definition, event));
    const started = [];
    for (const definition of definitions) {
      const idempotencyKey = 'workflow:event:' + definition.id + ':' + event.eventId;
      try {
        const instance = startWorkflow(definition.id, {
          trigger: 'event',
          triggerEvent: event,
          eventId: event.eventId,
          eventType: event.eventType,
          source: event.source,
          projectId: event.projectId,
        }, { idempotencyKey, triggerEventId: event.eventId });
        started.push({ definitionId: definition.id, instanceId: instance.id, replayed: !!instance.replayed });
      } catch (error) {
        console.warn('[event-router] workflow ' + definition.id + ' rejected event ' + event.eventId + ': ' + error.message);
      }
    }
    return { matched: definitions.length, started };
  } catch (error) {
    console.warn('[event-router] event routing failed:', error.message);
    return { matched: 0, started: [], error: error.message };
  }
}

function cronMatches(expr, date, parseCron) {
  const cron = parseCron(expr);
  const day = date.getDay();
  return cron.minute(date.getMinutes())
    && cron.hour(date.getHours())
    && cron.day(date.getDate())
    && cron.month(date.getMonth() + 1)
    && (cron.weekday(day) || (day === 0 && cron.weekday(7)));
}

/** Run due cron workflows once per local minute; DB idempotency protects duplicate ticks/restarts. */
export async function runWorkflowCronTriggers(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('invalid cron trigger date');
  try {
    const [{ listDefinitions, startWorkflow }, { parseCron }] = await Promise.all([
      import('./workflow-engine.js'),
      import('./cron-scheduler.js'),
    ]);
    const minuteKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-'
      + String(now.getDate()).padStart(2, '0') + 'T' + String(now.getHours()).padStart(2, '0')
      + ':' + String(now.getMinutes()).padStart(2, '0');
    const started = [];
    for (const definition of listDefinitions()) {
      if (!definition.enabled || definition.triggerType !== 'cron') continue;
      const expression = String(definition.triggerConfig?.cron || '').trim();
      if (!expression) continue;
      let due = false;
      try { due = cronMatches(expression, now, parseCron); }
      catch (error) {
        console.warn('[event-router] invalid cron workflow ' + definition.id + ': ' + error.message);
        continue;
      }
      if (!due) continue;
      try {
        const instance = startWorkflow(definition.id, {
          trigger: 'cron',
          triggerAt: now.toISOString(),
          projectId: definition.triggerConfig?.projectId || null,
        }, { idempotencyKey: 'workflow:cron:' + definition.id + ':' + minuteKey });
        started.push({ definitionId: definition.id, instanceId: instance.id, replayed: !!instance.replayed });
      } catch (error) {
        console.warn('[event-router] cron workflow ' + definition.id + ' rejected: ' + error.message);
      }
    }
    return started;
  } catch (error) {
    console.warn('[event-router] cron trigger sweep failed:', error.message);
    return [];
  }
}

async function cronTick() {
  if (cronRunning) return;
  cronRunning = true;
  try { await runWorkflowCronTriggers(new Date()); }
  finally {
    // eslint-disable-next-line require-atomic-updates -- 单进程事件循环中的 Cron tick 互斥标志。
    cronRunning = false;
  }
}

export function startWorkflowCronTriggers() {
  if (cronTimer || process.env.DISABLE_BACKGROUND_JOBS === '1') return;
  cronTimer = setInterval(() => { void cronTick(); }, CRON_INTERVAL_MS);
  cronTimer.unref?.();
  setTimeout(() => { void cronTick(); }, 8000).unref?.();
}

export function stopWorkflowCronTriggers() {
  if (cronTimer) clearInterval(cronTimer);
  cronTimer = null;
}
