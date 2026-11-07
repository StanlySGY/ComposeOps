import { recordEvent } from './event-center.js';
/**
 * 巡检引擎:把散落在各处的只读事实收敛成"结论 + 建议",而不是再堆一页指标。
 *
 * 设计约束:
 * - 只读。这里不执行任何变更,只采集事实并给出建议动作(建议由 Agent 或用户去执行)。
 * - 单次巡检的所有采集都容错:任一项失败只降级为一条 finding,不让整次巡检失败。
 * - 产物落库(inspections),既做报告历史,也做容量预测的磁盘采样点。
 *
 * 产出结构:
 *   { score, grade, findings[], predictions[], stats, summary }
 * finding: { id, level, title, detail, advice, target, tool }
 *   level: critical | warning | info
 *   tool : 可选的 Agent 工具名,前端据此给出一键"交给 Agent 处理"入口
 */

import os from 'node:os';
import { statfs } from 'node:fs/promises';
import { scanProjects } from './scanner.js';
import { getActivityDocker } from './docker-hosts.js';
import { getSystemStorageDf } from './docker-storage.js';
import { getNotificationConfig } from './notifications.js';
import { listVolumeBackups, listInspections, listDiskSamples, addInspection, getSetting, setSetting } from '../lib/db.js';

const LEVEL_WEIGHT = { critical: 20, warning: 7, info: 0 };
const GB = 1024 ** 3;

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 分数 → 等级,阈值集中在一处,前端文案与之对齐。 */
export function gradeOf(score) {
  if (score >= 90) return 'healthy';
  if (score >= 75) return 'attention';
  if (score >= 55) return 'degraded';
  return 'critical';
}

export const GRADE_LABELS = {
  healthy: '健康',
  attention: '需关注',
  degraded: '需处理',
  critical: '严重',
};

function finding(level, title, detail, extra = {}) {
  return { level, title, detail, advice: extra.advice || '', target: extra.target || '', tool: extra.tool || '', id: extra.id || `${level}:${title}` };
}

/** 读取宿主根分区使用率。fileSystem 不可用时返回 null(远程节点场景)。 */
async function readRootDisk() {
  try {
    const stats = await statfs('/');
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bavail) * Number(stats.bsize);
    const used = total - free;
    if (!total) return null;
    return { total, free, used, percent: used / total * 100 };
  } catch {
    return null;
  }
}

/**
 * 容器状态巡检:退出/不健康/重启循环/OOM。
 *
 * 容器列表来自 scanner(只有 Status 文本),重启次数与 OOMKilled 必须 inspect 才能拿到;
 * 为控制耗时,只在容器数量可控时逐个 inspect(上限 80),超出部分仅按 scanner 事实巡检。
 */
async function inspectContainers(projects) {
  const findings = [];
  let running = 0;
  let total = 0;
  const unhealthy = [];
  const exited = [];
  const restartHeavy = [];
  const oomKilled = [];
  const ids = [];

  for (const project of projects) {
    for (const container of project.containers || []) {
      total += 1;
      if (container.state === 'running') running += 1;
      if (project.managed && container.state !== 'running') exited.push({ project, container });
      if (container.health === 'unhealthy') unhealthy.push({ project, container });
      if (ids.length < 80) ids.push({ project, container });
    }
  }

  const facts = new Map();
  if (ids.length) {
    let docker = null;
    try { docker = getActivityDocker(); } catch { docker = null; }
    if (docker) {
      await Promise.all(ids.map(async ({ container }) => {
        try {
          const info = await docker.getContainer(container.id).inspect();
          facts.set(container.id, {
            restarts: Number(info?.RestartCount || 0),
            oomKilled: !!info?.State?.OOMKilled,
            exitCode: info?.State?.ExitCode ?? null,
            startedAt: info?.State?.StartedAt || null,
          });
        } catch {
          // 单个容器 inspect 失败不进入事实表,后续按 scanner 事实判断。
        }
      }));
    }
  }

  for (const { project, container } of ids) {
    const fact = facts.get(container.id);
    if (!fact) continue;
    if (fact.oomKilled) oomKilled.push({ project, container, fact });
    if (fact.restarts >= 5) restartHeavy.push({ project, container, fact });
  }

  for (const { project, container, fact } of oomKilled.slice(0, 5)) {
    findings.push(finding('critical', `${container.name} 曾被 OOMKilled`, `${project.projectName} / ${container.name} 因内存超限被内核终止,累计重启 ${fact.restarts} 次。`, {
      id: `oom:${container.id}`,
      advice: '检查容器内存上限与真实峰值,必要时提高 mem_limit 或修复内存泄漏。',
      target: project.id,
      tool: 'diagnostic.analyze',
    }));
  }
  for (const { project, container, fact } of restartHeavy.slice(0, 8)) {
    findings.push(finding('warning', `${container.name} 重启 ${fact.restarts} 次`, `${project.projectName} / ${container.name} 在容器生命周期内已重启 ${fact.restarts} 次${fact.exitCode != null ? `,最近退出码 ${fact.exitCode}` : ''}。`, {
      id: `restart:${container.id}`,
      advice: '读取该容器的最近日志与退出码,定位是启动失败、依赖不可达还是被健康检查反复重启。',
      target: project.id,
      tool: 'diagnostic.analyze',
    }));
  }
  for (const { project, container } of exited.slice(0, 10)) {
    findings.push(finding('critical', `${container.name} 未运行`, `${project.projectName} / ${container.name} 当前状态为 ${container.state}(${container.statusText || '无状态信息'})。`, {
      id: `exited:${container.id}`,
      advice: '检查最近日志后决定重启或修正配置;可直接让 Agent 分析日志并给出修复建议。',
      target: project.id,
      tool: 'compose.logs',
    }));
  }
  if (exited.length > 10) {
    findings.push(finding('critical', `另有 ${exited.length - 10} 个容器未运行`, '为控制报告长度,仅列出前 10 个未运行容器。', { id: 'exited:more' }));
  }
  for (const { project, container } of unhealthy.slice(0, 10)) {
    findings.push(finding('warning', `${container.name} 健康检查未通过`, `${project.projectName} / ${container.name} 的 healthcheck 报告 unhealthy。`, {
      id: `unhealthy:${container.id}`,
      advice: '确认依赖服务是否可达;健康检查命令是否过于苛刻。',
      target: project.id,
      tool: 'diagnostic.probe',
    }));
  }
  return {
    findings,
    stats: {
      containers: {
        total,
        running,
        exited: exited.length,
        unhealthy: unhealthy.length,
        restartHeavy: restartHeavy.length,
        oomKilled: oomKilled.length,
        inspected: facts.size,
      },
    },
  };
}

/** 磁盘巡检:宿主分区 + Docker 可回收空间。 */
function inspectStorage(disk, df) {
  const findings = [];
  const stats = {};
  if (disk) {
    stats.disk = { percent: Number(disk.percent.toFixed(1)), used: disk.used, total: disk.total, free: disk.free };
    if (disk.percent >= 90) {
      findings.push(finding('critical', `磁盘使用率 ${disk.percent.toFixed(0)}%`, `根分区已用 ${(disk.used / GB).toFixed(1)} GB / ${(disk.total / GB).toFixed(1)} GB,剩余 ${(disk.free / GB).toFixed(1)} GB。`, {
        id: 'disk:root',
        advice: '先做安全清理(safe 模式)回收悬空镜像与构建缓存;再评估数据卷备份是否占用过多。',
        tool: 'maintenance.clean',
      }));
    } else if (disk.percent >= 80) {
      findings.push(finding('warning', `磁盘使用率 ${disk.percent.toFixed(0)}%`, `根分区剩余 ${(disk.free / GB).toFixed(1)} GB,建议在到 90% 前处理。`, {
        id: 'disk:root',
        advice: '运行一次安全清理,并检查日志/备份目录的增长率。',
        tool: 'maintenance.clean',
      }));
    }
  }
  if (df) {
    stats.reclaimable = { total: df.reclaimable, images: df.images?.reclaimable || 0, buildCache: df.buildCache?.reclaimable || 0, volumes: df.volumes?.reclaimable || 0 };
    const reclaimableGb = df.reclaimable / GB;
    if (reclaimableGb >= 10) {
      findings.push(finding('info', `可回收 ${reclaimableGb.toFixed(1)} GB`, `悬空镜像 ${(( df.images?.reclaimable || 0) / GB).toFixed(1)} GB、构建缓存 ${((df.buildCache?.reclaimable || 0) / GB).toFixed(1)} GB、孤儿卷 ${((df.volumes?.reclaimable || 0) / GB).toFixed(1)} GB。`, {
        id: 'docker:reclaimable',
        advice: '执行安全清理即可回收,不影响运行中的服务。',
        tool: 'maintenance.clean',
      }));
    }
    if ((df.volumes?.orphans || 0) > 0) {
      findings.push(finding('info', `${df.volumes.orphans} 个孤儿数据卷`, '这些卷未被任何容器引用,可能包含历史数据。', {
        id: 'docker:orphan-volumes',
        advice: '删除前先确认卷内是否有需要保留的数据(可先做卷备份)。',
      }));
    }
  } else {
    findings.push(finding('info', '无法读取 Docker 空间统计', 'docker system df 调用失败,本次未评估镜像与构建缓存占用。', { id: 'docker:df-unavailable' }));
  }
  return { findings, stats };
}

/** 备份与巡检时效:最近一次卷备份 / 上次巡检距今多久。 */
function inspectBackups() {
  const findings = [];
  const backups = listVolumeBackups();
  const lastBackup = backups[0] || null;
  const stats = { backups: { count: backups.length, lastAt: lastBackup?.createdAt || null } };
  if (!backups.length) {
    findings.push(finding('warning', '尚无数据卷备份', '命名卷内的数据库/上传文件目前没有可恢复的备份点。', {
      id: 'backup:none',
      advice: '在定时任务里创建「数据卷备份」任务(例如每天凌晨),或对本项目卷手动备份一次。',
    }));
  } else {
    const lastMs = Date.parse(`${String(lastBackup.createdAt).replace(' ', 'T')}Z`);
    const days = Number.isFinite(lastMs) ? Math.floor((Date.now() - lastMs) / 86400000) : null;
    stats.backups.lastDaysAgo = days;
    if (days != null && days >= 7) {
      findings.push(finding('warning', `最近一次卷备份在 ${days} 天前`, `共 ${backups.length} 份备份,最新一份创建于 ${lastBackup.createdAt}。`, {
        id: 'backup:stale',
        advice: '检查定时任务是否还在正常触发;必要时手动补一次备份。',
      }));
    }
  }

  const notifications = getNotificationConfig(false);
  stats.notifications = { enabled: !!notifications.enabled, type: notifications.type };
  if (!notifications.enabled) {
    findings.push(finding('warning', '告警通知未启用', '容器退出、OOM、健康检查失败等事件目前只会留在站内,不会推送给你。', {
      id: 'notify:disabled',
      advice: '在「设置 → 通知」配置一个渠道(Bark/Telegram/企微/邮件/Webhook)。',
    }));
  }
  return { findings, stats };
}

/** 纳管与配置巡检:未纳管项目、不可编辑的 Compose 目录。 */
function inspectProjects(projects) {
  const findings = [];
  const unmanaged = projects.filter((project) => !project.managed);
  const stats = { projects: { total: projects.length, managed: projects.length - unmanaged.length, unmanaged: unmanaged.length } };
  if (unmanaged.length) {
    findings.push(finding('info', `${unmanaged.length} 个项目未纳管`, `未纳管项目只能查看,不能由 Agent 执行任何操作:${unmanaged.slice(0, 5).map((p) => p.projectName).join('、')}${unmanaged.length > 5 ? ' 等' : ''}。`, {
      id: 'project:unmanaged',
      advice: '在「设置 → 项目纳管」勾选需要 Agent 代为操作的项目。',
    }));
  }
  const editableBroken = projects.filter((project) => project.managed && project.mountEnabled && !project.editable);
  if (editableBroken.length) {
    findings.push(finding('warning', `${editableBroken.length} 个项目无法编辑 Compose`, `已纳管但 Compose 目录不可达:${editableBroken.slice(0, 5).map((p) => p.projectName).join('、')}。`, {
      id: 'project:not-editable',
      advice: '确认面板是否挂载了这些 compose 目录;远程节点需使用容器控制模式。',
    }));
  }
  return { findings, stats };
}

/** 系统资源巡检:内存压力、CPU 负载。 */
function inspectHost() {
  const findings = [];
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedPercent = totalMem ? (totalMem - freeMem) / totalMem * 100 : 0;
  const cores = Math.max(1, os.cpus()?.length || 1);
  const load1 = os.loadavg()[0] || 0;
  const loadPerCore = load1 / cores;
  const stats = {
    host: {
      memoryPercent: Number(usedPercent.toFixed(1)),
      memoryUsed: totalMem - freeMem,
      memoryTotal: totalMem,
      load1: Number(load1.toFixed(2)),
      cores,
      loadPerCore: Number(loadPerCore.toFixed(2)),
      uptime: os.uptime(),
      hostname: os.hostname(),
    },
  };
  if (usedPercent >= 92) {
    findings.push(finding('critical', `内存使用率 ${usedPercent.toFixed(0)}%`, `宿主内存 ${((totalMem - freeMem) / GB).toFixed(1)} GB / ${(totalMem / GB).toFixed(1)} GB。`, {
      id: 'host:memory',
      advice: '找出占用最高的容器,评估调整其 mem_limit;内存不足也会引发 OOMKilled 与容器重启。',
      tool: 'server.inspect',
    }));
  } else if (usedPercent >= 85) {
    findings.push(finding('warning', `内存使用率 ${usedPercent.toFixed(0)}%`, '接近高位,建议关注增长趋势。', { id: 'host:memory', advice: '查看各容器内存占用排名,必要时限制大户。', tool: 'server.inspect' }));
  }
  if (loadPerCore >= 2) {
    findings.push(finding('warning', `CPU 负载偏高(每核 ${loadPerCore.toFixed(2)})`, `1 分钟负载 ${load1.toFixed(2)},共 ${cores} 核。`, {
      id: 'host:load',
      advice: '确认是否有容器在空转或正在执行构建/备份任务。',
      tool: 'server.inspect',
    }));
  }
  return { findings, stats };
}

/**
 * 容量预测:用历史磁盘采样做线性外推,回答"磁盘还有多久满"。
 * 样本不足(少于 3 个点或跨度 < 6 小时)时明确返回 unknown,不硬编一个数字。
 */
export function predictCapacity(samples, currentDisk) {
  const data = (samples || []).filter((item) => item.diskUsed > 0 && item.diskTotal > 0);
  if (currentDisk) {
    data.push({ createdAt: new Date().toISOString(), diskUsed: currentDisk.used, diskTotal: currentDisk.total });
  }
  if (data.length < 3) {
    return [{ metric: 'disk', status: 'unknown', detail: `采样点不足(${data.length}/3),再积累几次巡检后可给出趋势预测。` }];
  }
  const points = data.map((item) => ({ t: Date.parse(`${String(item.createdAt).replace(' ', 'T').replace('Z', '')}Z`) || Date.now(), v: item.diskUsed }));
  points.sort((a, b) => a.t - b.t);
  const spanHours = (points[points.length - 1].t - points[0].t) / 3600000;
  if (spanHours < 6) {
    return [{ metric: 'disk', status: 'unknown', detail: `采样跨度仅 ${spanHours.toFixed(1)} 小时,需要至少 6 小时才能判断增长趋势。` }];
  }
  const n = points.length;
  const meanT = points.reduce((sum, p) => sum + p.t, 0) / n;
  const meanV = points.reduce((sum, p) => sum + p.v, 0) / n;
  const covariance = points.reduce((sum, p) => sum + (p.t - meanT) * (p.v - meanV), 0);
  const variance = points.reduce((sum, p) => sum + (p.t - meanT) ** 2, 0);
  const slopePerMs = variance > 0 ? covariance / variance : 0;
  const bytesPerDay = slopePerMs * 86400000;
  const latest = points[n - 1].v;
  const total = data[data.length - 1].diskTotal;
  const result = {
    metric: 'disk',
    latestUsed: latest,
    total,
    usedPercent: Number((latest / total * 100).toFixed(1)),
    bytesPerDay: Math.round(bytesPerDay),
    sampleCount: n,
    spanHours: Number(spanHours.toFixed(1)),
  };
  if (bytesPerDay <= total * 0.001) {
    // 日均增长不足容量的 0.1%(约 100 天涨 10%),判定为稳定,避免噪声外推出荒谬结论。
    return [{ ...result, status: 'stable', detail: `近 ${Math.round(spanHours / 24) || 1} 天磁盘基本持平,按当前趋势不会在 100 天内写满。` }];
  }
  const daysToFull = (total - latest) / bytesPerDay;
  return [{
    ...result,
    status: daysToFull < 30 ? 'warning' : 'ok',
    daysToFull: Number(daysToFull.toFixed(1)),
    etaDate: new Date(Date.now() + daysToFull * 86400000).toISOString().slice(0, 10),
    detail: `按当前增长速度(约 ${(bytesPerDay / GB).toFixed(2)} GB/天),预计 ${daysToFull.toFixed(0)} 天后(${new Date(Date.now() + daysToFull * 86400000).toISOString().slice(0, 10)})写满。`,
  }];
}

/** 采样点不足时的兜底预测:只看当前水位,不做外推。 */
function fallbackPrediction(disk) {
  if (!disk) return [{ metric: 'disk', status: 'unknown', detail: '本次未能读取磁盘水位,无法预测。' }];
  const percent = Number(disk.percent.toFixed(1));
  return [{
    metric: 'disk',
    status: percent >= 85 ? 'warning' : 'ok',
    latestUsed: disk.used,
    total: disk.total,
    usedPercent: percent,
    sampleCount: 1,
    detail: `当前水位 ${percent}%(剩余 ${(disk.free / GB).toFixed(1)} GB),采样点不足,暂不做趋势外推。`,
  }];
}

/** 按 finding 汇总成一句话结论(报告列表页直接用这句,不必再读明细)。 */
export function summarize(findings, stats) {
  const critical = findings.filter((item) => item.level === 'critical').length;
  const warning = findings.filter((item) => item.level === 'warning').length;
  const containers = stats.containers || {};
  const head = critical
    ? `发现 ${critical} 项需要立即处理的问题`
    : warning
      ? `发现 ${warning} 项需要关注的问题`
      : '未发现需要处理的问题';
  const parts = [head];
  if (containers.total) parts.push(`容器 ${containers.running}/${containers.total} 运行中`);
  if (stats.disk) parts.push(`磁盘 ${stats.disk.percent}%`);
  if (stats.host) parts.push(`内存 ${stats.host.memoryPercent}%`);
  return `${parts.join(' · ')}。`;
}

/**
 * 执行一次完整巡检(只读)。
 * @param {{ source?: string, persist?: boolean }} options
 * @returns {Promise<object>} 巡检报告
 */
export async function runInspection({ source = 'manual', persist = true } = {}) {
  const started = Date.now();
  const findings = [];
  const stats = {};

  let projects = [];
  try {
    projects = await scanProjects();
  } catch (error) {
    findings.push(finding('warning', '项目扫描失败', `无法枚举 Compose 项目:${error.message}`, { id: 'scan:failed' }));
  }

  const containerResult = await inspectContainers(projects);
  findings.push(...containerResult.findings);
  Object.assign(stats, containerResult.stats);

  const disk = await readRootDisk();
  let df;
  try {
    df = await getSystemStorageDf();
  } catch {
    df = null;
  }
  const storageResult = inspectStorage(disk, df);
  findings.push(...storageResult.findings);
  Object.assign(stats, storageResult.stats);

  const projectResult = inspectProjects(projects);
  findings.push(...projectResult.findings);
  Object.assign(stats, projectResult.stats);

  const hostResult = inspectHost();
  findings.push(...hostResult.findings);
  Object.assign(stats, hostResult.stats);

  const backupResult = inspectBackups();
  findings.push(...backupResult.findings);
  Object.assign(stats, backupResult.stats);

  // 评分:每个 critical/warning 扣分,下限 0;info 不扣分只提示。
  const deduction = findings.reduce((sum, item) => sum + (LEVEL_WEIGHT[item.level] || 0), 0);
  const score = clampScore(100 - deduction);
  const grade = gradeOf(score);

  let predictions;
  try {
    predictions = predictCapacity(listDiskSamples(30), disk);
  } catch {
    predictions = fallbackPrediction(disk);
  }
  for (const prediction of predictions) {
    if (prediction.metric === 'disk' && prediction.status === 'warning') {
      findings.push(finding('warning', `磁盘预计 ${Math.round(prediction.daysToFull)} 天后写满`, prediction.detail, {
        id: 'disk:forecast',
        advice: '提前清理并评估是否需要扩容磁盘;若为日志增长,可考虑调整日志驱动与轮转策略。',
        tool: 'maintenance.clean',
      }));
    }
  }

  const summary = summarize(findings, stats);
  const report = {
    source,
    score,
    grade,
    summary,
    findings: findings.sort((a, b) => (LEVEL_WEIGHT[b.level] || 0) - (LEVEL_WEIGHT[a.level] || 0)),
    predictions,
    stats,
    durationMs: Date.now() - started,
    createdAt: new Date().toISOString(),
  };

  if (persist) {
    try {
      report.id = addInspection({ source, score, grade, findings: report.findings, predictions, summary, stats, diskUsed: disk?.used ?? null, diskTotal: disk?.total ?? null, durationMs: report.durationMs });
      // 手动与自动巡检共用同一个"最近一次"时间戳,调度器据此判断是否到期。
      setSetting('inspection.last_run', String(Date.now()));
      recordEvent({ eventType: 'inspection', source, title: `巡检完成 · ${score} 分`, detail: summary, severity: grade === 'critical' ? 'danger' : grade === 'healthy' ? 'info' : 'warning', status: grade === 'healthy' ? 'resolved' : 'open', payload: { reportId: report.id, to: `/inspection?report=${report.id}&from=ops-center` } });
    } catch {
      // 落库失败不影响本次结果返回
    }
  }
  return report;
}

/** 巡检调度开关与间隔(setting 持久化,默认关闭,避免未经允许就周期性调用 Docker API)。 */
export function getInspectionSchedule() {
  const enabled = getSetting('inspection.auto_enabled', '0') === '1';
  const intervalHours = Math.max(1, Math.min(Number(getSetting('inspection.interval_hours', '24')) || 24, 168));
  const lastRunAt = Number(getSetting('inspection.last_run', '0')) || 0;
  return { enabled, intervalHours, lastRunAt };
}

/** 巡检时效:给首页/巡检页用的一句话状态。 */
export function getInspectionOverview(limit = 20) {
  const reports = listInspections(limit);
  return {
    schedule: getInspectionSchedule(),
    latest: reports[0] ? { ...reports[0], counts: countLevels(reports[0].findings) } : null,
    reports: reports.map((item) => ({ id: item.id, source: item.source, score: item.score, grade: item.grade, summary: item.summary, createdAt: item.createdAt, durationMs: item.durationMs, counts: countLevels(item.findings) })),
  };
}

function countLevels(findings) {
  return (findings || []).reduce((acc, item) => {
    if (item.level === 'critical') acc.critical += 1;
    else if (item.level === 'warning') acc.warning += 1;
    else acc.info += 1;
    return acc;
  }, { critical: 0, warning: 0, info: 0 });
}

let timer = null;
let lastRunDay = '';

/**
 * 后台巡检调度:每小时唤醒一次,按 setting 的间隔判断是否到期。
 * 默认关闭;开启后每天最多执行一次,且以 UTC 日期为界防止重启后重复跑。
 */
export function startInspectionScheduler() {
  if (timer || process.env.DISABLE_BACKGROUND_JOBS === '1') return;
  timer = setInterval(() => {
    const { enabled, intervalHours, lastRunAt } = getInspectionSchedule();
    if (!enabled) return;
    if (Date.now() - lastRunAt < intervalHours * 3600000) return;
    const today = new Date().toISOString().slice(0, 10);
    if (lastRunDay === today) return;
    lastRunDay = today;
    void runInspection({ source: 'schedule' })
      .then(() => { /* 时间戳由路由/服务写入,这里失败不阻塞 */ })
      .catch((error) => console.error('[inspection] 自动巡检失败:', error.message));
  }, 3600000);
  timer.unref();
}

export function stopInspectionScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
