import { recordEvent } from './event-center.js';
import { readFile } from 'fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'node:crypto';
import { pruneStorage } from './docker-storage.js';
import { checkAllUpdates } from './image-updater.js';
import { listProjectDbContainers, runDbDump } from './db-dumper.js';
import { getNotificationConfig, sendNotification } from './notifications.js';
import { scanAllProjects as scanProjects } from './scanner.js';
import db, { addAlertEvent } from '../lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CRON_DATA_FILE = process.env.CRON_DATA_FILE || path.join(__dirname, '../../data/cron-jobs.json');

const JOB_TYPES = {
  'db-backup': { label: '数据库自动备份', description: '对所有纳管项目中运行的数据库容器执行 Dump 并留存本地' },
  'prune-safe': { label: 'Docker 安全清理', description: '清理悬空镜像、退出容器与未使用构建缓存' },
  'prune-all': { label: 'Docker 自动深度清理', description: '自动清理悬空镜像、退出容器与全部未使用构建缓存;不会删除数据卷' },
  'images-check': { label: '镜像更新检查', description: '只读查询纳管项目的远端镜像更新；不会拉取或重建容器' },
  'pull-images': { label: '定时拉取镜像', description: '对所有可编辑项目执行 docker compose pull' },
  'volume-backup': { label: '数据卷备份', description: '对所有纳管项目的命名卷执行 tar 备份,保留最近份数' },
  'inspection': { label: 'AI 巡检', description: '执行一次只读巡检并留存报告(容器/磁盘/内存/备份时效)' },
};

/** 汇总镜像拉取结果;部分失败必须抛错,由调度器记录 failed 并触发告警。 */
export function summarizePullImagesResult(pulled, errors) {
  if (errors.length && !pulled) throw new Error(`拉取镜像全部失败:${errors.slice(0, 3).join(', ')}`);
  if (errors.length) throw new Error(`拉取镜像部分失败: ${pulled} 个成功,${errors.length} 个失败:${errors.slice(0, 5).join(', ')}`);
  return pulled ? `已拉取 ${pulled} 个项目的镜像` : '没有可拉取镜像的项目';
}

import { nextRunTime, validateCron } from '../lib/cron-expression.js';
export { parseField, parseCron, validateCron, nextRunTime } from '../lib/cron-expression.js';

export { JOB_TYPES };

/* ---------------- 持久化 ---------------- */

let jobs = [];
let history = [];
const fileState = { loaded: false, promise: null };

async function ensureFile() {
  if (fileState.loaded) return;
  if (!fileState.promise) fileState.promise = loadFile().finally(() => { fileState.promise = null; });
  return fileState.promise;
}

async function loadFile() {
  const saved = db.prepare('SELECT payload FROM cron_state WHERE id = 1').get();
  try {
    const raw = saved?.payload ?? await readFile(CRON_DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.jobs) || !Array.isArray(data.history)) throw new Error('任务文件结构无效');
    jobs = data.jobs;
    history = data.history;
    // 升级时为从未运行过的旧任务建立固定起点，避免补跑历史任务。
    let initialized = false;
    for (const job of jobs) {
      if (!job.scheduleFromAt && !job.lastRunAt) { job.scheduleFromAt = Date.now(); initialized = true; }
    }
    if (!saved || initialized) await persist();
    fileState.loaded = true;
  } catch (err) {
    if (err.code === 'ENOENT') { fileState.loaded = true; return; }
    addAlertEvent({ key: 'cron:persistence', title: '定时任务读取失败', detail: '原始任务文件已保留，请修复后重试', priority: 'danger', to: '/cron' });
    throw new Error('定时任务数据损坏，已阻止覆盖原文件', { cause: err });
  }
}

async function persist() {
  db.prepare('INSERT INTO cron_state(id, payload) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload')
    .run(JSON.stringify({ jobs, history }));
}

export async function listJobs() {
  await ensureFile();
  return jobs.map((job) => enrich(job));
}

export async function getJob(id) {
  await ensureFile();
  return jobs.find((job) => job.id === id) || null;
}

export async function createJob(input = {}) {
  await ensureFile();
  const type = String(input.type || '');
  if (!JOB_TYPES[type]) throw Object.assign(new Error('未知任务类型'), { statusCode: 400 });
  const name = String(input.name || '').trim().slice(0, 60);
  if (!name) throw Object.assign(new Error('请填写任务名称'), { statusCode: 400 });
  const expr = String(input.cron || '').trim();
  validateCron(expr);
  const job = {
    id: randomBytes(4).toString('hex'),
    name,
    cron: expr,
    type,
    enabled: input.enabled !== false,
    createdAt: Date.now(),
    scheduleFromAt: Date.now(),
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
  };
  jobs.push(job);
  await persist();
  return enrich(job);
}

export async function updateJob(id, patch = {}) {
  await ensureFile();
  const job = jobs.find((item) => item.id === id);
  if (!job) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
  if (patch.cron !== undefined) validateCron(patch.cron);
  if (patch.type !== undefined && !JOB_TYPES[patch.type]) throw Object.assign(new Error('未知任务类型'), { statusCode: 400 });
  if ((patch.enabled === true && !job.enabled) || (patch.cron !== undefined && String(patch.cron).trim() !== job.cron)) job.scheduleFromAt = Date.now();
  if (patch.name !== undefined) job.name = String(patch.name).trim().slice(0, 60) || job.name;
  if (patch.cron !== undefined) job.cron = String(patch.cron).trim();
  if (patch.type !== undefined) job.type = patch.type;
  if (patch.enabled !== undefined) job.enabled = !!patch.enabled;
  await persist();
  return enrich(job);
}

export async function deleteJob(id) {
  await ensureFile();
  const index = jobs.findIndex((job) => job.id === id);
  if (index < 0) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
  jobs.splice(index, 1);
  await persist();
  return { ok: true };
}

export async function listHistory(limit = 50) {
  await ensureFile();
  return history.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)));
}

export function nextScheduledRun(job) {
  if (!job.enabled) return null;
  const anchor = Math.max(Number(job.scheduleFromAt) || Number(job.createdAt) || 0, Number(job.lastRunAt) || 0);
  return anchor > 0 ? nextRunTime(job.cron, new Date(anchor)) : null;
}

function enrich(job) {
  const next = nextScheduledRun(job);
  return { ...job, nextRunAt: next ? next.getTime() : null, typeLabel: JOB_TYPES[job.type]?.label || job.type };
}

/* ---------------- 执行 ---------------- */

async function recordRun(job, status, error = '', duration) {
  job.lastRunAt = Date.now();
  job.lastStatus = status;
  job.lastError = error ? String(error).slice(0, 300) : null;
  history.unshift({
    id: randomBytes(4).toString('hex'),
    jobId: job.id,
    jobName: job.name,
    type: job.type,
    status,
    error: error ? String(error).slice(0, 500) : '',
    durationMs: Math.round(duration),
    at: Date.now(),
  });
  history = history.slice(0, 200);
  await persist();
  recordEvent({ eventType: 'cron', source: 'cron', title: `定时任务${status === 'success' ? '完成' : '失败'} · ${job.name}`, detail: error || `${Math.round(duration)} ms`, severity: status === 'success' ? 'info' : 'warning', status: status === 'success' ? 'resolved' : 'open', payload: { jobId: job.id, runId: history[0].id, to: `/cron?job=${encodeURIComponent(job.id)}&from=ops-center` } });
  // 失败告警:通过既有通知渠道
  if (status === 'failed') {
    try {
      const config = getNotificationConfig(false);
      if (config.enabled) {
        await sendNotification(
          `ComposeOps:Cron 任务失败 · ${job.name}`,
          `任务「${job.name}」(${JOB_TYPES[job.type]?.label || job.type}) 执行失败。\n错误:${error}\n时间:${new Date().toLocaleString('zh-CN')}`,
          config,
        ).catch(() => {});
      }
    } catch { /* 单个任务状态异常不应阻断其他任务。 */ }
  }
}

async function executeJob(job) {
  const started = Date.now();
  try {
    switch (job.type) {
      case 'db-backup': {
        const projects = (await scanProjects()).filter((project) => project.managed);
        let dumped = 0;
        const errors = [];
        for (const project of projects) {
          const targets = await listProjectDbContainers(project).catch(() => []);
          for (const target of targets) {
            try {
              const result = await runDbDump(project, target.containerId, { download: false });
              if (result.exitCode === 0) dumped += 1;
              else errors.push(`${project.projectName}/${target.containerName}`);
            } catch (e) {
              errors.push(`${project.projectName}/${target.containerName}:${e.message}`);
            }
          }
        }
        if (errors.length && !dumped) throw new Error(`所有备份失败:${errors.slice(0, 3).join('; ')}`);
        if (errors.length) {
          // 部分失败也算失败并告警
          throw new Error(`备份 ${dumped} 个成功,${errors.length} 个失败:${errors.slice(0, 2).join('; ')}`);
        }
        if (!dumped) throw new Error('没有找到可备份的数据库容器');
        return `数据库备份完成,共导出 ${dumped} 个容器`;
      }
      case 'prune-safe':
      case 'prune-all': {
        // 定时任务无人值守,即使类型名为 prune-all 也不得删除孤儿数据卷。
        // 数据卷清理只允许通过需要显式 PRUNE 确认的手动接口执行。
        const result = await pruneStorage(job.type === 'prune-all' ? 'scheduled' : 'safe');
        return `Docker 清理完成,释放 ${result.reclaimedMB} MB`;
      }
      case 'images-check': {
        const result = await checkAllUpdates();
        return `镜像更新检查完成,共 ${result.projects.length} 个项目`;
      }
      case 'volume-backup': {
        const { listProjectVolumes, createVolumeBackup } = await import('./volume-backup.js');
        const projects = (await scanProjects()).filter((project) => project.managed);
        let backed = 0;
        const errors = [];
        for (const project of projects) {
          let volumes;
          try {
            volumes = (await listProjectVolumes(project)).filter((item) => !item.skip && item.exists !== false);
          } catch (error) {
            errors.push(`${project.projectName}:${error.message}`);
            continue;
          }
          for (const volume of volumes) {
            try {
              await createVolumeBackup(project, volume.name);
              backed += 1;
            } catch (error) {
              errors.push(`${project.projectName}/${volume.name}:${error.message}`);
            }
          }
        }
        if (errors.length && !backed) throw new Error(`所有卷备份失败:${errors.slice(0, 3).join('; ')}`);
        if (errors.length) throw new Error(`备份 ${backed} 个成功,${errors.length} 个失败:${errors.slice(0, 2).join('; ')}`);
        if (!backed) throw new Error('没有找到可备份的命名卷');
        return `数据卷备份完成,共 ${backed} 个卷`;
      }
      case 'pull-images': {
        const { prepareProjectAction } = await import('./project-action-runner.js');
        const projects = (await scanProjects()).filter((project) => project.managed && project.editable);
        let pulled = 0;
        const errors = [];
        for (const project of projects) {
          try {
            const prepared = await prepareProjectAction(project, 'pull');
            const code = await prepared.run(() => {}, () => {}, { timeoutMs: 900000 });
            if (code === 0) pulled += 1;
            else errors.push(project.projectName);
          } catch (e) {
            errors.push(project.projectName);
          }
        }
        return summarizePullImagesResult(pulled, errors);
      }
      case 'inspection': {
        const { runInspection } = await import('./inspection.js');
        const report = await runInspection({ source: 'cron' });
        return `巡检完成:${report.summary}(评分 ${report.score})`;
      }
      default:
        throw new Error('未知任务类型');
    }
  } catch (error) {
    await recordRun(job, 'failed', error.message, Date.now() - started);
    throw error;
  }
}

/* ---------------- 调度器 ---------------- */

let timer = null;
const running = new Set();

export async function runJobNow(id) {
  const job = await getJob(id);
  if (!job) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
  if (running.has(job.id)) throw Object.assign(new Error('该任务正在执行中'), { statusCode: 409 });
  running.add(job.id);
  const started = Date.now();
  try {
    const summary = await executeJob(job);
    await recordRun(job, 'success', '', Date.now() - started);
    return { ok: true, summary };
  } finally {
    running.delete(job.id);
  }
}

export async function tick() {
  const now = Date.now();
  for (const job of jobs) {
    if (!job.enabled || running.has(job.id)) continue;
    const next = nextScheduledRun(job);
    if (!next || next.getTime() > now) continue;
    running.add(job.id);
    const started = Date.now();
    executeJob(job)
      .then(async (summary) => { await recordRun(job, 'success', '', Date.now() - started); return summary; })
      .catch((err) => {
        console.error(`[cron-scheduler] Job ${job.name} (${job.id}) execution failed:`, err.message);
      })
      .finally(() => running.delete(job.id));
  }
}

export function startCronScheduler() {
  if (timer || process.env.DISABLE_BACKGROUND_JOBS === '1') return;
  void ensureFile().catch(error => console.error('[cron-scheduler]', error.message));
  timer = setInterval(() => { void tick(); }, 15000);
  timer.unref();
}

export function stopCronScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
