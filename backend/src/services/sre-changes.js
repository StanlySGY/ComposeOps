import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import db, { getProjectPreference, addComposeBackup } from '../lib/db.js';
import { getSreProfile } from './sre-profiles.js';
import { scanProjects } from './scanner.js';
import { getHost, getDockerForHost } from './docker-hosts.js';
import { hostRevision, withReadTimeout, containerSnapshot, PROJECT_LABEL, SERVICE_LABEL } from './incident-observer.js';
import { incidentError, safeIncidentData } from './incident-store.js';
import { captureDeploymentInputs } from './reviewed-deployment.js';
import { spawnComposeCommand, readCompose } from './compose-runner.js';
import { withRunner, putArchiveFile, execInRunner, readArchiveFile, runWorkspaceComposeArgs } from './compose-workspace.js';
import { withProjectOperationLock } from './project-operation-lock.js';
import { evaluateAgentPolicy, recordAgentAuditEvent } from './agent/policy-store.js';
import { runHttpProbe } from './sre-probes.js';
import { recordEvent } from './event-center.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeJson = value => JSON.stringify(safeIncidentData(value));
const imageId = value => /^sha256:[a-f0-9]{64}$/.test(value || '');
const activeStates = ['queued', 'checking', 'executing', 'verifying', 'rolling_back', 'verifying_rollback', 'outcome_unknown'];
function map(row) { return row && { id: row.id, status: row.status, hostId: row.host_id, projectId: row.project_id, profileId: row.profile_id,
  review: JSON.parse(row.review_json), result: JSON.parse(row.result_json), createdAt: row.created_at, updatedAt: row.updated_at,
  expiresAt: row.expires_at, reviewedBy: row.reviewed_by, approvedBy: row.approved_by, approvedAt: row.approved_at, error: row.error }; }
export function getSreChange(id) { const result = map(db.prepare('SELECT * FROM sre_changes WHERE id=?').get(id)); if (!result) throw incidentError('变更记录不存在', 404); return result; }
export function listSreChanges() { return db.prepare('SELECT * FROM sre_changes ORDER BY created_at DESC LIMIT 100').all().map(map); }
function update(id, status, result = {}, error = '') {
  db.prepare('UPDATE sre_changes SET status=?,result_json=?,error=?,updated_at=? WHERE id=?').run(status, safeJson(result), String(safeIncidentData(error)).slice(0, 2000), Date.now(), id);
  recordAgentAuditEvent({ executionId: id, eventType: 'sre_change_' + status, toolName: 'sre.change', actor: 'sre-worker', decision: status, details: result });
  return getSreChange(id);
}
function policy(profile, id, actor) {
  for (const toolName of ['sre.change', 'compose.up', 'compose.upgrade']) {
    const decision = evaluateAgentPolicy({ toolName, projectId: profile.projectId, params: { hostId: profile.hostId, projectId: profile.projectId, serviceName: profile.serviceName } });
    if (id) recordAgentAuditEvent({ executionId: id, eventType: 'policy_decision', actor, toolName, decision: decision.decision, reason: decision.reason });
    if (decision.decision === 'deny') throw incidentError('变更被拒绝策略阻止：' + decision.reason, 403);
  }
}
async function projectFor(profile, deps) {
  if (!profile.enabled || profile.archivedAt || !getProjectPreference(profile.projectId).managed) throw incidentError('应用目标已暂停、归档或取消纳管');
  const project = (await deps.scan(profile.hostId, { background: true })).find(item => item.id === profile.projectId);
  if (!project?.managed || !project.editable || !project.mountEnabled || !project.composeFiles?.length) throw incidentError('可靠变更需要可编辑且已挂载的纳管 Compose 工作区');
  if (hostRevision(deps.hostForId(profile.hostId)) !== profile.hostRevision) throw incidentError('节点配置发生变化，请重新审阅应用目标');
  const docker = deps.dockerForHost(profile.hostId), info = await withReadTimeout(docker.info());
  if (info.ID !== profile.engineId) throw incidentError('Docker Engine 身份发生变化');
  return { project, docker };
}
async function containers(docker, project, service) {
  const rows = await withReadTimeout(docker.listContainers({ all: true, filters: { label: [`${PROJECT_LABEL}=${project.projectName}`, `${SERVICE_LABEL}=${service}`] } }));
  const values = await Promise.all(rows.map(row => withReadTimeout(docker.getContainer(row.Id).inspect())));
  if (values.length !== 1 || values.some(row => row.Config?.Labels?.[PROJECT_LABEL] !== project.projectName || row.Config?.Labels?.[SERVICE_LABEL] !== service)) throw incidentError('当前可靠变更仅支持身份明确的单副本服务');
  return values;
}
const identity = item => ({ id: item.Id, createdAt: item.Created, imageId: item.Image });
const defaults = { scan: scanProjects, hostForId: getHost, dockerForHost: getDockerForHost, capture: captureDeploymentInputs, probe: runHttpProbe };
export async function reviewSreChange(input, actor = 'admin', options = {}) {
  const deps = { ...defaults, ...options }, profile = getSreProfile(input.profileId);
  if (typeof input.image !== 'string' || !input.image.trim() || input.image.length > 300 || /\s/.test(input.image) || [...input.image].some(char => char.charCodeAt(0) < 32)) throw incidentError('请输入节点中已准备好的镜像标签、摘要或 ID', 400);
  policy(profile);
  return withProjectOperationLock(profile.projectId, async () => {
    const { project, docker } = await projectFor(profile, deps);
    const captured = await deps.capture(project), current = (await containers(docker, project, profile.serviceName))[0];
    if (!containerSnapshot(current).healthy || (await deps.probe(profile.config)).outcome !== 'good') throw incidentError('变更前应用必须通过容器状态和 HTTP 探针检查');
    let next;
    try { next = await withReadTimeout(docker.getImage(input.image).inspect()); } catch { throw incidentError('目标镜像不在该节点，请先在镜像管理中拉取，再重新评审', 400); }
    if (!imageId(next.Id) || !imageId(current.Image)) throw incidentError('无法固定完整新旧镜像 ID');
    if (next.Id === current.Image) throw incidentError('新镜像与当前运行镜像相同', 400);
    await withReadTimeout(docker.getImage(current.Image).inspect());
    if (!captured.effective.services?.[profile.serviceName]) throw incidentError('完整 Compose 配置中找不到目标服务');
    if ((await deps.capture(project)).fingerprint !== captured.fingerprint || getSreProfile(profile.id).version !== profile.version) throw incidentError('评审期间输入发生变化');
    const id = 'srec_' + randomUUID(), now = Date.now();
    const review = { recipe: 'pinned-image-v1', projectName: project.projectName, hostId: profile.hostId, serviceName: profile.serviceName,
      profileVersion: profile.version, hostRevision: profile.hostRevision, engineId: profile.engineId,
      workingDir: project.workingDir, files: project.composeFiles, inputFingerprint: captured.fingerprint,
      old: identity(current), next: { requested: input.image, imageId: next.Id, digests: next.RepoDigests || [] },
      probe: profile.config, scope: 'single_service_image_and_http', rollbackScope: '仅恢复镜像，不回退数据库、卷内容或外部系统；不兼容的数据迁移需要独立恢复方案' };
    db.prepare('INSERT INTO sre_changes(id,status,host_id,project_id,profile_id,review_json,created_at,updated_at,expires_at,reviewed_by) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, 'reviewed', profile.hostId, profile.projectId, profile.id, safeJson(review), now, now, now + 900000, actor);
    recordAgentAuditEvent({ executionId: id, eventType: 'sre_change_review', actor, toolName: 'sre.change', decision: 'reviewed', details: review });
    return getSreChange(id);
  });
}
export function approveSreChange(id, input, actor = 'admin') {
  const change = getSreChange(id), profile = getSreProfile(change.profileId);
  if (change.review.recipe !== 'pinned-image-v1') throw incidentError('请通过对应发布流程审批', 400);
  if (input.confirm !== 'APPLY_PINNED_IMAGE' || input.fingerprint !== hash(change.review) || typeof input.allowRollback !== 'boolean') throw incidentError('请明确确认当前评审和回退范围', 400);
  if (change.status !== 'reviewed' || change.expiresAt <= Date.now() || profile.version !== change.review.profileVersion || !profile.enabled) throw incidentError('评审已过期或应用目标发生变化');
  policy(profile, id, actor);
  db.transaction(() => {
    const existing = db.prepare('SELECT id,status FROM sre_changes WHERE project_id=? AND id<>?').all(change.projectId, id).find(row => activeStates.includes(row.status));
    if (existing) throw incidentError('此应用已有进行中或结果未知的变更，请先核对');
    const approved = db.prepare("UPDATE sre_changes SET status='queued',approved_by=?,approved_at=?,result_json=?,updated_at=? WHERE id=? AND status='reviewed'")
      .run(actor, Date.now(), safeJson({ allowRollback: input.allowRollback, approvalFingerprint: input.fingerprint }), Date.now(), id);
    if (!approved.changes) throw incidentError('评审状态已变化');
    recordAgentAuditEvent({ executionId: id, eventType: 'sre_change_approval', actor, toolName: 'sre.change', decision: 'approved', details: { allowRollback: input.allowRollback, fingerprint: input.fingerprint } });
  })();
  return getSreChange(id);
}
export const sreChangeFingerprint = change => hash(change.review);
export function cancelSreChange(id, actor = 'admin') {
  const changed = db.prepare("UPDATE sre_changes SET status='cancelled',updated_at=? WHERE id=? AND status IN ('reviewed','queued')").run(Date.now(), id);
  if (!changed.changes) throw incidentError('变更已开始或已结束，不能取消');
  recordAgentAuditEvent({ executionId: id, eventType: 'sre_change_cancel', actor, toolName: 'sre.change', decision: 'cancelled' });
  return getSreChange(id);
}
async function materialize(project, change, image, phase, effective) {
  const directory = path.join(project.workingDir, `.composeops-${change.id}-${phase}`), file = path.join(directory, 'images.json');
  const content = snapshotContent(effective, change.review.serviceName, image);
  // Keep a resolved, immutable deployment document; execution does not reread mutable env/Compose inputs.
  if (project.mounted) { await mkdir(directory, { mode: 0o700 }); await writeFile(file, content, { mode: 0o600, flag: 'wx' }); }
  else await withRunner(project, async runner => {
    const created = await execInRunner(runner, ['mkdir', '-m', '700', '--', directory]);
    if (created.code !== 0) throw incidentError('无法创建独立变更材料目录');
    await putArchiveFile(runner, directory, 'images.json', content, { mode: 0o600, uid: 0, gid: 0 });
  });
  return file;
}
export function snapshotContent(effective, service, image) {
  const snapshot = structuredClone(effective);
  snapshot.services[service].image = image; snapshot.services[service].pull_policy = 'never';
  delete snapshot.services[service].build;
  return JSON.stringify(snapshot, null, 2);
}
async function verifyMaterial(project, file, image, service, effective) {
  const expected = snapshotContent(effective, service, image);
  const actual = project.mounted ? await readFile(file, 'utf8') : await withRunner(project, async runner => (await readArchiveFile(runner, file)).content);
  if (actual !== expected) throw incidentError('固定镜像材料已被修改，停止派发');
}
async function backupInputs(project, id) {
  if (project.mounted) { for (let i = 0; i < project.composeFiles.length; i++) { const file = await readCompose(project, i); addComposeBackup(project.id, file.path, file.content, 'sre-change:' + id); } }
  else await withRunner(project, async runner => { for (const file of project.composeFiles) { const result = await readArchiveFile(runner, file); addComposeBackup(project.id, file, result.content, 'sre-change:' + id); } });
}
async function dispatch(project, file, service) {
  const target = { ...project, composeFiles: [file] }, args = ['--project-directory', project.workingDir, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', service];
  if (!project.mounted) {
    try { return await runWorkspaceComposeArgs(target, args, () => {}, { timeoutMs: 120000 }); }
    catch (error) { throw Object.assign(error, { outcomeUnknown: true }); }
  }
  return new Promise((resolve, reject) => {
    const child = spawnComposeCommand(target, args); let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120000);
    child.stdout.resume(); child.stderr.resume();
    child.once('error', error => { clearTimeout(timer); reject(Object.assign(error, { outcomeUnknown: true })); });
    child.once('close', code => { clearTimeout(timer); if (timedOut || code === null) reject(Object.assign(new Error('Compose 执行中断，实际结果未知'), { outcomeUnknown: true })); else resolve(code); });
  });
}
async function assertCurrent(change, deps) {
  const profile = getSreProfile(change.profileId);
  if (profile.version !== change.review.profileVersion) throw incidentError('应用目标版本已变化');
  const { project, docker } = await projectFor(profile, deps);
  const allowed = new Set([...change.review.files, change.result.forwardFile, change.result.rollbackFile].filter(Boolean));
  if (project.workingDir !== change.review.workingDir || project.composeFiles.some(file => !allowed.has(file))) throw incidentError('Compose 文件集合或工作目录已变化');
  const base = { ...project, composeFiles: change.review.files };
  if ((await deps.capture(base)).fingerprint !== change.review.inputFingerprint) throw incidentError('评审后的 Compose、环境或节点输入已变化');
  policy(profile, change.id, change.approvedBy);
  return { profile, project: base, docker };
}
export async function verifySreChange(change, expectedImage, deps) {
  const evidence = []; let consecutive = 0, since = 0, stable = '';
  for (let i = 0; i < (deps.verificationAttempts || 9); i++) {
    const { profile, project, docker } = await assertCurrent(change, deps);
    const items = await containers(docker, project, profile.serviceName), item = items[0];
    const http = await deps.probe(profile.config), at = Date.now(), snapshot = containerSnapshot(item);
    const runtime = JSON.stringify([item.Id, item.State?.StartedAt, item.RestartCount]);
    const healthy = snapshot.healthy && item.Image === expectedImage && http.outcome === 'good';
    if (!healthy) { consecutive = 0; since = 0; }
    else { if (runtime !== stable) { consecutive = 0; since = 0; } since ||= at; consecutive++; }
    stable = runtime;
    evidence.push({ at, healthy, container: identity(item), http, startedAt: snapshot.startedAt });
    Object.assign(change.result, { observations: evidence }); update(change.id, change.status, change.result);
    if (consecutive >= 3 && at - since >= (deps.verificationWindowMs ?? 30000)) return { passed: true, evidence, container: identity(item) };
    if (i < (deps.verificationAttempts || 9) - 1) await (deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))(15000);
  }
  return { passed: false, evidence, container: evidence.at(-1)?.container };
}
/** CAS before dispatch; a restarted process only marks in-flight changes unknown and never replays them. */
export async function executeSreChange(id, options = {}) {
  if (getSreChange(id).review.recipe === 'application-release-v1') return (await import('./sre-releases.js')).executeSreRelease(id, options);
  const deps = { ...defaults, materialize, verifyMaterial, backupInputs, dispatch, verify: verifySreChange, ...options };
  const startedAt = Date.now();
  const claimed = db.prepare("UPDATE sre_changes SET status='checking',updated_at=?,started_at=? WHERE id=? AND status='queued'").run(startedAt, startedAt, id);
  if (!claimed.changes) return getSreChange(id);
  let change = getSreChange(id), dispatched = false;
  try {
    return await withProjectOperationLock(change.projectId, async () => {
      if (!change.approvedBy || change.expiresAt <= Date.now() || change.result.approvalFingerprint !== hash(change.review)) throw incidentError('授权已失效');
      let { profile, project, docker } = await assertCurrent(change, deps);
      const current = (await containers(docker, project, profile.serviceName))[0];
      if (JSON.stringify(identity(current)) !== JSON.stringify(change.review.old)) throw incidentError('运行容器或原镜像在评审后发生变化');
      for (const image of [change.review.old.imageId, change.review.next.imageId]) if ((await withReadTimeout(docker.getImage(image).inspect())).Id !== image) throw incidentError('固定镜像已丢失');
      if (!containerSnapshot(current).healthy || (await deps.probe(profile.config)).outcome !== 'good') throw incidentError('应用在执行前未通过健康检查');
      const captured = await deps.capture(project);
      if (captured.fingerprint !== change.review.inputFingerprint) throw incidentError('准备执行快照时输入发生变化');
      await deps.backupInputs(project, id);
      Object.assign(change.result, { forwardFile: await deps.materialize(project, change, change.review.next.imageId, 'forward', captured.effective), snapshotMode: 'resolved_compose' });
      // Re-read all authorization and input conditions after preparing recovery material.
      await assertCurrent(change, deps);
      await deps.verifyMaterial(project, change.result.forwardFile, change.review.next.imageId, profile.serviceName, captured.effective);
      const immediate = (await containers(docker, project, profile.serviceName))[0];
      if (JSON.stringify(identity(immediate)) !== JSON.stringify(change.review.old) || getSreProfile(profile.id).version !== profile.version || !getSreProfile(profile.id).enabled || !getProjectPreference(profile.projectId).managed || hostRevision(deps.hostForId(profile.hostId)) !== profile.hostRevision) throw incidentError('派发前目标或授权发生变化');
      policy(profile, id, change.approvedBy);
      change = update(id, 'executing', change.result); dispatched = true;
      Object.assign(change.result, { exitCode: await deps.dispatch(project, change.result.forwardFile, profile.serviceName) });
      change = update(id, 'verifying', change.result);
      const verification = await deps.verify(change, change.review.next.imageId, deps);
      Object.assign(change.result, { forwardVerification: verification });
      if (verification.passed && change.result.exitCode === 0) return finish(change, 'succeeded');
      if (!change.result.allowRollback) return finish(change, 'failed', '应用变更未通过验收；未授权自动回退');
      ({ profile, project, docker } = await assertCurrent(change, deps));
      const actual = (await containers(docker, project, profile.serviceName))[0];
      if (actual.Image !== change.review.next.imageId || JSON.stringify(identity(actual)) !== JSON.stringify(verification.container)) throw incidentError('回退前目标发生变化，停止自动回退');
      if ((await withReadTimeout(docker.getImage(change.review.old.imageId).inspect())).Id !== change.review.old.imageId) throw incidentError('原镜像已丢失，不能回退');
      Object.assign(change.result, { rollbackFile: await deps.materialize(project, change, change.review.old.imageId, 'rollback', captured.effective) });
      await assertCurrent(change, deps);
      await deps.verifyMaterial(project, change.result.rollbackFile, change.review.old.imageId, profile.serviceName, captured.effective);
      const rollbackTarget = (await containers(docker, project, profile.serviceName))[0];
      if (JSON.stringify(identity(rollbackTarget)) !== JSON.stringify(verification.container) || getSreProfile(profile.id).version !== profile.version || !getSreProfile(profile.id).enabled || !getProjectPreference(profile.projectId).managed || hostRevision(deps.hostForId(profile.hostId)) !== profile.hostRevision) throw incidentError('回退派发前目标或授权发生变化');
      policy(profile, id, change.approvedBy);
      change = update(id, 'rolling_back', change.result);
      Object.assign(change.result, { rollbackExitCode: await deps.dispatch(project, change.result.rollbackFile, profile.serviceName) });
      change = update(id, 'verifying_rollback', change.result);
      Object.assign(change.result, { rollbackVerification: await deps.verify(change, change.review.old.imageId, deps) });
      return finish(change, change.result.rollbackExitCode === 0 && change.result.rollbackVerification.passed ? 'rolled_back' : 'rollback_failed', '新镜像未通过验收，已执行预授权镜像回退');
    });
  } catch (error) { return finish(change, dispatched ? 'outcome_unknown' : 'blocked', error.message); }
}
function finish(change, status, error = '') {
  const result = update(change.id, status, { ...change.result, finishedAt: Date.now() }, error);
  recordEvent({ source: 'sre', eventType: 'deploy', severity: status === 'succeeded' ? 'info' : 'warning', title: `${change.review.projectName} 可靠变更：${({ succeeded: '验收通过', rolled_back: '已回退并验收', failed: '验收失败', rollback_failed: '回退未通过', outcome_unknown: '结果未知', blocked: '执行前已阻止' })[status] || '需核对'}`, detail: error,
    payload: { changeId: change.id, projectId: change.projectId, hostId: change.hostId, target: '/reliability?tab=changes' } });
  return result;
}
export function recoverSreChanges() {
  return db.prepare("UPDATE sre_changes SET status='outcome_unknown',error='执行器中断；请核对实际镜像、应用健康及变更材料，不自动重放',updated_at=? WHERE status IN ('checking','executing','verifying','rolling_back','verifying_rollback')").run(Date.now()).changes;
}
export async function acknowledgeSreChange(id, reason, actor = 'admin', options = {}) {
  if (getSreChange(id).review.recipe === 'application-release-v1') return (await import('./sre-releases.js')).acknowledgeSreRelease(id, reason, actor, options);
  const change = getSreChange(id), deps = { ...defaults, ...options };
  if (change.status !== 'outcome_unknown' || typeof reason !== 'string' || reason.trim().length < 8 || reason.length > 1000) throw incidentError('仅可在人工核对后关闭未知结果，请填写至少 8 字说明', 400);
  return withProjectOperationLock(change.projectId, async () => {
    const profile = getSreProfile(change.profileId), docker = deps.dockerForHost(change.hostId);
    const info = await withReadTimeout(docker.info());
    if (info.ID !== change.review.engineId || hostRevision(deps.hostForId(change.hostId)) !== change.review.hostRevision) throw incidentError('原节点身份无法核对，不能关闭未知变更');
    const actual = await containers(docker, { projectName: change.review.projectName }, change.review.serviceName);
    const probe = await deps.probe(profile.config);
    const result = { ...change.result, reconciliation: { actor, reason, at: Date.now(), containers: actual.map(identity), probe, verifiedRecovery: false } };
    if (getSreChange(id).status !== 'outcome_unknown') throw incidentError('记录状态已变化');
    recordAgentAuditEvent({ executionId: id, eventType: 'sre_change_acknowledged', actor, toolName: 'sre.change', decision: 'closed_unverified', details: result.reconciliation });
    return update(id, 'closed', result, '人工核对后关闭；原执行结果仍未知，不计入成功');
  });
}
export const sreDeploymentIO = { materialize, verifyMaterial, backupInputs, dispatch };
