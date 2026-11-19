import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-sre-heartbeats-'));
process.env.DB_PATH = path.join(tempDir, 'sre-heartbeats.db');

const { default: db } = await import('../src/lib/db.js');
const { default: Database } = await import('../src/lib/sqlite.js');
const { workerHeartbeat, workerHeartbeats } = await import('../src/services/sre-heartbeats.js');

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('SRE heartbeat: persists normal worker state and progress', () => {
  const at = Date.now();
  assert.equal(workerHeartbeat('heartbeat-test', { state: 'working', workStartedAt: at - 100, progress: true, at }), true);
  const row = workerHeartbeats(at).find(item => item.name === 'heartbeat-test');
  assert.equal(row.state, 'working');
  assert.equal(row.workStartedAt, at - 100);
  assert.equal(row.progressAt, at);
  assert.equal(row.currentInstance, true);
});

test('SRE heartbeat: a transient SQLite writer lock is skipped and the next tick can recover', () => {
  const blocker = new Database(process.env.DB_PATH);
  blocker.exec('BEGIN IMMEDIATE');
  try {
    assert.equal(workerHeartbeat('heartbeat-lock-test', { state: 'working' }), false);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
  }

  assert.equal(workerHeartbeat('heartbeat-lock-test', { state: 'idle', progress: true }), true);
  const row = workerHeartbeats().find(item => item.name === 'heartbeat-lock-test');
  assert.equal(row.state, 'idle');
  assert.ok(row.progressAt > 0);
});
