import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import Database, { getDatabaseEncryptionStatus, readDatabaseEncryptionKey, rotateDatabaseEncryption } from '../src/lib/sqlite.js';
import { backupDatabase, verifyDatabase } from '../src/lib/database-backup.js';

const keyA = randomBytes(32).toString('hex');
const keyB = randomBytes(32).toString('hex');
const SQLITE_HEADER = Buffer.from('SQLite format 3\0');

function configureKey(t, { key = '', keyFile = '' } = {}) {
  const previous = { key: process.env.DB_ENCRYPTION_KEY, keyFile: process.env.DB_ENCRYPTION_KEY_FILE };
  delete process.env.DB_ENCRYPTION_KEY;
  delete process.env.DB_ENCRYPTION_KEY_FILE;
  if (key) process.env.DB_ENCRYPTION_KEY = key;
  if (keyFile) process.env.DB_ENCRYPTION_KEY_FILE = keyFile;
  t.after(() => {
    if (previous.key === undefined) delete process.env.DB_ENCRYPTION_KEY;
    else process.env.DB_ENCRYPTION_KEY = previous.key;
    if (previous.keyFile === undefined) delete process.env.DB_ENCRYPTION_KEY_FILE;
    else process.env.DB_ENCRYPTION_KEY_FILE = previous.keyFile;
  });
}

test('SQLite encryption: plaintext migration preserves schema, blobs, user_version and AUTOINCREMENT sequence', (t) => {
  configureKey(t);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'composeops-encryption-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'opsdash.db');
  const source = new DatabaseSync(file, { enableForeignKeyConstraints: false });
  source.exec(`
    CREATE TABLE records(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL, payload BLOB);
    CREATE INDEX idx_records_value ON records(value);
    CREATE TABLE audit(id INTEGER PRIMARY KEY, record_id INTEGER, note TEXT);
    CREATE TABLE parents(id INTEGER PRIMARY KEY);
    CREATE TABLE children(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL, FOREIGN KEY(parent_id) REFERENCES parents(id));
    CREATE VIEW record_view AS SELECT id, value FROM records;
  `);
  source.prepare('INSERT INTO records(value, payload) VALUES(?, ?)').run('keep-this-row', Buffer.from([0, 1, 127, 255]));
  source.prepare('INSERT INTO children(id, parent_id) VALUES(?, ?)').run(1, 999); // Legacy connection semantics allow pre-existing FK violations.
  source.prepare('INSERT INTO records(value, payload) VALUES(?, ?)').run('deleted-high-water', Buffer.from('gone'));
  source.exec('DELETE FROM records WHERE id=2; PRAGMA user_version=12;');
  source.close();

  process.env.DB_ENCRYPTION_KEY = keyA;
  let db = new Database(file);
  assert.equal(readFileSync(file).subarray(0, 16).equals(SQLITE_HEADER), false, 'database file header must be encrypted');
  assert.deepEqual(getDatabaseEncryptionStatus(file), { path: file, status: 'encrypted', encryptedHeader: true, keyVerified: true });
  assert.equal(db.pragma('user_version', { simple: true }), 12);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 0, 'encrypted adapter should retain foreign-key-off semantics');
  assert.equal(db.pragma('foreign_key_check').length, 1, 'legacy foreign-key findings must be preserved rather than silently rewritten');
  assert.equal(db.prepare('SELECT value FROM record_view').get().value, 'keep-this-row');
  assert.deepEqual(Buffer.from(db.prepare('SELECT payload FROM records').get().payload), Buffer.from([0, 1, 127, 255]));
  assert.equal(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='index' AND name='idx_records_value'").get().present, 1);
  const inserted = db.prepare('INSERT INTO records(value) VALUES(?)').run('after-migration');
  assert.equal(inserted.lastInsertRowid, 3, 'AUTOINCREMENT sequence should survive deleted high IDs');
  db.close();

  delete process.env.DB_ENCRYPTION_KEY;
  assert.throws(() => new Database(file), /DB_ENCRYPTION_KEY_FILE/);
  process.env.DB_ENCRYPTION_KEY = keyB;
  assert.throws(() => new Database(file), /密钥不正确|损坏/);
  process.env.DB_ENCRYPTION_KEY = keyA;
  db = new Database(file);
  assert.equal(db.prepare('SELECT count(*) AS count FROM records').get().count, 2);
  db.close();
});

test('SQLite encryption: encrypted backups restore with the same external key and pass integrity checks', async (t) => {
  configureKey(t, { key: keyA });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'composeops-encrypted-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'live.db');
  const destination = path.join(dir, 'snapshots', 'backup.db');
  const db = new Database(source);
  db.exec('CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES(\'encrypted-backup-row\')');
  db.close();

  const backup = await backupDatabase(source, destination);
  assert.equal(backup.ok, true);
  assert.equal(readFileSync(destination).subarray(0, 16).equals(SQLITE_HEADER), false);
  assert.deepEqual(verifyDatabase(destination), { ok: true });
  const restored = new Database(destination, { readonly: true });
  assert.equal(restored.prepare('SELECT value FROM proof').get().value, 'encrypted-backup-row');
  restored.close();
  assert.equal(readDatabaseEncryptionKey(), keyA);
});

test('SQLite encryption: offline key rotation is atomic and the old key stops working', (t) => {
  configureKey(t, { key: keyA });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'composeops-encrypted-rotate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'live.db');
  let db = new Database(file);
  db.exec('CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES(\'rotation-proof\')');
  db.close();

  assert.throws(() => rotateDatabaseEncryption(file, keyB, keyA), /密钥不正确|损坏/);
  db = new Database(file);
  assert.equal(db.prepare('SELECT value FROM proof').get().value, 'rotation-proof');
  db.close();

  assert.deepEqual(rotateDatabaseEncryption(file, keyA, keyB), { ok: true, status: 'encrypted', rotated: true });
  process.env.DB_ENCRYPTION_KEY = keyA;
  assert.throws(() => new Database(file), /密钥不正确|损坏/);
  process.env.DB_ENCRYPTION_KEY = keyB;
  db = new Database(file);
  assert.equal(db.prepare('SELECT value FROM proof').get().value, 'rotation-proof');
  db.close();
});

test('SQLite encryption: in-memory databases remain usable when file encryption is configured', (t) => {
  configureKey(t, { key: keyA });
  const db = new Database(':memory:');
  db.exec('CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES(\'memory-only\')');
  assert.equal(db.prepare('SELECT value FROM proof').get().value, 'memory-only');
  db.close();
});

test('SQLite encryption: key file loading validates key size and never depends on the data directory', (t) => {
  configureKey(t);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'composeops-keyfile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'db-key');
  writeFileSync(file, `${keyA}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  assert.equal(readDatabaseEncryptionKey({ DB_ENCRYPTION_KEY_FILE: file }), keyA);
  assert.throws(() => readDatabaseEncryptionKey({ DB_ENCRYPTION_KEY: 'weak' }), /64 位/);
  assert.throws(() => readDatabaseEncryptionKey({ DB_ENCRYPTION_KEY: keyA, DB_ENCRYPTION_KEY_FILE: file }), /只配置/);
});
