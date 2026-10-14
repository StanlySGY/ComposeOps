import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from '../src/lib/sqlite.js';
import { backupDatabase } from '../src/lib/database-backup.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scriptPath = path.join(projectRoot, 'backend/scripts/encryption-recovery-drill.js');
const sqliteHeader = Buffer.from('SQLite format 3\0');

function safeKeyFile(file, key) {
  writeFileSync(file, key + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

function runCli(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, DB_ENCRYPTION_KEY: '', DB_ENCRYPTION_KEY_FILE: '' },
  });
}

test('encryption recovery drill restores an encrypted backup with an external key and writes a private report', async (t) => {
  const previous = { key: process.env.DB_ENCRYPTION_KEY, keyFile: process.env.DB_ENCRYPTION_KEY_FILE };
  const root = mkdtempSync(path.join(os.tmpdir(), 'composeops-recovery-drill-test-'));
  t.after(() => {
    if (previous.key === undefined) delete process.env.DB_ENCRYPTION_KEY; else process.env.DB_ENCRYPTION_KEY = previous.key;
    if (previous.keyFile === undefined) delete process.env.DB_ENCRYPTION_KEY_FILE; else process.env.DB_ENCRYPTION_KEY_FILE = previous.keyFile;
    rmSync(root, { recursive: true, force: true });
  });
  const secretDir = path.join(root, 'secret-store');
  const backupDir = path.join(root, 'backup-export');
  const reportDir = path.join(root, 'reports');
  mkdirSync(secretDir, { mode: 0o700 });
  mkdirSync(backupDir, { mode: 0o700 });
  mkdirSync(reportDir, { mode: 0o700 });
  const key = randomBytes(32).toString('hex');
  const keyFile = path.join(secretDir, 'db-key');
  safeKeyFile(keyFile, key);
  const source = path.join(root, 'source.db');
  const backup = path.join(backupDir, 'encrypted.db');
  const report = path.join(reportDir, 'recovery-report.json');
  delete process.env.DB_ENCRYPTION_KEY;
  process.env.DB_ENCRYPTION_KEY_FILE = keyFile;

  const database = new Database(source);
  database.exec("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE ai_history(id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL); INSERT INTO settings VALUES ('theme', 'dark'); INSERT INTO ai_history(content) VALUES ('recovery-proof-1'), ('recovery-proof-2'); PRAGMA user_version = 16;");
  database.close();
  const backupResult = await backupDatabase(source, backup);
  assert.equal(backupResult.ok, true);
  assert.equal(readFileSync(backup).subarray(0, 16).equals(sqliteHeader), false, 'fixture must be encrypted');

  const result = runCli(['--backup', backup, '--key-file', keyFile, '--report-file', report]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'passed');
  assert.equal(output.checks.integrityCheck, 'ok');
  assert.equal(output.checks.keyAndBackupStoredSeparately, true);
  assert.equal(output.checks.schemaAndCoreCountsMatch, true);
  assert.equal(output.userVersion, 16);
  assert.equal(output.coreRowCounts.settings, 1);
  assert.equal(output.coreRowCounts.ai_history, 2);
  assert.equal(output.liveDatabaseModified, false);
  assert.equal(JSON.stringify(output).includes(key), false, 'key must not appear in output');
  assert.equal((statSync(report).mode & 0o777), 0o600);
  assert.equal(JSON.parse(readFileSync(report, 'utf8')).status, 'passed');
  assert.equal((statSync(keyFile).mode & 0o777), 0o600);
});

test('encryption recovery drill refuses a wrong key without disclosing either key', async (t) => {
  const previous = { key: process.env.DB_ENCRYPTION_KEY, keyFile: process.env.DB_ENCRYPTION_KEY_FILE };
  const root = mkdtempSync(path.join(os.tmpdir(), 'composeops-recovery-wrong-key-'));
  t.after(() => {
    if (previous.key === undefined) delete process.env.DB_ENCRYPTION_KEY; else process.env.DB_ENCRYPTION_KEY = previous.key;
    if (previous.keyFile === undefined) delete process.env.DB_ENCRYPTION_KEY_FILE; else process.env.DB_ENCRYPTION_KEY_FILE = previous.keyFile;
    rmSync(root, { recursive: true, force: true });
  });
  const secretDir = path.join(root, 'secret-store');
  const backupDir = path.join(root, 'backup-export');
  mkdirSync(secretDir, { mode: 0o700 });
  mkdirSync(backupDir, { mode: 0o700 });
  const key = randomBytes(32).toString('hex');
  const wrong = randomBytes(32).toString('hex');
  const keyFile = path.join(secretDir, 'wrong-key');
  safeKeyFile(keyFile, wrong);
  const goodKeyFile = path.join(secretDir, 'right-key');
  safeKeyFile(goodKeyFile, key);
  const source = path.join(root, 'source.db');
  const backup = path.join(backupDir, 'encrypted.db');
  delete process.env.DB_ENCRYPTION_KEY;
  process.env.DB_ENCRYPTION_KEY_FILE = goodKeyFile;
  const database = new Database(source);
  database.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('must-survive')");
  database.close();
  await backupDatabase(source, backup);

  const result = runCli(['--backup', backup, '--key-file', keyFile]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not be verified|Encryption recovery drill failed/i);
  assert.equal((result.stdout + result.stderr).includes(key), false);
  assert.equal((result.stdout + result.stderr).includes(wrong), false);
});

test('encryption recovery drill refuses a key stored alongside the backup and plaintext backups', async (t) => {
  const previous = { key: process.env.DB_ENCRYPTION_KEY, keyFile: process.env.DB_ENCRYPTION_KEY_FILE };
  const root = mkdtempSync(path.join(os.tmpdir(), 'composeops-recovery-separation-'));
  t.after(() => {
    if (previous.key === undefined) delete process.env.DB_ENCRYPTION_KEY; else process.env.DB_ENCRYPTION_KEY = previous.key;
    if (previous.keyFile === undefined) delete process.env.DB_ENCRYPTION_KEY_FILE; else process.env.DB_ENCRYPTION_KEY_FILE = previous.keyFile;
    rmSync(root, { recursive: true, force: true });
  });
  const secretDir = path.join(root, 'secrets');
  const backupDir = path.join(root, 'backup-export');
  mkdirSync(secretDir, { mode: 0o700 });
  mkdirSync(backupDir, { mode: 0o700 });
  const key = randomBytes(32).toString('hex');
  const source = path.join(root, 'plain.db');
  delete process.env.DB_ENCRYPTION_KEY;
  delete process.env.DB_ENCRYPTION_KEY_FILE;
  const plain = new Database(source);
  plain.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('plain')");
  plain.close();
  const backup = path.join(backupDir, 'plain.db');
  copyFileSync(source, backup);
  const sidecarKey = path.join(backupDir, 'db-key');
  safeKeyFile(sidecarKey, key);
  const sidecar = runCli(['--backup', backup, '--key-file', sidecarKey]);
  assert.notEqual(sidecar.status, 0);
  assert.match(sidecar.stderr, /separate directory trees/i);

  const keyFile = path.join(secretDir, 'db-key');
  safeKeyFile(keyFile, key);
  const plainWithKey = runCli(['--backup', backup, '--key-file', keyFile]);
  assert.notEqual(plainWithKey.status, 0);
  assert.match(plainWithKey.stderr, /could not be verified/i);
});
