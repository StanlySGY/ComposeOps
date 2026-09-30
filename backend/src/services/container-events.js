import { getActivityDocker, getActiveHostId, onActiveHostChange } from './docker-hosts.js';
import { createLineDecoder } from '../lib/line-decoder.js';
import { scanProjects } from './scanner.js';

/**
 * 容器状态变化实时推送服务
 * 监听 Docker Events API,过滤容器相关事件,广播给订阅的 WebSocket 客户端
 */

const SUBSCRIBERS = new Set(); // Set<Function>
let eventSession = null;
let unsubscribeHostChange = null;

/**
 * 订阅容器状态变化事件
 * @param {Function} callback 接收事件的回调函数
 * @returns {Function} 退订函数
 */
export function subscribeContainerEvents(callback) {
  if (typeof callback !== 'function') return () => {};
  SUBSCRIBERS.add(callback);
  if (!unsubscribeHostChange) unsubscribeHostChange = onActiveHostChange(() => {
    stopDockerEventStream();
    void startDockerEventStream();
  });
  if (eventSession && eventSession.hostId !== getActiveHostId()) stopDockerEventStream();
  if (!eventSession) void startDockerEventStream();
  return () => {
    SUBSCRIBERS.delete(callback);
    // 无订阅者时停止事件流
    if (SUBSCRIBERS.size === 0) {
      unsubscribeHostChange?.();
      unsubscribeHostChange = null;
      stopDockerEventStream();
    }
  };
}

/**
 * 广播容器事件到所有订阅者
 * @param {object} event 容器事件对象
 */
function broadcastEvent(event) {
  for (const subscriber of SUBSCRIBERS) {
    try {
      subscriber(event);
    } catch (error) {
      console.error('[container-events] 订阅者回调失败:', error);
    }
  }
}

/**
 * 启动 Docker Events 流监听
 */
async function startDockerEventStream() {
  if (eventSession || !SUBSCRIBERS.size) return;
  const session = { hostId: getActiveHostId(), stream: null, timer: null, ending: false };
  eventSession = session;
  const current = () => eventSession === session && SUBSCRIBERS.size > 0;
  function attachStream(stream) {
    if (!current()) { stream.destroy(); return false; }
    session.stream = stream;
    return true;
  }
  function reconnect() {
    if (!current() || session.ending) return;
    session.ending = true;
    session.stream?.destroy();
    session.timer = setTimeout(() => {
      if (!current()) return;
      eventSession = null;
      void startDockerEventStream();
    }, 3000);
    session.timer.unref?.();
  }
  try {
    const stream = await getActivityDocker().getEvents({ filters: {
      type: ['container'],
      event: ['start', 'stop', 'die', 'kill', 'pause', 'unpause', 'restart', 'health_status', 'create', 'destroy'],
    } });
    if (!attachStream(stream)) return;
    let queue = Promise.resolve();
    const decoder = createLineDecoder(line => {
      if (!line.trim()) return;
      // 按完整 JSON 行解析,一条坏事件不应丢弃同 chunk 的其它事件。
      try {
        const event = JSON.parse(line);
        queue = queue.then(() => current() && handleDockerEvent(event, current))
          .catch(error => console.error('[container-events] 事件处理失败:', error.message));
      } catch (error) { console.error('[container-events] 事件解析失败:', error.message); }
    });
    stream.on('data', chunk => { if (current()) decoder.write(chunk); });
    stream.on('end', () => { decoder.end(); reconnect(); });
    stream.on('error', error => { console.error('[container-events] Docker 事件流错误:', error.message); reconnect(); });
    stream.on('close', reconnect);
  } catch (error) {
    if (!current()) return;
    console.error('[container-events] 启动 Docker 事件流失败:', error.message);
    reconnect();
  }
}

/** 停止期间清除会话身份,迟到的 getEvents 与旧重连定时器都不能重新占用流。 */
function stopDockerEventStream() {
  const session = eventSession;
  eventSession = null;
  if (!session) return;
  clearTimeout(session.timer);
  session.stream?.destroy();
}

/**
 * 处理单个 Docker 事件
 * @param {object} event Docker Events API 返回的事件对象
 */
async function handleDockerEvent(event, current = () => true) {
  // 过滤: 只处理容器事件
  if (event.Type !== 'container') return;

  const containerId = event.Actor?.ID;
  const action = event.Action; // start, stop, die, kill, health_status 等
  const attributes = event.Actor?.Attributes || {};

  // 查找该容器所属的项目
  let projects;
  try {
    const result = await scanProjects();
    projects = result.filter((p) => p.managed); // 仅推送已纳管项目
  } catch (error) {
    console.error('[container-events] 扫描项目失败:', error.message);
    return;
  }

  if (!current()) return;

  // 定位包含此容器的项目
  const matchedProject = projects.find((project) =>
    project.containers.some((container) => container.id === containerId)
  );

  if (!matchedProject) {
    // 容器不属于任何纳管项目,忽略
    return;
  }

  // 构造推送事件
  const payload = {
    type: 'container_event',
    action, // start, stop, die, kill, pause, unpause, restart, health_status, create, destroy
    containerId,
    projectId: matchedProject.id,
    projectName: matchedProject.projectName,
    containerName: attributes['com.docker.compose.service'] || attributes.name || containerId.slice(0, 12),
    timestamp: event.time || Date.now() / 1000,
    attributes,
  };

  // 健康检查事件特殊处理
  if (String(action).startsWith('health_status')) {
    payload.healthStatus = attributes.health_status || action.split(':')[1]?.trim(); // healthy, unhealthy, starting
  }

  // 广播给所有订阅者
  broadcastEvent(payload);
}

/**
 * 手动触发全量容器状态刷新(用于 WebSocket 连接时的初始快照)
 * @returns {Promise<object>} 返回当前所有项目和容器状态
 */
export async function getContainersSnapshot() {
  try {
    const result = await scanProjects();
    return {
      type: 'snapshot',
      projects: result,
      timestamp: Date.now(),
    };
  } catch (error) {
    const wrappedError = new Error(`获取容器快照失败: ${error.message}`);
    wrappedError.cause = error;
    throw wrappedError;
  }
}
