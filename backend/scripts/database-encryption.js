#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptDatabaseFile, getDatabaseEncryptionStatus, rotateDatabaseEncryption } from '../src/lib/sqlite.js';

function readKeyFile(file) {
  let value;
  try {
    if ((statSync(file).mode & 0o077) !== 0) throw new Error('密钥文件权限过宽，请执行 chmod 600');
    value = readFileSync(file, 'utf8').trim();
  } catch (error) { throw new Error(`无法安全读取密钥文件 ${file}: ${error.message}`, { cause: error }); }
  // The secret must be independently stored, not alongside the SQLite data file.
  return validateKey(value, file);
}
function validateKey(value, label) {
  if (!/^[a-f0-9]{64}$/i.test(String(value || '').trim())) {
    throw new Error(`${label}必须包含 64 位十六进制密钥（使用 openssl rand -hex 32 生成）`);
  }
  return String(value).trim().toLowerCase();
}
function requireStopped(values) {
  if (!values['confirm-stopped']) {
    throw new Error('此操作会替换数据库文件；先停止 ComposeOps 并确认没有其他实例连接，再传入 --confirm-stopped');
  }
}
function resolveDatabase(values) {
  const file = values.db || process.env.DB_PATH || fileURLToPath(new URL('../data/opsdash.db', import.meta.url));
  return path.resolve(file);
}

try {
  const command = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      db: { type: 'string' },
      'key-file': { type: 'string' },
      'old-key-file': { type: 'string' },
      'new-key-file': { type: 'string' },
      'confirm-stopped': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const dbFile = resolveDatabase(values);

  if (command === 'status') {
    const result = getDatabaseEncryptionStatus(dbFile);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'encrypt') {
    requireStopped(values);
    if (!values['key-file']) throw new Error('encrypt 需要 --key-file <密钥文件>');
    const result = encryptDatabaseFile(dbFile, readKeyFile(values['key-file']));
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'rotate') {
    requireStopped(values);
    if (!values['old-key-file'] || !values['new-key-file']) {
      throw new Error('rotate 需要 --old-key-file <旧密钥> --new-key-file <新密钥>');
    }
    const result = rotateDatabaseEncryption(dbFile, readKeyFile(values['old-key-file']), readKeyFile(values['new-key-file']));
    console.log(JSON.stringify(result, null, 2));
  } else {
    throw new Error('用法: node backend/scripts/database-encryption.js status [--db PATH] | encrypt --db PATH --key-file PATH --confirm-stopped | rotate --db PATH --old-key-file PATH --new-key-file PATH --confirm-stopped');
  }
} catch (error) {
  console.error(`数据库加密工具失败: ${error.message}`);
  process.exitCode = 1;
}
