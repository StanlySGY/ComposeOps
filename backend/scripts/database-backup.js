#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { backupDatabase, verifyDatabase } from '../src/lib/database-backup.js';

try {
  const { values } = parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' }, verify: { type: 'string' } } });
  if (values.verify) {
    if (values.output || values.source) throw new Error('--verify 不可与 --source/--output 同时使用');
    console.log(JSON.stringify(verifyDatabase(values.verify)));
  } else {
    if (!values.output) throw new Error('用法: node scripts/database-backup.js --output <备份路径> [--source <数据库路径>]，或 --verify <备份路径>');
    const source = values.source || process.env.DB_PATH || fileURLToPath(new URL('../data/opsdash.db', import.meta.url));
    console.log(JSON.stringify(await backupDatabase(source, values.output)));
  }
} catch (error) {
  console.error(`数据库备份失败: ${error.message}`);
  process.exitCode = 1;
}
