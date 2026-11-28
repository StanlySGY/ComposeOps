#!/usr/bin/env node
/** Explicit real model + real Docker + production Tool Loop + persistent journal.
 * Only unique disposable, unprivileged fixtures are exposed to the model. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Docker from 'dockerode';
const args = process.argv.slice(2), option = key => args.find(a => a.startsWith('--' + key + '='))?.slice(key.length + 3);
if (!args.includes('--real-model') || !args.includes('--run-isolated-fixtures') || !option('config-file') || !option('report')) throw new Error('Require --real-model --run-isolated-fixtures --config-file=... --report=...');
const config = JSON.parse(fs.readFileSync(option('config-file'), 'utf8'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-agent-real-'));
process.env.DB_PATH = path.join(work, 'db.sqlite'); process.env.ENABLE_SHELL = '0'; process.env.DISABLE_BACKGROUND_JOBS = '1';
for (const key of ['DB_ENCRYPTION_KEY', 'DB_ENCRYPTION_KEY_FILE', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']) delete process.env[key];
const raw = new Docker(), name = 'composeops-agent-eval-' + randomBytes(5).toString('hex');
const fixtureIds = new Set(), reports = [], original = {};
const before = (await raw.listContainers({ all: true })).map(row => ({ id: row.Id, state: row.State }));
const { default: db, createAiSession, getProjectPreference, setProjectPreference } = await import('../backend/src/lib/db.js');
const { getDockerForHost } = await import('../backend/src/services/docker-hosts.js');
const { scanProjects, invalidateScanCache } = await import('../backend/src/services/scanner.js');
const { setAiConfig } = await import('../backend/src/services/ai.js');
const { OperationsAgent } = await import('../backend/src/services/agent/engine.js');
const { startAgentRun } = await import('../backend/src/services/agent/runs.js');
const { getRun, runEffects } = await import('../backend/src/services/agent/run-store.js');
const { projectGroupMetadata } = await import('../backend/src/services/project-groups.js');
const { listSreProfiles } = await import('../backend/src/services/sre-profiles.js');
const client = getDockerForHost('local');
const allowed = new Set(['project.discover','project.list_managed','project.manage','group.list','group.save','group.assign','compose.ps','compose.logs','compose.restart','compose.stop','compose.up','sre.context','sre.profile.save','ui.present']);
const agent = new OperationsAgent();
for (const tool of [...agent.tools.keys()]) if (!allowed.has(tool)) agent.tools.delete(tool);
const getTool = agent.getTool.bind(agent); agent.getTool = name => allowed.has(name) ? getTool(name) : null;
agent.listTools = () => [...agent.tools.values()].map(({ execute, ...rest }) => rest);
setAiConfig({ channels: [{ id: 'real-joint', name: '真实模型隔离 Docker 验收', enabled: true, supportsTools: true, firstTokenTimeoutMs: 60000, ...config }], failoverEnabled: false });
function save() { fs.writeFileSync(option('report'), JSON.stringify({ scope: 'real model + real Docker isolated containers + production approval and persistent runs', model: config.model, reports }, null, 2), { mode: 0o600 }); }
async function run(id, message, project, checks) {
  const started = Date.now(), events = []; let usage;
  const task = startAgentRun(message, { sessionId: createAiSession(), role: 'executor', hostId: 'local', projectId: project.id, initiator: 'admin', webSearchEnabled: false }, 'admin', event => {
    if (event.type === 'done') usage = event.usage;
    if (['tool_requested','confirmation_required','tool_result','tool_error','error'].includes(event.type)) events.push({ type: event.type, tool: event.tool, params: event.params, success: event.result?.success, result: event.tool === 'compose.logs' ? event.result?.result : undefined, error: event.error || event.content });
    if (event.type === 'confirmation_required') setImmediate(() => {
      const params = event.params || {};
      const scoped = !params.projectId || params.projectId === project.id;
      agent.approveToolCall(event.executionId, event.toolCallId, scoped && (!params.hostId || params.hostId === 'local') && allowed.has(event.tool));
    });
  }, agent);
  let failure = '';
  try { const completed = await task.finished; assert.equal(completed.status, 'completed', completed.error || completed.result?.finalContent); await checks({ events, task: completed }); }
  catch (error) { failure = error.message; }
  reports.push({ id, passed: !failure, failure, durationMs: Date.now() - started, usage: usage || null, monetaryCost: null, events, effects: runEffects(task.run.id), final: getRun(task.run.id)?.result?.finalContent }); save();
  console.log(JSON.stringify({ id, passed: !failure, durationMs: Date.now() - started, failure }));
}
try {
  for (const service of ['api','worker']) {
    const container = await raw.createContainer({ Image: 'composeops:sre-release-old', name: name + '-' + service,
      Labels: { 'composeops.eval': name, 'com.docker.compose.project': name, 'com.docker.compose.service': service, 'com.docker.compose.project.working_dir': work },
      ExposedPorts: { '8080/tcp': {} }, HostConfig: { Memory: 64 * 1024 * 1024, NanoCpus: 250000000, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] } } });
    fixtureIds.add(container.id); await container.start();
  }
  // Every engine helper gets the same local singleton. All other Docker I/O is denied.
  for (const method of ['listContainers','getContainer','info']) original[method] = client[method];
  original.dial = client.modem.dial;
  client.modem.dial = () => { throw new Error('Non-fixture Docker I/O denied'); };
  client.listContainers = options => raw.listContainers({ ...options, filters: { label: ['composeops.eval=' + name] } });
  client.getContainer = id => { assert.ok(fixtureIds.has(id), 'Model requested non-fixture container'); return raw.getContainer(id); };
  client.info = async () => ({ ID: (await raw.info()).ID });
  const [project] = await scanProjects('local'); assert.ok(project); assert.equal(project.containers.length, 2);
  await run('discover-adopt-and-group', `请发现 local 节点的 ${name} 项目，纳管并关闭 Compose 目录授权，放入新建分组“隔离验收组”。只处理这个项目，逐次确认由验收人员提供。完成后读取分组核对。`, project, ({ events }) => {
    assert.equal(getProjectPreference(project.id).managed, 1); assert.equal(projectGroupMetadata(project.id).groupName, '隔离验收组'); assert.ok(events.some(e => e.type === 'confirmation_required' && e.tool === 'project.manage'));
  });
  setProjectPreference(project.id, { managed: true, mountEnabled: false });
  const target = project.containers.find(c => c.service === 'api'), bystander = project.containers.find(c => c.service === 'worker');
  const initialTarget = await raw.getContainer(target.id).inspect(), initialOther = await raw.getContainer(bystander.id).inspect();
  await run('restart-one-service-and-verify', `重启 local 节点项目 ${project.id} 的 api 服务，只操作 api，必须保持 worker 不动。调用 compose.restart 并传 services=["api"]，随后读取 compose.ps 和 api 的日志核对。不要把容器运行等同于业务验收。`, project, async ({ events }) => {
    const a = await raw.getContainer(target.id).inspect(), b = await raw.getContainer(bystander.id).inspect();
    assert.equal(a.State.Running, true); assert.notEqual(a.State.StartedAt, initialTarget.State.StartedAt); assert.equal(b.State.StartedAt, initialOther.State.StartedAt);
    assert.ok(events.some(e => e.type === 'confirmation_required' && e.tool === 'compose.restart'));
    assert.ok(events.some(e => e.type === 'tool_requested' && e.tool === 'compose.ps'));
    assert.ok(events.some(e => e.type === 'tool_result' && e.tool === 'compose.logs' && e.result?.containers?.length === 1 && e.result.containers[0] === target.name), 'must read the selected api logs');
  });
  const info = await raw.getContainer(target.id).inspect(), url = 'http://127.0.0.1:' + info.NetworkSettings.Ports['8080/tcp'][0].HostPort + '/';
  await run('real-service-health-target', `为 local 节点项目 ${project.id} 的 api 创建健康目标，URL=${url}，HTTP 200、可用率99.9%、延迟1000ms，不授权自动修复。保存后通过 sre.context 查询，说明这是配置保存。`, project, async () => {
    const profile = listSreProfiles().find(p => p.projectId === project.id && p.serviceName === 'api'); assert.equal(profile?.config.url, url); assert.equal((await fetch(url)).status, 200);
  });
  await run('stop-only-worker', `请停止 local 节点项目 ${project.id} 的 worker，必须传 services=["worker"]，保留 api 运行。完成后用 compose.ps 核对。`, project, async () => {
    assert.equal((await raw.getContainer(bystander.id).inspect()).State.Running, false); assert.equal((await raw.getContainer(target.id).inspect()).State.Running, true);
  });
} finally {
  for (const [method, value] of Object.entries(original)) if (method === 'dial') client.modem.dial = value; else client[method] = value;
  for (const id of fixtureIds) { const container = raw.getContainer(id); const info = await container.inspect(); assert.equal(info.Config.Labels['composeops.eval'], name); await container.remove({ force: true, v: true }); }
  invalidateScanCache();
  const after = await raw.listContainers({ all: true }); const unchanged = before.every(row => after.some(other => other.Id === row.id && other.State === row.state));
  reports.push({ id: 'cleanup-and-production-isolation', passed: unchanged && !after.some(row => fixtureIds.has(row.Id)), unrelatedContainers: before.length }); save();
  await import('../backend/src/services/workflow-engine.js'); await new Promise(resolve => setImmediate(resolve)); db.close(); fs.rmSync(work, { recursive: true, force: true });
}
if (reports.some(r => !r.passed)) process.exitCode = 1;
