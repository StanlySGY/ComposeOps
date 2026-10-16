import assert from 'node:assert/strict';
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditDatabaseReadiness } from '../src/lib/database-readiness-audit.js';

function createDatabase(file, value = 'before') {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE ai_history (id INTEGER PRIMARY KEY, role TEXT NOT NULL);
    PRAGMA user_version = 7;
    PRAGMA application_id = 42;
  `);
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)').run('mode', value);
  db.close();
  chmodSync(file, 0o600);
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'composeops-db-readiness-'));
  chmodSync(root, 0o700);
  const dbDir = path.join(root, 'database');
  const backupDir = path.join(root, 'backup');
  const keyDir = path.join(root, 'keys');
  for (const directory of [dbDir, backupDir, keyDir]) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const dbPath = path.join(dbDir, 'opsdash.db');
  const backupPath = path.join(backupDir, 'snapshot.db');
  const keyFilePath = path.join(keyDir, 'database-key');
  createDatabase(dbPath);
  copyFileSync(dbPath, backupPath);
  chmodSync(backupPath, 0o600);
  writeFileSync(keyFilePath, 'a'.repeat(64) + '\n', { mode: 0o600 });
  chmodSync(keyFilePath, 0o600);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, dbPath, backupPath, keyFilePath };
}

test('database readiness audit is read-only and accepts an isolated healthy backup', (t) => {
  const files = fixture(t);
  const beforeDb = statSync(files.dbPath);
  const beforeBackup = statSync(files.backupPath);
  const result = auditDatabaseReadiness(files);
  assert.equal(result.status, 'ready_for_controlled_migration');
  assert.equal(result.readOnly, true);
  assert.equal(result.database.encryptionStatus, 'plaintext');
  assert.equal(result.backup.integrityCheck, 'ok');
  assert.equal(result.checks.schemaAndMigrationVersionMatch, true);
  assert.equal(statSync(files.dbPath).mtimeMs, beforeDb.mtimeMs);
  assert.equal(statSync(files.backupPath).mtimeMs, beforeBackup.mtimeMs);
});

test('database readiness audit blocks mismatched schemas', (t) => {
  const files = fixture(t);
  const db = new DatabaseSync(files.backupPath);
  db.exec('CREATE TABLE unexpected_extra (id INTEGER PRIMARY KEY)');
  db.close();
  assert.throws(() => auditDatabaseReadiness(files), /schema 不一致/);
});

test('database readiness audit blocks mismatched core table row counts', (t) => {
  const files = fixture(t);
  const backup = new DatabaseSync(files.backupPath);
  backup.prepare('INSERT INTO settings(key, value) VALUES (?, ?)').run('extra', 'row');
  backup.close();
  assert.throws(() => auditDatabaseReadiness(files), /核心表行数不一致/);
});

test('database readiness audit blocks a key and backup in the same directory tree', (t) => {
  const files = fixture(t);
  const colocatedBackup = path.join(path.dirname(files.keyFilePath), 'snapshot.db');
  copyFileSync(files.backupPath, colocatedBackup);
  chmodSync(colocatedBackup, 0o600);
  assert.throws(
    () => auditDatabaseReadiness({ ...files, backupPath: colocatedBackup }),
    /相互独立的目录树/,
  );
});

test('database readiness audit blocks a weakly permissioned key', (t) => {
  const files = fixture(t);
  chmodSync(files.keyFilePath, 0o644);
  assert.throws(() => auditDatabaseReadiness(files), /权限过宽/);
});
