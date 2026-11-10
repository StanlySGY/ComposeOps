import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function readBackupObservation(source) {
  try { return JSON.parse(await readFile(`${source}.backup-status.json`, 'utf8')); }
  catch (error) { return { state: 'unknown', reason: error.code === 'ENOENT' ? '尚无可核验的平台备份记录' : '平台备份观测无法读取' }; }
}
export async function writeBackupObservation(source, observation) {
  const file = `${source}.backup-status.json`, temporary = `${file}.${randomUUID()}`;
  try {
    const previous = await readBackupObservation(source);
    if (previous.startedAt > observation.startedAt) return false;
    const value = { ...observation, lastSuccessAt: observation.state === 'succeeded' ? observation.finishedAt : previous.lastSuccessAt ?? null,
      lastSuccessDurationMs: observation.state === 'succeeded' ? observation.durationMs : previous.lastSuccessDurationMs ?? null };
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    return true;
  } catch { return false; }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
