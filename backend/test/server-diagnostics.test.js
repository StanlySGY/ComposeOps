import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectServer, runServerDiagnostic } from '../src/services/server-diagnostics.js';
import { upsertHost, deleteHost, setActiveHost, getDockerForHost, getHost } from '../src/services/docker-hosts.js';
import { collectInfrastructure } from '../src/services/infrastructure.js';
import { registerMaintenanceTools } from '../src/services/tools/maintenance-tools.js';

const info = () => ({ ID: 'fixture-engine', Name: 'remote-fixture', OSType: 'linux', KernelVersion: 'fixture-kernel',
  NCPU: 2, MemTotal: 1073741824, ServerVersion: 'fixture', Containers: 0, ContainersRunning: 0 });
function remote(t) {
  const host = upsertHost({ name: '诊断隔离节点', type: 'tcp', host: '127.0.0.1', port: 9 });
  setActiveHost(host.id);
  t.after(() => { setActiveHost('local'); if (getHost(host.id)) deleteHost(host.id); });
  const docker = getDockerForHost(host.id);
  t.mock.method(docker, 'info', async () => info());
  t.mock.method(docker, 'listContainers', async () => []);
  return { host, docker };
}
function sample(hostId, source = 'ssh') {
  return { nodes: [{ hostId, status: 'ready', engine: { id: info().ID, hostname: info().Name, kernel: info().KernelVersion }, host: {
    status: 'ready', source, sampledAt: Date.now(), hostname: info().Name, kernel: info().KernelVersion, uptime: 1234,
    memory: { total: 1000, available: 400, used: 600, percent: 60 },
    cpu: { cores: 2, percent: 20, loadavg: [0.1, 0.2, 0.3] },
    disks: [{ mountpoint: '/', total: 1000, used: 500, free: 500, percent: 50 }], network: { rx: 10, tx: 20 },
  } }] };
}

test('远端容量来自指定Engine；没有宿主采集时使用量未知且不能回退本机命令', async t => {
  const { host } = remote(t);
  const tools = new Map(), registry = { registerTool(name, config) { tools.set(name, config); return this; } };
  registerMaintenanceTools(registry);
  const result = await tools.get('server.inspect').execute();
  assert.equal(result.hostId, host.id); assert.equal(result.hostname, 'remote-fixture');
  assert.equal(result.memory.totalBytes, info().MemTotal); assert.equal(result.memory.capacitySource, 'docker-engine');
  assert.equal(result.memory.usedBytes, null); assert.equal(result.cpu.percent, null);
  assert.equal(result.network, null); assert.equal(result.disks, null); assert.equal(result.uptimeSeconds, null);
  for (const command of ['memory', 'uptime', 'disk']) await assert.rejects(tools.get('server.command').execute({ command }), { statusCode: 409 });
  for (const command of ['uname', 'docker', 'containers']) {
    const result = await runServerDiagnostic(command);
    assert.equal(result.hostId, host.id); assert.equal(result.source, 'docker-engine');
  }
});

test('身份匹配且新鲜的SSH和独立采样可用于命令；输出说明来源时间', async t => {
  const { host } = remote(t);
  for (const source of ['ssh', 'host-agent']) {
    const value = sample(host.id, source), options = { snapshot: () => value };
    const data = await inspectServer(host.id, options);
    assert.equal(data.hostMetrics.status, 'ready'); assert.equal(data.memory.usedBytes, 600);
    assert.equal(data.memory.capacitySource, source); assert.equal(data.cpu.percent, 20);
    for (const command of ['memory', 'disk', 'uptime']) {
      const result = await runServerDiagnostic(command, host.id, options);
      assert.equal(result.source, source); assert.equal(result.sampledAt, value.nodes[0].host.sampledAt);
    }
    assert.equal(JSON.parse((await runServerDiagnostic('uptime', host.id, options)).output).uptimeSeconds, 1234);
  }
});

test('其它节点、Engine身份、主机名、内核、时钟或过期采样均不能提供实时使用量', async t => {
  const { host } = remote(t);
  const invalid = [
    node => { node.hostId = 'other'; }, node => { node.engine.id = 'other'; },
    node => { node.engine.hostname = 'other'; }, node => { node.engine.kernel = 'other'; },
    node => { node.host.hostname = 'other'; }, node => { node.host.kernel = 'other'; },
    node => { node.host.sampledAt -= 60000; }, node => { node.host.sampledAt += 60000; },
    node => { node.host.status = 'stale'; }, node => { node.status = 'stale'; },
    node => { node.host.source = 'panel'; }, node => { node.host.sampledAt = NaN; },
  ];
  for (const mutate of invalid) {
    const value = sample(host.id); mutate(value.nodes[0]); const options = { snapshot: () => value };
    const result = await inspectServer(host.id, options);
    assert.notEqual(result.hostMetrics.status, 'ready'); assert.equal(result.memory.usedBytes, null);
    await assert.rejects(runServerDiagnostic('memory', host.id, options), { statusCode: 409 });
  }
});

test('节点切换后再返回、修改连接和删除节点，均拒绝迟到诊断', async t => {
  for (const mutation of ['switch', 'edit', 'remove']) {
    await t.test(mutation, async t => {
      const { host, docker } = remote(t); let release;
      t.mock.method(docker, 'info', () => new Promise(resolve => { release = resolve; }));
      const result = inspectServer(); await new Promise(resolve => setImmediate(resolve));
      if (mutation === 'switch') { setActiveHost('local'); setActiveHost(host.id); }
      if (mutation === 'edit') upsertHost({ ...host, port: 10 });
      if (mutation === 'remove') { setActiveHost('local'); deleteHost(host.id); }
      release(info()); await assert.rejects(result, { statusCode: 409 });
    });
  }
});

test('不合作的Engine和容器清单读取有期限，清单失败保留未知而非空成功', async t => {
  const { host, docker } = remote(t); let signal;
  t.mock.method(docker, 'listContainers', ({ abortSignal }) => { signal = abortSignal; return new Promise(() => {}); });
  const start = Date.now(), result = await inspectServer(host.id, { timeoutMs: 20 });
  assert.ok(Date.now() - start < 1000); assert.equal(signal.aborted, true);
  assert.equal(result.containersAvailable, false); assert.equal(result.containers, null); assert.equal(result.containerCount, null);
  await assert.rejects(runServerDiagnostic('containers', host.id, { timeoutMs: 20 }), { statusCode: 503 });
  t.mock.method(docker, 'info', () => new Promise(() => {}));
  await assert.rejects(inspectServer(host.id, { timeoutMs: 20 }), { statusCode: 503 });
});

test('不回显原始Engine敏感字段或传输错误；容器清单有上限并注明截断', async t => {
  const { host, docker } = remote(t), secret = 'fixture-sensitive-proxy';
  t.mock.method(docker, 'info', async () => ({ ...info(), HttpProxy: secret, RegistryConfig: { Password: secret } }));
  t.mock.method(docker, 'listContainers', async () => Array.from({ length: 220 }, (_, i) => ({ Id: String(i), Names: [`/c${i}`], State: 'running', Env: [secret], Labels: { PASSWORD: secret } })));
  const result = await inspectServer(host.id);
  assert.equal(result.containers.length, 200); assert.equal(result.containerCount, 220); assert.equal(result.containersTruncated, true);
  assert.ok(!JSON.stringify(result).includes(secret));
  t.mock.method(docker, 'info', async () => { throw new Error(secret); });
  await assert.rejects(inspectServer(host.id), error => error.statusCode === 503 && !error.message.includes(secret));
  await assert.rejects(runServerDiagnostic('sh -c free', host.id), { statusCode: 400 });
});

test('真实基础设施采集链路中的宿主快照可被诊断消费，首次CPU保持未知', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'server-probe-test-'));
  const original = process.env.HOST_METRICS_FILE; process.env.HOST_METRICS_FILE = path.join(directory, 'host.json');
  t.after(async () => { if (original === undefined) delete process.env.HOST_METRICS_FILE; else process.env.HOST_METRICS_FILE = original; await rm(directory, { recursive: true, force: true }); });
  const docker = getDockerForHost('local');
  t.mock.method(docker, 'info', async () => info()); t.mock.method(docker, 'listContainers', async () => []);
  await writeFile(process.env.HOST_METRICS_FILE, JSON.stringify({ sampledAt: Date.now(), hostname: info().Name, kernel: info().KernelVersion, bootId: 'fixture', uptime: 123,
    cpu: { total: 100, idle: 50, cores: 2 }, memory: { total: 1000, available: 300 }, network: [], filesystems: [], diskCounters: [] }));
  await collectInfrastructure();
  const result = await inspectServer('local');
  assert.equal(result.memory.usedBytes, 700); assert.equal(result.cpu.percent, null); assert.equal(result.hostMetrics.source, 'host-agent');
  assert.equal(JSON.parse((await runServerDiagnostic('memory', 'local')).output).usedBytes, 700);
});
