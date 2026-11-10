import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, stat, statfs, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import db, { DB_PATH, getProjectPreference } from '../lib/db.js';
import { scanProjects } from './scanner.js';
import { getHost, getDockerForHost } from './docker-hosts.js';
import { hostRevision, withReadTimeout, PROJECT_LABEL, SERVICE_LABEL } from './incident-observer.js';
import { captureDeploymentInputs } from './reviewed-deployment.js';
import { withProjectOperationLock } from './project-operation-lock.js';
import { incidentError, safeIncidentData } from './incident-store.js';
import { harvestSecretValues } from '../lib/secret-redactor.js';
import { recordAgentAuditEvent, evaluateAgentPolicy } from './agent/policy-store.js';
import { recordEvent } from './event-center.js';
import { validateBusinessConfig } from './business-recovery-config.js';
import { businessDump, businessExec, restoreBusinessDump, verifyBusinessData, waitBusinessDatabase, recoveryContainerConfig, databaseEnvironment, isolatedEnvironment, businessHttpProbeScript } from './business-recovery-docker.js';

const ROOT = path.join(path.dirname(DB_PATH), 'backups', 'business');
const json = value => JSON.stringify(safeIncidentData(value));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const imagePattern = /^sha256:[a-f0-9]{64}$/;
const defaults = { scan: scanProjects, host: getHost, dockerForHost: getDockerForHost, capture: captureDeploymentInputs,
  dump: businessDump, restore: restoreBusinessDump, assertData: verifyBusinessData, ready: waitBusinessDatabase, exec: businessExec, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
const planRow = row => row && ({ id: row.id, hostId: row.host_id, projectId: row.project_id, projectName: row.project_name, version: row.version, enabled: !!row.enabled,
  config: JSON.parse(row.config_json), identity: JSON.parse(row.identity_json), nextRunAt: row.next_run_at, updatedAt: row.updated_at, updatedBy: row.updated_by });
const jobRow = row => row && ({ id: row.id, planId: row.plan_id, version: row.version, status: row.status, snapshot: JSON.parse(row.snapshot_json), result: JSON.parse(row.result_json),
  createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, requestedBy: row.requested_by, error: row.error });
export function getBusinessPlan(id) { const row = planRow(db.prepare('SELECT * FROM sre_business_plans WHERE id=?').get(id)); if (!row) throw incidentError('业务恢复计划不存在', 404); return row; }
export function getBusinessBackup(id) { const row = jobRow(db.prepare('SELECT * FROM sre_business_backups WHERE id=?').get(id)); if (!row) throw incidentError('业务备份不存在', 404); return row; }
export function getBusinessRun(id) { const row = jobRow(db.prepare('SELECT * FROM sre_business_runs WHERE id=?').get(id)); if (!row) throw incidentError('业务演练不存在', 404); return row; }
export function listBusinessRecovery() { return { plans: db.prepare('SELECT * FROM sre_business_plans ORDER BY updated_at DESC LIMIT 100').all().map(planRow),
  backups: db.prepare('SELECT * FROM sre_business_backups ORDER BY created_at DESC LIMIT 100').all().map(jobRow), runs: db.prepare('SELECT * FROM sre_business_runs ORDER BY created_at DESC LIMIT 100').all().map(jobRow) }; }
function policy(plan, action) {
  const decision = evaluateAgentPolicy({ toolName: 'sre.business.' + action, projectId: plan.projectId, params: { hostId: plan.hostId, projectId: plan.projectId, dbService: plan.config.dbService } });
  if (decision.decision === 'deny') throw incidentError('业务恢复被拒绝策略阻止：' + decision.reason, 403);
}
async function sourceFor(docker, project, service) {
  const rows = await withReadTimeout(docker.listContainers({ all: true, filters: { label: [`${PROJECT_LABEL}=${project.projectName}`, `${SERVICE_LABEL}=${service}`] } }));
  if (rows.length !== 1) throw incidentError('业务恢复仅支持单副本数据库与应用服务');
  const source = await withReadTimeout(docker.getContainer(rows[0].Id).inspect());
  if (!source.State?.Running || source.Config?.Labels?.[PROJECT_LABEL] !== project.projectName || source.Config?.Labels?.[SERVICE_LABEL] !== service || !imagePattern.test(source.Image)) throw incidentError('源容器身份或运行状态不可信');
  return source;
}
const containerIdentity = source => ({ id: source.Id, createdAt: source.Created, image: source.Image, commandHash: hash([source.Config?.Cmd, source.Config?.Entrypoint, source.Config?.User]) });
async function targetFor(input, config, deps) {
  if (!getProjectPreference(input.projectId).managed) throw incidentError('项目未纳管');
  const project = (await deps.scan(input.hostId, { background: true })).find(row => row.id === input.projectId);
  if (!project?.managed || !project.editable || !project.mountEnabled) throw incidentError('需要完整可读取的 Compose 纳管应用');
  const revision = hostRevision(deps.host(input.hostId)), docker = deps.dockerForHost(input.hostId), info = await withReadTimeout(docker.info());
  const captured = await deps.capture(project);
  if (!captured.effective.services?.[config.dbService] || !captured.effective.services?.[config.appService]) throw incidentError('服务不属于当前 Compose 应用');
  const source = await sourceFor(docker, project, config.dbService), app = await sourceFor(docker, project, config.appService);
  if (app.Mounts?.length) throw incidentError('当前业务恢复支持无挂载的无状态应用；含文件挂载的应用须先准备专用恢复镜像');
  const dbImage = await withReadTimeout(docker.getImage(source.Image).inspect());
  const volumePaths = Object.keys(dbImage.Config?.Volumes || {});
  if (!volumePaths.length || volumePaths.length > 3 || volumePaths.some(value => !/^\/var\/lib\/(postgresql|mysql)(\/data)?$/.test(value))) throw incidentError('数据库镜像的数据路径不受支持，请使用声明标准数据卷的 PostgreSQL/MySQL/MariaDB 镜像');
  const appImage = await withReadTimeout(docker.getImage(app.Image).inspect());
  if (Object.keys(appImage.Config?.Volumes || {}).length) throw incidentError('应用镜像声明了数据卷，不能按无状态应用恢复');
  const probeImage = await withReadTimeout(docker.getImage(process.env.WORKSPACE_IMAGE || 'stanly1997/opsdash:latest').inspect());
  if (!imagePattern.test(probeImage.Id) || !info.ID || revision !== hostRevision(deps.host(input.hostId))) throw incidentError('节点或探针镜像身份无法确认');
  return { docker, source, app, identity: { hostRevision: revision, engineId: info.ID, fingerprint: captured.fingerprint,
    database: containerIdentity(source), application: containerIdentity(app), volumePaths, probeImage: probeImage.Id }, project };
}
function sourcePassword(source, config) {
  const values = source.Config?.Env || []; harvestSecretValues(values.join('\n'));
  const prefix = config.credentialEnv + '=', password = values.find(value => value.startsWith(prefix))?.slice(prefix.length);
  if (!password || password.length > 4096 || [...password].some(char => char.charCodeAt(0) < 32)) throw incidentError('源数据库缺少指定凭据环境变量；不会猜测密码或使用空口令');
  return password;
}
export async function businessRecoveryCandidates(input, options = {}) {
  const deps = { ...defaults, ...options }, hostId = input.hostId || 'local';
  if (!getProjectPreference(input.projectId).managed) throw incidentError('项目未纳管');
  const project = (await deps.scan(hostId, { background: true })).find(row => row.id === input.projectId);
  if (!project?.managed) throw incidentError('项目不存在', 404);
  const docker = deps.dockerForHost(hostId), services = [];
  for (const item of (project.containers || []).slice(0, 40)) {
    try {
      const source = await sourceFor(docker, project, item.service);
      const values = source.Config?.Env || [], keys = values.map(value => value.split('=')[0]);
      services.push({ serviceName: item.service, image: source.Config?.Image || source.Image, stateless: !source.Mounts?.length,
        credentialVariables: keys.filter(key => /(PASSWORD|PASSWD)/i.test(key) && !key.endsWith('_FILE')) });
    } catch { services.push({ serviceName: item.service, unsupported: '服务未运行、不是单副本或身份无法确认' }); }
  }
  return { hostId, projectId: project.id, projectName: project.projectName, supported: !!project.editable && !!project.mountEnabled, services,
    limitations: '仅支持单数据库与无挂载无状态应用；隔离环境只使用明确配置的变量。MySQL/MariaDB 要求全 InnoDB 且备份期间无并发 DDL。' };
}
export async function saveBusinessPlan(input, actor = 'admin', options = {}) {
  const previous = input.id ? getBusinessPlan(input.id) : null;
  if (previous && input.version !== previous.version) throw incidentError('计划已更新，请刷新');
  const config = validateBusinessConfig(input.config), hostId = previous?.hostId || input.hostId || 'local', projectId = previous?.projectId || input.projectId;
  if (config.scheduleHours && (config.scheduleHours < 24 || input.confirm !== 'ENABLE_BUSINESS_SCHEDULE')) throw incidentError('定时备份并演练至少间隔 24 小时，需明确确认', 400);
  if (config.engine !== 'postgres' && input.noConcurrentDdl !== true) throw incidentError('MySQL/MariaDB 必须确认备份窗口不执行结构变更', 400);
  return withProjectOperationLock(projectId, async () => {
    const deps = { ...defaults, ...options }, target = await targetFor({ hostId, projectId }, config, deps);
    sourcePassword(target.source, config);
    const id = previous?.id || options.createId || 'sbp_' + randomUUID(), now = Date.now(), enabled = input.enabled !== false;
    db.transaction(() => {
      if (previous) {
        if (!db.prepare('UPDATE sre_business_plans SET config_json=?,identity_json=?,version=version+1,enabled=?,next_run_at=?,updated_at=?,updated_by=? WHERE id=? AND version=?')
          .run(JSON.stringify(config), json(target.identity), Number(enabled), enabled && config.scheduleHours ? now + config.scheduleHours * 3600000 : null, now, actor, id, previous.version).changes) throw incidentError('计划已被并发更新');
      } else {
        if (db.prepare('SELECT COUNT(*) AS n FROM sre_business_plans').get().n >= 100) throw incidentError('业务恢复计划已达上限');
        db.prepare('INSERT INTO sre_business_plans(id,host_id,project_id,project_name,config_json,identity_json,enabled,next_run_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(id, hostId, projectId, target.project.projectName, JSON.stringify(config), json(target.identity), Number(enabled), enabled && config.scheduleHours ? now + config.scheduleHours * 3600000 : null, now, actor);
      }
      recordAgentAuditEvent({ executionId: id, eventType: 'business_plan_saved', toolName: 'sre.business.plan', actor, decision: 'saved', details: { version: (previous?.version || 0) + 1, config, noConcurrentDdl: config.engine === 'postgres' ? null : true } });
    })();
    return getBusinessPlan(id);
  });
}
export function pauseBusinessPlan(id, actor = 'admin') {
  getBusinessPlan(id); db.prepare('UPDATE sre_business_plans SET enabled=0,version=version+1,next_run_at=NULL,updated_at=?,updated_by=? WHERE id=?').run(Date.now(), actor, id);
  recordAgentAuditEvent({ executionId: id, eventType: 'business_plan_paused', actor, toolName: 'sre.business.plan', decision: 'paused' }); return getBusinessPlan(id);
}
function requireCurrent(plan, action) {
  const current = getBusinessPlan(plan.id);
  if (!current.enabled || current.version !== plan.version || !getProjectPreference(plan.projectId).managed) throw incidentError('业务恢复计划已改变、暂停或项目已取消纳管');
  policy(plan, action);
}
function noActive(plan) {
  for (const table of ['sre_business_backups', 'sre_business_runs']) if (db.prepare(`SELECT id FROM ${table} WHERE plan_id=? AND status IN ('queued','running','outcome_unknown')`).get(plan.id)) throw incidentError('此计划有进行中或结果未知的任务，请先核对');
}
export function queueBusinessBackup(id, actor = 'admin', drillAfter = false) {
  return db.transaction(() => {
    const plan = getBusinessPlan(id); requireCurrent(plan, 'backup'); noActive(plan);
    if (drillAfter) policy(plan, 'drill');
    const jobId = 'sbb_' + randomUUID(), now = Date.now();
    // Config contains only validated placeholders. Redacting its keys would destroy the recovery template.
    db.prepare("INSERT INTO sre_business_backups(id,plan_id,version,status,snapshot_json,created_at,requested_by) VALUES(?,?,?,'queued',?,?,?)")
      .run(jobId, id, plan.version, JSON.stringify({ plan, drillAfter }), now, actor);
    if (plan.config.scheduleHours) db.prepare('UPDATE sre_business_plans SET next_run_at=? WHERE id=?').run(now + plan.config.scheduleHours * 3600000, id);
    recordAgentAuditEvent({ executionId: jobId, eventType: 'business_backup_queued', toolName: 'sre.business.backup', actor, decision: 'queued', details: { planId: id, drillAfter } });
    return getBusinessBackup(jobId);
  })();
}
export function queueBusinessRun(id, backupId, actor = 'admin') {
  return db.transaction(() => {
    const plan = getBusinessPlan(id), backup = getBusinessBackup(backupId); requireCurrent(plan, 'drill'); noActive(plan);
    if (backup.planId !== id || backup.version !== plan.version || backup.status !== 'verified' || !backup.result.sha256) throw incidentError('请选择当前计划版本已经校验的固定备份');
    const jobId = 'sbr_' + randomUUID();
    db.prepare("INSERT INTO sre_business_runs(id,plan_id,version,status,snapshot_json,created_at,requested_by) VALUES(?,?,?,'queued',?,?,?)")
      .run(jobId, id, plan.version, JSON.stringify({ plan, backup: { id: backup.id, result: backup.result } }), Date.now(), actor);
    recordAgentAuditEvent({ executionId: jobId, eventType: 'business_drill_queued', toolName: 'sre.business.drill', actor, decision: 'queued', details: { planId: id, backupId } }); return getBusinessRun(jobId);
  })();
}
export function scheduleBusinessRecovery(now = Date.now()) {
  for (const row of db.prepare('SELECT id FROM sre_business_plans WHERE enabled=1 AND next_run_at<=?').all(now)) {
    try { queueBusinessBackup(row.id, 'sre-scheduler', true); }
    catch (error) { pauseBusinessPlan(row.id, 'sre-scheduler'); recordEvent({ source: 'sre', eventType: 'backup', severity: 'warning', title: '业务恢复调度已暂停', detail: error.message }); }
  }
}
export function businessBackupFile(id) { if (!/^sbb_[a-f0-9-]{36}$/.test(id)) throw incidentError('备份标识无效', 400); return path.join(ROOT, id + '.gz'); }
async function fileHash(file) { const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex'); }
async function checkTarget(plan, deps) {
  const target = await targetFor(plan, plan.config, deps);
  if (hash(target.identity) !== hash(plan.identity)) throw incidentError('源容器、完整配置、节点或辅助镜像已变化，请重新审阅计划');
  return target;
}
function finish(table, job, status, result, error) {
  db.prepare(`UPDATE ${table} SET status=?,result_json=?,finished_at=?,error=? WHERE id=?`).run(status, json(result), Date.now(), String(safeIncidentData(error || '')).slice(0, 1000), job.id);
  recordAgentAuditEvent({ executionId: job.id, eventType: 'business_recovery_result', actor: job.requestedBy, toolName: table === 'sre_business_runs' ? 'sre.business.drill' : 'sre.business.backup', decision: status, details: result });
}
async function pruneBackups(planId) {
  const old = db.prepare("SELECT id FROM sre_business_backups WHERE plan_id=? AND status='verified' ORDER BY created_at DESC LIMIT -1 OFFSET 10").all(planId);
  for (const row of old) {
    if (db.prepare("SELECT id FROM sre_business_runs WHERE plan_id=? AND status IN ('queued','running','outcome_unknown') AND json_extract(snapshot_json,'$.backup.id')=?").get(planId, row.id)) continue;
    await rm(businessBackupFile(row.id), { force: true }); db.prepare("UPDATE sre_business_backups SET status='expired' WHERE id=? AND status='verified'").run(row.id);
  }
}
export async function executeBusinessBackup(id, options = {}) {
  if (!db.prepare("UPDATE sre_business_backups SET status='running',started_at=? WHERE id=? AND status='queued'").run(Date.now(), id).changes) return getBusinessBackup(id);
  const job = getBusinessBackup(id), plan = job.snapshot.plan, deps = { ...defaults, ...options }, result = {};
  let status = 'failed', failure = '';
  try {
    await withProjectOperationLock(plan.projectId, async () => {
      requireCurrent(plan, 'backup'); const target = await checkTarget(plan, deps), password = sourcePassword(target.source, plan.config);
      await mkdir(ROOT, { recursive: true, mode: 0o700 }); const capacity = await statfs(ROOT);
      if (capacity.bavail * capacity.bsize < 2.25 * 1024 ** 3) throw incidentError('备份存储可用空间不足 2.25 GiB');
      const file = businessBackupFile(id), snapshotAt = Date.now();
      const dumped = await deps.dump(target.docker.getContainer(target.source.Id), plan.config, password, file);
      requireCurrent(plan, 'backup'); await checkTarget(plan, deps);
      const sha256 = await fileHash(file), size = (await stat(file)).size;
      Object.assign(result, { sha256, bytes: size, rawBytes: dumped.rawBytes, snapshotAt, durationMs: Date.now() - job.startedAt, engine: plan.config.engine, source: plan.identity.database,
        consistency: plan.config.engine === 'postgres' ? 'pg_dump 一致性快照' : 'InnoDB 一致性快照；用户声明窗口内无并发 DDL', format: plan.config.engine === 'postgres' ? 'pg_custom_gzip' : 'sql_gzip' }); status = 'verified';
    });
  } catch (error) { failure = error.message; await rm(businessBackupFile(id), { force: true }).catch(() => {}); }
  finish('sre_business_backups', job, status, result, failure);
  if (status === 'verified') {
    await pruneBackups(plan.id).catch(() => {});
    if (job.snapshot.drillAfter) { try { queueBusinessRun(plan.id, id, job.requestedBy); } catch (error) { recordEvent({ source: 'sre', eventType: 'backup', severity: 'warning', title: '业务备份完成但演练未入队', detail: error.message }); } }
  }
  return getBusinessBackup(id);
}

export async function executeBusinessRun(id, options = {}) {
  if (!db.prepare("UPDATE sre_business_runs SET status='running',started_at=? WHERE id=? AND status='queued'").run(Date.now(), id).changes) return getBusinessRun(id);
  const job = getBusinessRun(id), plan = job.snapshot.plan, deps = { ...defaults, ...options };
  const result = { scope: 'isolated_database_and_application', businessRecoveryVerified: false, resources: [], assertions: [], httpChecks: [] };
  const persist = () => db.prepare('UPDATE sre_business_runs SET result_json=? WHERE id=?').run(json(result), id);
  const deadline = Date.now() + plan.config.rtoMinutes * 60000;
  const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw incidentError('业务恢复超过 RTO 期限', 504); return ms; };
  let docker, uncertain = false, failure = '';
  const labels = { 'composeops.business-recovery': id, 'composeops.project': plan.projectId };
  const register = (kind, name) => { const resource = { kind, id: name, state: 'creating' }; result.resources.push(resource); persist(); return resource; };
  const verifyNode = async () => {
    if (hostRevision(deps.host(plan.hostId)) !== plan.identity.hostRevision || (await withReadTimeout(docker.info())).ID !== plan.identity.engineId) throw incidentError('恢复期间节点身份变化');
  };
  const mutate = async fn => {
    requireCurrent(plan, 'drill');
    await verifyNode();
    try { return await withReadTimeout(Promise.resolve().then(fn), Math.min(remaining(), 30000)); }
    catch (error) { uncertain = true; throw error; }
  };
  const createContainer = async (name, config) => {
    const resource = register('container', name), container = await mutate(() => docker.createContainer({ name, ...config }));
    resource.state = 'created'; persist(); await mutate(() => container.start()); resource.state = 'running'; persist(); return container;
  };
  try {
    await withProjectOperationLock(plan.projectId, async () => {
      requireCurrent(plan, 'drill'); const target = await checkTarget(plan, deps); docker = target.docker;
      const backup = getBusinessBackup(job.snapshot.backup.id), expected = job.snapshot.backup.result;
      if (backup.status !== 'verified' || backup.version !== plan.version || backup.planId !== plan.id || hash(backup.result) !== hash(expected)) throw incidentError('固定备份记录已变化或已过期');
      const file = businessBackupFile(backup.id);
      if ((await stat(file)).size !== expected.bytes || await fileHash(file) !== expected.sha256) throw incidentError('备份校验值不匹配，禁止恢复');
      Object.assign(result, { backupId: backup.id, sha256: expected.sha256, backupAgeMs: Date.now() - expected.snapshotAt });
      result.rpoMet = result.backupAgeMs >= 0 && result.backupAgeMs <= plan.config.rpoMinutes * 60000; persist();
      if (!result.rpoMet) throw incidentError('备份恢复点年龄超过 RPO 目标');
      const prefix = 'composeops-recovery-' + id.slice(4), networkName = prefix + '-net';
      const network = register('network', networkName);
      await mutate(() => docker.createNetwork({ Name: networkName, Internal: true, CheckDuplicate: true, Labels: labels })); network.state = 'created'; persist();
      const mounts = [];
      for (const [index, targetPath] of plan.identity.volumePaths.entries()) {
        const volume = register('volume', prefix + '-data-' + index);
        await mutate(() => docker.createVolume({ Name: volume.id, Labels: labels })); volume.state = 'created'; persist(); mounts.push({ Type: 'volume', Source: volume.id, Target: targetPath });
      }
      const password = randomBytes(24).toString('hex');
      harvestSecretValues('RECOVERY_PASSWORD=' + password);
      const database = await createContainer(prefix + '-db', recoveryContainerConfig(plan.identity.database.image, networkName, labels, 'recovery-db', { env: databaseEnvironment(plan.config, password), database: true, mounts }));
      await deps.ready(database, plan.config, password, { sleep: deps.sleep, deadline: Math.min(deadline, Date.now() + 120000) });
      await deps.restore(database, plan.config, password, file, remaining());
      const assertions = await deps.assertData(database, plan.config, password); Object.assign(result, { assertions }); persist();
      if (!assertions.length || assertions.some(item => !item.passed)) throw incidentError('SQL 业务数据断言未通过');
      await createContainer(prefix + '-app', recoveryContainerConfig(plan.identity.application.image, networkName, labels, 'recovery-app', {
        env: isolatedEnvironment(plan.config, password), cmd: target.app.Config.Cmd, entrypoint: target.app.Config.Entrypoint, user: target.app.Config.User || '65534:65534' }));
      const helper = await createContainer(prefix + '-probe', recoveryContainerConfig(plan.identity.probeImage, networkName, labels, 'recovery-probe', { entrypoint: ['node'], cmd: ['-e', 'setInterval(()=>{},1000)'], user: '65534:65534' }));
      let consecutive = 0;
      for (let attempt = 0; attempt < 30 && remaining() > 0; attempt++) {
        requireCurrent(plan, 'drill');
        try { const output = await deps.exec(helper, ['node', '-e', businessHttpProbeScript(plan.config.http)], [], { timeoutMs: Math.min(remaining(), 8000) });
          const observed = JSON.parse(output); if (observed.statusCode !== plan.config.http.expectedStatus || observed.bodyMatched !== true) throw new Error('HTTP 验收未通过');
          consecutive++; result.httpChecks.push({ at: Date.now(), ...observed, passed: true });
        } catch { consecutive = 0; result.httpChecks.push({ at: Date.now(), passed: false }); }
        persist(); if (consecutive === 3) break; await deps.sleep(1000);
      }
      if (consecutive !== 3) throw incidentError('隔离应用未连续三次通过 HTTP 业务断言');
      requireCurrent(plan, 'drill'); await checkTarget(plan, deps);
      Object.assign(result, { businessRecoveryVerified: true, recoveryDurationMs: Date.now() - job.startedAt }); result.rtoMet = result.recoveryDurationMs <= plan.config.rtoMinutes * 60000; persist();
    });
  } catch (error) { failure = error.message; }
  if (docker) {
    for (const resource of [...result.resources].reverse()) {
      try {
        await verifyNode();
        const entity = resource.kind === 'network' ? docker.getNetwork(resource.id) : resource.kind === 'volume' ? docker.getVolume(resource.id) : docker.getContainer(resource.id);
        const info = await withReadTimeout(entity.inspect());
        if ((info.Labels || info.Config?.Labels)?.['composeops.business-recovery'] !== id) throw new Error('资源标签不匹配，拒绝清理');
        await verifyNode();
        await withReadTimeout(entity.remove(resource.kind === 'container' ? { force: true, v: true } : {})); resource.state = 'removed';
      } catch (error) { if (error.statusCode === 404) resource.state = 'removed'; else { resource.state = 'cleanup_failed'; uncertain = true; } }
      persist();
    }
  }
  result.cleanupComplete = result.resources.every(item => item.state === 'removed'); result.durationMs = Date.now() - job.startedAt;
  const status = uncertain || !result.cleanupComplete ? 'outcome_unknown' : result.businessRecoveryVerified && result.rtoMet && result.rpoMet ? 'passed' : 'failed';
  finish('sre_business_runs', job, status, result, failure);
  recordEvent({ source: 'sre', eventType: 'backup', severity: status === 'passed' ? 'info' : 'warning', title: `${plan.projectName} 业务恢复${status === 'passed' ? '验收通过' : '未通过'}`, detail: failure, payload: { runId: id, target: '/reliability?tab=business' } });
  return getBusinessRun(id);
}
export function recoverBusinessJobs() {
  db.prepare("UPDATE sre_business_backups SET status='outcome_unknown',error='备份执行器中断，需核对后关闭',finished_at=? WHERE status='running'").run(Date.now());
  return db.prepare("UPDATE sre_business_runs SET status='outcome_unknown',error='恢复执行器中断，需核对登记资源，不会自动重放',finished_at=? WHERE status='running'").run(Date.now()).changes;
}
export async function acknowledgeBusinessJob(kind, id, reason, actor = 'admin', options = {}) {
  if (!['backup', 'run'].includes(kind) || typeof reason !== 'string' || reason.trim().length < 8 || reason.length > 1000) throw incidentError('请填写至少 8 字的实际核对说明', 400);
  const job = kind === 'backup' ? getBusinessBackup(id) : getBusinessRun(id), plan = job.snapshot.plan;
  if (job.status !== 'outcome_unknown') throw incidentError('只有结果未知的任务可核对关闭');
  const deps = { ...defaults, ...options }, docker = deps.dockerForHost(plan.hostId);
  if (hostRevision(deps.host(plan.hostId)) !== plan.identity.hostRevision || (await withReadTimeout(docker.info())).ID !== plan.identity.engineId) throw incidentError('原节点身份不能确认');
  for (const resource of job.result.resources || []) {
    const entity = resource.kind === 'network' ? docker.getNetwork(resource.id) : resource.kind === 'volume' ? docker.getVolume(resource.id) : docker.getContainer(resource.id);
    try { await withReadTimeout(entity.inspect()); throw incidentError('仍有登记资源未清理：' + resource.id); } catch (error) { if (error.statusCode !== 404) throw error; }
  }
  if (kind === 'backup') await rm(businessBackupFile(id), { force: true });
  finish(kind === 'backup' ? 'sre_business_backups' : 'sre_business_runs', { ...job, requestedBy: actor }, 'closed', { ...job.result, reconciliation: { actor, reason, at: Date.now(), verifiedRecovery: false } }, job.error);
  return kind === 'backup' ? getBusinessBackup(id) : getBusinessRun(id);
}
