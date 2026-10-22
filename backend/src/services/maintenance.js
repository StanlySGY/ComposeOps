import { getActivityDocker } from './docker-hosts.js';
import { sendNotification } from './notifications.js';
import { setSetting } from '../lib/db.js';
import db, { pruneAgentPlans, pruneAiUsage, pruneOperationHistory, COMPOSE_BACKUP_KEEP } from '../lib/db.js';
import { pruneEvents } from './event-center.js';
import { pruneStateHistory } from './state-history.js';
import { checkAllUpdates } from './image-updater.js';

function sum(items, key) {
  return (items || []).reduce((total, item) => total + (Number(item?.[key]) || 0), 0);
}

export async function getDockerUsage() {
  // 跟随当前活跃节点:此前固定本地 daemon,切到远程宿主后清理/检查仍操作面板本机。
  const docker = await getActivityDocker();
  const data = await docker.df();
  const imagesTotal = sum(data.Images, 'Size');
  const imagesReclaimable = sum((data.Images || []).filter((item) => Number(item.Containers) <= 0), 'Size');
  const containersReclaimable = sum((data.Containers || []).filter((item) => item.State !== 'running'), 'SizeRw');
  const buildCacheTotal = sum(data.BuildCache, 'Size');
  const buildCacheReclaimable = sum((data.BuildCache || []).filter((item) => !item.InUse), 'Size');
  const unusedVolumes = (data.Volumes || []).filter((item) => Number(item.UsageData?.RefCount) <= 0);
  const volumesReclaimable = unusedVolumes
    .reduce((total, item) => total + (Number(item.UsageData?.Size) || 0), 0);
  return {
    images: { count: data.Images?.length || 0, total: imagesTotal, reclaimable: imagesReclaimable },
    containers: { count: data.Containers?.length || 0, reclaimable: containersReclaimable },
    buildCache: { count: data.BuildCache?.length || 0, total: buildCacheTotal, reclaimable: buildCacheReclaimable },
    volumes: { count: unusedVolumes.length, reclaimable: volumesReclaimable },
    total: imagesTotal + buildCacheTotal,
    reclaimable: imagesReclaimable + containersReclaimable + buildCacheReclaimable + volumesReclaimable,
  };
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
  const { projects } = await checkAllUpdates();
  const results = flattenUpdateResults(projects);
  for (const item of results) onProgress(`检查 ${item.image}`);
  const updated = results.filter((item) => item.status === 'updated');
  if (updated.length) {
    await sendNotification('ComposeOps：发现镜像更新（等待手动应用）', updated.map((item) => `${item.projectName}/${item.service}: ${item.image}`).join('\n')).catch(() => {});
  }
  setSetting('updates.last_results', JSON.stringify(results));
  return results;
}

export async function pruneDocker({ images = true, buildCache = true, containers = false, volumes = false }) {
  const docker = await getActivityDocker();
  const result = {};
  if (images) result.images = await docker.pruneImages({ filters: { dangling: ['false'] } });
  if (buildCache) result.buildCache = await docker.pruneBuilds();
  if (containers) result.containers = await docker.pruneContainers();
  if (volumes) result.volumes = await docker.pruneVolumes();
  return result;
}

/* ---------------------------------------------------------------------------
 * 数据维护:周期清理无上限增长只追加的历史表。
 * 与上述 Docker 清理同属 maintenance,故归置一处。
 * 定时任务用 setInterval.unref(),不阻塞进程退出。
 * ------------------------------------------------------------------------- */

const DATA_DEFAULTS = {
  agentPlansDays: 90,        // agent_plans(含 CASCADE agent_executions)保留天数
  operationHistoryDays: 30,  // operation_history 保留天数
  aiHistoryDays: 30,         // ai_history 保留天数
  stateHistoryDays: 90,      // container_state_events 保留天数(每行不足 200 B,90 天足够回看宕机规律)
  composeBackupKeep: COMPOSE_BACKUP_KEEP, // 与 addComposeBackup 共用同一常量,避免"写入留 20 份、清理裁 5 份"的漂移
  runIntervalMs: 6 * 60 * 60 * 1000, // 每 6 小时
};

/** 清理超过保留天数的 AI 对话历史。 */
export function pruneDataHistory({ aiHistoryDays, operationHistoryDays, agentPlansDays, stateHistoryDays } = {}) {
  const clear = {
    aiHistoryDays,
    operationHistoryDays,
    agentPlansDays,
    stateHistoryDays,
  };
  const days = clear.aiHistoryDays ?? DATA_DEFAULTS.aiHistoryDays;
  const safeDays = Math.max(1, Math.min(Math.floor(Number(days) || 30), 3650));
  const ai = db.prepare(
    "DELETE FROM ai_history WHERE julianday('now') - julianday(created_at) > ?"
  ).run(safeDays);
  const aiUsage = pruneAiUsage(safeDays);

  const opDays = clear.operationHistoryDays ?? DATA_DEFAULTS.operationHistoryDays;
  const operations = pruneOperationHistory(opDays);

  const planDays = clear.agentPlansDays ?? DATA_DEFAULTS.agentPlansDays;
  const agent = pruneAgentPlans(planDays);

  // 状态历史只追加,不清理会随 health_status 抖动无限增长。
  let stateEvents = 0;
  try { stateEvents = pruneStateHistory(clear.stateHistoryDays ?? DATA_DEFAULTS.stateHistoryDays).changes; } catch { /* 表缺失等异常不阻断其他清理。 */ }

  return {
    aiHistoryDeleted: ai.changes,
    aiUsageDeleted: aiUsage.changes,
    operationHistoryDeleted: operations.changes,
    agentPlansDeleted: agent.changes,
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
export function runDataMaintenance() {
  const history = pruneDataHistory();
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
