import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createAlertRule, writeAlertRules, deleteAlertRule, listAlertRules } from '../src/services/alert-rules.js';
import { observeAgentAlertState, evaluateAgentRules, startAlertMonitor, stopAlertMonitor } from '../src/services/alert-monitor.js';
import { getDockerForHost, setActiveHost, upsertHost, deleteHost } from '../src/services/docker-hosts.js';
import { executeResourceAlertAction, alertActionState, acknowledgeAlertAction, boundedAlertCall, validateScaleDefinition, captureAlertAuthorization } from '../src/services/resource-alert-actions.js';
import { alertMatchesContainer } from '../src/services/alert-rule-store.js';
import { resolveManagedContainer } from '../src/services/agent-metrics.js';
import { scanProjects, invalidateScanCache } from '../src/services/scanner.js';
import { setProjectPreference } from '../src/lib/db.js';
import { withProjectOperationLock } from '../src/services/project-operation-lock.js';
import { createAgentPolicyGroup, createAgentPolicyRule, deleteAgentPolicyGroup, listAgentAuditEvents } from '../src/services/agent/policy-store.js';
import Fastify from 'fastify';
import metricsRoutes from '../src/routes/metrics.js';
import { getSystemStorageDf } from '../src/services/docker-storage.js';

const stats = { memory_stats: { usage: 90, limit: 100 }, cpu_stats: { cpu_usage: { total_usage: 1900 }, system_cpu_usage: 2000, online_cpus: 1 }, precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 1000 } };
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alert-target-')), file = path.join(root, 'compose.yml');
  await writeFile(file, 'services:\n  web:\n    image: busybox:1.36\n  webhook:\n    image: busybox:1.36\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const docker = getDockerForHost('local'), rows = ['web', 'webhook'].map(service => ({ Id: 'full-' + service, Names: ['/fixture-' + service + '-1'], State: 'running',
    Labels: { 'com.docker.compose.project': 'fixture', 'com.docker.compose.service': service, 'com.docker.compose.project.working_dir': root, 'com.docker.compose.project.config_files': file } }));
  t.mock.method(docker, 'info', async () => ({ ID: 'test-engine' }));
  t.mock.method(docker, 'listContainers', async () => rows);
  let started = 'before';
  const restart = t.mock.fn(async () => { started += '-after'; });
  const inspect = t.mock.fn(async () => ({ Id: rows[0].Id, Config: { Labels: rows[0].Labels }, State: { Running: true, StartedAt: started }, RestartCount: 9 }));
  const sample = t.mock.fn(async () => stats);
  t.mock.method(docker, 'getContainer', () => ({ restart, inspect, stats: sample }));
  const [project] = await scanProjects('local');
  setProjectPreference(project.id, { managed: true, mountEnabled: true, operationalIntent: 'running' });
  const input = { projectId: project.id, service: 'web', metric: 'memory', threshold: 80, action: 'auto_restart', confirmAutomatic: true };
  return { project, docker, rows, restart, inspect, sample, input };
}
test.beforeEach(() => { setActiveHost('local'); invalidateScanCache(); writeAlertRules([]); });
test.afterEach(() => { stopAlertMonitor(); setActiveHost('local'); invalidateScanCache(); });

test('不存在的项目不可凭空登记自动重启授权', async t => {
  t.mock.method(getDockerForHost('local'), 'listContainers', async () => []);
  await assert.rejects(createAlertRule({ projectId: 'missing', service: 'web', metric: 'cpu', threshold: 80, action: 'auto_restart', confirmAutomatic: true }), /项目不存在或尚未纳管/);
});

test('服务与容器使用精确目标，不能前缀模糊匹配或在旧ID消失时回退名称', async t => {
  const f = await fixture(t);
  await assert.rejects(createAlertRule({ ...f.input, service: 'we' }), /精确服务名/);
  assert.equal(alertMatchesContainer({ service: 'web' }, { id: 'other', name: 'webhook' }), false);
  assert.equal(alertMatchesContainer({ containerId: 'gone', service: 'web' }, { id: 'new', name: 'web', service: 'web' }), false);
  await assert.rejects(resolveManagedContainer('full-'), /不唯一/);
});

test('自动授权必须明确确认，固定节点Engine和完整容器ID，旧规则只通知', async t => {
  const f = await fixture(t);
  await assert.rejects(createAlertRule({ ...f.input, confirmAutomatic: false }), /明确确认/);
  const rule = await createAlertRule(f.input);
  assert.equal(rule.target.hostId, 'local'); assert.equal(rule.target.engineId, 'test-engine');
  assert.deepEqual(rule.authorization.containerIds, ['full-web']);
  assert.equal(rule.authorization.expiresAt - rule.authorization.approvedAt, 7 * 86400000);
  assert.equal(alertActionState({ ...rule, authorization: null }).status, 'authorization_required');
  assert.equal((await listAlertRules())[0].actionState.status, 'ready');
});

test('真实执行入口只重启固定容器，完成后保留审计和跨规则项目冷却预算', async t => {
  const f = await fixture(t), first = await createAlertRule(f.input), second = await createAlertRule({ ...f.input, metric: 'cpu' });
  const result = await executeResourceAlertAction(first, 'full-web');
  assert.equal(result.status, 'succeeded'); assert.equal(f.restart.mock.callCount(), 1);
  assert.equal(alertActionState(second).status, 'cooldown');
  await assert.rejects(executeResourceAlertAction(second, 'full-web'), /冷却/);
  assert.equal(f.restart.mock.callCount(), 1);
  assert.deepEqual(listAgentAuditEvents({ executionId: result.executionId }).map(row => row.eventType), ['resource_alert_reserved', 'resource_alert_succeeded']);
});

test('同项目不同规则共享24小时3次预算，删除重建规则不能清零', async t => {
  const f = await fixture(t); let now = Date.now(); t.mock.method(Date, 'now', () => now);
  let rule;
  for (let i = 0; i < 3; i++) {
    rule = await createAlertRule(f.input); await executeResourceAlertAction(rule, 'full-web'); await deleteAlertRule(rule.id); now += 600001;
  }
  rule = await createAlertRule(f.input);
  assert.equal(alertActionState(rule).status, 'exhausted');
  await assert.rejects(executeResourceAlertAction(rule, 'full-web'), /预算/);
  assert.equal(f.restart.mock.callCount(), 3);
});

test('项目锁等待期间撤销纳管，拿到锁后不发出重启', async t => {
  const f = await fixture(t), rule = await createAlertRule(f.input);
  let release, enter; const entered = new Promise(resolve => { enter = resolve; });
  const held = withProjectOperationLock(f.project.id, async () => { enter(); await new Promise(resolve => { release = resolve; }); });
  await entered;
  const pending = executeResourceAlertAction(rule, 'full-web');
  setProjectPreference(f.project.id, { managed: false }); release(); await held;
  await assert.rejects(pending, /取消纳管/); assert.equal(f.restart.mock.callCount(), 0);
});

test('Engine、规则、维护意图和持久拒绝策略变化都阻止自动处置', async t => {
  const f = await fixture(t), rule = await createAlertRule(f.input);
  t.mock.method(f.docker, 'info', async () => ({ ID: 'changed-engine' }));
  await assert.rejects(executeResourceAlertAction(rule, 'full-web'), /Engine 身份已变化/);
  t.mock.method(f.docker, 'info', async () => ({ ID: 'test-engine' }));
  setProjectPreference(f.project.id, { operationalIntent: 'maintenance' });
  await assert.rejects(executeResourceAlertAction(rule, 'full-web'), /维护/);
  setProjectPreference(f.project.id, { operationalIntent: 'running' });
  const group = createAgentPolicyGroup({ name: '禁止资源告警重启' }); t.after(() => deleteAgentPolicyGroup(group.id));
  createAgentPolicyRule({ groupId: group.id, name: 'deny', effect: 'deny', toolName: 'container.restart', projectId: f.project.id, parameters: { containerId: 'full-web' } });
  await assert.rejects(executeResourceAlertAction(rule, 'full-web'), /拒绝策略/);
  writeAlertRules([]); await assert.rejects(executeResourceAlertAction(rule, 'full-web'), /已删除或变更/);
  assert.equal(f.restart.mock.callCount(), 0);
});

test('切换活动节点不会把固定自动规则指向另一个Docker', async t => {
  const f = await fixture(t), rule = await createAlertRule(f.input);
  const host = upsertHost({ name: '无关节点', type: 'tcp', host: '127.0.0.1', port: 9 });
  t.after(() => { setActiveHost('local'); deleteHost(host.id); });
  const other = t.mock.method(getDockerForHost(host.id), 'listContainers', async () => { throw new Error('不应访问'); });
  setActiveHost(host.id); await executeResourceAlertAction(rule, 'full-web');
  assert.equal(other.mock.callCount(), 0); assert.equal(f.restart.mock.callCount(), 1);
});

test('执行异常持久保留未知，自动重放与删除被阻止，人工核对仍保留次数', async t => {
  const f = await fixture(t), rule = await createAlertRule(f.input);
  f.restart.mock.mockImplementation(async () => { throw new Error('连接中断'); });
  await assert.rejects(executeResourceAlertAction(rule, 'full-web'), /连接中断/);
  const state = alertActionState(rule); assert.equal(state.status, 'unknown');
  assert.equal(alertActionState(rule, rule.authorization.expiresAt + 1).status, 'unknown');
  await assert.rejects(executeResourceAlertAction(rule, 'full-web'), /未知/);
  await assert.rejects(deleteAlertRule(rule.id), /人工核对/);
  await assert.rejects(acknowledgeAlertAction(rule.id, { executionId: state.executionId }), /人工核对/);
  await acknowledgeAlertAction(rule.id, { executionId: state.executionId, confirm: 'CHECKED_RESOURCE_ACTION' });
  assert.equal(alertActionState(rule).status, 'cooldown'); assert.equal(f.restart.mock.callCount(), 1);
  await deleteAlertRule(rule.id);
});

test('最新指标已经恢复或数据缺失时，不执行先前排队的自动动作', async t => {
  const f = await fixture(t), rule = await createAlertRule(f.input);
  f.sample.mock.mockImplementation(async () => ({ memory_stats: { usage: 20, limit: 100 } }));
  await assert.rejects(executeResourceAlertAction(rule, 'full-web'), /已经恢复/);
  f.sample.mock.mockImplementation(async () => ({}));
  await assert.rejects(executeResourceAlertAction(rule, 'full-web'), /未知/);
  assert.equal(f.restart.mock.callCount(), 0); assert.equal(alertActionState(rule).status, 'ready');
});

test('监测停止期间尚未发出的操作取消，已经发送的未知操作不伪装成功', async t => {
  const f = await fixture(t), rule = await createAlertRule(f.input); let current = true, verifies = 0;
  await assert.rejects(executeResourceAlertAction(rule, 'full-web', { isCurrent: () => current, verifyHost: async () => { if (++verifies === 3) current = false; } }), /监测已停止/);
  assert.equal(f.restart.mock.callCount(), 0); assert.equal(alertActionState(rule).status, 'ready');
});

test('缺失CPU基准和内存数据不能进入告警，固定ID规则不触发同名其它容器', async t => {
  const f = await fixture(t), rule = await createAlertRule({ ...f.input, metric: 'cpu', action: 'notify' });
  const apply = t.mock.fn(async () => {}), project = { ...f.project, managed: true };
  for (let i = 0; i < 3; i++) await evaluateAgentRules(project, { id: 'full-web', service: 'web' }, { cpu_stats: stats.cpu_stats }, { apply });
  assert.equal(apply.mock.callCount(), 0);
  for (let i = 0; i < 3; i++) await evaluateAgentRules(project, { id: 'new-web', service: 'web' }, stats, { apply });
  assert.equal(apply.mock.callCount(), 0);
  for (let i = 0; i < 3; i++) await evaluateAgentRules(project, { id: 'full-web', service: 'web' }, stats, { apply });
  assert.equal(apply.mock.callCount(), 1); assert.equal(apply.mock.calls[0].arguments[0].id, rule.id);
});

test('不合作传输也有明确期限，不会永远卡住采样', async () => {
  const start = Date.now();
  await assert.rejects(boundedAlertCall(() => new Promise(() => {}), 20), /超时/);
  assert.ok(Date.now() - start < 1000);
});

test('停止监测也清理五秒启动定时器，不能在停用后启动采样', t => {
  const previous = process.env.DISABLE_BACKGROUND_JOBS; delete process.env.DISABLE_BACKGROUND_JOBS;
  t.after(() => { if (previous !== undefined) process.env.DISABLE_BACKGROUND_JOBS = previous; });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const read = t.mock.method(getDockerForHost('local'), 'listContainers', async () => []);
  startAlertMonitor(); stopAlertMonitor(); t.mock.timers.tick(6000);
  assert.equal(read.mock.callCount(), 0);
});

test('自动扩容拒绝可变镜像、挂载、固定端口与特殊网络', () => {
  const base = { image: 'busybox@sha256:' + 'a'.repeat(64) };
  assert.equal(validateScaleDefinition({ effective: { services: { web: base } } }, 'web'), base);
  for (const extra of [{ image: 'busybox:latest' }, { volumes: [{ type: 'volume' }] }, { ports: [{ published: '8080' }] }, { network_mode: 'host' }, { privileged: true }, { container_name: 'fixed' }]) {
    assert.throws(() => validateScaleDefinition({ effective: { services: { web: { ...base, ...extra } } } }, 'web'));
  }
});

test('扩容配置变更或副本上限阻止执行，未知结果不会继续扩容', async t => {
  const f = await fixture(t), snapshot = { fingerprint: 'fixed-config', effective: { services: { web: { image: 'busybox@sha256:' + 'a'.repeat(64) } } } };
  const rule = { ...(await createAlertRule(f.input)), action: 'scale' }; delete rule.actionState;
  rule.authorization = await captureAlertAuthorization(rule, { ...f.project, containers: [{ id: 'full-web', service: 'web', state: 'running' }], editable: true }, { confirmAutomatic: true }, { capture: async () => snapshot });
  writeAlertRules([rule]); const scale = t.mock.fn(async () => {});
  await assert.rejects(executeResourceAlertAction(rule, 'full-web', { capture: async () => ({ ...snapshot, fingerprint: 'changed' }), scale }), /配置已变化/);
  const containers = Array.from({ length: 5 }, (_, i) => ({ id: i ? 'replica-' + i : 'full-web', service: 'web', state: 'running' }));
  await assert.rejects(executeResourceAlertAction(rule, 'full-web', { capture: async () => snapshot, scale, scan: async () => [{ ...f.project, managed: true, editable: true, containers }] }), /5 个副本/);
  assert.equal(scale.mock.callCount(), 0);
});

test('缺失指标不能充当正常样本重新武装已有告警', () => {
  const rule = { id: 'unknown-sample', projectId: 'fixture', service: 'web', metric: 'cpu', threshold: 80, action: 'notify' };
  assert.equal(observeAgentAlertState(rule, 'container', 90), false);
  assert.equal(observeAgentAlertState(rule, 'container', 90), true);
  observeAgentAlertState(rule, 'container', null); observeAgentAlertState(rule, 'container', null);
  assert.equal(observeAgentAlertState(rule, 'container', 90), false);
  assert.equal(observeAgentAlertState(rule, 'container', 90), false);
});

test('缺失或过期采样打断连续样本计数，但不能解除已有事件', () => {
  const rule = { id: 'consecutive-samples', projectId: 'fixture', service: 'web', metric: 'cpu', threshold: 80, action: 'notify' };
  assert.equal(observeAgentAlertState(rule, 'container', 90, 80, { now: 0 }), false);
  observeAgentAlertState(rule, 'container', null);
  assert.equal(observeAgentAlertState(rule, 'container', 90, 80, { now: 1000 }), false);
  assert.equal(observeAgentAlertState(rule, 'container', 90, 80, { now: 300000 }), false);
  assert.equal(observeAgentAlertState(rule, 'container', 90, 80, { now: 301000 }), true);
});

test('HTTP接口保留明确自动授权字段，缺少确认不保存规则', async t => {
  const f = await fixture(t), app = Fastify(); await app.register(metricsRoutes, { prefix: '/metrics' }); t.after(() => app.close());
  const payload = { container: 'full-web', metric: 'cpu', threshold: 80, action: 'auto_restart' };
  const denied = await app.inject({ method: 'POST', url: '/metrics/alerts', payload });
  assert.equal(denied.statusCode, 400); assert.match(denied.json().message, /明确确认/);
  const created = await app.inject({ method: 'POST', url: '/metrics/alerts', payload: { ...payload, confirmAutomatic: true } });
  assert.equal(created.statusCode, 200); assert.equal(created.json().rule.target.engineId, 'test-engine');
  assert.equal(f.restart.mock.callCount(), 0);
});

test('后台空间检查可读固定非活动节点，交互式统计仍要求当前节点', async t => {
  const host = upsertHost({ name: '后台存储节点', type: 'tcp', host: '127.0.0.1', port: 9 });
  t.after(() => deleteHost(host.id));
  t.mock.method(getDockerForHost(host.id), 'df', async () => ({ LayersSize: 100, Images: [{ Size: 90 }, { Size: 90 }], Containers: [], Volumes: [], BuildCache: [] }));
  const result = await getSystemStorageDf(host.id, { background: true });
  assert.equal(result.hostId, host.id); assert.equal(result.images.total, 100);
  await assert.rejects(getSystemStorageDf(host.id), /节点或连接配置已变化/);
});
