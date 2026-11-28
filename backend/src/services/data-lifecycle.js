import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import db, { DB_PATH, getSetting, setSetting } from '../lib/db.js';
import { readDatabaseEncryptionKey } from '../lib/sqlite.js';

const size = file => { try { return fs.statSync(file).size; } catch { return 0; } };
export function dataLifecycleStatus() {
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  const pageCount = Number(db.pragma('page_count', { simple: true }));
  const freePages = Number(db.pragma('freelist_count', { simple: true }));
  const disk = fs.statfsSync(path.dirname(DB_PATH));
  const freeBytes = disk.bavail * disk.bsize, capacityBytes = disk.blocks * disk.bsize;
  const databaseBytes = size(DB_PATH), walBytes = size(DB_PATH + '-wal');
  const warnings = [];
  if (freeBytes < Math.max(2 * 1024 ** 3, databaseBytes * 1.2)) warnings.push('可用空间不足以安全制作完整数据库副本，请先扩容或转移备份');
  if (capacityBytes && freeBytes / capacityBytes < .1) warnings.push('数据库所在磁盘可用空间低于 10%');
  if (walBytes > 1024 ** 3) warnings.push('数据库 WAL 超过 1 GiB，请检查长事务与备份任务');
  let lastArchive = null; try { lastArchive = JSON.parse(getSetting('retention.run_archive_last', 'null')); } catch { /* corrupted observation */ }
  return { databaseBytes, walBytes, allocatedBytes: pageSize * pageCount, reusableBytes: pageSize * freePages, freeBytes, capacityBytes, warnings,
    archiveEnabled: getSetting('retention.run_archive_enabled', '0') === '1', archiveConfigured: !!process.env.AGENT_ARCHIVE_DIR,
    retentionDays: 90, lastArchive, note: '删除记录后的空页可被 SQLite 复用，文件不会立刻缩小；在线不执行全库 VACUUM。归档仅处理 90 天前已完成任务的事件，任务结果与副作用证据保留。' };
}
function archiveKey() {
  const key = readDatabaseEncryptionKey();
  if (!key) throw new Error('事件归档需要外置数据库加密密钥');
  return createHash('sha256').update('composeops-run-archive-v1\0').update(key).digest();
}
export function readRunArchive(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 8).toString() !== 'COARCH01') throw new Error('归档格式无效');
  const decipher = createDecipheriv('aes-256-gcm', archiveKey(), bytes.subarray(8, 20));
  decipher.setAAD(Buffer.from('COARCH01')); decipher.setAuthTag(bytes.subarray(20, 36));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(36)), decipher.final()]).toString());
}
/** Small bounded batches; publish and decrypt-verify before deleting exact immutable event IDs. */
export function archiveCompletedRunEvents(now = Date.now()) {
  if (getSetting('retention.run_archive_enabled', '0') !== '1') return { disabled: true };
  const root = process.env.AGENT_ARCHIVE_DIR;
  if (!root || !path.isAbsolute(root)) throw new Error('请配置仓库外的 AGENT_ARCHIVE_DIR');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const real = fs.realpathSync(root), repo = path.resolve(import.meta.dirname, '../../..'), data = path.dirname(fs.realpathSync(DB_PATH));
  const within = (parent, child) => child === parent || child.startsWith(parent + path.sep);
  if (within(repo, real) || within(data, real) || (fs.statSync(real).mode & 0o077)) throw new Error('归档目录必须在仓库和数据库目录外，权限为 0700');
  const cutoff = now - 90 * 86400000;
  const rows = db.prepare(`SELECT e.* FROM agent_run_events e JOIN agent_runs r ON r.id=e.run_id
    WHERE e.created_at < ? AND r.updated_at < ? AND r.status='completed'
    AND NOT EXISTS (SELECT 1 FROM agent_run_effects f WHERE f.run_id=r.id AND f.status IN ('started','unknown'))
    ORDER BY e.id LIMIT 100`).all(cutoff, cutoff);
  if (!rows.length) return { archived: 0 };
  const payload = Buffer.from(JSON.stringify({ version: 1, archivedAt: now, cutoff, events: rows }));
  const disk = fs.statfsSync(real);
  if (disk.bavail * disk.bsize < payload.length * 3 + 100 * 1024 ** 2) throw new Error('归档目录可用空间不足');
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', archiveKey(), nonce);
  cipher.setAAD(Buffer.from('COARCH01'));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const bytes = Buffer.concat([Buffer.from('COARCH01'), nonce, cipher.getAuthTag(), ciphertext]);
  const name = `agent-events-${now}-${randomUUID()}.enc`, file = path.join(real, name);
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dirfd = fs.openSync(real, 'r'); try { fs.fsyncSync(dirfd); } finally { fs.closeSync(dirfd); }
  if (JSON.stringify(readRunArchive(file).events) !== JSON.stringify(rows)) throw new Error('归档解密核对失败，源记录保留');
  return db.transaction(() => {
    const remove = db.prepare(`DELETE FROM agent_run_events WHERE id=? AND run_id=? AND event_json=?
      AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.id=run_id AND r.status='completed' AND r.updated_at < ?)
      AND NOT EXISTS (SELECT 1 FROM agent_run_effects f WHERE f.run_id=agent_run_events.run_id AND f.status IN ('started','unknown'))`);
    let archived = 0;
    for (const row of rows) archived += remove.run(row.id, row.run_id, row.event_json, cutoff).changes;
    const result = { archived, file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), at: now, verified: true };
    setSetting('retention.run_archive_last', JSON.stringify(result));
    return result;
  })();
}
