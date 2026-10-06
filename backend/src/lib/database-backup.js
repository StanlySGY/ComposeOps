import Database from './sqlite.js';
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export function verifyDatabase(file) {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const results = database.pragma('integrity_check');
    if (results.length !== 1 || results[0].integrity_check !== 'ok') throw new Error('数据库完整性校验未通过');
    return { ok: true };
  } finally { database.close(); }
}

/** SQLite online backup API includes committed WAL data; publish only a verified snapshot. */
export async function backupDatabase(source, destination) {
  source = path.resolve(source);
  destination = path.resolve(destination);
  if (source === destination) throw new Error('备份路径不能与源数据库相同');
  const database = new Database(source, { readonly: true, fileMustExist: true });
  const temporary = `${destination}.partial-${randomUUID()}`;
  try {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const handle = await open(temporary, 'wx', 0o600);
    await handle.close();
    await database.backup(temporary);
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
