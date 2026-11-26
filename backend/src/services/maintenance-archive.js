import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform, Writable } from 'node:stream';

const MAGIC = Buffer.from('COFB01');
export async function digestFile(file, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}
export async function encryptArtifact(input, file, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const output = createWriteStream(file, { flags: 'wx', mode: 0o600 });
  output.write(Buffer.concat([MAGIC, iv]));
  await pipeline(typeof input === 'string' ? Readable.from([input]) : input, cipher, output);
  const handle = await open(file, 'a');
  try {
    await handle.write(cipher.getAuthTag());
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { file: file.split('/').pop(), bytes: (await stat(file)).size, sha256: await digestFile(file) };
}
export async function decryptArtifact(file, key, output = null) {
  const size = (await stat(file)).size;
  if (size < 34) throw new Error('备份文件不完整');
  const handle = await open(file, 'r');
  const header = Buffer.alloc(18),
    tag = Buffer.alloc(16);
  try {
    await handle.read(header, 0, 18, 0);
    await handle.read(tag, 0, 16, size - 16);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, 6).equals(MAGIC)) throw new Error('备份文件格式不正确');
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(6));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  const hash = createHash('sha256');
  const meter = new Transform({
    transform(data, encoding, callback) {
      hash.update(data);
      callback(null, data);
    },
  });
  await pipeline(
    createReadStream(file, { start: 18, end: size - 17 }),
    decipher,
    meter,
    output ||
      new Writable({
        write(data, encoding, callback) {
          callback();
        },
      }),
  );
  return hash.digest('hex');
}
