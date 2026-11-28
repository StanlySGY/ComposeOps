import { archiveCompletedRunEvents } from './data-lifecycle.js';
import { getActiveHostId, getDockerForHost, listHosts } from './docker-hosts.js';
import { readDockerDiskUsage, diskUsageFailure } from './docker-disk-usage.js';
import { sendNotification } from './notifications.js';
import { setSetting } from '../lib/db.js';
import db, { pruneAiData, pruneOperationHistory, COMPOSE_BACKUP_KEEP } from '../lib/db.js';
import { pruneEvents } from './event-center.js';
import { pruneStateHistory } from './state-history.js';
import { storageHostScope } from './storage-host-scope.js';
import { pruneStorageResources } from './docker-storage.js';
import { summarizeDockerDiskUsage } from '../lib/docker-storage-summary.js';
import { checkAllUpdates } from './image-updater.js';

function sum(items, key) {
  return (items || []).reduce((total, item) => total + (Number(item?.[key]) || 0), 0);
}

export async function getDockerUsage(hostId = getActiveHostId(), { timeoutMs = 60000 } = {}) {
  hostId = hostId || getActiveHostId();
  // Resolve before collecting: an unknown explicit node is a 404, not an empty total.
  const selected = (hostId === 'all' ? listHosts().map(host => host.id) : [hostId])
    .map(id => ({ id, docker: getDockerForHost(id), scope: storageHostScope(id) }));
  const snapshots = await Promise.all(selected.map(async ({ id, scope }) => {
    try {
      const data = await readDockerDiskUsage(id, { timeoutMs });
      if (storageHostScope(id).hostRevision !== scope.hostRevision) throw Object.assign(new Error('节点配置已变化'), { code: 'DISK_SCAN_SCOPE_CHANGED' });
      return { id, data: summarizeDockerDiskUsage(data), scope };
    } catch (error) {
      return { id, data: null, error };
    }
  }));
  const unavailable = snapshots.filter(item => !item.data).map(item => item.id);
  const failures = snapshots.filter(item => !item.data).map(item => ({ hostId: item.id, ...diskUsageFailure(item.error) }));
  const data = snapshots.filter(item => item.data).map(item => item.data);
  if (!data.length) throw Object.assign(new Error(`节点存储暂不可用：${failures.map(item => `${item.hostId}（${item.message}）`).join('、')}`), { code: 'HOST_UNAVAILABLE', statusCode: 503, failures });
  const sections = data;
  const result = {};
  for (const key of ['images', 'containers', 'buildCache', 'volumes']) {
    result[key] = Object.fromEntries(['count', 'active', 'total', 'reclaimable', ...(key === 'volumes' ? ['orphans', 'unknown'] : [])]
      .map(field => [field, sections.reduce((total, section) => total + (section[key][field] || 0), 0)]));
  }
  return { ...result, total: sum(sections, 'total'), reclaimable: sum(sections, 'reclaimable'),
    estimated: sections.some(section => section.estimated), hostId,
    ...(hostId === 'all' ? {} : snapshots.find(item => item.data).scope), unavailableHosts: unavailable, failures };

}

/** 将雷达结果转换为设置页/通知使用的兼容格式；只读查询，不执行 docker pull。 */
export function flattenUpdateResults(projects = []) {
  return projects.flatMap((project) => (project.images || []).map((item) => ({
    projectId: project.projectId,
    projectName: project.projectName,
    service: item.service,
    image: item.image || item.service,
    status: item.hasUpdate ? 'updated' : item.status === 'failed' ? 'failed' : item.status,
    localDigest: item.localDigest || null,
    remoteDigest: item.remoteDigest || null,
    error: item.error || item.reason || '',
  })));
}

export async function checkImageUpdates(onProgress = () => {}) {
  const { projects, nodeErrors = [] } = await checkAllUpdates();
  const results = [...flattenUpdateResults(projects), ...nodeErrors.map(node => ({ hostId: node.hostId, projectName: node.hostName,
    service: '节点项目扫描', image: '节点项目扫描', status: 'failed', error: node.message }))];
  for (const item of results) onProgress(`检查 ${item.image}`);
  const updated = results.filter((item) => item.status === 'updated');
  if (updated.length) {
    await sendNotification('ComposeOps：发现镜像更新（等待手动应用）', updated.map((item) => `${item.projectName}/${item.service}: ${item.image}`).join('\n')).catch(() => {});
  }
  setSetting('updates.last_results', JSON.stringify(results));
  return results;
}

/** Compatibility endpoint uses the same scope and conservative policy as settings. */
export async function pruneDocker({ images = true, buildCache = true, containers = false, volumes = false } = {}, scope) {
  if (containers) throw Object.assign(new Error('批量清理不删除容器，请在服务页逐项确认停止容器及其数据'), { statusCode: 400 });
  return pruneStorageResources({ images, buildCache, volumes, allBuildCache: false }, scope);
}

/* ---------------------------------------------------------------------------
 * 数据维护:周期清理无上限增长只追加的历史表。
 * 与上述 Docker 清理同属 maintenance,故归置一处。
 * 定时任务用 setInterval.unref(),不阻塞进程退出。
 * ------------------------------------------------------------------------- */

const DATA_DEFAULTS = {
  operationHistoryDays: 30,  // operation_history 保留天数
  stateHistoryDays: 90,      // container_state_events 保留天数(每行不足 200 B,90 天足够回看宕机规律)
  composeBackupKeep: COMPOSE_BACKUP_KEEP, // 与 addComposeBackup 共用同一常量,避免"写入留 20 份、清理裁 5 份"的漂移
  runIntervalMs: 6 * 60 * 60 * 1000, // 每 6 小时
};

/** 清理超过保留天数的 AI 对话历史。 */
export function pruneDataHistory({ aiHistoryDays, operationHistoryDays, stateHistoryDays, now = Date.now() } = {}) {
  const ai = pruneAiData(aiHistoryDays, now);
  const operations = pruneOperationHistory(operationHistoryDays ?? DATA_DEFAULTS.operationHistoryDays);
  let stateEvents = 0;
  try { stateEvents = pruneStateHistory(stateHistoryDays ?? DATA_DEFAULTS.stateHistoryDays).changes; } catch { /* 状态表故障不阻断其他维护。 */ }
  return {
    aiHistoryDeleted: ai.history,
    aiUsageDeleted: ai.usage,
    agentExecutionsDeleted: ai.executions,
    operationHistoryDeleted: operations.changes,
    agentPlansDeleted: ai.plans,
    stateHistoryDeleted: stateEvents,
  };
}

/** 每个项目只保留最新 N 份 compose_backups。 */
export function pruneComposeBackups(keep = DATA_DEFAULTS.composeBackupKeep) {
  const safeKeep = Math.max(1, Math.min(Math.floor(Number(keep) || COMPOSE_BACKUP_KEEP), 100));
  return db.prepare(`
    DELETE FROM compose_backups
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY id DESC) AS rn
        FROM compose_backups
      ) WHERE rn <= ?
    )
  `).run(safeKeep);
}

/** 执行全部数据清理,返回各表删除行数。 */
export function runDataMaintenance(options) {
  try { archiveCompletedRunEvents(); } catch (error) { setSetting('retention.run_archive_error', error.message); console.error('[archive] 保留源数据：', error.message); }
  const history = pruneDataHistory(options);
  const backups = pruneComposeBackups();
  // event_records 此前无任何调度方调用,只增不删;纳入周期清理。
  let events = 0;
  try { events = pruneEvents().changes; } catch { /* 事件表缺失等异常不阻断其他清理。 */ }
  return {
    ...history,
    composeBackupsDeleted: backups.changes,
    eventRecordsDeleted: events,
    at: new Date().toISOString(),
  };
}

let dataTimer = null;

/** 启动周期数据清理,返回 stop 函数。 interval 不阻塞进程退出。 */
export function startDataMaintenance(intervalMs = DATA_DEFAULTS.runIntervalMs) {
  if (dataTimer) return () => {};
  const interval = setInterval(() => {
    try {
      const result = runDataMaintenance();
      console.log(`[维护] 数据清理完成:${JSON.stringify(result)}`);
    } catch (error) {
      console.error('[维护] 数据清理失败:', error.message);
    }
  }, intervalMs);
  interval.unref();

  // 启动后延迟一分钟做首次清理,避免与其它启动任务争 IO。
  const firstRun = setTimeout(() => {
    try {
      const result = runDataMaintenance();
      console.log(`[维护] 首次清理完成:${JSON.stringify(result)}`);
    } catch (error) {
      console.error('[维护] 首次清理失败:', error.message);
    }
  }, 60 * 1000);
  firstRun.unref();

  dataTimer = interval;
  return () => {
    clearInterval(interval);
    clearTimeout(firstRun);
    dataTimer = null;
  };
}
