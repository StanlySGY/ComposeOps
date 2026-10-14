import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { statfsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database, { getDatabaseEncryptionStatus, readDatabaseEncryptionKey } from './sqlite.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const CORE_TABLES = ['settings', 'ai_history', 'ai_sessions', 'ai_memories', 'sessions', 'project_preferences', 'operation_history'];
const KEY_PATTERN = /^[a-f0-9]{64}$/i;

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function secureFile(file, label) {
  let stat;
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error('symbolic link is not accepted');
    stat = statSync(file);
  } catch (error) {
    throw new Error(label + ' is unavailable or unsafe: ' + error.message, { cause: error });
  }
  if (!stat.isFile()) throw new Error(label + ' must be a regular file');
  return stat;
}

function verifyKeyFile(keyFile) {
  const stat = secureFile(keyFile, 'Encryption key file');
  if ((stat.mode & 0o077) !== 0) throw new Error('Encryption key file permissions must be 0600 or stricter');
  const parent = statSync(path.dirname(keyFile));
  if ((parent.mode & 0o077) !== 0) throw new Error('Encryption key directory permissions must be 0700 or stricter');
  const key = readDatabaseEncryptionKey({ DB_ENCRYPTION_KEY_FILE: keyFile });
  if (!key || !KEY_PATTERN.test(key)) throw new Error('Encryption key file contents are invalid');
}

function coreCounts(database) {
  const existing = new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name));
  const counts = {};
  for (const table of CORE_TABLES) {
    if (!existing.has(table)) continue;
    counts[table] = Number(database.prepare('SELECT count(*) AS count FROM "' + table + '"').get().count);
  }
  return counts;
}

function schemaFingerprint(database) {
  return database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
    .map((row) => [row.type, row.name, row.tbl_name, row.sql]);
}

function inspectDatabase(file) {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma('integrity_check');
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('SQLite integrity_check failed');
    const userVersion = Number(database.pragma('user_version', { simple: true }));
    const applicationId = Number(database.pragma('application_id', { simple: true }));
    const schema = schemaFingerprint(database);
    return {
      integrityCheck: 'ok',
      userVersion,
      applicationId,
      schemaObjectCount: schema.length,
      schema,
      coreRowCounts: coreCounts(database),
    };
  } finally {
    database.close();
  }
}

/** Restore an encrypted backup into an isolated temporary path with the supplied external key. */
export async function runEncryptionRecoveryDrill({ backupPath, keyFilePath, reportPath = null }) {
  if (!backupPath || !keyFilePath) throw new Error('Both --backup and --key-file are required');
  const backup = path.resolve(backupPath);
  const keyFile = path.resolve(keyFilePath);
  const keyStat = secureFile(keyFile, 'Encryption key file');
  const backupStat = secureFile(backup, 'Encrypted backup');
  const realKey = realpathSync(keyFile);
  const realBackup = realpathSync(backup);
  const repoRoot = realpathSync(PROJECT_ROOT);
  const backupDir = path.dirname(realBackup);
  const keyDir = path.dirname(realKey);

  if (realKey === realBackup) throw new Error('The backup and encryption key must be separate files');
  if (isWithin(repoRoot, realKey)) throw new Error('The encryption key must be outside the repository');
  if (isWithin(repoRoot, realBackup)) throw new Error('The encrypted backup must be outside the repository');
  if (isWithin(backupDir, realKey) || isWithin(keyDir, realBackup)) {
    throw new Error('The key and encrypted backup must be stored in separate directory trees');
  }
  if ((keyStat.mode & 0o077) !== 0) throw new Error('Encryption key file permissions must be 0600 or stricter');
  if ((statSync(keyDir).mode & 0o077) !== 0) throw new Error('Encryption key directory permissions must be 0700 or stricter');
  verifyKeyFile(realKey);

  const previous = {
    key: process.env.DB_ENCRYPTION_KEY,
    keyFile: process.env.DB_ENCRYPTION_KEY_FILE,
  };
  delete process.env.DB_ENCRYPTION_KEY;
  process.env.DB_ENCRYPTION_KEY_FILE = realKey;
  let tempDir;
  try {
    const sourceStatus = getDatabaseEncryptionStatus(realBackup, { env: process.env });
    if (sourceStatus.status !== 'encrypted' || sourceStatus.keyVerified !== true) {
      throw new Error('The backup could not be verified as an encrypted database with the supplied key');
    }

    const filesystem = statfsSync(os.tmpdir());
    const available = filesystem.bavail * filesystem.bsize;
    if (available < backupStat.size * 1.1) throw new Error('Insufficient free disk space for an isolated restore rehearsal');

    tempDir = mkdtempSync(path.join(os.tmpdir(), 'composeops-recovery-drill-'));
    chmodSync(tempDir, 0o700);
    const restoredPath = path.join(tempDir, 'restored-encrypted.db');
    copyFileSync(realBackup, restoredPath);
    chmodSync(restoredPath, 0o600);

    const before = inspectDatabase(realBackup);
    const restored = inspectDatabase(restoredPath);
    const restoredStatus = getDatabaseEncryptionStatus(restoredPath, { env: process.env });
    if (restoredStatus.status !== 'encrypted' || restoredStatus.keyVerified !== true) {
      throw new Error('The restored copy could not be opened with the external key');
    }
    if (before.integrityCheck !== restored.integrityCheck
      || before.userVersion !== restored.userVersion
      || before.applicationId !== restored.applicationId
      || before.schemaObjectCount !== restored.schemaObjectCount
      || JSON.stringify(before.schema) !== JSON.stringify(restored.schema)
      || JSON.stringify(before.coreRowCounts) !== JSON.stringify(restored.coreRowCounts)) {
      throw new Error('The restored database metadata does not match the encrypted backup');
    }

    const result = {
      status: 'passed',
      checks: {
        keyFileFormatAndPermissions: true,
        keyAndBackupStoredSeparately: true,
        backupOpensWithSuppliedKey: true,
        restoredCopyOpensWithSuppliedKey: true,
        integrityCheck: 'ok',
        schemaAndCoreCountsMatch: true,
      },
      backupBytes: backupStat.size,
      restoredBytes: statSync(restoredPath).size,
      userVersion: restored.userVersion,
      applicationId: restored.applicationId,
      schemaObjectCount: restored.schemaObjectCount,
      coreRowCounts: restored.coreRowCounts,
      restoredCopyWasTemporary: true,
      liveDatabaseModified: false,
      keyContentsLogged: false,
      completedAt: new Date().toISOString(),
    };

    if (reportPath) {
      const report = path.resolve(reportPath);
      if (isWithin(repoRoot, report)) throw new Error('The recovery report must be outside the repository');
      if (report === realBackup || report === realKey) throw new Error('The report path must not overwrite the backup or key');
      mkdirSync(path.dirname(report), { recursive: true, mode: 0o700 });
      const parentStat = statSync(path.dirname(report));
      if ((parentStat.mode & 0o077) !== 0) throw new Error('Recovery report directory permissions must be 0700 or stricter');
      result.reportFile = report;
      writeFileSync(report, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      chmodSync(report, 0o600);
    }
    return result;
  } finally {
    if (previous.key === undefined) delete process.env.DB_ENCRYPTION_KEY;
    else process.env.DB_ENCRYPTION_KEY = previous.key;
    if (previous.keyFile === undefined) delete process.env.DB_ENCRYPTION_KEY_FILE;
    else process.env.DB_ENCRYPTION_KEY_FILE = previous.keyFile;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}
