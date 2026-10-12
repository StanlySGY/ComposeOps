import {
  listContainerStateEvents,
  listContainerStateEventsWindow,
  listContainerStateLatest,
  getContainerStateEventBefore,
  pruneContainerStateEvents,
} from '../lib/db.js';

/**
 * 容器状态历史服务:把 container_state_events 的原始转换序列换算成可用率。
 *
 * 模型(uptime-kuma 式):状态只在"转换事件"之间切换,事件本身是瞬时点,
 * 因此 [事件N, 事件N+1] 这段区间归属事件N 之后的状态;窗口起点到首个事件之间,
 * 用窗口前最近一条事件推断,推不出时再用首个事件反推(退出之前必然是运行中)。
 * 推不出的一律计入 unknownSeconds,不猜成运行或宕机 —— 可用率宁可少算也不能虚高。
 */

const RUNNING_AFTER = new Set(['start', 'unpause', 'restart']);
const DOWN_AFTER = new Set(['stop', 'die', 'kill', 'pause', 'destroy']);
// 这些事件发生前容器必然处于运行态,可在缺少窗口前历史时反推起点状态。
const UP_BEFORE = new Set(['stop', 'die', 'kill', 'pause']);

/** 事件之后的状态:up / down / null(health_status、create 不改变运行态)。 */
function stateAfter(action) {
  if (RUNNING_AFTER.has(action)) return 'up';
  if (DOWN_AFTER.has(action)) return 'down';
  return null;
}

/** 事件之前的状态(仅用于推断窗口起点),destroy 之前可能运行也可能已停止,故返回 null。 */
function stateBefore(action) {
  if (UP_BEFORE.has(action)) return 'up';
  if (RUNNING_AFTER.has(action)) return 'down';
  return null;
}

export function listStateHistory({ projectId = '', containerId = '', action = '', limit = 200 } = {}) {
  return listContainerStateEvents({ projectId, containerId, action, limit });
}

/** 窗口内每个容器的最近一次状态转换,供列表页展示"最后一次异常退出"之类的列。 */
export function listStateContainers({ projectId = '', since = 0, limit = 500 } = {}) {
  return [...listContainerStateLatest({ projectId, since, limit }).values()];
}

/**
 * 计算单个容器在窗口内的运行/宕机时长。
 * @param {Array} events 该容器窗口内的事件(升序)
 * @param {object|null} preceding 窗口起点前最近一条事件
 */
function computeContainerWindow(events, preceding, since, until) {
  const result = {
    upSeconds: 0,
    downSeconds: 0,
    unknownSeconds: 0,
    transitions: 0,
    exits: 0,
    abnormalExits: 0,
    destroyed: false,
    // 最近一次 die 的退出码与时刻。不能取"最近一条事件"的退出码:
    // 容器被 137 杀掉后自动重启,最近一条事件是 start,列表页会显示成"无退出码"。
    lastExitCode: null,
    lastExitAt: null,
  };

  let state = preceding ? stateAfter(preceding.action) : null;
  if (!state && events.length) state = stateBefore(events[0].action);

  let cursor = since;
  for (const event of events) {
    const at = Math.max(since, Math.min(Number(event.timestamp) || since, until));
    const delta = at - cursor;
    if (delta > 0) {
      if (state === 'up') result.upSeconds += delta;
      else if (state === 'down') result.downSeconds += delta;
      else result.unknownSeconds += delta;
    }
    cursor = Math.max(cursor, at);

    if (stateAfter(event.action)) result.transitions += 1;
    if (event.action === 'die') {
      result.exits += 1;
      result.lastExitCode = Number.isFinite(event.exitCode) ? event.exitCode : null;
      result.lastExitAt = at;
      // exitCode 缺失(旧事件未记录)不当作异常,避免把未知当成故障。
      if (Number.isFinite(event.exitCode) && event.exitCode !== 0) result.abnormalExits += 1;
    }
    if (event.action === 'destroy') {
      result.destroyed = true;
      break;
    }
    const next = stateAfter(event.action);
    if (next) state = next;
  }

  // 未被销毁的容器,窗口尾部延续最后一个状态。
  if (!result.destroyed && cursor < until) {
    const tail = until - cursor;
    if (state === 'up') result.upSeconds += tail;
    else if (state === 'down') result.downSeconds += tail;
    else result.unknownSeconds += tail;
  }
  return result;
}

/**
 * 窗口可用率报表:一次批量查询取全部事件,再逐容器换算。
 * @param {object} options
 * @param {string} [options.projectId] 限定项目,留空为全部纳管项目
 * @param {number} options.since 窗口起点(unix 秒)
 * @param {number} [options.until] 窗口终点,默认当前时间
 */
export function getStateUptime({ projectId = '', since, until = Date.now() / 1000 } = {}) {
  const start = Math.floor(Number(since) || 0);
  const end = Math.floor(Number(until) || Date.now() / 1000);
  const { groups, truncated } = listContainerStateEventsWindow({ projectId, since: start, until: end });

  const containers = [];
  for (const [containerId, events] of groups) {
    const latest = events[events.length - 1];
    const window = computeContainerWindow(events, getContainerStateEventBefore(containerId, start), start, end);
    const measurable = window.upSeconds + window.downSeconds;
    containers.push({
      containerId,
      containerName: latest.containerName,
      projectName: latest.projectName,
      ...window,
      // 分母只取可判定区间:未知时长不参与可用率,否则长时间无事件会被算成 100%。
      availability: measurable > 0 ? Number(((window.upSeconds / measurable) * 100).toFixed(2)) : null,
      lastAction: latest.action,
      // lastExitCode/lastExitAt 来自 computeContainerWindow(最近一次 die),
      // 不是最近一条事件 —— 重启过的容器仍要能看出上次为什么挂。
      lastEventAt: latest.timestamp,
    });
  }

  containers.sort((a, b) => (a.availability ?? 101) - (b.availability ?? 101) || a.containerName.localeCompare(b.containerName));

  const totals = containers.reduce((acc, item) => {
    acc.upSeconds += item.upSeconds;
    acc.downSeconds += item.downSeconds;
    acc.unknownSeconds += item.unknownSeconds;
    acc.transitions += item.transitions;
    acc.exits += item.exits;
    acc.abnormalExits += item.abnormalExits;
    return acc;
  }, { upSeconds: 0, downSeconds: 0, unknownSeconds: 0, transitions: 0, exits: 0, abnormalExits: 0 });
  const measurable = totals.upSeconds + totals.downSeconds;

  return {
    window: { since: start, until: end, seconds: Math.max(0, end - start) },
    truncated,
    containers,
    summary: {
      containers: containers.length,
      availability: measurable > 0 ? Number(((totals.upSeconds / measurable) * 100).toFixed(2)) : null,
      ...totals,
    },
  };
}

/** 最近 N 天的退出明细(异常退出优先),用于"最近为什么挂过"的快速定位。 */
export function listStateExits({ projectId = '', days = 7, limit = 100 } = {}) {
  const safeDays = Math.max(1, Math.min(Number(days) || 7, 365));
  const since = Math.floor(Date.now() / 1000) - safeDays * 86400;
  const { groups } = listContainerStateEventsWindow({ projectId, since, until: Date.now() / 1000 });
  const exits = [];
  for (const events of groups.values()) {
    for (const event of events) {
      if (event.action !== 'die') continue;
      exits.push({
        containerId: event.containerId,
        containerName: event.containerName,
        projectName: event.projectName,
        exitCode: event.exitCode,
        execDuration: event.execDuration,
        timestamp: event.timestamp,
        abnormal: Number.isFinite(event.exitCode) && event.exitCode !== 0,
      });
    }
  }
  // 异常退出排前面,同码按时间倒序。
  exits.sort((a, b) => Number(b.abnormal) - Number(a.abnormal) || b.timestamp - a.timestamp);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
  return { exits: exits.slice(0, safeLimit), total: exits.length };
}

export function pruneStateHistory(days = 90) {
  return pruneContainerStateEvents(days);
}
