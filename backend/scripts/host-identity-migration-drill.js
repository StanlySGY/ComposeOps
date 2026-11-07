import { parseArgs } from 'node:util';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// 输入必须是已关闭连接的备份副本；本脚本从不打开或修改源库。
const { values } = parseArgs({ options: { backup: { type: 'string' } } });
if (!values.backup) throw new Error('用法：node backend/scripts/host-identity-migration-drill.js --backup=/外部目录/独立备份.db');
const backup = resolve(values.backup);
if (!statSync(backup).isFile()) throw new Error('备份路径不是文件');
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const before = digest(backup);
const root = mkdtempSync(join(tmpdir(), 'composeops-identity-drill-'));
try {
  const target = join(root, 'drill.db');
  copyFileSync(backup, target);
  process.env.DB_PATH = target;
  const { default: db } = await import('../src/lib/db.js');
  const integrity = db.pragma('integrity_check', { simple: true });
  const foreignKeys = db.pragma('foreign_key_check');
  const version = db.pragma('user_version', { simple: true });
  if (integrity !== 'ok' || foreignKeys.length) throw new Error('迁移副本的完整性检查失败');
  db.close();
  copyFileSync(backup, target);
  if (digest(target) !== before || digest(backup) !== before) throw new Error('还原副本或源备份校验失败');
  console.log(JSON.stringify({ ok: true, version, integrity, foreignKeyErrors: 0, restoredByteForByte: true, sourceUnchanged: true }));
} finally { rmSync(root, { recursive: true, force: true }); }
