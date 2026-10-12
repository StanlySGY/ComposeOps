import { getActivityDocker, getActiveHostId, onActiveHostChange } from './docker-hosts.js';
import { createLineDecoder } from '../lib/line-decoder.js';
import { scanProjects } from './scanner.js';
import { composeProjectId } from './project-id.js';
import { addContainerStateEvent, getProjectPreference } from '../lib/db.js';

/**
 * 容器状态变化实时推送服务
 * 监听 Docker Events API,过滤容器相关事件,广播给订阅的 WebSocket 客户端
 */

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_WORKDIR_LABEL = 'com.docker.compose.project.working_dir';

const SUBSCRIBERS = new Set(); // Set<Function>
let eventSession = null;
let unsubscribeHostChange = null;
let recorderUnsubscribe = null;

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
 * 常驻状态记录器:把容器状态转换写进 container_state_events。
 * 事件流原本只在有 WebSocket 订阅者时运行,历史会在最后一个浏览器关闭后停止累积;
 * 记录器自己作订阅者,宕机历史与可用率统计才能跨重启保留(uptime-kuma 式持久化的前提)。
 * @returns {Function} 停止记录的函数
 */
export function startStateRecorder() {
  if (recorderUnsubscribe || process.env.DISABLE_BACKGROUND_JOBS === '1') return recorderUnsubscribe || (() => {});
  recorderUnsubscribe = subscribeContainerEvents(persistContainerStateEvent);
  return recorderUnsubscribe;
}

export function stopStateRecorder() {
  recorderUnsubscribe?.();
  recorderUnsubscribe = null;
}

/** 落库失败只记日志:状态历史是旁路观测,不该打断实时广播,也不该打断事件流本身。 */
function persistContainerStateEvent(payload) {
  try {
    addContainerStateEvent({
      containerId: payload.containerId,
      containerName: payload.containerName,
      projectId: payload.projectId,
      projectName: payload.projectName,
      action: payload.action,
      healthStatus: payload.healthStatus || '',
      exitCode: payload.action === 'die' ? payload.attributes?.exitCode : null,
      execDuration: payload.action === 'die' ? payload.attributes?.execDuration : null,
      timestamp: payload.timestamp,
    });
  } catch (error) {
    console.error('[container-events] 状态历史写入失败:', error.message);
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
 * 从事件自带的 compose 标签还原项目标识。
 * create/destroy 事件在 listContainers 快照里可能缺席(销毁后容器已不在列表、创建后 3s 缓存尚未刷新),
 * 但 Docker 把 compose 标签一并放进 Actor.Attributes,与 scanner 用同一套标签+同一哈希就能得到同一个 id。
 */
function resolveProjectFromLabels(attributes = {}) {
  const projectName = attributes[COMPOSE_PROJECT_LABEL];
  if (!projectName) return null;
  const workingDir = attributes[COMPOSE_WORKDIR_LABEL] || '';
  const projectId = composeProjectId(workingDir, projectName);
  if (!getProjectPreference(projectId).managed) return null;
  return { id: projectId, projectName };
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
  ) || resolveProjectFromLabels(attributes);

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
