import Database from './sqlite.js';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export function verifyDatabase(file) {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const results = database.pragma('integrity_check');
    if (results.length !== 1 || results[0].integrity_check !== 'ok') throw new Error('数据库完整性校验未通过');
    return { ok: true };
  } finally { database.close(); }
}

/** SQLite 快照导出:先只读校验源库,再用 VACUUM INTO 生成一致性快照并原子发布。 */
export async function backupDatabase(source, destination) {
  source = path.resolve(source);
  destination = path.resolve(destination);
  if (source === destination) throw new Error('备份路径不能与源数据库相同');
  // 只读连接做存在性/完整性守卫:missing 根本打不开,corrupt 在 integrity_check 抛出。
  verifyDatabase(source);
  const temporary = `${destination}.partial-${randomUUID()}`;
  // VACUUM INTO 拒绝只读源连接,备份用可写连接打开(源库内容不变,只写目标文件)。
  const database = new Database(source);
  try {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    // VACUUM INTO 要求目标文件不存在;UUID 后缀避免并发冲突,失败时 finally 清理。
    database.vacuumInto(temporary);
    // VACUUM INTO 按 umask 建文件;快照含敏感运维数据,发布前收紧到 0600。
    await chmod(temporary, 0o600);
    // A standalone file is easier to transfer and restore than a WAL + SHM family.
    const snapshot = new Database(temporary, { fileMustExist: true });
    try { snapshot.pragma('journal_mode = DELETE'); }
    finally { snapshot.close(); }
    verifyDatabase(temporary);
    // Hard-link publishes atomically and refuses to overwrite an existing backup.
    await link(temporary, destination);
    return { ok: true, file: destination, bytes: (await stat(destination)).size };
  } finally {
    database.close();
    await rm(temporary, { force: true });
    await rm(`${temporary}-wal`, { force: true });
    await rm(`${temporary}-shm`, { force: true });
  }
}
