import { randomUUID, createHash } from 'node:crypto';
import db, { getProjectPreference } from '../lib/db.js';
import { getSreChange, listSreChanges, sreChangeFingerprint, sreDeploymentIO } from './sre-changes.js';
import { getSreProfile } from './sre-profiles.js';
import { scanProjects } from './scanner.js';
import { getHost, getDockerForHost } from './docker-hosts.js';
import { hostRevision, withReadTimeout, containerSnapshot, PROJECT_LABEL, SERVICE_LABEL } from './incident-observer.js';
import { captureDeploymentInputs } from './reviewed-deployment.js';
import { runHttpProbe } from './sre-probes.js';
import { withProjectOperationLock } from './project-operation-lock.js';
import { incidentError, safeIncidentData } from './incident-store.js';
import { evaluateAgentPolicy, recordAgentAuditEvent } from './agent/policy-store.js';
import { recordEvent } from './event-center.js';

const json = value => JSON.stringify(safeIncidentData(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const identity = item => ({ id: item.Id, createdAt: item.Created, imageId: item.Image });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const activeStates = ['queued', 'checking', 'executing', 'verifying', 'rolling_back', 'verifying_rollback', 'outcome_unknown'];
const defaults = { scan: scanProjects, hostForId: getHost, dockerForHost: getDockerForHost, capture: captureDeploymentInputs, probe: runHttpProbe, ...sreDeploymentIO,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), verificationAttempts: 9, verificationWindowMs: 30000 };
export const listSreReleases = () => listSreChanges().filter(row => row.review.recipe === 'application-release-v1');
export function releaseOrder(services) {
  const names = Object.keys(services).sort(); if (!names.length || names.length > 30) throw incidentError('应用服务数量应为 1 至 30', 400);
  const edges = [], order = [], visiting = new Set(), visited = new Set();
  for (const name of names) {
    const service = services[name], dependencies = new Set(Array.isArray(service.depends_on) ? service.depends_on : Object.keys(service.depends_on || {}));
    for (const value of [service.network_mode, service.pid, service.ipc]) if (value?.startsWith('service:')) dependencies.add(value.slice(8));
    for (const value of service.links || []) dependencies.add(value.split(':')[0]);
    for (const value of service.volumes_from || []) { if (value.startsWith('container:')) throw incidentError('跨应用 volumes_from 无法固定发布范围'); dependencies.add(value.split(':')[0]); }
    for (const dependency of dependencies) { if (!names.includes(dependency)) throw incidentError('依赖指向应用外服务：' + dependency); edges.push({ service: name, dependency, reason: 'Compose 声明依赖，先验证依赖再更新调用方' }); }
  }
  const visit = name => {
    if (visited.has(name)) return; if (visiting.has(name)) throw incidentError('应用存在循环依赖，无法生成可靠发布顺序'); visiting.add(name);
    for (const edge of edges.filter(row => row.service === name).sort((a, b) => a.dependency.localeCompare(b.dependency))) visit(edge.dependency);
    visiting.delete(name); visited.add(name); order.push(name);
  };
  names.forEach(visit); return { order, edges };
}
function policy(review, actor, id) {
  for (const step of review.services) for (const toolName of ['sre.release', 'sre.change', 'compose.up', 'compose.upgrade']) {
    const decision = evaluateAgentPolicy({ toolName, projectId: review.projectId, params: { hostId: review.hostId, projectId: review.projectId, serviceName: step.serviceName } });
    if (id) recordAgentAuditEvent({ executionId: id, eventType: 'release_policy', actor, toolName, decision: decision.decision, reason: decision.reason, details: { serviceName: step.serviceName } });
    if (decision.decision === 'deny') throw incidentError('多服务发布被拒绝策略阻止：' + decision.reason, 403);
  }
}
async function containers(docker, projectName, names) {
  const result = {};
  for (const name of names) {
    const rows = await withReadTimeout(docker.listContainers({ all: true, filters: { label: [`${PROJECT_LABEL}=${projectName}`, `${SERVICE_LABEL}=${name}`] } }));
    if (rows.length !== 1) throw incidentError('可靠发布要求所有服务为运行中的单副本：' + name);
    const item = await withReadTimeout(docker.getContainer(rows[0].Id).inspect());
    if (item.Config?.Labels?.[PROJECT_LABEL] !== projectName || item.Config?.Labels?.[SERVICE_LABEL] !== name || !/^sha256:[a-f0-9]{64}$/.test(item.Image || '')) throw incidentError('服务身份或镜像无法固定：' + name);
    result[name] = item;
  }
  return result;
}
async function projectFor(review, deps, allowedFiles = []) {
  if (!getProjectPreference(review.projectId).managed || hostRevision(deps.hostForId(review.hostId)) !== review.hostRevision) throw incidentError('纳管授权或节点配置已变化');
  const project = (await deps.scan(review.hostId, { background: true })).find(row => row.id === review.projectId);
  if (!project?.managed || !project.editable || !project.mountEnabled || project.projectName !== review.projectName) throw incidentError('可靠发布需要完整可编辑的纳管 Compose 应用');
  if (review.files && (project.workingDir !== review.workingDir || project.composeFiles.some(file => ![...review.files, ...allowedFiles].includes(file)))) throw incidentError('发布期间配置文件集合或目录变化');
  const docker = deps.dockerForHost(review.hostId);
  if ((await withReadTimeout(docker.info())).ID !== review.engineId) throw incidentError('Docker Engine 身份变化');
  for (const step of review.services) {
    const profile = getSreProfile(step.profileId);
    if (!profile.enabled || profile.archivedAt || profile.version !== step.profileVersion || profile.hostId !== review.hostId || profile.projectId !== review.projectId || profile.serviceName !== step.serviceName) throw incidentError('服务健康目标或授权版本已变化：' + step.serviceName);
  }
  return { project: review.files ? { ...project, composeFiles: review.files } : project, docker };
}
export async function reviewSreRelease(input, actor = 'admin', options = {}) {
  if (!Array.isArray(input.services) || input.services.length < 2 || input.services.length > 20) throw incidentError('每次选择 2 至 20 个服务', 400);
  const seen = new Set(), steps = input.services.map(row => {
    const profile = getSreProfile(row.profileId);
    if (seen.has(profile.serviceName)) throw incidentError('发布服务不能重复', 400); seen.add(profile.serviceName);
    if (typeof row.image !== 'string' || !row.image || row.image.length > 300 || /\s/.test(row.image) || [...row.image].some(char => char.charCodeAt(0) < 32)) throw incidentError('目标镜像引用无效', 400);
    if (!['none', 'backward_compatible'].includes(row.migration) || typeof row.compatibilityNote !== 'string' || row.compatibilityNote.trim().length < 8 || row.compatibilityNote.length > 1000) throw incidentError('必须声明无数据迁移或双向兼容，并填写至少 8 字依据；不可逆或未知迁移不能可靠发布', 400);
    return { profileId: profile.id, profileVersion: profile.version, serviceName: profile.serviceName, requested: row.image, migration: row.migration, compatibilityNote: row.compatibilityNote, probe: profile.config };
  });
  const profile = getSreProfile(steps[0].profileId), deps = { ...defaults, ...options };
  const review = { recipe: 'application-release-v1', projectId: profile.projectId, projectName: profile.projectName, hostId: profile.hostId, hostRevision: profile.hostRevision, engineId: profile.engineId,
    serviceName: steps[0].serviceName, profileVersion: profile.version, services: steps,
    rollbackScope: '仅将本次已更新服务按反向顺序恢复固定旧镜像并重新验收，不恢复数据库、卷或外部系统。需要各版本数据双向兼容。' };
  return withProjectOperationLock(profile.projectId, async () => {
    policy(review, actor); const { project, docker } = await projectFor(review, deps), captured = await deps.capture(project), graph = releaseOrder(captured.effective.services || {});
    if (steps.some(step => !graph.order.includes(step.serviceName))) throw incidentError('发布服务不在完整配置中');
    const current = await containers(docker, project.projectName, graph.order);
    for (const [name, item] of Object.entries(current)) if (!containerSnapshot(item).healthy) throw incidentError('评审前所有应用服务必须健康：' + name);
    for (const step of steps) {
      if ((await deps.probe(step.probe)).outcome !== 'good') throw incidentError('服务 HTTP 基线未通过：' + step.serviceName);
      let next; try { next = await withReadTimeout(docker.getImage(step.requested).inspect()); } catch { throw incidentError('目标镜像未准备在节点上：' + step.serviceName); }
      if (!/^sha256:[a-f0-9]{64}$/.test(next.Id || '') || next.Id === current[step.serviceName].Image) throw incidentError('目标镜像必须不同于当前镜像并可固定完整 ID：' + step.serviceName);
      Object.assign(step, { old: identity(current[step.serviceName]), next: { imageId: next.Id, digests: next.RepoDigests || [] } });
    }
    for (const item of Object.values(current)) await withReadTimeout(docker.getImage(item.Image).inspect());
    if ((await deps.capture(project)).fingerprint !== captured.fingerprint) throw incidentError('评审期间配置发生变化');
    await projectFor(review, deps);
    Object.assign(review, { files: project.composeFiles, workingDir: project.workingDir, inputFingerprint: captured.fingerprint, graph,
      order: graph.order.filter(name => seen.has(name)), pinnedBaseline: Object.fromEntries(Object.entries(current).map(([name, item]) => [name, identity(item)])),
      // Compatibility fields for existing history clients. Full release approval uses services/order.
      old: steps[0].old, next: steps[0].next, scope: 'ordered_application_release' });
    const id = 'srel_' + randomUUID(), now = Date.now();
    db.prepare('INSERT INTO sre_changes(id,status,host_id,project_id,profile_id,review_json,created_at,updated_at,expires_at,reviewed_by) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, 'reviewed', profile.hostId, profile.projectId, profile.id, json(review), now, now, now + 900000, actor);
    recordAgentAuditEvent({ executionId: id, eventType: 'release_reviewed', toolName: 'sre.release', actor, decision: 'reviewed', details: review }); return getSreChange(id);
  });
}
export function approveSreRelease(id, input, actor = 'admin') {
  return db.transaction(() => {
    const change = getSreChange(id);
    if (change.review.recipe !== 'application-release-v1' || change.status !== 'reviewed' || change.expiresAt <= Date.now()) throw incidentError('发布评审已失效');
    if (input.confirm !== 'APPLY_APPLICATION_RELEASE' || input.fingerprint !== sreChangeFingerprint(change) || typeof input.allowRollback !== 'boolean' || input.compatibilityConfirmed !== true) throw incidentError('请确认完整发布评审、数据兼容声明与回退范围', 400);
    for (const step of change.review.services) if (getSreProfile(step.profileId).version !== step.profileVersion || !getSreProfile(step.profileId).enabled) throw incidentError('健康目标已变化');
    policy(change.review, actor, id);
    if (db.prepare('SELECT id,status FROM sre_changes WHERE project_id=? AND id<>?').all(change.projectId, id).some(row => activeStates.includes(row.status))) throw incidentError('此应用已有进行中或结果未知的变更');
    if (!db.prepare("UPDATE sre_changes SET status='queued',approved_by=?,approved_at=?,updated_at=?,result_json=? WHERE id=? AND status='reviewed'").run(actor, Date.now(), Date.now(), json({ approvalFingerprint: input.fingerprint, allowRollback: input.allowRollback, compatibilityConfirmed: true, steps: [], rollbackSteps: [] }), id).changes) throw incidentError('发布已被并发批准');
    recordAgentAuditEvent({ executionId: id, eventType: 'release_approved', toolName: 'sre.release', actor, decision: 'approved', details: input }); return getSreChange(id);
  })();
}
function persist(change, status = change.status, error = '') {
  change.status = status;
  db.prepare('UPDATE sre_changes SET status=?,result_json=?,error=?,updated_at=? WHERE id=?').run(status, json(change.result), String(safeIncidentData(error)).slice(0, 1000), Date.now(), change.id);
  return getSreChange(change.id);
}
async function currentState(change, deps, expected) {
  const { project, docker } = await projectFor(change.review, deps, [change.result.forwardFile, change.result.rollbackFile].filter(Boolean));
  if ((await deps.capture(project)).fingerprint !== change.review.inputFingerprint) throw incidentError('发布期间完整 Compose 或环境输入发生漂移');
  policy(change.review, change.approvedBy, change.id);
  const items = await containers(docker, project.projectName, Object.keys(change.review.pinnedBaseline));
  for (const [name, value] of Object.entries(expected)) if (!equal(identity(items[name]), value)) throw incidentError('发布期间检测到非本流程的容器变化：' + name);
  return { project, docker, items };
}
function pinnedEffective(effective, baseline, steps, forward) {
  const result = structuredClone(effective);
  for (const [name, service] of Object.entries(result.services)) {
    service.image = forward ? steps.find(row => row.serviceName === name)?.next.imageId || baseline[name].imageId : baseline[name].imageId;
    service.pull_policy = 'never'; delete service.build;
  }
  return result;
}
async function verify(change, step, image, expected, deps, rollback = false) {
  const evidence = []; let consecutive = 0, since = 0, stable = '';
  for (let attempt = 0; attempt < deps.verificationAttempts; attempt++) {
    const { items } = await currentState(change, deps, expected), item = items[step.serviceName], http = await deps.probe(step.probe), at = Date.now();
    const runtime = JSON.stringify([item.Id, item.State?.StartedAt, item.RestartCount]), healthy = item.Image === image && containerSnapshot(item).healthy && http.outcome === 'good';
    if (!healthy || stable !== runtime) { consecutive = 0; since = at; } if (healthy) consecutive++; stable = runtime;
    evidence.push({ at, healthy, container: identity(item), http });
    Object.assign(change.result, { observation: { serviceName: step.serviceName, rollback, evidence } }); persist(change);
    if (consecutive >= 3 && at - since >= deps.verificationWindowMs) return { passed: true, evidence };
    if (attempt < deps.verificationAttempts - 1) await deps.sleep(15000);
  }
  return { passed: false, evidence };
}
export async function executeSreRelease(id, options = {}) {
  if (!db.prepare("UPDATE sre_changes SET status='checking',started_at=?,updated_at=? WHERE id=? AND status='queued'").run(Date.now(), Date.now(), id).changes) return getSreChange(id);
  const change = getSreChange(id), deps = { ...defaults, ...options }, review = change.review, expected = structuredClone(review.pinnedBaseline);
  let dispatched = false, failure = '', outcome = 'blocked';
  try {
    await withProjectOperationLock(change.projectId, async () => {
      if (!change.approvedBy || change.expiresAt <= Date.now() || change.result.approvalFingerprint !== digest(review) || !change.result.compatibilityConfirmed) throw incidentError('完整发布授权已失效');
      const initial = await currentState(change, deps, expected), captured = await deps.capture(initial.project);
      if (captured.fingerprint !== review.inputFingerprint) throw incidentError('创建发布快照前输入变化');
      for (const [name, item] of Object.entries(initial.items)) if (!containerSnapshot(item).healthy) throw incidentError('发布前服务不健康：' + name);
      for (const step of review.services) {
        if ((await deps.probe(step.probe)).outcome !== 'good') throw incidentError('发布前 HTTP 基线未通过：' + step.serviceName);
        for (const image of [step.old.imageId, step.next.imageId]) if ((await withReadTimeout(initial.docker.getImage(image).inspect())).Id !== image) throw incidentError('固定新旧镜像已丢失');
      }
      const forward = pinnedEffective(captured.effective, review.pinnedBaseline, review.services, true), backward = pinnedEffective(captured.effective, review.pinnedBaseline, review.services, false);
      await deps.backupInputs(initial.project, id);
      const forwardFile = await deps.materialize(initial.project, change, review.next.imageId, 'forward', forward);
      const rollbackFile = change.result.allowRollback ? await deps.materialize(initial.project, change, review.old.imageId, 'rollback', backward) : null;
      Object.assign(change.result, { forwardFile, rollbackFile, snapshotMode: 'resolved_application', expected }); persist(change);
      const touched = []; let failed = false;
      for (const name of review.order) {
        const step = review.services.find(row => row.serviceName === name), state = await currentState(change, deps, expected);
        for (const edge of review.graph.edges.filter(row => row.service === name)) if (!containerSnapshot(state.items[edge.dependency]).healthy) throw incidentError('依赖不健康，停止后续发布：' + edge.dependency);
        await deps.verifyMaterial(state.project, forwardFile, review.next.imageId, review.serviceName, forward);
        await currentState(change, deps, expected);
        persist(change, 'executing'); dispatched = true;
        const exitCode = await deps.dispatch(state.project, forwardFile, name);
        const actual = (await containers(state.docker, review.projectName, [name]))[name];
        if (![step.old.imageId, step.next.imageId].includes(actual.Image)) throw incidentError('派发后出现未审阅镜像，结果需人工核对');
        Object.assign(expected, { [name]: identity(actual) }); touched.push(name);
        Object.assign(change.result, { expected }); persist(change, 'verifying');
        const checked = await verify(change, step, step.next.imageId, expected, deps);
        change.result.steps.push({ serviceName: name, exitCode, ...checked }); persist(change);
        recordAgentAuditEvent({ executionId: id, eventType: 'release_step', toolName: 'sre.release', actor: change.approvedBy, decision: checked.passed && exitCode === 0 ? 'passed' : 'failed', details: { serviceName: name, exitCode, evidence: checked.evidence } });
        if (!checked.passed || exitCode !== 0) { failed = true; failure = name + ' 未通过验收，后续服务已停止'; break; }
      }
      if (!failed) {
        const final = [];
        for (const step of review.services) final.push({ serviceName: step.serviceName, ...await verify(change, step, step.next.imageId, expected, deps) });
        Object.assign(change.result, { finalVerification: final }); failed = final.some(row => !row.passed); failure = failed ? '全部更新后联合复验未通过' : '';
      }
      if (!failed) { outcome = 'succeeded'; return; }
      outcome = 'failed'; if (!change.result.allowRollback) return;
      for (const name of [...touched].reverse()) {
        const step = review.services.find(row => row.serviceName === name), state = await currentState(change, deps, expected);
        if ((await withReadTimeout(state.docker.getImage(step.old.imageId).inspect())).Id !== step.old.imageId) throw incidentError('回退镜像丢失');
        await deps.verifyMaterial(state.project, rollbackFile, review.old.imageId, review.serviceName, backward); await currentState(change, deps, expected);
        persist(change, 'rolling_back'); const exitCode = await deps.dispatch(state.project, rollbackFile, name);
        const actual = (await containers(state.docker, review.projectName, [name]))[name];
        if (actual.Image !== step.old.imageId) { outcome = 'rollback_failed'; return; }
        Object.assign(expected, { [name]: identity(actual) }); Object.assign(change.result, { expected }); persist(change, 'verifying_rollback');
        const checked = await verify(change, step, step.old.imageId, expected, deps, true);
        change.result.rollbackSteps.push({ serviceName: name, exitCode, ...checked }); persist(change);
        if (exitCode !== 0 || !checked.passed) { outcome = 'rollback_failed'; return; }
      }
      // A reverse rollback can affect previously reverted dependents; verify the entire release again.
      const final = [];
      for (const step of review.services) final.push({ serviceName: step.serviceName, ...await verify(change, step, step.old.imageId, expected, deps, true) });
      Object.assign(change.result, { rollbackVerification: final }); outcome = final.every(row => row.passed) ? 'rolled_back' : 'rollback_failed';
    });
  } catch (error) { failure = error.message; outcome = dispatched ? 'outcome_unknown' : 'blocked'; }
  Object.assign(change.result, { finishedAt: Date.now() });
  const result = persist(change, outcome, failure);
  recordAgentAuditEvent({ executionId: id, eventType: 'release_result', toolName: 'sre.release', actor: change.approvedBy, decision: outcome, details: { order: review.order, steps: change.result.steps, rollbackSteps: change.result.rollbackSteps } });
  recordEvent({ source: 'sre', eventType: 'deploy', severity: outcome === 'succeeded' ? 'info' : 'warning', title: review.projectName + ' 多服务发布：' + ({ succeeded: '通过', rolled_back: '已回退并验收', failed: '失败', rollback_failed: '回退未通过', outcome_unknown: '结果未知', blocked: '已阻止' })[outcome], detail: failure, payload: { changeId: id, target: '/reliability?tab=releases' } });
  return result;
}
export async function acknowledgeSreRelease(id, reason, actor = 'admin', options = {}) {
  const change = getSreChange(id), deps = { ...defaults, ...options };
  if (change.status !== 'outcome_unknown' || typeof reason !== 'string' || reason.trim().length < 8 || reason.length > 1000) throw incidentError('请核对全部服务后填写至少 8 字说明', 400);
  return withProjectOperationLock(change.projectId, async () => {
    const docker = deps.dockerForHost(change.hostId);
    if ((await withReadTimeout(docker.info())).ID !== change.review.engineId || hostRevision(deps.hostForId(change.hostId)) !== change.review.hostRevision) throw incidentError('原节点身份无法确认');
    const items = await containers(docker, change.review.projectName, Object.keys(change.review.pinnedBaseline)), probes = [];
    for (const step of change.review.services) probes.push({ serviceName: step.serviceName, result: await deps.probe(step.probe) });
    if (getSreChange(id).status !== 'outcome_unknown') throw incidentError('记录状态已变化');
    Object.assign(change.result, { reconciliation: { actor, reason, at: Date.now(), containers: Object.fromEntries(Object.entries(items).map(([name, item]) => [name, identity(item)])), probes, verifiedRecovery: false } });
    recordAgentAuditEvent({ executionId: id, eventType: 'release_unknown_acknowledged', toolName: 'sre.release', actor, decision: 'closed_unverified', details: change.result.reconciliation });
    return persist(change, 'closed', '人工核对关闭；原执行结果未知，不计入成功');
  });
}
