import { DatabaseSync } from 'node:sqlite';
import MultiCipherDatabase from 'better-sqlite3-multiple-ciphers';
import { chmodSync, closeSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SQLITE_HEADER = Buffer.from('SQLite format 3\0');
const KEY_PATTERN = /^[a-f0-9]{64}$/i;

function validateEncryptionKey(value, label = '数据库加密密钥') {
  const key = String(value || '').trim();
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`${label}必须是 64 位十六进制字符串（32 字节随机密钥）`);
  }
  return key.toLowerCase();
}

/** Prefer a read-only mounted secret file over environment values; never log or return key contents to callers. */
export function readDatabaseEncryptionKey(env = process.env) {
  const envKey = String(env.DB_ENCRYPTION_KEY || '').trim();
  const keyFile = String(env.DB_ENCRYPTION_KEY_FILE || '').trim();
  if (envKey && keyFile) throw new Error('请只配置 DB_ENCRYPTION_KEY 或 DB_ENCRYPTION_KEY_FILE 其中一项');
  if (keyFile) {
    let content;
    try { content = readFileSync(keyFile, 'utf8'); }
    catch (error) { throw new Error(`无法读取数据库密钥文件 ${keyFile}: ${error.message}`, { cause: error }); }
    return validateEncryptionKey(content, '数据库密钥文件内容');
  }
  return envKey ? validateEncryptionKey(envKey) : null;
}

function fileKind(location) {
  if (!existsSync(location)) return 'missing';
  let stat;
  try { stat = statSync(location); } catch { return 'unknown'; }
  if (!stat.size) return 'empty';
  let descriptor;
  try {
    descriptor = openSync(location, 'r');
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    return bytesRead === SQLITE_HEADER.length && header.equals(SQLITE_HEADER) ? 'plaintext' : 'encrypted-or-corrupt';
  } catch {
    return 'unknown';
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
export function getDatabaseEncryptionStatus(location, options = {}) {
  const absolute = path.resolve(location);
  const kind = fileKind(absolute);
  if (kind === 'plaintext') return { path: absolute, status: 'plaintext', encryptedHeader: false, keyVerified: false };
  if (kind !== 'encrypted-or-corrupt') return { path: absolute, status: kind, encryptedHeader: false, keyVerified: false };

  let key;
  try { key = readDatabaseEncryptionKey(options.env || process.env); }
  catch {
    return { path: absolute, status: 'encrypted-or-unrecognized', encryptedHeader: true, keyVerified: false };
  }
  if (!key) return { path: absolute, status: 'encrypted-or-unrecognized', encryptedHeader: true, keyVerified: false };

  let database;
  try {
    database = new MultiCipherDatabase(absolute, { readonly: true, fileMustExist: true });
    database.pragma(`key = ${quoteLiteral(key)}`);
    database.pragma('foreign_keys = OFF');
    assertEncryptedKeyWorks(database);
    return { path: absolute, status: 'encrypted', encryptedHeader: true, keyVerified: true };
  } catch {
    return { path: absolute, status: 'encrypted-or-corrupt', encryptedHeader: true, keyVerified: false };
  } finally {
    try { database?.close(); } catch { /* preserve verification result */ }
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runIntegrityCheck(database) {
  const result = database.pragma('integrity_check');
  if (result.length !== 1 || result[0].integrity_check !== 'ok') {
    throw new Error('数据库完整性校验未通过');
  }
}

function assertEncryptedKeyWorks(database) {
  try {
    // A wrong key often appears to open successfully until SQLite reads the first page.
    database.pragma('cipher_version');
    database.prepare('SELECT name FROM sqlite_master LIMIT 1').all();
    runIntegrityCheck(database);
  } catch (error) {
    throw new Error('无法打开加密数据库：密钥不正确或数据库文件已损坏', { cause: error });
  }
}

/**
 * Copy the existing plaintext schema and all rows into a separately keyed file.
 * The live path is replaced atomically only after integrity verification succeeds.
 * ComposeOps currently uses ordinary tables/indexes/views/triggers (no virtual tables).
 */
function migratePlaintextDatabase(location, key) {
  const absolute = path.resolve(location);
  const temporary = `${absolute}.encrypt-${randomUUID()}`;
  let source;
  let target;
  let targetClosed = false;
  try {
    source = new DatabaseSync(absolute, { enableForeignKeyConstraints: false });
    const checkpoint = source.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint?.busy) throw new Error('数据库仍有未结束的读写事务，已拒绝加密迁移');
    source.prepare('PRAGMA journal_mode = DELETE').get();

    const schema = source.prepare(`
      SELECT type, name, sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        AND type IN ('table', 'index', 'view', 'trigger')
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name
    `).all();
    const tables = schema.filter((item) => item.type === 'table');
    const sourceUserVersion = Number(source.prepare('PRAGMA user_version').get()?.user_version || 0);
    const sourceApplicationId = Number(source.prepare('PRAGMA application_id').get()?.application_id || 0);
    const sourceForeignKeyViolations = source.prepare('PRAGMA foreign_key_check').all();

    target = new MultiCipherDatabase(temporary);
    target.pragma(`key = ${quoteLiteral(key)}`);
    // Match the application's pre-encryption SQLite contract: foreign keys were not enforced per connection.
    target.pragma('foreign_keys = OFF');
    // Force key verification and initialize the encrypted database before copying.
    target.prepare('SELECT name FROM sqlite_master LIMIT 1').all();

    for (const table of tables) target.exec(table.sql);

    for (const table of tables) {
      const identifier = quoteIdentifier(table.name);
      const columns = source.prepare(`PRAGMA table_xinfo(${quoteLiteral(table.name)})`).all()
        .filter((column) => Number(column.hidden || 0) === 0)
        .map((column) => column.name);
      if (!columns.length) continue;
      const names = columns.map(quoteIdentifier).join(', ');
      const placeholders = columns.map(() => '?').join(', ');
      const rows = source.prepare(`SELECT ${names} FROM ${identifier}`).iterate();
      const insert = target.prepare(`INSERT INTO ${identifier} (${names}) VALUES (${placeholders})`);
      const copyRows = target.transaction((items) => {
        for (const row of items) insert.run(...columns.map((column) => row[column]));
      });
      // Stream the source and commit bounded batches, avoiding a whole-table read into memory.
      let batch = [];
      for (const row of rows) {
        batch.push(row);
        if (batch.length === 500) {
          copyRows(batch);
          batch = [];
        }
      }
      if (batch.length) copyRows(batch);
    }

    // Preserve AUTOINCREMENT high-water marks even when the highest IDs were deleted.
    const hasSequence = source.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get();
    if (hasSequence) {
      const sequences = source.prepare('SELECT name, seq FROM sqlite_sequence').all();
      if (target.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get()) {
        const updateSequence = target.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?');
        const insertSequence = target.prepare('INSERT INTO sqlite_sequence(name, seq) VALUES(?, ?)');
        for (const sequence of sequences) {
          const updated = updateSequence.run(sequence.seq, sequence.name);
          if (updated.changes === 0) insertSequence.run(sequence.name, sequence.seq);
        }
      }
    }

    for (const item of schema.filter((entry) => entry.type !== 'table')) target.exec(item.sql);
    target.pragma(`user_version = ${sourceUserVersion}`);
    target.pragma(`application_id = ${sourceApplicationId}`);
    runIntegrityCheck(target);
    const targetForeignKeyViolations = target.pragma('foreign_key_check');
    const normalizeForeignKeyViolations = (rows) => rows
      .map((row) => JSON.stringify(row))
      .sort();
    if (JSON.stringify(normalizeForeignKeyViolations(sourceForeignKeyViolations))
      !== JSON.stringify(normalizeForeignKeyViolations(targetForeignKeyViolations))) {
      throw new Error('加密迁移前后外键检查结果不一致，原数据库保持不变');
    }
    target.pragma('journal_mode = DELETE');
    target.close();
    targetClosed = true;
    source.close();
    source = null;

    chmodSync(temporary, 0o600);
    if (fileKind(temporary) !== 'encrypted-or-corrupt') {
      throw new Error('加密迁移产物的文件头未通过校验，原数据库保持不变');
    }
    renameSync(temporary, absolute);
    chmodSync(absolute, 0o600);
    rmSync(`${absolute}-wal`, { force: true });
    rmSync(`${absolute}-shm`, { force: true });
  } catch (error) {
    throw new Error(`SQLite 静态加密迁移失败，原数据库未被替换：${error.message}`, { cause: error });
  } finally {
    try { source?.close(); } catch { /* ignore cleanup failures */ }
    if (target && !targetClosed) {
      try { target.close(); } catch { /* ignore cleanup failures */ }
    }
    rmSync(temporary, { force: true });
    rmSync(`${temporary}-wal`, { force: true });
    rmSync(`${temporary}-shm`, { force: true });
  }
}

export function encryptDatabaseFile(location, key) {
  const checkedKey = validateEncryptionKey(key);
  const absolute = path.resolve(location);
  const kind = fileKind(absolute);
  if (kind === 'missing' || kind === 'empty') throw new Error('数据库文件不存在或为空，未执行加密');
  if (kind === 'plaintext') {
    migratePlaintextDatabase(absolute, checkedKey);
    const encrypted = new MultiCipherDatabase(absolute, { readonly: true, fileMustExist: true });
    try {
      encrypted.pragma(`key = ${quoteLiteral(checkedKey)}`);
      assertEncryptedKeyWorks(encrypted);
    } finally { encrypted.close(); }
    return { ok: true, status: 'encrypted', migrated: true };
  }
  const encrypted = new MultiCipherDatabase(absolute, { readonly: true, fileMustExist: true });
  try {
    encrypted.pragma(`key = ${quoteLiteral(checkedKey)}`);
    assertEncryptedKeyWorks(encrypted);
  } finally { encrypted.close(); }
  return { ok: true, status: 'encrypted', migrated: false };
}

/** Rotate a key offline: export to a same-filesystem temp file, rekey, verify, then atomically replace. */
export function rotateDatabaseEncryption(location, previousKey, nextKey) {
  const oldKey = validateEncryptionKey(previousKey, '旧数据库密钥');
  const newKey = validateEncryptionKey(nextKey, '新数据库密钥');
  if (oldKey === newKey) throw new Error('新旧数据库密钥相同，无需轮换');
  const absolute = path.resolve(location);
  if (fileKind(absolute) !== 'encrypted-or-corrupt') throw new Error('只能轮换已加密的数据库；当前文件头不是加密 SQLite 格式');
  const temporary = `${absolute}.rotate-${randomUUID()}`;
  let source;
  let rotated;
  try {
    source = new MultiCipherDatabase(absolute, { fileMustExist: true });
    source.pragma(`key = ${quoteLiteral(oldKey)}`);
    assertEncryptedKeyWorks(source);
    const checkpoints = source.pragma('wal_checkpoint(TRUNCATE)');
    if (checkpoints[0]?.busy) throw new Error('数据库仍有未结束的读写事务；请停止 ComposeOps 后重试');
    source.exec(`VACUUM INTO ${quoteLiteral(temporary)}`);
    source.close();
    source = null;

    rotated = new MultiCipherDatabase(temporary, { fileMustExist: true });
    rotated.pragma(`key = ${quoteLiteral(oldKey)}`);
    assertEncryptedKeyWorks(rotated);
    rotated.pragma(`rekey = ${quoteLiteral(newKey)}`);
    assertEncryptedKeyWorks(rotated);
    rotated.pragma('journal_mode = DELETE');
    rotated.close();
    rotated = null;

    chmodSync(temporary, 0o600);
    renameSync(temporary, absolute);
    chmodSync(absolute, 0o600);
    rmSync(`${absolute}-wal`, { force: true });
    rmSync(`${absolute}-shm`, { force: true });
    return { ok: true, status: 'encrypted', rotated: true };
  } catch (error) {
    throw new Error(`SQLite 密钥轮换失败，原数据库未被替换：${error.message}`, { cause: error });
  } finally {
    try { source?.close(); } catch { /* ignore cleanup failures */ }
    try { rotated?.close(); } catch { /* ignore cleanup failures */ }
    rmSync(temporary, { force: true });
    rmSync(`${temporary}-wal`, { force: true });
    rmSync(`${temporary}-shm`, { force: true });
  }
}

function openEncryptedDatabase(location, options, key) {
  const database = new MultiCipherDatabase(location, {
    readonly: options.readonly ?? false,
    fileMustExist: options.fileMustExist ?? false,
  });
  try {
    database.pragma(`key = ${quoteLiteral(key)}`);
    // Preserve the legacy adapter's explicit foreign-key-off behavior after encryption is enabled.
    database.pragma('foreign_keys = OFF');
    assertEncryptedKeyWorks(database);
    return database;
  } catch (error) {
    try { database.close(); } catch { /* ignore cleanup failures */ }
    throw error;
  }
}

class StatementWrapper {
  constructor(stmt) {
    this._stmt = stmt;
  }

  run(...params) {
    const cleaned = sanitizeParams(params);
    const result = this._stmt.run(...cleaned);
    return {
      changes: result.changes ?? 0,
      lastInsertRowid: result.lastInsertRowid ?? 0,
    };
  }

  get(...params) {
    const cleaned = sanitizeParams(params);
    const result = this._stmt.get(...cleaned);
    return result ? { ...result } : undefined;
  }

  all(...params) {
    const cleaned = sanitizeParams(params);
    return this._stmt.all(...cleaned).map((row) => ({ ...row }));
  }

  *iterate(...params) {
    const cleaned = sanitizeParams(params);
    for (const row of this._stmt.iterate(...cleaned)) {
      yield { ...row };
    }
  }
}

function sanitizeParam(val) {
  if (val === undefined) return null;
  return val;
}
function sanitizeParams(params) {
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) {
    return [Object.fromEntries(Object.entries(params[0]).map(([key, value]) => [key, sanitizeParam(value)]))];
  }
  return params.map(sanitizeParam);
}

export default class Database {
  constructor(location, options = {}) {
    // Keep SQLite's sentinel intact: path.resolve(':memory:') silently turns it into a shared disk file.
    const inMemory = String(location) === ':memory:';
    const absolute = inMemory ? ':memory:' : path.resolve(location);
    const key = readDatabaseEncryptionKey();
    const kind = inMemory ? 'missing' : fileKind(absolute);
    if (inMemory) {
      // Encryption is an at-rest control; in-memory test/ephemeral databases must not require a file key.
      this._db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
      return;
    }
    if (key && kind === 'plaintext') {
      if (options.readonly) throw new Error('发现明文 SQLite 数据库，但当前连接为只读；请先在应用启动时或停机维护时完成加密迁移');
      migratePlaintextDatabase(absolute, key);
    } else if (!key && kind === 'encrypted-or-corrupt') {
      throw new Error('检测到加密或无法识别的 SQLite 文件；请配置 DB_ENCRYPTION_KEY_FILE，缺少密钥时不会尝试降级打开');
    }
    if (key) {
      this._db = openEncryptedDatabase(absolute, options, key);
    } else {
      this._db = new DatabaseSync(absolute, {
        readOnly: options.readonly ?? false,
        enableForeignKeyConstraints: false,
      });
    }
  }

  prepare(sql) {
    const stmt = this._db.prepare(sql);
    return new StatementWrapper(stmt);
  }

  exec(sql) {
    return this._db.exec(sql);
  }

  pragma(pragmaStr, options = {}) {
    const trimmed = pragmaStr.trim();
    if (trimmed.includes('=')) {
      if (typeof this._db.pragma === 'function') this._db.pragma(trimmed);
      else this._db.exec(`PRAGMA ${trimmed};`);
      return [];
    }
    const rows = typeof this._db.pragma === 'function'
      ? this._db.pragma(trimmed)
      : this._db.prepare(`PRAGMA ${trimmed};`).all();
    if (options.simple) {
      if (!rows.length) return undefined;
      const firstRow = rows[0];
      const keys = Object.keys(firstRow);
      return keys.length ? firstRow[keys[0]] : undefined;
    }
    return rows.map((row) => ({ ...row }));
  }

  transaction(fn) {
    return (...args) => {
      this._db.exec('BEGIN');
      try {
        const result = fn(...args);
        this._db.exec('COMMIT');
        return result;
      } catch (error) {
        try { this._db.exec('ROLLBACK'); } catch { /* preserve original transaction error */ }
        throw error;
      }
    };
  }

  vacuumInto(destinationPath) {
    const target = String(destinationPath).replace(/'/g, "''");
    this._db.exec(`VACUUM INTO '${target}'`);
  }

  close() {
    return this._db.close();
  }
}
