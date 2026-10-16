import { lstatSync, realpathSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database, { getDatabaseEncryptionStatus, readDatabaseEncryptionKey } from './sqlite.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const CORE_TABLES = ['settings', 'ai_history', 'ai_sessions', 'sessions', 'project_preferences', 'operation_history'];
const KEY_PATTERN = /^[a-f0-9]{64}$/i;

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function secureFile(file, label) {
  let stat;
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error('不接受符号链接');
    stat = statSync(file);
  } catch (error) {
    throw new Error(`${label}不存在或不可安全读取: ${error.message}`, { cause: error });
  }
  if (!stat.isFile() || stat.size <= 0) throw new Error(`${label}必须是非空普通文件`);
  return { path: path.resolve(file), realPath: realpathSync(file), stat };
}

function assertPrivateFile(file, label) {
  if ((file.stat.mode & 0o077) !== 0) throw new Error(`${label}权限过宽，必须为 0600 或更严格`);
}

function assertPrivateDirectory(directory, label) {
  const stat = statSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error(`${label}目录权限过宽，必须为 0700 或更严格`);
  }
}

function inspectDatabase(filePath, keyFilePath) {
  const encryption = getDatabaseEncryptionStatus(filePath, { env: { DB_ENCRYPTION_KEY_FILE: keyFilePath } });
  if (!['plaintext', 'encrypted'].includes(encryption.status)
    || (encryption.status === 'encrypted' && encryption.keyVerified !== true)) {
    throw new Error(`数据库无法验证(${encryption.status})；检查文件是否损坏以及外置密钥是否匹配`);
  }

  let database;
  let restoreEnv = null;
  try {
    if (encryption.status === 'plaintext') {
      database = new DatabaseSync(filePath, { readOnly: true });
    } else {
      restoreEnv = {
        key: process.env.DB_ENCRYPTION_KEY,
        keyFile: process.env.DB_ENCRYPTION_KEY_FILE,
      };
      delete process.env.DB_ENCRYPTION_KEY;
      process.env.DB_ENCRYPTION_KEY_FILE = keyFilePath;
      database = new Database(filePath, { readonly: true, fileMustExist: true });
    }

    const integrity = database.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error('SQLite integrity_check 未通过');
    }
    const userVersion = Number(database.prepare('PRAGMA user_version').get().user_version);
    const applicationId = Number(database.prepare('PRAGMA application_id').get().application_id);
    const existing = new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name));
    const schema = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
      .map((row) => [row.type, row.name, row.tbl_name, row.sql]);
    const coreRowCounts = {};
    for (const table of CORE_TABLES) {
      if (existing.has(table)) coreRowCounts[table] = Number(database.prepare(`SELECT count(*) AS count FROM "${table}"`).get().count);
    }

    return {
      encryptionStatus: encryption.status,
      integrityCheck: 'ok',
      userVersion,
      applicationId,
      schemaObjectCount: schema.length,
      schema,
      coreRowCounts,
      bytes: statSync(filePath).size,
    };
  } finally {
    try { database?.close(); } catch { /* keep the inspection result */ }
    if (restoreEnv) {
      if (restoreEnv.key === undefined) delete process.env.DB_ENCRYPTION_KEY;
      else process.env.DB_ENCRYPTION_KEY = restoreEnv.key;
      if (restoreEnv.keyFile === undefined) delete process.env.DB_ENCRYPTION_KEY_FILE;
      else process.env.DB_ENCRYPTION_KEY_FILE = restoreEnv.keyFile;
    }
  }
}

/**
 * Read-only preflight for a controlled encryption migration.
 * It never writes to the database, backup, or key files.
 */
export function auditDatabaseReadiness({ dbPath, backupPath, keyFilePath } = {}) {
  if (!dbPath || !backupPath || !keyFilePath) throw new Error('必须同时提供 --db、--backup 与 --key-file');

  const databaseFile = secureFile(path.resolve(dbPath), '当前数据库');
  const backupFile = secureFile(path.resolve(backupPath), '数据库备份');
  const keyFile = secureFile(path.resolve(keyFilePath), '数据库密钥文件');

  if (databaseFile.realPath === backupFile.realPath) throw new Error('备份不能指向当前数据库文件本身');
  if (isWithin(PROJECT_ROOT, backupFile.realPath)) throw new Error('备份必须保存在仓库/应用目录之外');
  if (isWithin(PROJECT_ROOT, keyFile.realPath)) throw new Error('密钥必须保存在仓库/应用目录之外');
  if (path.dirname(databaseFile.realPath) === path.dirname(backupFile.realPath)) {
    throw new Error('备份目录必须与数据库目录分离');
  }
  const backupDirectory = path.dirname(backupFile.realPath);
  const keyDirectory = path.dirname(keyFile.realPath);
  if (isWithin(backupDirectory, keyFile.realPath) || isWithin(keyDirectory, backupFile.realPath)) {
    throw new Error('密钥和备份必须位于相互独立的目录树');
  }

  assertPrivateFile(backupFile, '数据库备份');
  assertPrivateFile(keyFile, '数据库密钥文件');
  assertPrivateDirectory(path.dirname(keyFile.realPath), '密钥');
  assertPrivateDirectory(path.dirname(backupFile.realPath), '备份');

  const key = readDatabaseEncryptionKey({ DB_ENCRYPTION_KEY_FILE: keyFile.realPath });
  if (!key || !KEY_PATTERN.test(key)) throw new Error('密钥文件格式无效');
  const database = inspectDatabase(databaseFile.realPath, keyFile.realPath);
  const backup = inspectDatabase(backupFile.realPath, keyFile.realPath);

  if (database.userVersion !== backup.userVersion || database.applicationId !== backup.applicationId) {
    throw new Error('当前数据库与备份的迁移版本或 application_id 不一致');
  }
  if (JSON.stringify(database.schema) !== JSON.stringify(backup.schema)) {
    throw new Error('当前数据库与备份的 schema 不一致');
  }
  if (JSON.stringify(database.coreRowCounts) !== JSON.stringify(backup.coreRowCounts)) {
    throw new Error('当前数据库与备份的核心表行数不一致');
  }

  return {
    status: 'ready_for_controlled_migration',
    readOnly: true,
    checks: {
      keyFormatValid: true,
      keyPermissionsRestricted: true,
      keyDirectoryRestricted: true,
      backupPermissionsRestricted: true,
      backupDirectoryRestricted: true,
      keyAndBackupStoredSeparately: true,
      backupOutsideApplicationDirectory: true,
      currentDatabaseIntegrity: database.integrityCheck,
      backupIntegrity: backup.integrityCheck,
      schemaAndMigrationVersionMatch: true,
    },
    database: {
      path: databaseFile.realPath,
      integrityCheck: database.integrityCheck,
      encryptionStatus: database.encryptionStatus,
      userVersion: database.userVersion,
      applicationId: database.applicationId,
      schemaObjectCount: database.schemaObjectCount,
      coreRowCounts: database.coreRowCounts,
      bytes: database.bytes,
    },
    backup: {
      path: backupFile.realPath,
      integrityCheck: backup.integrityCheck,
      encryptionStatus: backup.encryptionStatus,
      userVersion: backup.userVersion,
      applicationId: backup.applicationId,
      schemaObjectCount: backup.schemaObjectCount,
      coreRowCounts: backup.coreRowCounts,
      bytes: backup.bytes,
    },
    keyFile: { path: keyFile.realPath, permissions: 'restricted' },
    note: '此结果只验证迁移前置条件；迁移后仍须确认 encrypted/keyVerified，并独立执行恢复演练。',
  };
}
