import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-blueprints-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { deployBlueprint } = await import('../src/services/app-blueprints.js');
const { getProjectPreference } = await import('../src/lib/db.js');
const { composeProjectId } = await import('../src/services/project-id.js');

function fakeDocker() {
  return { listContainers: async () => [] };
}

function fakeWorkspace(calls) {
  return async (project, callback) => {
    calls.push({ type: 'workspace', project });
    await callback({ async putArchive() {} });
  };
}

test('blueprint: TCP 节点拒绝无法证明宿主工作区的部署', async () => {
  await assert.rejects(
    deployBlueprint('uptime-kuma', {}, { hostType: 'tcp' }),
    (error) => error.statusCode === 409 && /TCP Docker API/.test(error.message),
  );
});

test('blueprint: mock workspace runner 使用扫描器一致的项目 ID并传递停止句柄', async () => {
  const workspaceCalls = [];
  const composeCalls = [];
  const childHandles = [];
  const result = await deployBlueprint('uptime-kuma', { projectName: 'blueprint-test', PORT: '18088' }, {
    hostType: 'local',
    dockerClient: fakeDocker(),
    workspaceRunner: fakeWorkspace(workspaceCalls),
    composeRunner: async (project, args, onOutput, options) => {
      composeCalls.push({ project, args });
      const handle = { kill() {} };
      options.onExec(handle);
      onOutput('stdout', 'started');
      return 0;
    },
    onChild: (handle) => childHandles.push(handle),
  });
  const expectedId = composeProjectId('/projects/blueprint-test', 'blueprint-test');
  assert.equal(result.projectId, expectedId);
  assert.equal(getProjectPreference(expectedId).managed, 1);
  assert.equal(workspaceCalls[0].project.id, expectedId);
  assert.deepEqual(composeCalls[0].args, ['up', '-d']);
  assert.equal(childHandles.length, 1);
  assert.equal(result.code, 0);
});

test('blueprint: SSH 节点仍通过 workspace runner执行,不调用本地 Compose CLI', async () => {
  const calls = [];
  let composeCalled = false;
  const result = await deployBlueprint('uptime-kuma', { projectName: 'ssh-blueprint-test' }, {
    hostType: 'ssh',
    dockerClient: fakeDocker(),
    workspaceRunner: fakeWorkspace(calls),
    composeRunner: async () => { composeCalled = true; return 0; },
  });
  assert.equal(result.code, 0);
  assert.equal(calls.length, 1);
  assert.equal(composeCalled, true);
});
