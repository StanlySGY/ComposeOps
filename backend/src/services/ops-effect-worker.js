import os from 'node:os';
import { randomUUID } from 'node:crypto';
import docker from './docker.js';
import db from '../lib/db.js';
import { redactSecretValue } from '../lib/secret-redactor.js';
import {
  claimNextOpsEffect, startOpsEffect, heartbeatOpsEffect,
  completeOpsEffect, rejectOpsEffect,
} from './ops-tickets.js';

const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/i;
const MAX_CONTAINERS = 200;

// Closed registry: untrusted Effect rows and UI input can never add handlers.
const ACTIONS = Object.freeze({
  'service.inspect': Object.freeze({ readOnly: true, idempotent: true, maxRisk: 'low' }),
  'container.inspect': Object.freeze({ readOnly: true, idempotent: true, maxRisk: 'low' }),
});
const riskRank = { low: 0, medium: 1, high: 2, critical: 3 };
const safeError = (error) => redactSecretValue(String(error?.message || error || 'Worker 执行失败')).slice(0, 1000);

function projectName(target) {
  const value = String(target?.composeProject || '').trim();
  if (!PROJECT_NAME.test(value)) throw new Error('必须提供有效的 Compose 项目名（仅允许字母、数字、点、下划线和连字符）');
  return value;
}

function validateEffect(effect) {
  const action = ACTIONS[effect.effectType];
  if (!action) return '不支持动作 ' + effect.effectType + '；当前仅允许 service.inspect 和 container.inspect';
  if (effect.mode !== 'execute') return '只有 Execute 模式的意图可以进入派发';
  if (!effect.approvedBy || !effect.approvedAt) return '缺少人工审批记录，拒绝派发';
  if (riskRank[effect.risk] === undefined || riskRank[effect.risk] > riskRank[action.maxRisk]) return '当前动作最高只接受 ' + action.maxRisk + ' 风险，拒绝 ' + effect.risk + ' 风险请求';
  if (!action.readOnly || !action.idempotent) return '动作未通过只读与幂等安全约束';
  if (effect.target?.hostId) return '当前 Worker 仅连接本机 Docker Engine，不支持远程 Host 派发';
  if (!effect.payload || typeof effect.payload !== 'object' || Array.isArray(effect.payload) || Object.keys(effect.payload).length) return '当前只读动作不接受额外参数；请使用空 JSON 对象 {}';
  try { projectName(effect.target); } catch (error) { return error.message; }
  if (effect.effectType === 'service.inspect' && effect.target?.resourceId) return 'service.inspect 不接受 resourceId；请使用 container.inspect';
  if (effect.effectType === 'container.inspect' && !CONTAINER_ID.test(String(effect.target?.resourceId || ''))) {
    return 'container.inspect 必须提供 12–64 位十六进制容器 ID';
  }
  return '';
}

function containerSummary(item) {
  const labels = item.Labels || {};
  return {
    id: String(item.Id || '').slice(0, 12),
    names: (item.Names || []).map((name) => String(name).replace(/^\/+/, '')).slice(0, 8),
    image: String(item.Image || ''),
    state: String(item.State || ''),
    status: String(item.Status || ''),
    createdAt: Number.isFinite(Number(item.Created)) ? new Date(Number(item.Created) * 1000).toISOString() : null,
    composeProject: String(labels[PROJECT_LABEL] || ''),
    composeService: String(labels[SERVICE_LABEL] || ''),
  };
}

async function inspectService({ dockerClient, target }) {
  const name = projectName(target);
  const rows = await dockerClient.listContainers({ all: true, filters: { label: [PROJECT_LABEL + '=' + name] } });
  const matching = (Array.isArray(rows) ? rows : []).filter((item) => item.Labels?.[PROJECT_LABEL] === name);
  return redactSecretValue({
    composeProject: name,
    count: matching.length,
    containers: matching.slice(0, MAX_CONTAINERS).map(containerSummary),
    truncated: matching.length > MAX_CONTAINERS,
    readOnly: true,
  });
}

async function inspectContainer({ dockerClient, target }) {
  const name = projectName(target);
  const resourceId = String(target.resourceId || '');
  if (!CONTAINER_ID.test(resourceId)) throw new Error('容器 ID 格式无效');
  const item = await dockerClient.getContainer(resourceId).inspect();
  const labels = item.Config?.Labels || {};
  if (labels[PROJECT_LABEL] !== name) throw new Error('目标容器不属于授权的 Compose 项目，已拒绝返回详情');
  const state = item.State || {};
  return redactSecretValue({
    id: String(item.Id || '').slice(0, 12),
    name: String(item.Name || '').replace(/^\/+/, ''),
    image: String(item.Config?.Image || ''),
    imageId: String(item.Image || ''),
    state: {
      status: String(state.Status || ''),
      running: Boolean(state.Running),
      paused: Boolean(state.Paused),
      restarting: Boolean(state.Restarting),
      oomKilled: Boolean(state.OOMKilled),
      exitCode: Number.isFinite(Number(state.ExitCode)) ? Number(state.ExitCode) : null,
      startedAt: state.StartedAt || null,
      finishedAt: state.FinishedAt || null,
    },
    composeProject: String(labels[PROJECT_LABEL] || ''),
    composeService: String(labels[SERVICE_LABEL] || ''),
    createdAt: item.Created || null,
    readOnly: true,
  });
}

export function createOpsEffectWorker({
  dockerClient = docker,
  workerId = 'ops-effect-' + os.hostname() + '-' + process.pid + '-' + randomUUID().slice(0, 8),
  pollMs = 3000,
  leaseSeconds = 60,
  logger = console,
} = {}) {
  const interval = Math.max(1000, Math.min(Number(pollMs) || 3000, 60000));
  const lease = Math.max(10, Math.min(Number(leaseSeconds) || 60, 600));
  let state = 'stopped';
  let timer = null;
  let inFlight = null;
  let lastStartedAt = null;
  let lastFinishedAt = null;
  let lastError = '';
  let processed = 0;
  let rejected = 0;

  const status = () => ({
    state, enabled: state === 'running', workerId, pollMs: interval, leaseSeconds: lease,
    readOnlyOnly: true,
    supportedActions: Object.entries(ACTIONS).map(([effectType, meta]) => ({ effectType, ...meta })),
    unsupportedExamples: ['image.pull', 'compose.up', 'compose.down', 'container.restart', 'container.remove', 'volume.delete', 'shell.exec'],
    queueDepth: Number(db.prepare("SELECT COUNT(*) AS count FROM ops_effects WHERE status='queued'").get().count) || 0,
    outcomeUnknown: Number(db.prepare("SELECT COUNT(*) AS count FROM ops_effects WHERE status='outcome_unknown'").get().count) || 0,
    leased: Number(db.prepare("SELECT COUNT(*) AS count FROM ops_effects WHERE status='leased'").get().count) || 0,
    executing: Number(db.prepare("SELECT COUNT(*) AS count FROM ops_effects WHERE status='executing'").get().count) || 0,
    processed, rejected, lastStartedAt, lastFinishedAt, lastError,
  });

  async function runOnce() {
    const effect = claimNextOpsEffect(workerId, lease);
    if (!effect) return { processed: false, effect: null };
    const invalidReason = validateEffect(effect);
    if (invalidReason) {
      try {
        const result = rejectOpsEffect(effect.id, workerId, invalidReason);
        rejected += 1;
        return { processed: true, status: result.status, effect: result };
      } catch (error) {
        lastError = safeError(error);
        logger.error?.({ effectId: effect.id, error: lastError }, 'Effect Worker could not reject an unsupported intent');
        return { processed: true, status: 'lease_lost', effectId: effect.id, error: lastError };
      }
    }

    let started = false;
    let heartbeatTimer = null;
    let heartbeatError = null;
    try {
      startOpsEffect(effect.id, workerId);
      started = true;
      lastStartedAt = new Date().toISOString();
      heartbeatTimer = setInterval(() => {
        try { heartbeatOpsEffect(effect.id, workerId, lease); }
        catch (error) { heartbeatError = error; clearInterval(heartbeatTimer); }
      }, Math.max(3000, Math.floor((lease * 1000) / 3)));
      heartbeatTimer.unref?.();

      const result = effect.effectType === 'service.inspect'
        ? await inspectService({ dockerClient, target: effect.target })
        : await inspectContainer({ dockerClient, target: effect.target });

      if (heartbeatError) throw heartbeatError;
      const completed = completeOpsEffect(effect.id, workerId, { success: true, result });
      processed += 1;
      lastFinishedAt = new Date().toISOString();
      lastError = '';
      return { processed: true, status: completed.status, effect: completed };
    } catch (error) {
      const message = safeError(error);
      lastError = message;
      if (!started) {
        const current = db.prepare('SELECT status FROM ops_effects WHERE id=?').get(effect.id);
        return { processed: true, status: current?.status || 'rejected', effectId: effect.id, error: message };
      }
      if (heartbeatError) {
        logger.warn?.({ effectId: effect.id, error: message }, 'Effect Worker lost its lease; outcome reconciliation is required');
        return { processed: true, status: 'lease_lost', effectId: effect.id, error: message };
      }
      try {
        const completed = completeOpsEffect(effect.id, workerId, { success: false, error: message, result: { readOnly: true } });
        processed += 1;
        lastFinishedAt = new Date().toISOString();
        return { processed: true, status: completed.status, effect: completed, error: message };
      } catch (completionError) {
        lastError = safeError(completionError);
        logger.error?.({ effectId: effect.id, error: lastError }, 'Effect Worker could not persist execution outcome');
        return { processed: true, status: 'outcome_unknown_pending_recovery', effectId: effect.id, error: lastError };
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }

  function tick() {
    if (state !== 'running' || inFlight) return;
    inFlight = runOnce()
      .catch((error) => {
        lastError = safeError(error);
        logger.error?.({ error: lastError }, 'Effect Worker poll failed');
      })
      .finally(() => { inFlight = null; });
  }

  function start() {
    if (state === 'running') return stop;
    state = 'running';
    lastError = '';
    tick();
    timer = setInterval(tick, interval);
    timer.unref?.();
    return stop;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    state = 'stopped';
    return inFlight || Promise.resolve();
  }

  return { start, stop, runOnce, getStatus: status };
}

let singleton = null;
export function startOpsEffectWorker(options = {}) {
  if (singleton) return () => stopOpsEffectWorker();
  singleton = createOpsEffectWorker(options);
  return singleton.start();
}
export function stopOpsEffectWorker() {
  if (!singleton) return null;
  const pending = singleton.stop();
  singleton = null;
  return pending;
}
export function getOpsEffectWorkerStatus() {
  if (singleton) return singleton.getStatus();
  return {
    state: 'stopped', enabled: false, readOnlyOnly: true,
    supportedActions: Object.entries(ACTIONS).map(([effectType, meta]) => ({ effectType, ...meta })),
    unsupportedExamples: ['image.pull', 'compose.up', 'compose.down', 'container.restart', 'container.remove', 'volume.delete', 'shell.exec'],
    queueDepth: Number(db.prepare("SELECT COUNT(*) AS count FROM ops_effects WHERE status='queued'").get().count) || 0,
    outcomeUnknown: Number(db.prepare("SELECT COUNT(*) AS count FROM ops_effects WHERE status='outcome_unknown'").get().count) || 0,
    leased: Number(db.prepare("SELECT COUNT(*) AS count FROM ops_effects WHERE status='leased'").get().count) || 0,
    executing: Number(db.prepare("SELECT COUNT(*) AS count FROM ops_effects WHERE status='executing'").get().count) || 0,
    processed: 0, rejected: 0, lastStartedAt: null, lastFinishedAt: null, lastError: '',
  };
}
