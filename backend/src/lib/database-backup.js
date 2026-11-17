import Database from './sqlite.js';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeBackupObservation } from './backup-observation.js';

function verifyConnection(database) {
  const results = database.pragma('integrity_check');
  if (results.length !== 1 || results[0].integrity_check !== 'ok') throw new Error('数据库完整性校验未通过');
}

export function verifyDatabase(file) {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    verifyConnection(database);
    return { ok: true };
  } finally { database.close(); }
}

/** SQLite 快照导出：源库和产物各做一次完整校验，再原子发布。 */
export async function backupDatabase(source, destination, { onProgress = () => {} } = {}) {
  const startedAt = Date.now();
  source = path.resolve(source);
  await writeBackupObservation(source, { state: 'running', startedAt });
  try {
    const result = await createDatabaseSnapshot(source, destination, { onProgress });
    const finishedAt = Date.now();
    const observationRecorded = await writeBackupObservation(source, { state: 'succeeded', startedAt, finishedAt, durationMs: finishedAt - startedAt, bytes: result.bytes });
    return { ...result, durationMs: finishedAt - startedAt, observationRecorded };
  } catch (error) {
    const finishedAt = Date.now();
    await writeBackupObservation(source, { state: 'failed', startedAt, finishedAt, durationMs: finishedAt - startedAt, reason: '备份或完整性校验失败，请查看备份任务输出' });
    throw error;
  }
}
async function createDatabaseSnapshot(source, destination, { onProgress }) {
  const started = performance.now();
  const progress = (stage) => onProgress({ stage, elapsedMs: Math.round(performance.now() - started) });
  source = path.resolve(source);
  destination = path.resolve(destination);
  if (source === destination) throw new Error('备份路径不能与源数据库相同');
  const temporary = `${destination}.partial-${randomUUID()}`;
  // VACUUM INTO 拒绝只读源连接,备份用可写连接打开(源库内容不变,只写目标文件)。
  progress('open-source');
  // Read-only opening rejects a plaintext source when a key is configured; a backup must never migrate the source.
  const guard = new Database(source, { readonly: true, fileMustExist: true });
  guard.close();
  const database = new Database(source, { fileMustExist: true });
  try {
    progress('verify-source');
    verifyConnection(database);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    // VACUUM INTO 要求目标文件不存在;UUID 后缀避免并发冲突,失败时 finally 清理。
    progress('snapshot');
    database.vacuumInto(temporary);
    // VACUUM INTO 按 umask 建文件;快照含敏感运维数据,发布前收紧到 0600。
    await chmod(temporary, 0o600);
    // A standalone file is easier to transfer and restore than a WAL + SHM family.
    const snapshot = new Database(temporary, { fileMustExist: true });
    try {
      snapshot.pragma('journal_mode = DELETE');
      progress('verify-snapshot');
      verifyConnection(snapshot);
    }
    finally { snapshot.close(); }
    // Hard-link publishes atomically and refuses to overwrite an existing backup.
    progress('publish');
    await link(temporary, destination);
    progress('complete');
    return { ok: true, file: destination, bytes: (await stat(destination)).size };
  } finally {
    database.close();
    await rm(temporary, { force: true });
    await rm(`${temporary}-wal`, { force: true });
    await rm(`${temporary}-shm`, { force: true });
  }
}
