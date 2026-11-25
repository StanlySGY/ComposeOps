import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-new-workspace-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.COMPOSEOPS_RUNNER_IMAGE = 'workspace-test-image';
const { default: docker } = await import('../src/services/docker.js');
const { withNewWorkspace, execInRunner } = await import('../src/services/compose-workspace.js');
const { setSetting } = await import('../src/lib/db.js');
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
test.afterEach(() => setSetting('docker.active_host', 'local'));
const project = { id: 'test-new', hostId: 'local', activeHostAtScan: 'local', workingDir: '/projects/test-new', composeFiles: ['/projects/test-new/docker-compose.yml'] };

function fixture(t, { code = 0, afterCreate = () => {}, startFails = false } = {}) {
  const calls = { removed: 0, commands: [], config: null };
  t.mock.method(docker, 'createContainer', async config => {
    calls.config = config;
    return {
      async start() { if (startFails) throw new Error('start failed'); },
      async remove() { calls.removed++; },
      async exec({ Cmd }) {
        const isRootRealpath = Cmd[0] === 'realpath';
        if (!isRootRealpath) calls.commands.push(Cmd);
        return {
          async start() {
            if (!isRootRealpath) afterCreate();
            if (!isRootRealpath) return Readable.from([]);
            const payload = Buffer.from(Cmd.at(-1) + '\n');
            const frame = Buffer.alloc(8 + payload.length);
            frame[0] = 1;
            frame.writeUInt32BE(payload.length, 4);
            payload.copy(frame, 8);
            return Readable.from([frame]);
          },
          async inspect() { return { ExitCode: isRootRealpath ? 0 : code }; },
        };
      },
    };
  });
  return calls;
}

test('new workspace: 初始化无须既有 Compose 文件，helper 无 socket/网络并及时释放', async t => {
  const calls = fixture(t); let wrote = false;
  await withNewWorkspace(project, async () => { wrote = true; });
  assert.equal(wrote, true); assert.equal(calls.removed, 1);
  assert.deepEqual(calls.config.HostConfig.Binds, ['/projects:/projects:rw']);
  assert.equal(calls.config.HostConfig.NetworkMode, 'none'); assert.equal(calls.config.HostConfig.ReadonlyRootfs, true);
  assert.equal(calls.commands[0].at(-1), project.workingDir);
  assert.match(calls.commands[0][2], /mkdir --/); assert.doesNotMatch(calls.commands[0][2], /mkdir -p/);
});

test('new workspace: 只允许管理员额外配置的项目根目录，并将该根目录限定挂载给 helper', async t => {
  const previous = process.env.COMPOSEOPS_PROJECT_ROOTS;
  Reflect.set(process.env, 'COMPOSEOPS_PROJECT_ROOTS', '/projects,/srv/composeops');
  try {
    const customProject = {
      ...project,
      id: 'test-custom-root',
      creationRoot: '/srv/composeops',
      workingDir: '/srv/composeops/test-custom',
      composeFiles: ['/srv/composeops/test-custom/docker-compose.yml'],
    };
    const calls = fixture(t);
    let wrote = false;
    await withNewWorkspace(customProject, async () => { wrote = true; });
    assert.equal(wrote, true);
    assert.deepEqual(calls.config.HostConfig.Binds, ['/srv/composeops:/srv/composeops:rw']);
    await assert.rejects(
      withNewWorkspace({ ...customProject, creationRoot: '/srv/not-allowed', workingDir: '/srv/not-allowed/test', composeFiles: ['/srv/not-allowed/test/docker-compose.yml'] }, async () => {}),
      error => error.statusCode === 403,
    );
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'COMPOSEOPS_PROJECT_ROOTS');
    else Reflect.set(process.env, 'COMPOSEOPS_PROJECT_ROOTS', previous);
  }
});

test('new workspace: 已存在目录或符号链接时拒绝覆盖', async t => {
  const calls = fixture(t, { code: 17 }); let wrote = false;
  await assert.rejects(withNewWorkspace(project, async () => { wrote = true; }), error => error.statusCode === 409 && /已存在/.test(error.message));
  assert.equal(wrote, false); assert.equal(calls.removed, 1);
  assert.match(calls.commands[0][2], /-L/);
});

test('new workspace: mkdir 权限失败不能当作成功或空目录', async t => {
  const calls = fixture(t, { code: 1 });
  await assert.rejects(withNewWorkspace(project, async () => { throw new Error('must not write'); }), error => error.statusCode === 409 && /写入权限/.test(error.message));
  assert.equal(calls.removed, 1);
});

test('new workspace: 写入异常保留目标状态并释放 helper', async t => {
  const calls = fixture(t);
  await assert.rejects(withNewWorkspace(project, async () => { throw new Error('write failed'); }), error => error.directoryCreated === true && error.message === 'write failed');
  assert.equal(calls.removed, 1);
});

test('new workspace: 创建后节点变化不得写入，仍说明目录已建', async t => {
  const calls = fixture(t, { afterCreate: () => setSetting('docker.active_host', 'other') });
  await assert.rejects(withNewWorkspace(project, async () => { throw new Error('must not write'); }), error => error.code === 'HOST_CHANGED' && error.directoryCreated === true);
  assert.equal(calls.removed, 1);
});

test('new workspace: helper 启动失败也释放，不访问任意父目录', async t => {
  const calls = fixture(t, { startFails: true });
  await assert.rejects(withNewWorkspace(project, async () => {}), /start failed/); assert.equal(calls.removed, 1);
  await assert.rejects(withNewWorkspace({ ...project, workingDir: '/srv/other', composeFiles: ['/srv/other/compose.yml'] }, async () => {}), error => error.statusCode === 403);
});

test('workspace exec: 迟到句柄同步取消立即释放等待，不等命令超时', async () => {
  const stream = new PassThrough();
  const startedAt = Date.now();
  await assert.rejects(execInRunner({ async exec() { return { async start() { return stream; }, async inspect() { throw new Error('must not inspect'); } }; } }, ['sleep', '300'], {
    onExec: handle => handle.kill(), timeoutMs: 10000,
  }), error => error.name === 'AbortError');
  assert.ok(Date.now() - startedAt < 1000); assert.equal(stream.destroyed, true);
});

test('workspace exec: 退出状态检查仍受期限约束', async () => {
  await assert.rejects(execInRunner({ async exec() { return { async start() { return Readable.from([]); }, async inspect() { return new Promise(() => {}); } }; } }, ['true'], {
    timeoutMs: 25,
  }), error => error.statusCode === 504);
});
