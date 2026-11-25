import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-custom-compose-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
const {
  createCustomComposeProject,
  validateComposeInput,
  validateProjectName,
  hasPullableImages,
} = await import('../src/services/custom-compose-project.js');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const compose = 'services:\n  web:\n    image: nginx:latest\n    ports:\n      - "8080:80"\n';
const buildCompose = 'services:\n  app:\n    image: local/app:dev\n    build: .\n';
const input = (overrides = {}) => ({
  projectName: 'my-web',
  rootDir: '/projects',
  composeContent: compose,
  envContent: 'APP_ENV=production\n',
  expectedHostId: 'local',
  ...overrides,
});

function dependencies({ hostType = 'local', containers = [], codes = {} } = {}) {
  const state = {
    workspaceCalls: 0,
    writes: [],
    composeCalls: [],
    registered: [],
    preferences: [],
    operations: [],
    invalidations: 0,
  };
  const deps = {
    getActiveHostId: () => 'local',
    getHost: (id) => id === 'local' ? { id, name: 'Test host', type: hostType } : null,
    getDockerForHost: () => ({ listContainers: async () => containers }),
    assertProjectHostUnchanged: () => {},
    getSetting: (_key, fallback) => fallback,
    composeProjectId: () => 'custom-project-id',
    configuredComposeProjectRoots: () => ['/projects'],
    withNewWorkspace: async (project, callback) => {
      state.workspaceCalls += 1;
      state.project = project;
      await callback({ fakeWorkspace: true });
    },
    putArchiveFile: async (container, directory, name, content, metadata) => {
      state.writes.push({ container, directory, name, content, metadata });
    },
    runWorkspaceComposeArgs: async (project, args, onOutput, options) => {
      state.composeCalls.push({ project, args, options });
      const phase = args[0];
      const code = codes[phase] ?? 0;
      if (code !== 0) onOutput('stderr', phase + ' failed\n');
      return code;
    },
    withProjectOperationLock: async (_projectId, callback) => callback(),
    invalidateScanCache: () => { state.invalidations += 1; },
    registerCustomComposeProject: (record) => state.registered.push(record),
    setProjectPreference: (projectId, preference) => state.preferences.push({ projectId, preference }),
    addOperation: (operation) => state.operations.push(operation),
  };
  return { deps, state };
}

test('项目名只接受小写 Compose 安全标识', () => {
  assert.equal(validateProjectName('web_1-app'), 'web_1-app');
  for (const value of ['', '../escape', 'UpperCase', 'web app', 'a'.repeat(41)]) {
    assert.throws(() => validateProjectName(value), (error) => error.statusCode === 400);
  }
});

test('Compose 输入必须包含 services，且 .env 与 YAML 都有大小上限', () => {
  assert.equal(validateComposeInput(compose).config.services.web.image, 'nginx:latest');
  assert.throws(() => validateComposeInput('volumes:\n  data: {}\n'), (error) => error.statusCode === 422);
  assert.throws(() => validateComposeInput('services: ['));
  assert.throws(() => validateComposeInput(compose, 'x'.repeat(524289)), (error) => error.statusCode === 400);
  assert.throws(() => validateComposeInput('services:\n  "bad/name": {}\n'), (error) => error.statusCode === 422);
});

test('根据 Compose 服务定义判断是否先拉取远端镜像', () => {
  assert.equal(hasPullableImages(validateComposeInput(compose).config), true);
  assert.equal(hasPullableImages(validateComposeInput(buildCompose).config), false);
});

test('完整创建流程：创建目录、写入受限文件、校验、拉镜像、启动并登记项目', async () => {
  const { deps, state } = dependencies();
  const phases = [];
  const result = await createCustomComposeProject(input(), {
    dependencies: deps,
    onPhase: (phase) => phases.push(phase.phase),
  });

  assert.equal(result.ok, true);
  assert.equal(result.projectId, 'custom-project-id');
  assert.equal(result.workingDir, '/projects/my-web');
  assert.deepEqual(state.composeCalls.map((call) => call.args), [
    ['config', '--quiet'],
    ['pull', '--ignore-buildable'],
    ['up', '-d', '--build'],
  ]);
  assert.deepEqual(state.writes.map((item) => item.name), ['docker-compose.yml', '.env']);
  assert.ok(state.writes.every((item) => item.metadata.mode === 0o600));
  assert.equal(state.registered.length, 1);
  assert.equal(state.registered[0].workingDir, '/projects/my-web');
  assert.deepEqual(state.preferences[0], {
    projectId: 'custom-project-id',
    preference: { managed: true, mountEnabled: true },
  });
  assert.deepEqual(phases, ['checking', 'preparing', 'validating', 'pulling', 'starting']);
  assert.equal(state.operations[0].status, 'success');
  assert.equal(state.invalidations, 2);
});

test('Compose 校验失败时保留已写配置，不拉镜像也不启动', async () => {
  const { deps, state } = dependencies({ codes: { config: 422 } });
  const result = await createCustomComposeProject(input(), { dependencies: deps });

  assert.equal(result.ok, false);
  assert.equal(result.directoryCreated, true);
  assert.equal(result.filesCreated, true);
  assert.deepEqual(state.composeCalls.map((call) => call.args), [['config', '--quiet']]);
  assert.equal(state.registered.length, 1);
  assert.equal(state.operations[0].status, 'failed');
});

test('镜像拉取失败时保留项目文件，等待用户修复后重试', async () => {
  const { deps, state } = dependencies({ codes: { pull: 1 } });
  const result = await createCustomComposeProject(input(), { dependencies: deps });

  assert.equal(result.ok, false);
  assert.match(result.message, /镜像拉取失败/);
  assert.deepEqual(state.composeCalls.map((call) => call.args), [
    ['config', '--quiet'],
    ['pull', '--ignore-buildable'],
  ]);
  assert.equal(state.registered.length, 1);
  assert.equal(state.operations[0].status, 'failed');
});

test('纯 build 服务跳过 pull，直接执行 compose up --build', async () => {
  const { deps, state } = dependencies();
  const result = await createCustomComposeProject(input({ composeContent: buildCompose }), { dependencies: deps });

  assert.equal(result.ok, true);
  assert.deepEqual(state.composeCalls.map((call) => call.args), [
    ['config', '--quiet'],
    ['up', '-d', '--build'],
  ]);
});

test('任意普通父目录可创建，内核目录和相对路径拒绝', async () => {
  const { deps, state } = dependencies();
  const result = await createCustomComposeProject(input({ rootDir: '/srv/other' }), { dependencies: deps });
  assert.equal(result.workingDir, '/srv/other/my-web');
  assert.equal(state.workspaceCalls, 1);
  for (const rootDir of ['relative', '/proc/1', '/dev/shm', '/sys', '/tmp/../proc']) {
    await assert.rejects(createCustomComposeProject(input({ rootDir }), { dependencies: deps }));
  }
  assert.equal(state.workspaceCalls, 1);
});

test('文件上限按 UTF-8 字节校验，组合合法内容可超过 1 MiB', () => {
  assert.doesNotThrow(() => validateComposeInput(compose + '#' + 'x'.repeat(700000), '#' + 'x'.repeat(400000)));
  assert.throws(() => validateComposeInput(compose + '#' + '中'.repeat(350000)), /1 MiB/);
  assert.throws(() => validateComposeInput(compose, '中'.repeat(175000)), /512 KiB/);
});

test('TCP Docker API 节点不能创建宿主机 Compose 文件', async () => {
  const { deps, state } = dependencies({ hostType: 'tcp' });
  await assert.rejects(
    () => createCustomComposeProject(input(), { dependencies: deps }),
    (error) => error.statusCode === 409,
  );
  assert.equal(state.workspaceCalls, 0);
});

test('同名 Compose 项目已存在时拒绝新建', async () => {
  const { deps, state } = dependencies({
    containers: [{ Labels: { 'com.docker.compose.project': 'my-web' } }],
  });
  await assert.rejects(
    () => createCustomComposeProject(input(), { dependencies: deps }),
    (error) => error.statusCode === 409 && /同名/.test(error.message),
  );
  assert.equal(state.workspaceCalls, 0);
});

test('节点切换或期望节点不匹配时拒绝部署', async () => {
  const { deps, state } = dependencies();
  await assert.rejects(
    () => createCustomComposeProject(input({ expectedHostId: 'another-node' }), { dependencies: deps }),
    (error) => error.statusCode === 409 && error.code === 'HOST_CHANGED',
  );
  assert.equal(state.workspaceCalls, 0);
});
