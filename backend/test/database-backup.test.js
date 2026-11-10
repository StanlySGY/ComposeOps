import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from '../src/lib/sqlite.js';
import { backupDatabase, verifyDatabase } from '../src/lib/database-backup.js';

test('在线快照包含尚未 checkpoint 的 WAL 数据，权限为 0600，源库继续可写', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'composeops-db-backup-'));
  const source = path.join(dir, 'live.db'), destination = path.join(dir, 'snapshots', 'backup.db');
  const writer = new Database(source);
  try {
    writer.pragma('journal_mode = WAL'); writer.pragma('wal_autocheckpoint = 0');
    writer.exec('CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES (\'committed-in-wal\')');
    assert.ok(statSync(`${source}-wal`).size > 0);
    const stages = [];
    const result = await backupDatabase(source, destination, { onProgress: event => stages.push(event.stage) });
    assert.deepEqual(stages, ['open-source', 'verify-source', 'snapshot', 'verify-snapshot', 'publish', 'complete']);
    assert.equal(result.ok, true); assert.ok(result.bytes > 0);
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    const restored = new Database(destination, { readonly: true });
    try { assert.equal(restored.prepare('SELECT value FROM proof').get().value, 'committed-in-wal'); }
    finally { restored.close(); }
    writer.exec("INSERT INTO proof VALUES ('after-backup')");
    assert.equal(writer.prepare('SELECT count(*) AS count FROM proof').get().count, 2);
    assert.deepEqual(verifyDatabase(destination), { ok: true });
    await assert.rejects(backupDatabase(source, destination), /EEXIST/);
    await assert.rejects(backupDatabase(source, source), /不能与源数据库相同/);
    assert.deepEqual(readdirSync(path.dirname(destination)), ['backup.db']);
  } finally { writer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('缺失或损坏的数据库不生成可用备份，也不留下 partial 文件', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'composeops-db-invalid-'));
  try {
    await assert.rejects(backupDatabase(path.join(dir, 'missing.db'), path.join(dir, 'backup.db')));
    writeFileSync(path.join(dir, 'corrupt.db'), 'this is not sqlite');
    await assert.rejects(backupDatabase(path.join(dir, 'corrupt.db'), path.join(dir, 'backup.db')));
    assert.throws(() => verifyDatabase(path.join(dir, 'corrupt.db')));
    assert.deepEqual(readdirSync(dir).sort(), ['corrupt.db', 'corrupt.db.backup-status.json', 'missing.db.backup-status.json']);
    for (const name of ['corrupt.db', 'missing.db']) {
      const observation = path.join(dir, `${name}.backup-status.json`);
      assert.equal(JSON.parse(readFileSync(observation, 'utf8')).state, 'failed');
      assert.equal(statSync(observation).mode & 0o777, 0o600);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('完整校验发现非 schema 页损坏，拒绝发布备份', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'composeops-db-page-corrupt-'));
  const file = path.join(dir, 'damaged.db');
  try {
    const db = new Database(file);
    db.exec("CREATE TABLE data(value BLOB); INSERT INTO data VALUES(zeroblob(20000))");
    const root = db.prepare("SELECT rootpage FROM sqlite_master WHERE name='data'").get().rootpage;
    const pageSize = db.pragma('page_size', { simple: true });
    db.close();
    const { openSync, writeSync, closeSync } = await import('node:fs');
    const fd = openSync(file, 'r+');
    try { writeSync(fd, Buffer.alloc(100, 0xff), 0, 100, (root - 1) * pageSize); } finally { closeSync(fd); }
    assert.throws(() => verifyDatabase(file));
    await assert.rejects(backupDatabase(file, path.join(dir, 'backup.db')));
    assert.deepEqual(readdirSync(dir).sort(), ['damaged.db', 'damaged.db.backup-status.json']);
    assert.equal(JSON.parse(readFileSync(`${file}.backup-status.json`, 'utf8')).state, 'failed');
    assert.equal(statSync(`${file}.backup-status.json`).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
