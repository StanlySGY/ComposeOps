/** Agent adapters use the exact services used by the reliability UI. */
import { durableOperation, readDurableOperation } from '../agent/operations.js';
import { getSreProfile, listSreProfiles, saveSreProfile, pauseSreProfile } from '../sre-profiles.js';
import { latestProbe, probeStatistics } from '../sre-probes.js';
import { getOnboarding, listOnboarding, onboardingContext, saveOnboarding, applyOnboarding } from '../sre-onboarding.js';
import { getSreChange, listSreChanges, reviewSreChange, approveSreChange, cancelSreChange, sreChangeFingerprint } from '../sre-changes.js';
import { reviewSreRelease, approveSreRelease } from '../sre-releases.js';
import { listBusinessRecovery, businessRecoveryCandidates, getBusinessPlan, saveBusinessPlan, pauseBusinessPlan, queueBusinessBackup, queueBusinessRun } from '../sre-business-recovery.js';

const id = { type: 'string', minLength: 1, maxLength: 160 };
const version = { type: 'integer', minimum: 1 };
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const schema = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const scope = { hostId: id, projectId: id };
const fingerprint = { type: 'string', minLength: 64, maxLength: 64 };
const config = { type: 'object', description: '与可靠性页面相同的配置；先读取 sre.context 的 configGuide。不得填写生产凭据，只引用已有环境变量名或隔离占位值。' };
const actor = context => context.initiator || 'agent';
function assertScope(resource, p) {
  if (resource.hostId !== p.hostId || resource.projectId !== p.projectId) throw new Error('记录不属于指定节点与项目');
  return resource;
}
function currentPlan(p) {
  const plan = assertScope(getBusinessPlan(p.planId), p);
  if (plan.version !== p.version) throw new Error('业务恢复计划版本已变化，请重新审阅');
  return plan;
}

const configGuide = {
  health: { url: 'http://service.example/health', expectedStatus: 200, targetPercent: 99.9, maxLatencyMs: 1000 },
  business: { engine: 'postgres', dbService: 'db', appService: 'api', database: 'app', user: 'postgres', credentialEnv: 'POSTGRES_PASSWORD', appEnvironment: { DATABASE_URL: '$DB_URL' }, assertions: [{ table: 'orders', expectedRows: 1 }], http: { port: 8080, path: '/health', expectedStatus: 200, bodyContains: 'ok' }, rpoMinutes: 1440, rtoMinutes: 15, scheduleHours: 0 },
  onboarding: { health: { mode: 'create', serviceName: 'api', config: { url: 'http://service.example/health' } }, recovery: { mode: 'later', reason: '用户选择稍后配置' }, alerts: { enabled: true }, notifications: 'later', autonomy: { enabled: false } },
  note: '示例值不是当前业务事实。HTTP 地址、数据断言、兼容声明和授权范围必须来自用户或真实证据，不能猜测。',
};
export function registerReliabilityTools(agent) {
  const register = (name, description, properties, required, execute, write = false) => agent.registerTool(name, {
    description, parameters: schema({ ...scope, ...properties }, ['hostId', 'projectId', ...required]), execute,
    ...(name === 'sre.operation' ? { storedScope: true } : {}),
    category: 'reliability', productDomain: 'reliability', readOnly: !write, requiredPermission: name === 'sre.operation' ? 'readonly' : 'managed', requiresProject: name !== 'sre.operation', confirmationRequired: write,
  });
  register('sre.context', '读取指定应用健康目标、接入草稿、发布记录、恢复计划与配置格式；含真实服务名、版本和限制。', {}, [], async p => {
    const belongs = row => row.hostId === p.hostId && row.projectId === p.projectId;
    const context = await onboardingContext(p);
    return { ...context, configGuide, profiles: listSreProfiles().filter(belongs).map(profile => ({ ...profile, latest: latestProbe(profile), statistics: probeStatistics(profile) })),
      drafts: listOnboarding().filter(belongs), changes: listSreChanges().filter(belongs).map(row => ({ ...row, fingerprint: sreChangeFingerprint(row) })) };
  });
  register('sre.profile.save', '创建或修改应用 HTTP 健康目标。更新需 id/version；此配置不等于健康已经通过。', { id, version, serviceName: id, config, enabled: { type: 'boolean' } }, ['serviceName', 'config'], async (p, c) => {
    if (p.id) assertScope(getSreProfile(p.id), p); return saveSreProfile(p, actor(c));
  }, true);
  register('sre.profile.pause', '暂停指定健康目标及其自动修复授权，需当前版本。', { profileId: id, version }, ['profileId', 'version'], async (p, c) => {
    const profile = assertScope(getSreProfile(p.profileId), p); if (profile.version !== p.version) throw new Error('健康目标版本已变化'); return pauseSreProfile(p.profileId, actor(c));
  }, true);
  register('sre.onboarding.save', '保存可恢复的应用接入草稿；仅保存不执行接入。更新需 id/version，新建使用稳定 requestId 防止重复。', { id, version, requestId: { type: 'string', minLength: 16, maxLength: 80 }, config }, ['requestId', 'config'], async (p, c) => {
    if (p.id) assertScope(getOnboarding(p.id), p); return saveOnboarding(p, actor(c));
  }, true);
  register('sre.onboarding.apply', '按已审阅版本与指纹提交接入草稿。启用自动修复还需 autonomyConfirm 明确范围授权；部分完成可以查询后重新审阅。', {
    id, version, fingerprint, confirm: { const: 'APPLY_APPLICATION_ONBOARDING' }, autonomyConfirm: { const: 'ENABLE_AUTONOMY' },
  }, ['id', 'version', 'fingerprint', 'confirm'], async (p, c) => { assertScope(getOnboarding(p.id), p); return durableOperation('onboarding', await applyOnboarding(p.id, p, actor(c))); }, true);
  register('sre.change.review', '评审单服务固定镜像变更，收集当前配置、镜像和 HTTP 基线；生成指纹，不执行发布。', { profileId: id, image: text(300) }, ['profileId', 'image'], async (p, c) => {
    assertScope(getSreProfile(p.profileId), p); const change = await reviewSreChange(p, actor(c)); return { ...change, fingerprint: sreChangeFingerprint(change) };
  }, true);
  register('sre.release.review', '评审同一应用的多服务可靠发布；固定完整配置、镜像、依赖顺序与兼容声明。不执行发布；不要以 compose.pull/up 替代可靠发布。', {
    services: { type: 'array', minItems: 2, maxItems: 20, items: schema({ profileId: id, image: text(300), migration: { enum: ['none', 'backward_compatible'] }, compatibilityNote: { type: 'string', minLength: 8, maxLength: 1000 } }, ['profileId', 'image', 'migration', 'compatibilityNote']) },
  }, ['services'], async (p, c) => { p.services.forEach(row => assertScope(getSreProfile(row.profileId), p)); const change = await reviewSreRelease(p, actor(c)); return { ...change, fingerprint: sreChangeFingerprint(change) }; }, true);
  register('sre.change.apply', '人工确认单服务评审指纹与回退授权后进入持久队列。必须查询 sre.operation 的最终验收结果。不能用于多服务发布。', {
    id, fingerprint, allowRollback: { type: 'boolean' }, confirm: { const: 'APPLY_PINNED_IMAGE' },
  }, ['id', 'fingerprint', 'allowRollback', 'confirm'], async (p, c) => { assertScope(getSreChange(p.id), p); return durableOperation('change', approveSreChange(p.id, p, actor(c))); }, true);
  register('sre.release.apply', '人工确认完整多服务评审、兼容声明及反序回退授权后进入持久队列；不能复用单服务审批。', {
    id, fingerprint, allowRollback: { type: 'boolean' }, compatibilityConfirmed: { const: true }, confirm: { const: 'APPLY_APPLICATION_RELEASE' },
  }, ['id', 'fingerprint', 'allowRollback', 'compatibilityConfirmed', 'confirm'], async (p, c) => { assertScope(getSreChange(p.id), p); return durableOperation('change', approveSreRelease(p.id, p, actor(c))); }, true);
  register('sre.change.cancel', '取消尚未执行的单服务或多服务发布；运行中或结果未知的任务不能取消重放。', { id }, ['id'], async (p, c) => { assertScope(getSreChange(p.id), p); return cancelSreChange(p.id, actor(c)); }, true);
  register('sre.business.candidates', '读取数据库和应用服务、凭据变量名与隔离恢复支持范围；不返回凭据值。', {}, [], p => businessRecoveryCandidates(p));
  register('sre.business.plan', '保存业务备份和隔离恢复计划，使用真实业务表断言与 HTTP 响应验收。定时执行需显式 ENABLE_BUSINESS_SCHEDULE；MySQL 要确认无并发 DDL。', {
    id, version, config, enabled: { type: 'boolean' }, confirm: { const: 'ENABLE_BUSINESS_SCHEDULE' }, noConcurrentDdl: { type: 'boolean' },
  }, ['config'], async (p, c) => { if (p.id) assertScope(getBusinessPlan(p.id), p); return saveBusinessPlan(p, actor(c)); }, true);
  register('sre.business.pause', '暂停业务恢复计划，取消后续计划执行；需当前版本。', { planId: id, version }, ['planId', 'version'], async (p, c) => { currentPlan(p); return pauseBusinessPlan(p.planId, actor(c)); }, true);
  register('sre.business.backup', '为固定版本恢复计划提交原生数据库备份。drillAfter=true 表示备份后隔离业务演练。排队不等于备份或业务恢复通过。', {
    planId: id, version, drillAfter: { type: 'boolean' }, confirm: { const: 'CREATE_BUSINESS_BACKUP' },
  }, ['planId', 'version', 'confirm'], async (p, c) => { currentPlan(p); return durableOperation('business-backup', queueBusinessBackup(p.planId, actor(c), p.drillAfter === true)); }, true);
  register('sre.business.restore', '使用指定备份在独立网络/新卷进行 SQL+HTTP 业务恢复演练，不覆盖源数据库。必须指定已验证备份及当前计划版本。', {
    planId: id, version, backupId: id, confirm: { const: 'ISOLATED_BUSINESS_RECOVERY' },
  }, ['planId', 'version', 'backupId', 'confirm'], async (p, c) => { currentPlan(p); return durableOperation('business-run', queueBusinessRun(p.planId, p.backupId, actor(c))); }, true);
  register('sre.operation', '查询持久发布、备份、恢复或接入记录。重连或重启后用原 ID 查询，禁止自动重放未知结果。业务恢复仅 passed 且 SQL/HTTP/RPO/RTO/清理全部通过才算验收。', {
    kind: { enum: ['change', 'business-backup', 'business-run', 'onboarding'] }, id,
  }, ['kind', 'id'], async p => {
    return readDurableOperation(p);
  });
  register('sre.business.list', '查询指定应用业务恢复计划、备份和演练状态，含固定备份证据。', {}, [], async p => {
    const rows = listBusinessRecovery(), belongs = row => row.hostId === p.hostId && row.projectId === p.projectId;
    return { protection: rows.protection, plans: rows.plans.filter(belongs), backups: rows.backups.filter(row => belongs(row.snapshot.plan)), runs: rows.runs.filter(row => belongs(row.snapshot.plan)) };
  });
}
