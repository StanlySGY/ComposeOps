import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { constants, openSync, readFileSync, closeSync, fstatSync, realpathSync } from 'node:fs';
import { open, mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from('COBKP001');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const within = (root, file) => { const p = path.relative(root, file); return p === '' || (!p.startsWith('..' + path.sep) && p !== '..' && !path.isAbsolute(p)); };
const fail = () => new Error('业务备份密钥未配置或不可安全读取；请检查外置密钥文件、权限和密钥版本');

/** External key ring permits rotation without making retained backups unreadable. Never returns key bytes to APIs. */
export function readBusinessBackupKey(keyId, { env = process.env, dataDir = path.dirname(env.DB_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/opsdash.db')) } = {}) {
  let fd;
  try {
    const file = env.BUSINESS_BACKUP_KEYS_FILE;
    if (!file || !path.isAbsolute(file)) throw fail();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd), real = realpathSync(file);
    const data = realpathSync(dataDir);
    if (!info.isFile() || info.size > 16384 || (info.mode & 0o077) || within(realpathSync(ROOT), real) || within(data, real)) throw fail();
    const ring = JSON.parse(readFileSync(fd, 'utf8'));
    if (!ring || !ring.keys || Array.isArray(ring.keys) || typeof ring.keys !== 'object' || !/^[a-zA-Z0-9_-]{1,64}$/.test(ring.active || '')) throw fail();
    if (Object.keys(ring.keys).length > 32 || Object.entries(ring.keys).some(([id, key]) => !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key))) throw fail();
    if (!ring.keys[ring.active]) throw fail();
    const id = keyId ?? ring.active;
    if (!Object.hasOwn(ring.keys, id)) throw fail();
    return { keyId: id, key: Buffer.from(ring.keys[id], 'hex') };
  } catch { throw fail(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function businessBackupProtectionStatus() {
  try { const { key, keyId } = readBusinessBackupKey(); key.fill(0); return { ready: true, algorithm: 'aes-256-gcm', activeKeyId: keyId }; }
  catch (error) { return { ready: false, algorithm: 'aes-256-gcm', message: error.message }; }
}

/** Stream gzip bytes through authenticated encryption; plaintext never reaches a temporary archive. */
export async function* encryptBusinessBackup(source, { key, keyId, context }) {
  const iv = randomBytes(12);
  const metadata = Buffer.from(JSON.stringify({ algorithm: 'aes-256-gcm', keyId, context, iv: iv.toString('hex') }));
  const length = Buffer.alloc(4); length.writeUInt32BE(metadata.length);
  const header = Buffer.concat([MAGIC, length, metadata]);
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(header);
  yield header;
  for await (const chunk of source) yield cipher.update(chunk);
  yield cipher.final(); yield cipher.getAuthTag();
}

const authenticationError = () => new Error('业务备份认证失败：文件损坏、密钥不匹配或备份身份不一致');
async function readExact(handle, length, position, signal) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) throw authenticationError();
    offset += bytesRead;
  }
  return buffer;
}
async function* fileBytes(handle, signal, start = 0, end = Infinity) {
  const size = Math.min((await handle.stat()).size, end);
  for (let at = start; at < size; at += 65536) yield await readExact(handle, Math.min(65536, size - at), at, signal);
}
async function* decryptHandle(handle, { key, keyId, context, signal }) {
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 30) throw authenticationError();
    const prefix = await readExact(handle, 12, 0, signal);
    const length = prefix.readUInt32BE(8);
    if (!prefix.subarray(0, 8).equals(MAGIC) || length < 2 || length > 4096 || info.size <= 12 + length + 16) throw authenticationError();
    const metadata = await readExact(handle, length, 12, signal);
    const header = JSON.parse(metadata.toString('utf8'));
    if (header.algorithm !== 'aes-256-gcm' || header.keyId !== keyId || header.context !== context || !/^[a-f0-9]{24}$/.test(header.iv)) throw authenticationError();
    const tag = await readExact(handle, 16, info.size - 16, signal);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'hex'), { authTagLength: 16 });
    decipher.setAAD(Buffer.concat([prefix, metadata])); decipher.setAuthTag(tag);
    for await (const chunk of fileBytes(handle, signal, 12 + length, info.size - 16)) yield decipher.update(chunk);
    yield decipher.final();
  } catch (error) { if (signal?.aborted) throw signal.reason; throw authenticationError(); }
}
/** Internal verification stream: callers MUST discard all output on authentication failure. */
export async function* decryptBusinessBackup(file, options) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { yield* decryptHandle(handle, options); }
  finally { await handle.close(); }
}

/** Pin a private, unlinked ciphertext copy, authenticate and gunzip it BEFORE any restore writes.
 * Restore reads the same descriptor: swapping or changing the archive path cannot change its bytes.
 * No decrypted backup is written to disk. The copy is removed even on cancellation or auth failure.
 */
export async function prepareBusinessBackup(file, { protection, context, sha256, bytes, signal } = {}) {
  let source, handle, temporary, material;
  try {
    signal?.throwIfAborted();
    source = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await source.stat();
    if (!info.isFile() || info.size !== bytes || bytes > 2.1 * 1024 ** 3) throw authenticationError();
    const digest = createHash('sha256');
    const archiveContext = protection ? context : 'legacy-verification';
    if (protection) {
      if (protection.algorithm !== 'aes-256-gcm' || protection.context !== context || !protection.keyId) throw authenticationError();
      material = readBusinessBackupKey(protection.keyId);
    } else {
      // Preserve legacy restore without writing another plaintext copy or leaving a mutable source open.
      material = { key: randomBytes(32), keyId: 'ephemeral' };
    }
    temporary = await mkdtemp(path.join(path.dirname(file), '.verify-'));
    const copy = path.join(temporary, 'ciphertext'), original = source;
    const chunks = async function* () { for await (const chunk of fileBytes(original, signal, 0, info.size)) { digest.update(chunk); yield chunk; } };
    await pipeline(protection ? chunks : () => encryptBusinessBackup(chunks(), { ...material, context: archiveContext }),
      createWriteStream(copy, { flags: 'wx', mode: 0o600, flush: true }), { signal });
    handle = await open(copy, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    await rm(copy); await rm(temporary, { recursive: true }); temporary = undefined;
    source = undefined; await original.close();
    if (digest.digest('hex') !== sha256) throw authenticationError();
    const stream = () => Readable.from(decryptHandle(handle, { ...material, context: archiveContext, signal }));
    let rawBytes = 0;
    await pipeline(stream(), createGunzip(), new Writable({ write(chunk, _, done) {
      rawBytes += chunk.length; done(rawBytes > 2 * 1024 ** 3 ? new Error('业务备份超出容量限制') : undefined);
    } }), { signal });
    if (!rawBytes) throw authenticationError();
    let closed = false;
    return { rawBytes, stream() { if (closed) throw new Error('业务备份已关闭'); return stream(); }, async close() {
      if (closed) return; closed = true; material?.key.fill(0); await handle.close();
    } };
  } catch (error) {
    await handle?.close(); material?.key.fill(0); throw error;
  } finally { await source?.close(); if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
