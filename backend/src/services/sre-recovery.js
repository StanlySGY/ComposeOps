import { randomUUID } from 'node:crypto';
import db, { getProjectPreference, getVolumeBackup } from '../lib/db.js';
import { getHost, getDockerForHost } from './docker-hosts.js';
import { hostRevision, withReadTimeout } from './incident-observer.js';
import { incidentError, safeIncidentData } from './incident-store.js';
import { scanProjects } from './scanner.js';
import { captureDeploymentInputs } from './reviewed-deployment.js';
import { withProjectOperationLock } from './project-operation-lock.js';
import { verifyVolumeBackup } from './volume-backup.js';
import { recordAgentAuditEvent, evaluateAgentPolicy } from './agent/policy-store.js';
import { recordEvent } from './event-center.js';
const json = value => JSON.stringify(safeIncidentData(value));
const optionsFor = options => ({ scan: scanProjects, hostForId: getHost, dockerForHost: getDockerForHost, capture: captureDeploymentInputs, verify: verifyVolumeBackup, ...options });
const integer = (value, min, max, label) => { if (!Number.isInteger(value) || value < min || value > max) throw incidentError(label + '超出范围', 400); return value; };
const map = row => row && ({ id: row.id, hostId: row.host_id, projectId: row.project_id, projectName: row.project_name, version: row.version, enabled: !!row.enabled,
  config: JSON.parse(row.config_json), identity: JSON.parse(row.identity_json), nextRunAt: row.next_run_at, updatedAt: row.updated_at, updatedBy: row.updated_by });
export function getRecoveryPlan(id) { const value = map(db.prepare('SELECT * FROM sre_recovery_plans WHERE id=?').get(id)); if (!value) throw incidentError('恢复计划不存在', 404); return value; }
export function listRecoveryPlans() { return db.prepare('SELECT * FROM sre_recovery_plans ORDER BY updated_at DESC LIMIT 200').all().map(map); }
const mapRun = row => row && ({ id: row.id, planId: row.plan_id, version: row.version, status: row.status, snapshot: JSON.parse(row.snapshot_json), result: JSON.parse(row.result_json), requestedBy: row.requested_by,
  createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, error: row.error });
export function getRecoveryRun(id) { const row = mapRun(db.prepare('SELECT * FROM sre_recovery_runs WHERE id=?').get(id)); if (!row) throw incidentError('演练记录不存在', 404); return row; }
export function listRecoveryRuns() { return db.prepare('SELECT * FROM sre_recovery_runs ORDER BY created_at DESC LIMIT 100').all().map(mapRun); }
async function inspectTarget(input, deps) {
  if (!getProjectPreference(input.projectId).managed) throw incidentError('项目未纳管');
  const project = (await deps.scan(input.hostId, { background: true })).find(item => item.id === input.projectId);
  if (!project?.managed || !project.editable || !project.mountEnabled) throw incidentError('恢复计划需要可读取完整配置的纳管应用');
  const revision = hostRevision(deps.hostForId(input.hostId)), docker = deps.dockerForHost(input.hostId);
  const info = await withReadTimeout(docker.info()), captured = await deps.capture(project);
  if (!info.ID || revision !== hostRevision(deps.hostForId(input.hostId))) throw incidentError('节点身份无法确认');
  const volumes = new Set(), excluded = [];
  for (const [name, service] of Object.entries(captured.effective.services || {})) for (const mount of service.volumes || []) {
    if (mount.type === 'volume' && mount.source) volumes.add(captured.effective.volumes?.[mount.source]?.name || `${project.projectName}_${mount.source}`);
    else excluded.push({ service: name, type: mount.type || 'unknown', target: mount.target || '', reason: '绑定挂载、匿名卷或临时文件系统未纳入命名卷归档演练' });
  }
  return { project, volumes: [...volumes], excluded, identity: { hostRevision: revision, engineId: info.ID, fingerprint: captured.fingerprint } };
}
export async function recoveryCandidates(input, options = {}) {
  const result = await inspectTarget({ ...input, hostId: input.hostId || 'local' }, optionsFor(options));
  return { projectName: result.project.projectName, volumes: result.volumes, excluded: result.excluded };
}
export async function saveRecoveryPlan(input, actor = 'admin', options = {}) {
  const previous = input.id ? getRecoveryPlan(input.id) : null;
  if (previous && input.version !== previous.version) throw incidentError('恢复计划已更新，请刷新');
  const hostId = previous?.hostId || input.hostId || 'local', projectId = previous?.projectId || input.projectId;
  const deps = optionsFor(options), target = await inspectTarget({ hostId, projectId }, deps);
  if (!Array.isArray(input.volumes) || !input.volumes.length || input.volumes.length > 20 || input.volumes.some(volume => !target.volumes.includes(volume))) throw incidentError('请选择此应用的 1 至 20 个已声明命名卷', 400);
  const config = { volumes: [...new Set(input.volumes)], rpoMinutes: integer(input.rpoMinutes ?? 1440, 1, 43200, '恢复点年龄目标'), rtoMinutes: integer(input.rtoMinutes ?? 30, 1, 120, '隔离还原用时目标'),
    scheduleHours: integer(input.scheduleHours ?? 0, 0, 720, '定时间隔'), declaredVolumes: target.volumes, excluded: target.excluded };
  if (config.scheduleHours && (config.scheduleHours < 24 || input.confirm !== 'ENABLE_RECOVERY_SCHEDULE')) throw incidentError('定时隔离演练至少间隔 24 小时且需要明确授权', 400);
  const id = previous?.id || 'srp_' + randomUUID(), now = Date.now();
  const enabled = input.enabled !== false;
  db.transaction(() => {
    if (previous) {
      const changed = db.prepare('UPDATE sre_recovery_plans SET config_json=?,identity_json=?,enabled=?,version=version+1,next_run_at=?,updated_at=?,updated_by=? WHERE id=? AND version=?')
        .run(json(config), json(target.identity), Number(enabled), enabled && config.scheduleHours ? now + config.scheduleHours * 3600000 : null, now, actor, id, previous.version);
      if (!changed.changes) throw incidentError('计划已被其他操作更新');
    } else {
      if (db.prepare('SELECT COUNT(*) AS n FROM sre_recovery_plans').get().n >= 200) throw incidentError('恢复计划已达上限');
      db.prepare('INSERT INTO sre_recovery_plans(id,host_id,project_id,project_name,config_json,identity_json,enabled,next_run_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, hostId, projectId, target.project.projectName, json(config), json(target.identity), Number(enabled), enabled && config.scheduleHours ? now + config.scheduleHours * 3600000 : null, now, actor);
    }
    recordAgentAuditEvent({ executionId: id, eventType: 'recovery_plan_saved', toolName: 'sre.recovery', actor, decision: enabled ? 'enabled' : 'paused', details: config });
  })();
  return getRecoveryPlan(id);
}
export function pauseRecoveryPlan(id, actor = 'admin') {
  getRecoveryPlan(id);
  db.prepare('UPDATE sre_recovery_plans SET enabled=0,version=version+1,next_run_at=NULL,updated_at=?,updated_by=? WHERE id=?').run(Date.now(), actor, id);
  recordAgentAuditEvent({ executionId: id, eventType: 'recovery_plan_paused', toolName: 'sre.recovery', actor, decision: 'paused' });
  return getRecoveryPlan(id);
}
function assertPolicy(plan) {
  const decision = evaluateAgentPolicy({ toolName: 'sre.recovery.drill', projectId: plan.projectId, params: { projectId: plan.projectId, hostId: plan.hostId } });
  if (decision.decision === 'deny') throw incidentError('恢复演练被拒绝策略阻止：' + decision.reason, 403);
}
export function queueRecoveryRun(id, actor = 'admin', now = Date.now()) {
  return db.transaction(() => {
    const plan = getRecoveryPlan(id);
    if (!plan.enabled) throw incidentError('恢复计划已暂停');
    assertPolicy(plan);
    const old = db.prepare("SELECT id FROM sre_recovery_runs WHERE plan_id=? AND status IN ('queued','running','outcome_unknown')").get(id);
    if (old) throw incidentError('此计划有进行中或结果未知的演练，请先核对');
    const runId = 'srr_' + randomUUID();
    const backups = plan.config.volumes.map(volume => {
      const row = db.prepare('SELECT id FROM volume_backups WHERE project_id=? AND host=? AND volume=? ORDER BY id DESC LIMIT 1').get(plan.projectId, plan.hostId, volume);
      return { volume, backup: row ? getVolumeBackup(row.id) : null };
    });
    db.prepare("INSERT INTO sre_recovery_runs(id,plan_id,version,status,snapshot_json,requested_by,created_at) VALUES(?,?,?,'queued',?,?,?)")
      .run(runId, id, plan.version, json({ plan, backups }), actor, now);
    if (plan.config.scheduleHours) db.prepare('UPDATE sre_recovery_plans SET next_run_at=? WHERE id=?').run(now + plan.config.scheduleHours * 3600000, id);
    recordAgentAuditEvent({ executionId: runId, eventType: 'recovery_drill_queued', toolName: 'sre.recovery.drill', actor, decision: 'queued', details: { planId: id, version: plan.version } });
    return getRecoveryRun(runId);
  })();
}
export function scheduleRecoveryRuns(now = Date.now()) {
  for (const row of db.prepare('SELECT id FROM sre_recovery_plans WHERE enabled=1 AND next_run_at<=?').all(now)) {
    try { queueRecoveryRun(row.id, 'sre-scheduler', now); }
    catch (error) {
      // Pausing avoids an unbounded queue/retry loop when authorization or prior outcome needs attention.
      pauseRecoveryPlan(row.id, 'sre-scheduler');
      recordEvent({ source: 'sre', eventType: 'backup', severity: 'warning', title: '定时恢复演练已暂停', detail: error.message, payload: { planId: row.id, target: '/reliability?tab=recovery' } });
    }
  }
}
export async function executeRecoveryRun(id, options = {}) {
  const claimed = db.prepare("UPDATE sre_recovery_runs SET status='running',started_at=? WHERE id=? AND status='queued'").run(Date.now(), id);
  if (!claimed.changes) return getRecoveryRun(id);
  const deps = optionsFor(options), run = getRecoveryRun(id), plan = run.snapshot.plan;
  const result = { scope: 'isolated_archive_extraction', businessRecoveryVerified: false, volumes: [], resources: [], excluded: plan.config.excluded,
    coveragePercent: plan.config.declaredVolumes.length ? plan.config.volumes.length / plan.config.declaredVolumes.length * 100 : 0 };
  const persist = () => db.prepare('UPDATE sre_recovery_runs SET result_json=? WHERE id=?').run(json(result), id);
  let status = 'failed', failure = '';
  try {
    await withProjectOperationLock(plan.projectId, async () => {
      const current = getRecoveryPlan(plan.id);
      if (!current.enabled || current.version !== plan.version) throw incidentError('演练开始前计划已暂停或改变');
      const target = await inspectTarget(plan, deps);
      if (JSON.stringify(target.identity) !== JSON.stringify(plan.identity)) throw incidentError('应用配置或节点身份已变化，请重新审阅恢复计划');
      assertPolicy(plan);
      for (const item of run.snapshot.backups) {
        assertPolicy(plan);
        if (!getProjectPreference(plan.projectId).managed) throw incidentError('项目已取消纳管');
        if (!getRecoveryPlan(plan.id).enabled || getRecoveryPlan(plan.id).version !== plan.version || hostRevision(deps.hostForId(plan.hostId)) !== plan.identity.hostRevision) throw incidentError('演练期间授权或节点已变化');
        if ((await withReadTimeout(deps.dockerForHost(plan.hostId).info())).ID !== plan.identity.engineId) throw incidentError('演练期间 Docker Engine 已变化');
        const backup = item.backup;
        if (!backup) { result.volumes.push({ volume: item.volume, status: 'missing', reason: '没有此节点和应用的备份' }); persist(); continue; }
        const currentBackup = getVolumeBackup(backup.id);
        if (!currentBackup || currentBackup.host !== plan.hostId || currentBackup.projectId !== plan.projectId || currentBackup.volume !== item.volume || currentBackup.file !== backup.file) throw incidentError('已选定恢复点已删除或归属变化');
        const at = Date.parse(backup.createdAt.includes('T') ? backup.createdAt : backup.createdAt.replace(' ', 'T') + 'Z');
        const ageMs = Date.now() - at;
        if (!Number.isFinite(ageMs) || ageMs < 0) throw incidentError('备份时间不可信，不能计算恢复点目标');
        const started = Date.now(), evidence = { volume: item.volume, backupId: backup.id, backupAgeMs: ageMs, rpoMet: ageMs <= plan.config.rpoMinutes * 60000 };
        result.volumes.push(evidence); persist();
        try {
          const checked = await deps.verify(backup.id, { onResource: resource => {
            const previous = result.resources.find(row => row.kind === resource.kind && row.id === resource.id);
            if (previous) Object.assign(previous, resource); else result.resources.push({ ...resource, hostId: plan.hostId });
            persist();
          } });
          Object.assign(evidence, { status: checked.status, files: checked.files, durationMs: Date.now() - started, cleanup: checked.cleanup, extractionVerified: checked.ok === true && checked.status === 'verified' });
        } catch (error) { Object.assign(evidence, { status: 'failed', error: error.message, durationMs: Date.now() - started }); }
        persist();
      }
      Object.assign(result, { durationMs: Date.now() - run.startedAt });
      result.rtoMet = result.durationMs <= plan.config.rtoMinutes * 60000;
      result.cleanupComplete = result.resources.every(resource => resource.state === 'removed') && result.volumes.every(item => item.status !== 'verified' || item.cleanup === 'removed');
      status = result.volumes.every(item => item.extractionVerified && item.rpoMet) && result.rtoMet && result.cleanupComplete ? 'passed' : 'failed';
    });
  } catch (error) { failure = error.message; }
  db.prepare('UPDATE sre_recovery_runs SET status=?,result_json=?,finished_at=?,error=? WHERE id=?').run(status, json(result), Date.now(), String(safeIncidentData(failure)).slice(0, 2000), id);
  recordAgentAuditEvent({ executionId: id, eventType: 'recovery_drill_result', toolName: 'sre.recovery.drill', actor: run.requestedBy, decision: status, details: result });
  recordEvent({ source: 'sre', eventType: 'backup', severity: status === 'passed' ? 'info' : 'warning', title: `${plan.projectName} 隔离恢复演练${status === 'passed' ? '达标' : '未达标'}`, detail: failure,
    payload: { runId: id, projectId: plan.projectId, hostId: plan.hostId, target: '/reliability?tab=recovery' } });
  return getRecoveryRun(id);
}
export function recoverRecoveryRuns() {
  return db.prepare("UPDATE sre_recovery_runs SET status='outcome_unknown',error='执行器中断；请按已记录的资源 ID 核对残留，禁止自动重放',finished_at=? WHERE status='running'").run(Date.now()).changes;
}
export async function acknowledgeRecoveryRun(id, reason, actor = 'admin', options = {}) {
  const run = getRecoveryRun(id), plan = run.snapshot.plan, deps = optionsFor(options);
  if (run.status !== 'outcome_unknown' || typeof reason !== 'string' || reason.trim().length < 8 || reason.length > 1000) throw incidentError('请在核对残留资源后填写至少 8 字说明', 400);
  const docker = deps.dockerForHost(plan.hostId), info = await withReadTimeout(docker.info());
  if (info.ID !== plan.identity.engineId || hostRevision(deps.hostForId(plan.hostId)) !== plan.identity.hostRevision) throw incidentError('原节点身份无法确认');
  for (const resource of run.result.resources || []) {
    try {
      await withReadTimeout((resource.kind === 'volume' ? docker.getVolume(resource.id) : docker.getContainer(resource.id)).inspect());
      throw incidentError('仍存在临时资源，请先人工核对并清理：' + resource.id);
    } catch (error) { if (error.statusCode !== 404) throw error; }
  }
  const result = { ...run.result, reconciliation: { actor, reason, at: Date.now(), recordedResourcesAbsent: true, verifiedRecovery: false } };
  db.prepare("UPDATE sre_recovery_runs SET status='closed',result_json=?,finished_at=? WHERE id=? AND status='outcome_unknown'").run(json(result), Date.now(), id);
  recordAgentAuditEvent({ executionId: id, eventType: 'recovery_unknown_acknowledged', toolName: 'sre.recovery.drill', actor, decision: 'closed_unverified', details: result.reconciliation });
  return getRecoveryRun(id);
}
