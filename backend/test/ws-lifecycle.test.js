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
  t.mock.method(docker, 'getContainer', () => ({ exec: async () => ({ start: () => { started.resolve(); return pending.promise; } }) }));
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
  t.mock.method(docker, 'getContainer', () => ({ exec: async () => ({ start: () => pending.promise, resize: async size => resize.push(size) }) }));
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
  t.mock.method(docker, 'getContainer', () => ({ exec: async () => ({ start: async () => new PassThrough() }) }));
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
  assert.deepEqual(frames[0], { type: 'stdout', data: 'ERROR 中文🙂', ts: '2026-09-29T12:00:00Z', level: 'error' });
  assert.equal(frames[1].type, 'end');
  assert.equal(socket.readyState, 3);
});
