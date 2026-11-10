import { createHash, randomUUID } from 'node:crypto';
import db, { getProjectPreference } from '../lib/db.js';
import { scanProjects } from './scanner.js';
import { getHost, getDockerForHost } from './docker-hosts.js';
import { hostRevision, withReadTimeout } from './incident-observer.js';
import { getSreProfile, listSreProfiles, saveSreProfile, validateProbeConfig } from './sre-profiles.js';
import { getBusinessPlan, listBusinessRecovery, saveBusinessPlan, businessRecoveryCandidates } from './sre-business-recovery.js';
import { validateBusinessConfig } from './business-recovery-config.js';
import { getSloAlertRule, saveSloAlertRule, validateSloAlertConfig } from './sre-slo-alerts.js';
import { getAutonomyPolicy, saveAutonomyPolicy } from './sre-autonomy.js';
import { getNotificationConfig } from './notifications.js';
import { withProjectOperationLock } from './project-operation-lock.js';
import { incidentError, safeIncidentData } from './incident-store.js';
import { recordAgentAuditEvent } from './agent/policy-store.js';
const defaults = { scan: scanProjects, host: getHost, hostForId: getHost, dockerForHost: getDockerForHost, saveProfile: saveSreProfile, saveBusiness: saveBusinessPlan,
  saveAlerts: saveSloAlertRule, saveAutonomy: saveAutonomyPolicy, notifications: getNotificationConfig, candidates: businessRecoveryCandidates };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rowMap = row => row && ({ id: row.id, hostId: row.host_id, projectId: row.project_id, projectName: row.project_name, version: row.version, status: row.status,
  config: JSON.parse(row.config_json), progress: JSON.parse(row.progress_json), createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: row.updated_by, error: row.error });
export function getOnboarding(id) { const row = rowMap(db.prepare('SELECT * FROM sre_onboarding WHERE id=?').get(id)); if (!row) throw incidentError('接入草稿不存在', 404); return { ...row, fingerprint: hash([row.id, row.version, row.config, row.progress.identity]) }; }
export const listOnboarding = () => db.prepare('SELECT id FROM sre_onboarding ORDER BY updated_at DESC LIMIT 100').all().map(row => getOnboarding(row.id));
function validateConfig(input) {
  if (!input || !['existing', 'create'].includes(input.health?.mode)) throw incidentError('请选择健康目标', 400);
  const health = input.health.mode === 'existing' ? { mode: 'existing', id: String(input.health.id || ''), version: input.health.version }
    : { mode: 'create', serviceName: String(input.health.serviceName || ''), config: validateProbeConfig(input.health.config) };
  if (!['existing', 'create', 'later'].includes(input.recovery?.mode)) throw incidentError('请选择业务恢复配置方式', 400);
  let recovery;
  if (input.recovery.mode === 'existing') recovery = { mode: 'existing', id: String(input.recovery.id || ''), version: input.recovery.version };
  else if (input.recovery.mode === 'create') {
    const config = validateBusinessConfig(input.recovery.config);
    if (config.scheduleHours && input.recovery.scheduleApproved !== true || config.engine !== 'postgres' && input.recovery.noConcurrentDdl !== true) throw incidentError('业务恢复定时授权或一致性声明未确认', 400);
    recovery = { mode: 'create', config, scheduleApproved: input.recovery.scheduleApproved === true, noConcurrentDdl: input.recovery.noConcurrentDdl === true };
  } else { if (typeof input.recovery.reason !== 'string' || input.recovery.reason.trim().length < 4 || input.recovery.reason.length > 500) throw incidentError('请记录稍后配置灾备的原因', 400); recovery = { mode: 'later', reason: input.recovery.reason.trim() }; }
  const alerts = validateSloAlertConfig(input.alerts);
  if (!['existing', 'later'].includes(input.notifications)) throw incidentError('请选择现有通知配置或稍后配置', 400);
  const autonomy = { enabled: input.autonomy?.enabled === true };
  if (autonomy.enabled) {
    for (const [key, min, max] of [['days', 1, 30], ['cooldownMinutes', 5, 1440], ['maxDaily', 1, 10]]) {
      if (!Number.isInteger(input.autonomy[key]) || input.autonomy[key] < min || input.autonomy[key] > max) throw incidentError('自动修复边界无效：' + key, 400); autonomy[key] = input.autonomy[key];
    }
  }
  return { health, recovery, alerts, notifications: input.notifications, autonomy };
}
function channels(deps) { const value = deps.notifications(); return { enabled: !!value.enabled, channels: value.channels.filter(row => row.enabled).map(row => ({ type: row.type })), ready: !!value.enabled && value.channels.some(row => row.enabled) }; }
async function target(input, deps) {
  if (!getProjectPreference(input.projectId).managed) throw incidentError('应用尚未纳管');
  const project = (await deps.scan(input.hostId || 'local')).find(row => row.id === input.projectId && row.managed);
  if (!project) throw incidentError('应用或节点不可用');
  const revision = hostRevision(deps.host(input.hostId || 'local')), info = await withReadTimeout(deps.dockerForHost(input.hostId || 'local').info());
  if (!info.ID || revision !== hostRevision(deps.host(input.hostId || 'local'))) throw incidentError('节点身份不可确认');
  return { project, identity: { hostRevision: revision, engineId: info.ID } };
}
function assertScope(resource, draft) {
  if (resource.hostId !== draft.hostId || resource.projectId !== draft.projectId || resource.enabled === false || resource.archivedAt) throw incidentError('已选配置不属于此应用或已停用');
}
export async function onboardingContext(input, options = {}) {
  const deps = { ...defaults, ...options }, hostId = input.hostId || 'local', { project } = await target({ ...input, hostId }, deps);
  let recovery;
  try { recovery = await deps.candidates({ hostId, projectId: project.id }, deps); } catch (error) { recovery = { supported: false, services: [], limitations: error.message }; }
  return { hostId, projectId: project.id, projectName: project.projectName, services: [...new Set(project.containers.map(row => row.service))],
    profiles: listSreProfiles().filter(row => row.hostId === hostId && row.projectId === project.id), recoveryPlans: listBusinessRecovery().plans.filter(row => row.hostId === hostId && row.projectId === project.id),
    recovery, notifications: channels(deps), autonomyDefault: false };
}
export async function saveOnboarding(input, actor = 'admin', options = {}) {
  const deps = { ...defaults, ...options }, previous = input.id ? getOnboarding(input.id) : null, config = validateConfig(input.config);
  if (previous && (previous.version !== input.version || previous.status === 'applying' || previous.status === 'complete')) throw incidentError('接入草稿已变化或提交完成，请刷新');
  const hostId = previous?.hostId || input.hostId || 'local', projectId = previous?.projectId || input.projectId;
  return withProjectOperationLock(projectId, async () => {
    const { project, identity } = await target({ hostId, projectId }, deps);
    const draft = { hostId, projectId };
    if (config.health.mode === 'existing') { const profile = getSreProfile(config.health.id); assertScope(profile, draft); if (profile.version !== config.health.version) throw incidentError('健康目标版本变化'); }
    else if (!project.containers.some(row => row.service === config.health.serviceName)) throw incidentError('服务不属于该应用');
    if (config.recovery.mode === 'existing') { const plan = getBusinessPlan(config.recovery.id); assertScope(plan, draft); if (plan.version !== config.recovery.version) throw incidentError('恢复计划版本变化'); }
    if (previous) for (const [step, result] of Object.entries(previous.progress)) if (result.status === 'configured' && Object.hasOwn(config, step) && hash(config[step]) !== hash(previous.config[step])) throw incidentError('已提交的步骤请在对应设置页编辑：' + step);
    const requestId = input.requestId || randomUUID(); if (!/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw incidentError('请求幂等标识无效', 400);
    const id = previous?.id || 'sro_' + requestId, existing = db.prepare('SELECT id FROM sre_onboarding WHERE id=?').get(id);
    if (!previous && existing) { const old = getOnboarding(id); if (old.hostId !== hostId || old.projectId !== projectId || hash(old.config) !== hash(config)) throw incidentError('幂等标识已用于另一份配置'); return old; }
    const now = Date.now();
    const progress = previous?.progress || { identity };
    if (!progress.health) progress.baselines = config.health.mode === 'existing' ? { alerts: getSloAlertRule(config.health.id).version, autonomy: getAutonomyPolicy(config.health.id)?.version || 0 } : { alerts: 0, autonomy: 0 };
    if (previous) {
      if (!db.prepare('UPDATE sre_onboarding SET config_json=?,progress_json=?,version=version+1,updated_at=?,updated_by=?,error=? WHERE id=? AND version=?').run(JSON.stringify(config), JSON.stringify(progress), now, actor, '', id, previous.version).changes) throw incidentError('接入草稿被并发更新');
    } else {
      if (db.prepare('SELECT COUNT(*) AS n FROM sre_onboarding').get().n >= 100) throw incidentError('接入记录已达上限');
      db.prepare('INSERT INTO sre_onboarding(id,host_id,project_id,project_name,config_json,progress_json,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, hostId, projectId, project.projectName, JSON.stringify(config), JSON.stringify(progress), now, now, actor);
    }
    return getOnboarding(id);
  });
}
export async function applyOnboarding(id, input, actor = 'admin', options = {}) {
  const deps = { ...defaults, ...options }, first = getOnboarding(id);
  if (input.confirm !== 'APPLY_APPLICATION_ONBOARDING' || input.version !== first.version || input.fingerprint !== first.fingerprint) throw incidentError('请审阅当前配置后提交', 400);
  if (first.config.autonomy.enabled && input.autonomyConfirm !== 'ENABLE_AUTONOMY') throw incidentError('自动修复必须单独明确授权', 400);
  return withProjectOperationLock(first.projectId, async () => {
    const draft = getOnboarding(id);
    if (draft.status === 'complete') return draft;
    if (draft.version !== first.version || draft.status === 'applying') throw incidentError('接入记录正在提交或已变化');
    const observed = await target(draft, deps);
    if (hash(observed.identity) !== hash(draft.progress.identity)) throw incidentError('节点身份变化，请重新创建接入草稿');
    db.prepare("UPDATE sre_onboarding SET status='applying',updated_at=? WHERE id=?").run(Date.now(), id);
    const progress = draft.progress, config = draft.config;
    const persist = () => db.prepare('UPDATE sre_onboarding SET progress_json=?,updated_at=? WHERE id=?').run(JSON.stringify(progress), Date.now(), id);
    try {
      const healthId = config.health.mode === 'existing' ? config.health.id : 'srep_onboard_' + id;
      let profile;
      if (config.health.mode === 'existing' || db.prepare('SELECT id FROM sre_profiles WHERE id=?').get(healthId)) profile = getSreProfile(healthId);
      else profile = await deps.saveProfile({ hostId: draft.hostId, projectId: draft.projectId, serviceName: config.health.serviceName, config: config.health.config, enabled: true }, actor, { ...deps, createId: healthId });
      assertScope(profile, draft);
      if (config.health.mode === 'create' && (profile.serviceName !== config.health.serviceName || hash(profile.config) !== hash(config.health.config)) || config.health.mode === 'existing' && profile.version !== config.health.version) throw incidentError('健康目标已被修改，不能重复提交旧配置');
      if (progress.health && progress.health.version !== profile.version) throw incidentError('已提交的健康目标被外部修改');
      progress.health = { status: 'configured', id: profile.id, version: profile.version }; persist();
      if (config.recovery.mode === 'later') { progress.recovery = { status: 'deferred', reason: config.recovery.reason }; persist(); }
      else {
        const recoveryId = config.recovery.mode === 'existing' ? config.recovery.id : 'sbp_onboard_' + id;
        let plan;
        if (config.recovery.mode === 'existing' || db.prepare('SELECT id FROM sre_business_plans WHERE id=?').get(recoveryId)) plan = getBusinessPlan(recoveryId);
        else plan = await deps.saveBusiness({ hostId: draft.hostId, projectId: draft.projectId, config: config.recovery.config, enabled: true, noConcurrentDdl: config.recovery.noConcurrentDdl, confirm: config.recovery.scheduleApproved ? 'ENABLE_BUSINESS_SCHEDULE' : '' }, actor, { ...deps, createId: recoveryId });
        assertScope(plan, draft);
        if (config.recovery.mode === 'existing' ? plan.version !== config.recovery.version : hash(plan.config) !== hash(config.recovery.config)) throw incidentError('恢复计划已修改，不能重复提交旧配置');
        if (progress.recovery?.status === 'configured' && progress.recovery.version !== plan.version) throw incidentError('已提交的恢复计划被外部修改');
        progress.recovery = { status: 'configured', id: plan.id, version: plan.version }; persist();
      }
      const currentRule = getSloAlertRule(profile.id);
      if (!progress.alerts && currentRule.version !== progress.baselines.alerts && (currentRule.profileVersion !== profile.version || hash(currentRule.config) !== hash(config.alerts))) throw incidentError('告警规则在审阅后发生外部修改');
      if (progress.alerts?.status === 'configured' && (progress.alerts.version !== currentRule.version || hash(currentRule.config) !== hash(config.alerts))) throw incidentError('已提交的告警规则被外部修改');
      const rule = currentRule.profileVersion === profile.version && hash(currentRule.config) === hash(config.alerts) ? currentRule : deps.saveAlerts(profile.id, { version: currentRule.version, config: config.alerts }, actor);
      progress.alerts = { status: 'configured', version: rule.version }; persist();
      const notifications = channels(deps);
      if (config.notifications === 'existing' && !notifications.ready) throw incidentError('尚无启用的通知渠道，请配置通知或选择稍后处理');
      progress.notifications = config.notifications === 'existing' ? { status: 'configured', channels: notifications.channels } : { status: 'deferred', reason: '尚未接入外部通知；告警仅在面板显示' }; persist();
      // Enable mutation permission last; partial setup never silently enables it.
      const currentPolicy = getAutonomyPolicy(profile.id);
      let policy = currentPolicy;
      if (config.autonomy.enabled) {
        if (!progress.autonomyIntent) { progress.autonomyIntent = { expiresAt: Date.now() + config.autonomy.days * 86400000 }; persist(); }
        const intent = { enabled: true, expiresAt: progress.autonomyIntent.expiresAt, maxDaily: config.autonomy.maxDaily, cooldownMs: config.autonomy.cooldownMinutes * 60000, maintenanceUntil: 0 };
        const matches = currentPolicy?.profileVersion === profile.version && Object.entries(intent).every(([key, value]) => currentPolicy[key] === value);
        if (!progress.autonomy && (currentPolicy?.version || 0) !== progress.baselines.autonomy && !matches) throw incidentError('自动授权在审阅后发生外部修改');
        if (progress.autonomy?.status === 'configured' && !matches) throw incidentError('已提交的自动授权已变化，请在应用目标页重新审阅');
        if (!matches) policy = deps.saveAutonomy(profile.id, { ...intent, version: currentPolicy?.version || 0, confirm: 'ENABLE_AUTONOMY' }, actor);
      } else if (currentPolicy?.enabled) {
        if ((currentPolicy?.version || 0) !== progress.baselines.autonomy) throw incidentError('自动授权在审阅后发生外部修改');
        policy = deps.saveAutonomy(profile.id, { enabled: false, version: currentPolicy.version }, actor);
      }
      progress.autonomy = { status: 'configured', enabled: !!policy?.enabled, version: policy?.version || 0 }; persist();
      const deferred = Object.values(progress).filter(row => row.status === 'deferred').length;
      db.prepare("UPDATE sre_onboarding SET status='complete',error='',updated_at=?,updated_by=? WHERE id=?").run(Date.now(), actor, id);
      recordAgentAuditEvent({ executionId: id, eventType: 'onboarding_complete', toolName: 'sre.onboarding', actor, decision: deferred ? 'configured_with_deferred_steps' : 'configured', details: { progress, deferred } });
    } catch (error) {
      db.prepare("UPDATE sre_onboarding SET status='partial',error=?,updated_at=? WHERE id=?").run(String(safeIncidentData(error.message)).slice(0, 1000), Date.now(), id);
      recordAgentAuditEvent({ executionId: id, eventType: 'onboarding_partial', toolName: 'sre.onboarding', actor, decision: 'partial', reason: error.message, details: progress });
    }
    return getOnboarding(id);
  });
}
export function recoverOnboarding() { return db.prepare("UPDATE sre_onboarding SET status='partial',error='提交中断，已保存步骤可恢复；再次提交前重新审阅',updated_at=? WHERE status='applying'").run(Date.now()).changes; }
