import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-ws-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const ws = await import('../src/routes/ws.js');

test('ws 模块导出 Web Shell 会话上限与超时常量', () => {
  assert.equal(typeof ws.MAX_EXEC_SESSIONS, 'number');
  assert.ok(ws.MAX_EXEC_SESSIONS > 0);
  assert.equal(typeof ws.EXEC_SESSION_TIMEOUT_MS, 'number');
  assert.ok(ws.EXEC_SESSION_TIMEOUT_MS > 0);
  assert.ok(ws.activeExecSessions instanceof Map);
});

test('exec 上限与超时取合理值(20 会话 / 30 分钟)', () => {
  assert.equal(ws.MAX_EXEC_SESSIONS, 20);
  assert.equal(ws.EXEC_SESSION_TIMEOUT_MS, 30 * 60 * 1000);
});

test('路由默认导出可调用(fastify 插件形态)', () => {
  assert.equal(typeof ws.default, 'function');
});

test('exec 会话清理幂等且释放失败建立的槽位', () => {
  const socket = {};
  ws.activeExecSessions.set(socket, { idleTimer: setTimeout(() => {}, 60_000), destroyed: false });
  const original = ws.activeExecSessions.get(socket).idleTimer;
  const released = ws.teardownExecSession(socket);
  assert.equal(released, true);
  assert.equal(ws.activeExecSessions.has(socket), false);
  assert.equal(ws.teardownExecSession(socket), false);
  clearTimeout(original);
});
