import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-blueprints-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { deployBlueprint, checkPortConflicts, renderBlueprintCompose, getBlueprint } = await import('../src/services/app-blueprints.js');
const { getProjectPreference, setSetting } = await import('../src/lib/db.js');
const { composeProjectId } = await import('../src/services/project-id.js');
const { default: YAML } = await import('yaml');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
test.afterEach(() => setSetting('docker.active_host', 'local'));

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

test('blueprint: 非零 Compose 退出返回真实失败和目标上下文', async () => {
  const result = await deployBlueprint('uptime-kuma', { projectName: 'failed-start' }, {
    dockerClient: fakeDocker(), workspaceRunner: fakeWorkspace([]), composeRunner: async () => 17,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 17);
  assert.equal(result.hostId, 'local');
  assert.equal(result.workingDir, '/projects/failed-start');
  assert.equal(result.filesCreated, true);
});

test('blueprint: 节点在预检 await 期间切换时不得写文件或启动', async () => {
  let wrote = false;
  await assert.rejects(deployBlueprint('uptime-kuma', { projectName: 'host-race' }, {
    dockerClient: { listContainers: async () => { setSetting('docker.active_host', 'other'); return []; } },
    workspaceRunner: async () => { wrote = true; },
  }), error => error.code === 'HOST_CHANGED');
  assert.equal(wrote, false);
});

test('blueprint: 写后切换节点不在新宿主启动，并保留已写目标', async () => {
  let started = false;
  const result = await deployBlueprint('uptime-kuma', { projectName: 'host-after-write' }, {
    dockerClient: fakeDocker(),
    workspaceRunner: async (project, callback) => { await callback({ async putArchive() {} }); setSetting('docker.active_host', 'other'); },
    composeRunner: async () => { started = true; return 0; },
  });
  assert.equal(started, false);
  assert.equal(result.ok, false);
  assert.equal(result.hostId, 'local');
  assert.equal(result.filesCreated, true);
});

test('blueprint: 写入与启动都携带同一份宿主身份', async () => {
  const seen = [];
  await deployBlueprint('uptime-kuma', { projectName: 'host-bound' }, {
    dockerClient: fakeDocker(), workspaceRunner: fakeWorkspace(seen),
    composeRunner: async project => { seen.push({ project }); return 0; },
  });
  for (const { project } of seen) {
    assert.equal(project.hostId, 'local');
    assert.equal(project.activeHostAtScan, 'local');
  }
});

test('blueprint: 不静默改写非法项目名', async () => {
  for (const name of ['../app', 'hello world', 'Uppercase', '-start', '中文', 'a'.repeat(41)]) {
    await assert.rejects(deployBlueprint('uptime-kuma', { projectName: name }, {
      dockerClient: fakeDocker(), workspaceRunner: fakeWorkspace([]), composeRunner: async () => 0,
    }), error => error.statusCode === 400, name);
  }
});

test('blueprint: 默认端口冲突也阻止写入', async () => {
  let writes = 0;
  await assert.rejects(deployBlueprint('uptime-kuma', { projectName: 'default-port-conflict' }, {
    dockerClient: { listContainers: async () => [{ Ports: [{ PublicPort: 3001, Type: 'tcp' }] }] },
    workspaceRunner: async () => { writes++; }, composeRunner: async () => 0,
  }), error => error.statusCode === 409 && /3001/.test(error.message));
  assert.equal(writes, 0);
});

test('blueprint: Docker 读取失败不能被预检伪装为没有端口冲突', async () => {
  await assert.rejects(checkPortConflicts(await getBlueprint('uptime-kuma'), {}, {
    dockerClient: { listContainers: async () => { throw new Error('Docker unavailable'); } },
  }), /Docker unavailable/);
});

test('blueprint: 非法端口和空秘密在写前拒绝', async () => {
  const options = { dockerClient: fakeDocker(), workspaceRunner: async () => { throw new Error('must not write'); } };
  for (const PORT of ['0', '65536', '-1', '3000:80', '12.3', '']) {
    await assert.rejects(deployBlueprint('uptime-kuma', { projectName: 'invalid-field', PORT }, options), error => error.statusCode === 400);
  }
  await assert.rejects(deployBlueprint('meilisearch', { projectName: 'missing-secret' }, options), error => error.statusCode === 400 && /MASTER_KEY/.test(error.message));
  await assert.rejects(deployBlueprint('minio', { projectName: 'duplicate-ports', MINIO_PASSWORD: 'synthetic-password', API_PORT: '9000', CONSOLE_PORT: '9000' }, options), error => error.statusCode === 400 && /重复/.test(error.message));
});

test('blueprint: 用户值不能插入 YAML 结构或触发二次模板替换', () => {
  const value = 'p"\nservices:\n  injected: value\n${OTHER} $HOME \\ test';
  const rendered = renderBlueprintCompose({
    defaultCompose: 'services:\n  test:\n    image: alpine\n    environment:\n      VALUE: "${PASSWORD}"\n',
    envSchema: [{ key: 'PASSWORD' }, { key: 'OTHER', default: 'replaced' }],
  }, { PASSWORD: value });
  const parsed = YAML.parse(rendered);
  assert.deepEqual(Object.keys(parsed.services), ['test']);
  assert.equal(parsed.services.test.environment.VALUE, value.replaceAll('$', () => '$$'));
});

test('blueprint: 同名并发部署串行核对目录，第二次不覆盖', async () => {
  let inFlight = 0; let maxConcurrent = 0; let exists = false;
  const options = {
    dockerClient: fakeDocker(),
    workspaceRunner: async (project, callback) => {
      inFlight++; maxConcurrent = Math.max(maxConcurrent, inFlight);
      try {
        await new Promise(resolve => setTimeout(resolve, 10));
        if (exists) throw Object.assign(new Error('目录已存在'), { statusCode: 409 });
        exists = true;
        await callback({ async putArchive() {} });
      } finally { inFlight--; }
    },
    composeRunner: async () => 0,
  };
  const results = await Promise.allSettled([1, 2].map(() => deployBlueprint('uptime-kuma', { projectName: 'concurrent-deploy' }, options)));
  assert.equal(maxConcurrent, 1);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.statusCode === 409).length, 1);
});

test('blueprint: 请求携带的预期节点不一致时拒绝', async () => {
  await assert.rejects(deployBlueprint('uptime-kuma', { projectName: 'stale-page' }, {
    expectedHostId: 'old-host', dockerClient: fakeDocker(), workspaceRunner: fakeWorkspace([]), composeRunner: async () => 0,
  }), error => error.code === 'HOST_CHANGED');
});

test('blueprint: 排队时取消不写文件，配置写完取消不启动且返回上下文', async () => {
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(deployBlueprint('uptime-kuma', { projectName: 'cancel-before' }, {
    signal: aborted.signal, dockerClient: fakeDocker(), workspaceRunner: async () => { throw new Error('must not write'); },
  }), error => error.name === 'AbortError');
  const controller = new AbortController(); let started = false;
  const result = await deployBlueprint('uptime-kuma', { projectName: 'cancel-after' }, {
    signal: controller.signal, dockerClient: fakeDocker(),
    workspaceRunner: async (project, callback) => { await callback({ async putArchive() {} }); controller.abort(); },
    composeRunner: async () => { started = true; return 0; },
  });
  assert.equal(started, false); assert.equal(result.ok, false); assert.equal(result.filesCreated, true);
});

test('blueprint: Compose 输出里的完整或跨分片秘密不外泄', async () => {
  const output = [];
  const secret = 'example-secret-123456';
  const result = await deployBlueprint('meilisearch', { projectName: 'redacted-output', MASTER_KEY: secret }, {
    dockerClient: fakeDocker(), workspaceRunner: fakeWorkspace([]),
    onOutput: (type, text) => output.push(text),
    composeRunner: async (project, args, emit) => {
      emit('stdout', `full=${secret}\npart=${secret.slice(0, 9)}`);
      emit('stdout', `${secret.slice(9)}\nfinished\n`);
      throw new Error(`invalid value ${secret}`);
    },
  });
  assert.equal(result.ok, false);
  assert.doesNotMatch(output.join(''), /example-secret/);
  assert.doesNotMatch(result.message, /example-secret/);
  assert.match(output.join(''), /full=\[REDACTED\]\npart=\[REDACTED\]/);
  assert.match(output.join(''), /finished/);
});
