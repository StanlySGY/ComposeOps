#!/usr/bin/env node
/** Real model + production Agent loop; synthetic Docker adapter, real disposable SQLite mutations.
 * Never opens the operator DB or Docker socket. No production logs/prompts leave the host.
 * node scripts/agent-product-eval.mjs --real-model --config-file=/outside/repo/model.json --report=/tmp/report.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import Docker from 'dockerode';
const args = process.argv.slice(2), option = name => args.find(value => value.startsWith('--' + name + '='))?.split('=').slice(1).join('=');
if (!args.includes('--real-model') || !option('config-file') || !option('report')) throw new Error('Explicit --real-model, --config-file and --report required');
const config = JSON.parse(fs.readFileSync(option('config-file'), 'utf8'));
if (!config.baseUrl || !config.apiKey || !config.model) throw new Error('Model config incomplete');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-product-eval-'));
process.env.DB_PATH = path.join(directory, 'isolated.db'); process.env.DISABLE_BACKGROUND_JOBS = '1'; process.env.ENABLE_SHELL = '0';
for (const key of ['DB_ENCRYPTION_KEY', 'DB_ENCRYPTION_KEY_FILE', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']) delete process.env[key];
const { default: db, setSetting, createAiSession, getProjectPreference, setProjectPreference } = await import('../backend/src/lib/db.js');
const { setAiConfig } = await import('../backend/src/services/ai.js');
const { OperationsAgent } = await import('../backend/src/services/agent/engine.js');
const { getDockerForHost, upsertHost, getHost } = await import('../backend/src/services/docker-hosts.js');
const { scanProjects } = await import('../backend/src/services/scanner.js');
const { listProjectGroups, projectGroupMetadata } = await import('../backend/src/services/project-groups.js');
const { listSreProfiles, saveSreProfile } = await import('../backend/src/services/sre-profiles.js');
const { getSreChange } = await import('../backend/src/services/sre-changes.js');
const { listSessionOperations } = await import('../backend/src/services/agent/operations.js');
const agent = new OperationsAgent();
const allowed = new Set(['host.list', 'project.discover', 'project.list_managed', 'project.manage', 'group.list', 'group.save', 'group.assign', 'sre.context', 'sre.profile.save', 'sre.release.apply', 'sre.operation', 'ui.present']);
for (const name of [...agent.tools.keys()]) if (!allowed.has(name)) agent.tools.delete(name);
const regularGetTool = agent.getTool.bind(agent);
agent.getTool = name => allowed.has(name) ? regularGetTool(name) : null;
agent.listTools = () => [...agent.tools.values()].map(({ execute, ...rest }) => rest);
setAiConfig({ channels: [{ id: 'real-eval', name: '合成任务评测', enabled: true, supportsTools: true, firstTokenTimeoutMs: 60000, ...config }], failoverEnabled: false });
setSetting('docker.active_host', 'eval-a');
getDockerForHost('local').modem.dial = () => { throw new Error('Evaluation must never access local Docker'); };
// Prototype adapter survives docker-hosts' 30 s client cache expiry. The synthetic
// port selects the fixture node; every other Docker call is rejected at modem.dial.
Docker.prototype.info = async function () { return { ID: 'synthetic-engine-' + (Number(this.modem.port) === 2 ? 'eval-b' : 'eval-a') }; };
Docker.prototype.listContainers = async function () {
  const hostId = Number(this.modem.port) === 2 ? 'eval-b' : 'eval-a';
  return ['api', 'web'].map((service, index) => ({
    Id: (hostId + '-' + service).padEnd(64, '0'), Names: ['/demo-app-' + service], State: 'running', Status: 'Up (healthy)', Image: 'demo:' + service,
    ImageID: 'sha256:' + 'a'.repeat(64), Created: 1800000000 + index, HostConfig: { NetworkMode: 'bridge' }, Ports: [], Mounts: [],
    Labels: { 'com.docker.compose.project': 'demo-app', 'com.docker.compose.service': service, 'com.docker.compose.project.working_dir': '/synthetic/demo-app', 'com.docker.compose.project.config_files': '/synthetic/demo-app/compose.yml' },
  }));
};
Object.getPrototypeOf(getDockerForHost('local').modem).dial = () => { throw new Error('Real Docker I/O forbidden in model evaluation'); };
for (const [index, hostId] of ['eval-a', 'eval-b'].entries()) upsertHost({ id: hostId, name: hostId, type: 'tcp', host: '127.0.0.1', port: index + 1 });

const [projectA] = await scanProjects('eval-a'), [projectB] = await scanProjects('eval-b');
setProjectPreference(projectB.id, { managed: true, mountEnabled: false });
const reports = [];
async function run(id, message, checks) {
  const sessionId = createAiSession(), events = [], started = Date.now();
  let final = '', usage, failure = '';
  try {
    const result = await agent.executeWithLoop(message, { sessionId, role: 'auto', webSearchEnabled: false, hostId: 'eval-a', initiator: 'isolated-real-model-eval' }, event => {
      if (['tool_requested', 'tool_error', 'tool_result', 'confirmation_required', 'error', 'done'].includes(event.type)) {
        events.push({ type: event.type, tool: event.tool, params: event.params, success: event.result?.success, error: event.error, verification: event.result?.postconditionStatus });
      }
      if (event.type === 'confirmation_required') setImmediate(() => agent.approveToolCall(event.executionId, event.toolCallId, allowed.has(event.tool) && (!event.params?.hostId || event.params.hostId === 'eval-a')));
      if (event.type === 'done') { final = event.content; usage = event.usage; }
    }, AbortSignal.timeout(240000));
    assert.notEqual(result?.success, false, 'Agent loop failed');
    await checks({ events, final, sessionId });
  } catch (error) { failure = error.message; }
  const report = { id, model: config.model, passed: !failure, failure, durationMs: Date.now() - started, usage: usage || null, monetaryCost: null,
    costNote: '供应商未返回实际账单；不推测金额。', events, final: String(final || '').slice(0, 4000) };
  reports.push(report); fs.writeFileSync(option('report'), JSON.stringify({ scope: 'real model + actual Agent approvals and SQLite; synthetic Docker, no production operations', reports }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ id, passed: report.passed, durationMs: report.durationMs, tools: events.filter(row => row.type === 'tool_requested').map(row => row.tool), failure }));
}
try {
  await run('adopt-and-group', '请把节点 eval-a 上的 demo-app 纳管，关闭 Compose 目录授权，归入新建的“我的业务”组。不要改动 eval-b 的同名项目。请直接完成，所有确认由测试管理员逐次确认。完成后读取实际状态核对。', ({ events }) => {
    assert.equal(getProjectPreference(projectA.id).managed, 1, 'target project not adopted');
    assert.equal(getProjectPreference(projectB.id).managed, 1, 'other host changed');
    assert.equal(projectGroupMetadata(projectA.id).groupName, '我的业务');
    assert.equal(projectGroupMetadata(projectB.id).groupId, null);
    assert.ok(events.some(row => row.type === 'confirmation_required' && row.tool === 'project.manage'));
    assert.ok(events.filter(row => row.type === 'tool_requested').some(row => ['project.discover', 'project.list_managed'].includes(row.tool)));
    assert.equal(listProjectGroups().filter(row => row.name === '我的业务').length, 1);
  });
  // Every scenario has an independent starting state so one failure doesn't invalidate later observations.
  setProjectPreference(projectA.id, { managed: true, mountEnabled: false });
  await run('health-target', `为节点 eval-a 的项目 demo-app（ID ${projectA.id}）的 api 服务创建健康目标：地址 http://127.0.0.1:18601/health，HTTP 200，可用率99.9%，延迟1000ms。不授权自动修复。请保存并查询配置；不要声称业务已经验收。`, ({ events }) => {
    const profile = listSreProfiles().find(row => row.projectId === projectA.id && row.serviceName === 'api');
    assert.ok(profile); assert.equal(profile.config.url, 'http://127.0.0.1:18601/health');
    assert.ok(events.some(row => row.type === 'confirmation_required' && row.tool === 'sre.profile.save'));
  });
  const profiles = [];
  for (const serviceName of ['api', 'web']) profiles.push(listSreProfiles().find(row => row.projectId === projectA.id && row.serviceName === serviceName) || await saveSreProfile({ hostId: 'eval-a', projectId: projectA.id, serviceName, config: { url: 'http://127.0.0.1:18601/' + serviceName } }, 'fixture'));
  const now = Date.now(), releaseId = 'srel_synthetic_approved';
  const review = { recipe: 'application-release-v1', hostId: 'eval-a', projectId: projectA.id, projectName: 'demo-app', services: profiles.map(profile => ({ profileId: profile.id, profileVersion: profile.version, serviceName: profile.serviceName, migration: 'none', compatibilityNote: '合成应用代码升级，无数据库结构变更' })) };
  db.prepare('INSERT INTO sre_changes(id,status,host_id,project_id,profile_id,review_json,created_at,updated_at,expires_at,reviewed_by) VALUES(?,?,?,?,?,?,?,?,?,?)').run(releaseId, 'reviewed', 'eval-a', projectA.id, profiles[0].id, JSON.stringify(review), now, now, now + 900000, 'synthetic-fixture');
  await run('release-queue-and-verify-status', `节点 eval-a 的 demo-app 已完成多服务评审 ${releaseId}。我确认兼容声明，明确不允许自动回退。请读取当前评审指纹，提交这次可靠发布并查询一次持久状态。本测试执行器暂未运行，请如实报告排队结果，不要反复轮询或说业务已恢复。`, ({ events, final, sessionId }) => {
    assert.equal(getSreChange(releaseId).status, 'queued');
    assert.ok(events.some(row => row.type === 'confirmation_required' && row.tool === 'sre.release.apply'));
    assert.ok(events.some(row => row.type === 'tool_requested' && row.tool === 'sre.operation'));
    assert.equal(listSessionOperations(sessionId).operations[0].verification.status, 'pending');
    assert.match(final, /排队|队列|等待|尚未/);
  });
  db.prepare("UPDATE sre_changes SET status='outcome_unknown' WHERE id=?").run(releaseId);
  await run('unknown-is-not-replayed', `请检查节点 eval-a 的 demo-app 发布记录 ${releaseId} 是否恢复成功。仅核对结果，不重试、不关闭记录。`, ({ events, final }) => {
    assert.equal(getSreChange(releaseId).status, 'outcome_unknown');
    assert.equal(events.some(row => row.type === 'tool_requested' && row.tool.endsWith('.apply')), false);
    assert.match(final, /未知|无法确认|不确定|不能确认|核对/);
  });
} finally {
  await import('../backend/src/services/workflow-engine.js'); await new Promise(resolve => setImmediate(resolve));
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
}
if (reports.some(row => !row.passed)) process.exitCode = 1;
