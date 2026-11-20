import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { encryptBusinessBackup, readBusinessBackupKey, prepareBusinessBackup } from '../src/lib/business-backup-crypto.js';
const dir = await mkdtemp(path.join(tmpdir(), 'backup-crypto-'));
const dataDir = path.join(dir, 'data'); await mkdir(dataDir);
const keyFile = path.join(dir, 'keys.json');
process.env.BUSINESS_BACKUP_KEYS_FILE = keyFile;
process.env.DB_PATH = path.join(dataDir, 'db.sqlite');
const ring = { active: 'new', keys: { old: 'ab'.repeat(32), new: 'cd'.repeat(32) } };
await writeFile(keyFile, JSON.stringify(ring), { mode: 0o600 });
test.after(() => rm(dir, { recursive: true, force: true }));
const collect = async source => { const out = []; for await (const chunk of source) out.push(chunk); return Buffer.concat(out); };
const identity = body => ({ bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
async function archive(id = 'old') {
  const material = readBusinessBackupKey(id), context = 'fixed-backup-identity';
  const body = await collect(encryptBusinessBackup([gzipSync('private business rows')], { ...material, context }));
  material.key.fill(0);
  return { body, expected: { ...identity(body), context, protection: { algorithm: 'aes-256-gcm', keyId: id, context } } };
}
test('轮换保留旧密钥可恢复，验证后替换路径不会改变恢复内容', async () => {
  const { body, expected } = await archive(), file = path.join(dataDir, 'archive'); await writeFile(file, body);
  assert.equal(body.includes(Buffer.from('private business rows')), false);
  const prepared = await prepareBusinessBackup(file, expected);
  try { await writeFile(file, 'changed'); assert.equal(gunzipSync(await collect(prepared.stream())).toString(), 'private business rows'); }
  finally { await prepared.close(); }
  assert.deepEqual(await readdir(dataDir), ['archive']);
});
test('篡改头、密文、标签或身份，即使重算 SHA 也拒绝；失败清理验证副本', async () => {
  const { body, expected } = await archive(), file = path.join(dataDir, 'archive');
  for (const offset of [8, 35, body.length - 20, body.length - 1]) {
    const bad = Buffer.from(body); bad[offset] ^= 1; await writeFile(file, bad);
    await assert.rejects(prepareBusinessBackup(file, { ...expected, ...identity(bad) }));
    assert.deepEqual(await readdir(dataDir), ['archive']);
  }
  await writeFile(file, body);
  await assert.rejects(prepareBusinessBackup(file, { ...expected, context: 'other-backup' }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareBusinessBackup(file, { ...expected, signal: controller.signal }));
});
test('旧 gzip 备份仍可恢复，损坏的 gzip 不能通过预验证', async () => {
  const file = path.join(dataDir, 'archive'), body = gzipSync('legacy rows'); await writeFile(file, body);
  const prepared = await prepareBusinessBackup(file, identity(body));
  try { await writeFile(file, 'changed'); assert.equal(gunzipSync(await collect(prepared.stream())).toString(), 'legacy rows'); }
  finally { await prepared.close(); }
  const bad = body.subarray(0, body.length - 5); await writeFile(file, bad);
  await assert.rejects(prepareBusinessBackup(file, identity(bad)));
});
test('密钥权限过宽、位于数据目录或软链均拒绝且不暴露密钥', async () => {
  await chmod(keyFile, 0o644); assert.throws(() => readBusinessBackupKey(), error => !error.message.includes(ring.keys.new)); await chmod(keyFile, 0o600);
  const link = path.join(dir, 'link'); await symlink(keyFile, link);
  assert.throws(() => readBusinessBackupKey(undefined, { env: { BUSINESS_BACKUP_KEYS_FILE: link }, dataDir }));
  const inside = path.join(dataDir, 'key'); await writeFile(inside, JSON.stringify(ring), { mode: 0o600 });
  assert.throws(() => readBusinessBackupKey(undefined, { env: { BUSINESS_BACKUP_KEYS_FILE: inside }, dataDir }));
});
