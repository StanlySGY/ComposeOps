import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'node:crypto';
import { pruneStorage } from './docker-storage.js';
import { checkAllUpdates } from './image-updater.js';
import { listProjectDbContainers, runDbDump } from './db-dumper.js';
import { getNotificationConfig, sendNotification } from './notifications.js';
import { scanProjects } from './scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CRON_DATA_FILE = path.join(__dirname, '../../data/cron-jobs.json');

const JOB_TYPES = {
  'db-backup': { label: '数据库自动备份', description: '对所有纳管项目中运行的数据库容器执行 Dump 并留存本地' },
  'prune-safe': { label: 'Docker 安全清理', description: '清理悬空镜像、退出容器与未使用构建缓存' },
  'prune-all': { label: 'Docker 深度清理', description: '深度清理孤儿卷与全部构建缓存(谨慎)' },
  'images-check': { label: '镜像更新检查', description: '全局检测纳管项目镜像是否有远程更新(写入雷达缓存)' },
  'pull-images': { label: '定时拉取镜像', description: '对所有可编辑项目执行 docker compose pull' },
  'volume-backup': { label: '数据卷备份', description: '对所有纳管项目的命名卷执行 tar 备份,保留最近份数' },
  'inspection': { label: 'AI 巡检', description: '执行一次只读巡检并留存报告(容器/磁盘/内存/备份时效)' },
};

/** 解析单个 cron 字段 → 匹配函数(纯函数,便于单测)。 */
export function parseField(value, min, max) {
  if (value === '*' || value.trim() === '') return () => true;
  const matchers = [];
  for (const part of String(value).split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed === '*') { matchers.push(() => true); continue; }
    const stepMatch = /^(.+?)\/(\d+)$/.exec(trimmed);
    let range = trimmed;
    let step = 1;
    if (stepMatch) { range = stepMatch[1]; step = Number(stepMatch[2]); }
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const [a, b] = range.split('-');
      lo = Number(a);
      hi = b !== undefined ? Number(b) : lo;
    }
    if (Number.isNaN(lo) || Number.isNaN(hi) || lo < min || hi > max || step < 1) {
      throw new Error(`无效的 cron 字段 "${trimmed}"`);
    }
    matchers.push((value) => value >= lo && value <= hi && (value - lo) % step === 0);
  }
  return (value) => matchers.some((match) => match(value));
}

/** 校验并解析 5 段 cron 表达式 → { minute, hour, day, month, weekday }(纯函数)。 */
export function parseCron(expr = '') {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron 表达式需要 5 段(分 时 日 月 周)');
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    day: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    weekday: parseField(parts[4], 0, 7),
  };
}

/** 校验 cron 表达式,合法返回 true,否则抛错(纯函数)。 */
export function validateCron(expr) {
  try {
    parseCron(expr);
    return true;
  } catch (error) {
    error.statusCode = 400;
    throw error;
  }
}

/** 计算下一次执行时间(从 from 开始向后找,最远扫描 5 年)(纯函数)。 */
export function nextRunTime(expr, from = new Date()) {
  const cron = parseCron(expr);
  const cursor = new Date(from.getTime());
  cursor.setMilliseconds(0);
  cursor.setSeconds(0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const deadline = from.getTime() + 5 * 365 * 24 * 3600 * 1000;
  while (cursor.getTime() <= deadline) {
    if (
      cron.minute(cursor.getMinutes()) &&
      cron.hour(cursor.getHours()) &&
      cron.day(cursor.getDate()) &&
      cron.month(cursor.getMonth() + 1) &&
      cron.weekday(cursor.getDay())
    ) {
      return cursor;
    }
    // 前进 1 分钟;命中失败时按 1 小时/1 天加速,避免超高迭代
    if (!cron.minute(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1);
    } else if (!cron.hour(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1);
      cursor.setMinutes(0);
    } else {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0);
      cursor.setMinutes(0);
    }
  }
  return null;
}

export { JOB_TYPES };

/* ---------------- 持久化 ---------------- */

let jobs = [];
let history = [];
let fileLoaded = false;

async function ensureFile() {
  if (fileLoaded) return;
  fileLoaded = true;
  try {
    const raw = await readFile(CRON_DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    jobs = Array.isArray(data.jobs) ? data.jobs : [];
    history = Array.isArray(data.history) ? data.history : [];
  } catch (err) {
    console.error('[cron-scheduler] Failed to load cron data file:', err.message);
    jobs = [];
    history = [];
  }
}

async function persist() {
  await mkdir(path.dirname(CRON_DATA_FILE), { recursive: true });
  await writeFile(CRON_DATA_FILE, JSON.stringify({ jobs, history }, null, 2), 'utf8');
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
  if (patch.name !== undefined) job.name = String(patch.name).trim().slice(0, 60) || job.name;
  if (patch.cron !== undefined) { validateCron(patch.cron); job.cron = String(patch.cron).trim(); }
  if (patch.type !== undefined) {
    if (!JOB_TYPES[patch.type]) throw Object.assign(new Error('未知任务类型'), { statusCode: 400 });
    job.type = patch.type;
  }
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

function enrich(job) {
  const next = job.enabled ? nextRunTime(job.cron, job.lastRunAt ? new Date(job.lastRunAt) : new Date()) : null;
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
              const result = await runDbDump(project, target.containerId, {});
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
        const result = await pruneStorage(job.type === 'prune-all' ? 'all' : 'safe');
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
        const { spawnComposeCommand } = await import('./compose-runner.js');
        const { runWorkspaceComposeArgs } = await import('./compose-workspace.js');
        const projects = (await scanProjects()).filter((project) => project.managed && project.editable);
        let pulled = 0;
        const errors = [];
        for (const project of projects) {
          try {
            const code = project.mounted
              ? await runStepSpawn(spawnComposeCommand(project, ['pull']))
              : await runWorkspaceComposeArgs(project, ['pull']);
            if (code === 0) pulled += 1;
            else errors.push(project.projectName);
          } catch (e) {
            errors.push(project.projectName);
          }
        }
        if (errors.length && !pulled) throw new Error(`拉取镜像全部失败:${errors.slice(0, 3).join(', ')}`);
        return pulled
          ? (errors.length ? `拉取 ${pulled} 个成功,${errors.length} 个失败` : `已拉取 ${pulled} 个项目的镜像`)
          : '没有可拉取镜像的项目';
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

function runStepSpawn(child) {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
    child.stdout.resume();
    child.stderr.resume();
  });
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

async function tick() {
  const now = Date.now();
  for (const job of jobs) {
    if (!job.enabled || running.has(job.id)) continue;
    const last = job.lastRunAt || 0;
    const next = nextRunTime(job.cron, new Date(last));
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
  void ensureFile();
  timer = setInterval(() => { void tick(); }, 15000);
  timer.unref();
}

export function stopCronScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
