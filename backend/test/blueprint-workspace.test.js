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

function fixture(t, { code = 0, afterCreate = () => {}, startFails = false, actualRoot = null } = {}) {
  const calls = { removed: 0, commands: [], config: null, configs: [] };
  t.mock.method(docker, 'createContainer', async config => {
    calls.config = config; calls.configs.push(config);
    return {
      async start() { if (startFails) throw new Error('start failed'); },
      async remove() { calls.removed++; },
      async exec({ Cmd }) {
        const isRootRealpath = Cmd[0] === 'node';
        if (!isRootRealpath) calls.commands.push(Cmd);
        return {
          async start() {
            if (!isRootRealpath) afterCreate();
            if (!isRootRealpath) return Readable.from([]);
            const payload = Buffer.from(JSON.stringify({ path: actualRoot || Cmd[3], exists: true, entries: [] }));
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
  assert.equal(wrote, true); assert.equal(calls.removed, 2);
  assert.deepEqual(calls.config.HostConfig.Mounts, [{ Type: 'bind', Source: '/projects', Target: '/workspace', ReadOnly: false }]);
  assert.deepEqual(calls.configs[0].HostConfig.Mounts, [{ Type: 'bind', Source: '/', Target: '/host', ReadOnly: true }]);
  assert.equal(calls.config.HostConfig.NetworkMode, 'none'); assert.equal(calls.config.HostConfig.ReadonlyRootfs, true);
  assert.equal(calls.commands[0].at(-1), '/workspace/test-new');
  assert.match(calls.commands[0][2], /mkdir --/); assert.doesNotMatch(calls.commands[0][2], /mkdir -p/);
});

test('new workspace: 允许白名单之外的父目录，但 helper 仅挂载所选父目录', async t => {
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
    assert.deepEqual(calls.config.HostConfig.Mounts, [{ Type: 'bind', Source: '/srv/composeops', Target: '/workspace', ReadOnly: false }]);
    await withNewWorkspace({ ...customProject, creationRoot: '/srv/another-folder', workingDir: '/srv/another-folder/test', composeFiles: ['/srv/another-folder/test/docker-compose.yml'] }, async () => {});
    assert.equal(calls.config.HostConfig.Mounts[0].Source, '/srv/another-folder');
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'COMPOSEOPS_PROJECT_ROOTS');
    else Reflect.set(process.env, 'COMPOSEOPS_PROJECT_ROOTS', previous);
  }
});

test('new workspace: 已存在目录或符号链接时拒绝覆盖', async t => {
  const calls = fixture(t, { code: 17 }); let wrote = false;
  await assert.rejects(withNewWorkspace(project, async () => { wrote = true; }), error => error.statusCode === 409 && /已存在/.test(error.message));
  assert.equal(wrote, false); assert.equal(calls.removed, 2);
  assert.match(calls.commands[0][2], /-L/);
});

test('new workspace: mkdir 权限失败不能当作成功或空目录', async t => {
  const calls = fixture(t, { code: 1 });
  await assert.rejects(withNewWorkspace(project, async () => { throw new Error('must not write'); }), error => error.statusCode === 409 && /写入权限/.test(error.message));
  assert.equal(calls.removed, 2);
});

test('new workspace: 写入异常保留目标状态并释放 helper', async t => {
  const calls = fixture(t);
  await assert.rejects(withNewWorkspace(project, async () => { throw new Error('write failed'); }), error => error.directoryCreated === true && error.message === 'write failed');
  assert.equal(calls.removed, 2);
});

test('new workspace: 创建后节点变化不得写入，仍说明目录已建', async t => {
  const calls = fixture(t, { afterCreate: () => setSetting('docker.active_host', 'other') });
  await assert.rejects(withNewWorkspace(project, async () => { throw new Error('must not write'); }), error => error.code === 'HOST_CHANGED' && error.directoryCreated === true);
  assert.equal(calls.removed, 2);
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

test('new workspace: 符号链接父目录必须改用解析后的真实路径', async t => {
  const calls = fixture(t, { actualRoot: '/srv/actual' });
  await assert.rejects(withNewWorkspace(project, async () => assert.fail('must not write')), /真实目录/);
  assert.equal(calls.configs.length, 1);
  assert.equal(calls.removed, 1);
});

test('workspace exec: 创建执行实例卡住也受同一期限限制', async () => {
  let signal;
  await assert.rejects(execInRunner({ exec(options) { signal = options.abortSignal; return new Promise(() => {}); } }, ['true'], { timeoutMs: 20 }), { statusCode: 504 });
  assert.equal(signal.aborted, true);
});

test('workspace exec: 超时后迟到的实例不能再启动命令', async () => {
  let arrive, starts = 0;
  const promise = execInRunner({ exec() { return new Promise(resolve => { arrive = resolve; }); } }, ['true'], { timeoutMs: 20 });
  await assert.rejects(promise, { statusCode: 504 });
  arrive({ start() { starts++; return new PassThrough(); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 0);
});

test('workspace exec: 启动卡住后迟到的输出流立即销毁', async () => {
  let arrive, signal;
  const promise = execInRunner({ async exec() { return { start(options) { signal = options.abortSignal; return new Promise(resolve => { arrive = resolve; }); } }; } }, ['true'], { timeoutMs: 20 });
  await assert.rejects(promise, { statusCode: 504 });
  assert.equal(signal.aborted, true);
  const stream = new PassThrough(); arrive(stream);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stream.destroyed, true);
});
