import { WebSocket } from 'ws';
import { findProjectContainer } from '../services/scanner.js';
import { getBackgroundJob } from '../lib/db.js';
import { subscribeJobEvents } from '../services/job-events.js';
import { getActivityDocker } from '../services/docker-hosts.js';
import { aggregateProjectLogs } from '../services/log-aggregator.js';
import { subscribeEvents } from '../services/events.js';
import { followContainerLogs } from '../services/docker-log-stream.js';
import { subscribeContainerEvents, getContainersSnapshot } from '../services/container-events.js';

/** Web Shell 会话上限与超时(防连接泄漏 / 占坑不操作)。 */
const MAX_EXEC_SESSIONS = 20;
const EXEC_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟无活动自动回收
const activeExecSessions = new Map(); // socket -> { idleTimer, destroyed }

export { MAX_EXEC_SESSIONS, EXEC_SESSION_TIMEOUT_MS, activeExecSessions };

/**
 * 释放 Web Shell 会话占用。路由中的 Docker exec 建立可能在 socket 已登记后
 * 失败，因此清理必须独立且幂等，不能只依赖 close/end 事件。
 */
export function teardownExecSession(socket) {
  const session = activeExecSessions.get(socket);
  if (!session) return false;
  session.destroyed = true;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  activeExecSessions.delete(socket);
  return true;
}

/**
 * WebSocket 路由：实时日志流与容器 Web Shell。
 *
 * - GET/WS /api/v1/ws/logs?containerId=<id>&tail=200
 *     绑定 Docker API /containers/{id}/logs?follow=true&stdout=true&stderr=true
 * - GET/WS /api/v1/ws/exec?containerId=<id>[&cmd=sh]
 *     基于 xterm.js 的交互式容器 shell
 *
 * 这些路由挂在 /ws 前缀（不经过 /api/v1），方便 nginx 反代区分。
 */
export default async function wsRoutes(fastify) {
  // ---- 容器状态实时推送 ----
  fastify.get('/containers', { websocket: true }, async (socket) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const unsubscribe = subscribeContainerEvents(event => safeSend(socket, event));
    socket.once('close', unsubscribe);
    // 先登记清理,避免快照请求期间断开后留下订阅。
    try {
      const snapshot = await getContainersSnapshot();
      safeSend(socket, snapshot);
    } catch (e) {
      safeSend(socket, { type: 'error', data: e.message });
    }

  });

  // ---- 告警事件实时流 ----
  fastify.get('/events', { websocket: true }, async (socket) => {
    const unsubscribe = subscribeEvents((event) => {
      safeSend(socket, { type: 'event', data: event });
    });
    socket.on('close', unsubscribe);
  });

  // ---- 批量任务进度推送 ----
  fastify.get('/jobs', { websocket: true }, async (socket, request) => {
    const { jobId } = request.query;
    if (jobId) {
      const job = getBackgroundJob(String(jobId));
      if (!job) {
        safeSend(socket, { type: 'error', data: 'job not found' });
        return socket.close();
      }
      // 先发当前全量快照，避免依赖连接时序丢状态；DB 为唯一事实来源。
      safeSend(socket, { type: 'snapshot', job });
    }
    const unsubscribe = subscribeJobEvents(({ jobId: id, event, ...rest }) => {
      if (id !== jobId) return; // 只推订阅的任务
      const job = getBackgroundJob(id);
      if (!job) return;
      safeSend(socket, { type: 'update', event, ...rest, job });
    });
    socket.on('close', unsubscribe);
  });

  // ---- 实时日志流 ----
  fastify.get('/logs', { websocket: true }, async (socket, request) => {
    const controller = socketAbortController(socket);
    const { projectId, containerId, tail = 200 } = request.query;
    try {
      if (!projectId || !containerId) throw new Error('缺少项目或容器');
      const match = await findProjectContainer(projectId, containerId);
      if (controller.signal.aborted) return;
      if (match.project && !match.project.managed) throw new Error('项目尚未加入管理');
      if (!match.container) throw new Error('项目中未找到该容器');
      await followContainerLogs({
        container: getActivityDocker().getContainer(match.container.id), tail, signal: controller.signal,
        onLine: line => safeSend(socket, line),
        onError: error => safeSend(socket, { type: 'error', data: error.message }),
        onEnd: () => {
          safeSend(socket, { type: 'end', data: '日志流已结束' });
          socket.close();
        },
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        safeSend(socket, { type: 'error', data: error.message });
        safeSend(socket, { type: 'end', data: '日志连接未建立' });
        socket.close();
      }
    }
  });

  // ---- 多容器聚合日志流 ----
  fastify.get('/aggregated-logs', { websocket: true }, async (socket, request) => {
    const controller = socketAbortController(socket);
    const { projectId, containers, tail = 200 } = request.query;
    try {
      if (!projectId) throw new Error('缺少项目');
      const { findProject } = await import('../services/scanner.js');
      const project = await findProject(String(projectId));
      if (controller.signal.aborted) return;
      if (!project) throw new Error('项目不存在');
      if (!project.managed) throw new Error('项目尚未加入管理');
      const ids = String(containers || '').split(',').map(item => item.trim()).filter(Boolean);
      const aggregator = await aggregateProjectLogs({
        project, containerIds: ids, tail, signal: controller.signal,
        onLine: line => safeSend(socket, { type: 'line', data: line }),
        onError: error => safeSend(socket, { type: 'error', data: `${error.containerName}: ${error.message}` }),
        onEnd: () => {
          safeSend(socket, { type: 'end', data: '所有容器日志流已结束' });
          socket.close();
        },
      });
      safeSend(socket, { type: 'meta', data: { count: aggregator.count } });
    } catch (error) {
      if (!controller.signal.aborted) {
        safeSend(socket, { type: 'error', data: error.message });
        safeSend(socket, { type: 'end', data: '聚合日志连接未建立' });
        socket.close();
      }
    }
  });

  // ---- 容器 Web Shell ----
  fastify.get('/exec', { websocket: true }, async (socket, request) => {
    if (process.env.ENABLE_SHELL !== '1') {
      socket.send(JSON.stringify({ type: 'error', data: 'Web Shell 未启用' }));
      return socket.close();
    }
    if (activeExecSessions.size >= MAX_EXEC_SESSIONS) {
      socket.send(JSON.stringify({ type: 'error', data: `Web Shell 会话数已达上限(${MAX_EXEC_SESSIONS}),请先关闭其它会话` }));
      return socket.close();
    }
    const { projectId, containerId, cmd = 'sh' } = request.query;
    if (!projectId || !containerId) {
      socket.send(JSON.stringify({ type: 'error', data: 'missing projectId or containerId' }));
      return socket.close();
    }
    if (!['sh', 'bash'].includes(cmd)) {
      socket.send(JSON.stringify({ type: 'error', data: '只允许 sh 或 bash' }));
      return socket.close();
    }
    if (socket.readyState !== WebSocket.OPEN) return;
    // 在第一次 await 前占位并绑定释放,并发初始化也计入上限。
    const session = { idleTimer: null, destroyed: false };
    activeExecSessions.set(socket, session);
    let exec;
    let stream;
    let pendingInput = [];
    let pendingBytes = 0;
    let pendingResize = null;
    function teardown() {
      teardownExecSession(socket);
      socket.removeListener('message', onMessage);
      pendingInput = [];
      pendingBytes = 0;
      pendingResize = null;
      stream?.destroy();
    }
    function refreshIdle() {
      if (session.destroyed) return;
      clearTimeout(session.idleTimer);
      session.idleTimer = setTimeout(() => {
        safeSend(socket, { type: 'error', data: '会话因超过 30 分钟无操作已自动关闭' });
        teardown();
        socket.close();
      }, EXEC_SESSION_TIMEOUT_MS);
      session.idleTimer.unref?.();
    }
    function onMessage(data, isBinary) {
      if (session.destroyed) return;
      refreshIdle();
      if (!isBinary) {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'resize') {
            if (Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols > 0 && message.rows > 0 && message.cols <= 1000 && message.rows <= 1000) {
              const size = { w: message.cols, h: message.rows };
              if (stream) void exec.resize(size).catch(() => {});
              else pendingResize = size;
            }
            return;
          }
        } catch { /* 普通终端输入继续按字节透传。 */ }
      }
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!stream) {
        if (pendingBytes + bytes.length > 64 * 1024) {
          safeSend(socket, { type: 'error', data: '终端初始化期间输入过多,请重新连接后再粘贴' });
          teardown();
          socket.close();
          return;
        }
        pendingInput.push(bytes);
        pendingBytes += bytes.length;
      } else if (stream.writable) stream.write(bytes);
    }
    socket.once('close', teardown);
    socket.on('message', onMessage);
    refreshIdle();
    try {
      const match = await findProjectContainer(projectId, containerId);
      if (session.destroyed) return;
      if (match.project && !match.project.managed) throw new Error('项目尚未加入管理');
      if (!match.container) throw new Error('项目中未找到该容器');
      const container = getActivityDocker().getContainer(match.container.id);
      exec = await container.exec({ AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: [cmd] });
      if (session.destroyed) return;
      stream = await exec.start({ hijack: true, stdin: true, Tty: true });
      if (session.destroyed) { stream.destroy(); return; }
      stream.on('data', bytes => {
        if (socket.readyState === WebSocket.OPEN) socket.send(bytes);
      });
      stream.on('error', error => {
        safeSend(socket, { type: 'error', data: error.message });
        teardown();
        socket.close();
      });
      stream.on('end', () => { teardown(); socket.close(); });
      stream.on('close', () => { teardown(); socket.close(); });
      if (pendingResize) void exec.resize(pendingResize).catch(() => {});
      pendingResize = null;
      for (const bytes of pendingInput) if (stream.writable) stream.write(bytes);
      pendingInput = [];
      pendingBytes = 0;
    } catch (error) {
      if (!session.destroyed) safeSend(socket, { type: 'error', data: error.message });
      teardown();
      socket.close();
    }
  });
}

function safeSend(socket, payload) {
  try {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  } catch { /* WebSocket 路由清理必须保持幂等。 */ }
}

/** 在任何异步初始化之前绑定断连,迟到的 Docker 流由同一 signal 回收。 */
function socketAbortController(socket) {
  const controller = new AbortController();
  socket.once('close', () => controller.abort());
  if (socket.readyState !== WebSocket.OPEN) controller.abort();
  return controller;
}
