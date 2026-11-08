import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as settle } from 'node:timers/promises';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-ws-lifecycle-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.ENABLE_SHELL = '1';
const { default: wsRoutes, activeExecSessions, teardownExecSession, MAX_EXEC_SESSIONS } = await import('../src/routes/ws.js');
const { getActivityDocker } = await import('../src/services/docker-hosts.js');
const { scanProjects, invalidateScanCache } = await import('../src/services/scanner.js');
const { setProjectPreference } = await import('../src/lib/db.js');
const docker = getActivityDocker();
const routes = new Map();
await wsRoutes({ get: (path, _, handler) => routes.set(path, handler) });
const row = { Id: 'test-container', Names: ['/audit'], State: 'running', Labels: { 'com.docker.compose.project': 'ws-audit', 'com.docker.compose.project.working_dir': tempDir } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
class Socket extends EventEmitter {
  readyState = 1;
  messages = [];
  send(data) { this.messages.push(data); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
}
async function fixture(t) {
  t.mock.method(docker, 'listContainers', async () => [row]);
  invalidateScanCache();
  const [project] = await scanProjects();
  setProjectPreference(project.id, { managed: true });
  invalidateScanCache();
  return { query: { projectId: project.id, containerId: row.Id } };
}
test.afterEach(() => { for (const socket of activeExecSessions.keys()) { socket.close?.(); teardownExecSession(socket); } invalidateScanCache(); });
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('终端初始化期间断连释放会话槽位,销毁迟到的流', async (t) => {
  const request = await fixture(t);
  const pending = deferred();
  const started = deferred();
  const raw = new PassThrough();
  t.mock.method(docker, 'getContainer', () => ({ exec: async () => ({ inspect: async () => ({ Running: true }), start: () => { started.resolve(); return pending.promise; } }) }));
  const socket = new Socket();
  const opening = routes.get('/exec')(socket, request);
  await started.promise;
  socket.close();
  pending.resolve(raw);
  await opening;
  assert.equal(raw.destroyed, true);
  assert.equal(activeExecSessions.has(socket), false);
});

test('初始 resize 和用户输入在终端就绪后送达', async (t) => {
  const request = await fixture(t);
  const pending = deferred();
  const input = [];
  const resize = [];
  const raw = new PassThrough();
  t.mock.method(raw, 'write', data => { input.push(data.toString()); return true; });
  t.mock.method(docker, 'getContainer', () => ({ exec: async () => ({ inspect: async () => ({ Running: true }), start: () => pending.promise, resize: async size => resize.push(size) }) }));
  const socket = new Socket();
  t.after(() => socket.close());
  const opening = routes.get('/exec')(socket, request);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 120, rows: 36 })), false);
  socket.emit('message', Buffer.from('echo 就绪\n'), true);
  pending.resolve(raw);
  await opening;
  assert.deepEqual(input, ['echo 就绪\n']);
  assert.deepEqual(resize, [{ w: 120, h: 36 }]);
});

test('并发初始化也受终端会话上限约束', async (t) => {
  const request = await fixture(t);
  const sockets = Array.from({ length: MAX_EXEC_SESSIONS - 1 }, () => new Socket());
  for (const socket of sockets) activeExecSessions.set(socket, { destroyed: false });
  t.mock.method(docker, 'getContainer', () => ({ exec: async () => ({ inspect: async () => ({ Running: true }), start: async () => new PassThrough() }) }));
  const first = new Socket(); const second = new Socket();
  await Promise.all([routes.get('/exec')(first, request), routes.get('/exec')(second, request)]);
  assert.equal(activeExecSessions.size, MAX_EXEC_SESSIONS);
  assert.equal(second.readyState, 3);
  assert.match(second.messages.join(''), /会话数已达上限/);
});

test('单容器日志与聚合日志共用完整行和时间戳解析', async (t) => {
  const request = await fixture(t);
  const raw = new PassThrough();
  t.mock.method(docker, 'getContainer', () => ({ inspect: async () => ({ Config: { Tty: true } }), logs: async () => raw }));
  const socket = new Socket();
  await routes.get('/logs')(socket, request);
  for (const byte of Buffer.from('2026-09-29T12:00:00Z ERROR 中文🙂\r\n')) raw.write(Buffer.from([byte]));
  raw.end();
  await settle();
  const frames = socket.messages.map(data => JSON.parse(data));
  assert.deepEqual(frames[0], { type: 'stdout', data: 'ERROR 中文🙂', ts: '2026-09-29T12:00:00Z', level: 'error', containerId: row.Id, containerName: 'audit' });
  assert.equal(frames[1].type, 'end');
  assert.equal(socket.readyState, 3);
});

test('两种日志路由按精确容器身份补读，忽略其他容器游标', async (t) => {
  const request = await fixture(t);
  const options = [];
  t.mock.method(docker, 'getContainer', () => ({ inspect: async () => ({ Config: { Tty: true } }), logs: async value => { options.push(value); return new PassThrough(); } }));
  for (const route of ['/logs', '/aggregated-logs']) {
    for (const [resume, since] of [[{ [row.Id]: 1793966399 }, 1793966399], [{ 'test': 1793966300 }, undefined]]) {
      const socket = new Socket();
      await routes.get(route)(socket, { query: { ...request.query, tail: 200, resume: JSON.stringify(resume) } });
      assert.equal(options.at(-1).since, since);
      assert.equal(options.at(-1).tail, since ? '5000' : '200');
      socket.close();
    }
  }
});

test('无效续读参数关闭日志连接并提供可见错误', async (t) => {
  const request = await fixture(t);
  for (const resume of ['bad', '[]', 'null', '{"a":-1}', '{"a":"1"}', '{"a":1.5}', ' '.repeat(8193)]) {
    const socket = new Socket();
    await routes.get('/logs')(socket, { query: { ...request.query, resume } });
    assert.equal(socket.readyState, 3);
    assert.match(socket.messages.join(''), /日志续读参数无效/);
  }
});

test('空闲日志流响应心跳，断开时移除处理器且不影响终端输入', async (t) => {
  const request = await fixture(t);
  t.mock.method(docker, 'getContainer', () => ({ inspect: async () => ({ Config: { Tty: true } }), logs: async () => new PassThrough() }));
  for (const route of ['/logs', '/aggregated-logs']) {
    const socket = new Socket();
    await routes.get(route)(socket, request);
    const before = socket.messages.length;
    socket.emit('message', Buffer.from('{"type":"ping"}'), false);
    assert.deepEqual(JSON.parse(socket.messages.at(-1)), { type: 'pong' });
    socket.emit('message', Buffer.from('{"type":"ping"}'), true);
    socket.emit('message', Buffer.from('bad JSON'), false);
    assert.equal(socket.messages.length, before + 1);
    socket.close();
    assert.equal(socket.listenerCount('message'), 0);
  }
});


test('终端就绪帧只在Docker流建立后发送，失败不能伪报就绪', async (t) => {
  const request = await fixture(t), pending = deferred(), started = deferred();
  t.mock.method(docker, 'getContainer', () => ({ exec: async () => ({ inspect: async () => ({ Running: true }), start: () => { started.resolve(); return pending.promise; } }) }));
  const socket = new Socket(), opening = routes.get('/exec')(socket, request);
  await started.promise;
  assert.equal(socket.messages.some(m => JSON.parse(m).type === 'ready'), false);
  pending.resolve(new PassThrough()); await opening;
  assert.equal(socket.messages.filter(m => JSON.parse(m).type === 'ready').length, 1);
  socket.close();
});

test('终端初始化期限到后释放槽位，迟到的流不能发送ready', async (t) => {
  const request = await fixture(t), pending = deferred(), started = deferred();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(docker, 'getContainer', () => ({ exec: async () => ({ inspect: async () => ({ Running: true }), start: () => { started.resolve(); return pending.promise; } }) }));
  const socket = new Socket(), opening = routes.get('/exec')(socket, request);
  await started.promise; t.mock.timers.tick(31000);
  assert.equal(activeExecSessions.has(socket), false);
  assert.match(socket.messages.join(''), /初始化超时/);
  const raw = new PassThrough(); pending.resolve(raw); await opening;
  assert.equal(raw.destroyed, true);
  assert.equal(socket.messages.some(m => JSON.parse(m).type === 'ready'), false);
});

test('Docker流打开但Shell进程启动失败时保留诊断且不发送ready', async (t) => {
  const request = await fixture(t), inspected = deferred(), inspecting = deferred(), raw = new PassThrough();
  t.mock.method(docker, 'getContainer', () => ({ exec: async () => ({ start: async () => raw, inspect: () => { inspecting.resolve(); return inspected.promise; } }) }));
  const socket = new Socket(), opening = routes.get('/exec')(socket, request);
  await inspecting.promise; raw.end('OCI runtime exec failed: bash missing');
  await settle(); inspected.resolve({ Running: false, ExitCode: 126 }); await opening;
  assert.equal(socket.messages.some(m => typeof m === 'string' && JSON.parse(m).type === 'ready'), false);
  assert.match(socket.messages.join(''), /Shell 未能启动/);
  assert.match(socket.messages.join(''), /bash missing/);
  assert.equal(activeExecSessions.has(socket), false);
});

test('就绪前用户输入与resize等进程核对完再送达', async (t) => {
  const request = await fixture(t), inspected = deferred(), raw = new PassThrough(), writes = [], resizes = [];
  t.mock.method(raw, 'write', value => { writes.push(value.toString()); return true; });
  t.mock.method(docker, 'getContainer', () => ({ exec: async () => ({ start: async () => raw, inspect: () => inspected.promise, resize: async value => resizes.push(value) }) }));
  const socket = new Socket(), opening = routes.get('/exec')(socket, request); await settle();
  socket.emit('message', Buffer.from('pwd\n'), true);
  socket.emit('message', Buffer.from('{"type":"resize","cols":90,"rows":30}'), false);
  assert.deepEqual(writes, []); assert.deepEqual(resizes, []);
  inspected.resolve({ Running: true }); await opening;
  assert.deepEqual(writes, ['pwd\n']); assert.deepEqual(resizes, [{ w: 90, h: 30 }]);
});


test('Shell启动后异常退出也发送退出码，正常退出不伪报失败', async (t) => {
  const request = await fixture(t);
  for (const code of [126, 0]) {
    const raw = new PassThrough(); let inspected = 0;
    t.mock.method(docker, 'getContainer', () => ({ exec: async () => ({ start: async () => raw, inspect: async () => ++inspected === 1 ? { Running: true, ExitCode: 0 } : { Running: false, ExitCode: code } }) }));
    const socket = new Socket(); await routes.get('/exec')(socket, request);
    raw.end('retained output'); await settle();
    const messages = socket.messages.filter(m => typeof m === 'string').map(m => JSON.parse(m));
    assert.equal(messages.some(m => m.type === 'error'), code !== 0);
    if (code) assert.match(messages.find(m => m.type === 'error').data, /126/);
    assert.match(socket.messages.join(''), /retained output/);
    assert.equal(socket.readyState, 3); assert.equal(activeExecSessions.has(socket), false);
  }
});

test('退出状态核对无响应时及时释放会话并忽略迟到结果', async (t) => {
  const request = await fixture(t), pending = deferred(), finishing = deferred(), raw = new PassThrough(); let inspected = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(docker, 'getContainer', () => ({ exec: async () => ({ start: async () => raw, inspect: () => { if (++inspected === 1) return Promise.resolve({ Running: true }); finishing.resolve(); return pending.promise; } }) }));
  const socket = new Socket(); await routes.get('/exec')(socket, request); raw.end(); await finishing.promise;
  t.mock.timers.tick(3001); assert.match(socket.messages.join(''), /退出状态核对超时/); assert.equal(socket.readyState, 3); assert.equal(activeExecSessions.has(socket), false);
  const count = socket.messages.length; pending.resolve({ Running: false, ExitCode: 126 }); await settle(); assert.equal(socket.messages.length, count);
});
