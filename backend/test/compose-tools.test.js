import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { buildExecCommand } from '../src/services/tools/compose-tools.js';
import { execInRunner } from '../src/services/compose-workspace.js';
import { replaceComposeWithBackup } from '../src/services/compose-runner.js';

test('compose.exec: 命令包装器写入 PID 标记并保留 shell 安全转义', () => {
  const command = "printf '%s' 'a'b";
  const wrapped = buildExecCommand(command, '/tmp/composeops-exec-test.pid');
  assert.match(wrapped, /echo "\$\$"/);
  assert.match(wrapped, /composeops-exec-test\.pid/);
  assert.match(wrapped, /timeout --signal=TERM 120s/);
  assert.match(wrapped, /a'\\''b/);
});

test('compose workspace: exec 超时销毁输出流并返回 504', async () => {
  let stream;
  const container = {
    async exec() {
      return {
        async start() {
          stream = new PassThrough();
          return stream;
        },
        async inspect() { return { ExitCode: 0 }; },
      };
    },
  };
  await assert.rejects(
    execInRunner(container, ['sleep', '1'], { timeoutMs: 10 }),
    (error) => error.statusCode === 504,
  );
  assert.equal(stream.destroyed, true);
});

test('compose save: 文件替换失败时不写入备份并尝试恢复原文件', async () => {
  const calls = [];
  await assert.rejects(replaceComposeWithBackup({
    replace: async () => { calls.push('replace'); throw new Error('rename failed'); },
    backup: async () => { calls.push('backup'); },
    rollback: async () => { calls.push('rollback'); },
  }), /rename failed/);
  assert.deepEqual(calls, ['replace', 'rollback']);
});

test('compose save: 备份持久化失败时恢复原文件且返回原始错误', async () => {
  const calls = [];
  const backupError = new Error('database unavailable');
  await assert.rejects(replaceComposeWithBackup({
    replace: async () => { calls.push('replace'); },
    backup: async () => { calls.push('backup'); throw backupError; },
    rollback: async () => { calls.push('rollback'); },
  }), (error) => error === backupError);
  assert.deepEqual(calls, ['replace', 'backup', 'rollback']);
});

test('compose save: 原文件恢复失败时返回明确错误代码', async () => {
  await assert.rejects(replaceComposeWithBackup({
    replace: async () => {},
    backup: async () => { throw new Error('database unavailable'); },
    rollback: async () => { throw new Error('disk unavailable'); },
  }), (error) => error.code === 'COMPOSE_SAVE_ROLLBACK_FAILED' && error.statusCode === 500 && /disk unavailable/.test(error.message));
});

test('selected services never fall back to whole project and preserve whole-project intent', async t => {
  const { prepareProjectAction } = await import('../src/services/project-action-runner.js');
  const { getDockerForHost } = await import('../src/services/docker-hosts.js');
  const { setProjectPreference, getProjectPreference } = await import('../src/lib/db.js');
  const calls = [], project = { id: 'selective', hostId: 'local', managed: true, editable: true, mounted: true, mountEnabled: true, containers: [{ id: 'api', service: 'api' }, { id: 'worker', service: 'worker' }] };
  t.mock.method(getDockerForHost('local'), 'getContainer', id => ({ inspect: async () => ({ State: { Status: 'running' } }), stop: async () => calls.push(id) }));
  setProjectPreference(project.id, { operationalIntent: 'running' });
  const action = await prepareProjectAction(project, 'stop', { services: ['worker'] });
  assert.equal(await action.run(), 0); assert.deepEqual(calls, ['worker']); assert.equal(getProjectPreference(project.id).operationalIntent, 'running');
  await assert.rejects(prepareProjectAction(project, 'stop', { services: ['missing'] }), /指定服务/);
});
test('log service selection overrides page container and rejects contradictory explicit identifiers', async t => {
  const { OperationsAgent } = await import('../src/services/agent/engine.js');
  const { getDockerForHost } = await import('../src/services/docker-hosts.js');
  const { scanProjects, invalidateScanCache } = await import('../src/services/scanner.js');
  const { setProjectPreference } = await import('../src/lib/db.js');
  const docker = getDockerForHost('local'), reads = [];
  t.mock.method(docker, 'listContainers', async () => ['api','worker','api-helper'].map(service => ({ Id: service, Names: ['/logs-' + service], State: 'running', Labels: { 'com.docker.compose.project': 'log-target', 'com.docker.compose.service': service } })));
  t.mock.method(docker, 'getContainer', id => ({ inspect: async () => ({ Config: { Tty: true } }), logs: async () => { reads.push(id); return Buffer.from('hello'); } }));
  invalidateScanCache(); t.after(invalidateScanCache);
  const [project] = await scanProjects(); setProjectPreference(project.id, { managed: true });
  const agent = new OperationsAgent();
  const result = await agent.executeTool('compose.logs', { projectId: project.id, services: ['api'] }, { containerId: 'worker', hostId: 'local' });
  assert.equal(result.success, true); assert.deepEqual(reads, ['api']);
  const mismatch = await agent.executeTool('compose.logs', { projectId: project.id, services: ['api'], containerId: 'worker' });
  assert.equal(mismatch.success, false); assert.deepEqual(reads, ['api']);
});
