import path from 'node:path';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  chmodSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const directory = path.resolve(
  process.env.MAINTENANCE_DATA_DIR ||
    path.join(
      path.dirname(process.env.DB_PATH || fileURLToPath(new URL('../../data/opsdash.db', import.meta.url))),
      'maintenance',
    ),
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
export const keyPath = process.env.MAINTENANCE_KEY_FILE ? path.resolve(process.env.MAINTENANCE_KEY_FILE) : path.join(directory, 'recovery.key');
if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
chmodSync(keyPath, 0o600);
const key = readFileSync(keyPath);
if (key.length !== 32) throw new Error('完整备份恢复密钥格式错误，不能覆盖已有密钥');
const location = path.join(directory, 'catalog.json');
let state = existsSync(location)
  ? JSON.parse(readFileSync(location, 'utf8'))
  : { version: 1, settings: {}, tasks: [], backups: [], targets: [] };
export function catalog() {
  return structuredClone(state);
}
export function mutateCatalog(fn) {
  const next = structuredClone(state);
  const result = fn(next);
  writeFileSync(location + '.tmp', JSON.stringify(next), { mode: 0o600 });
  const file = openSync(location + '.tmp', 'r+');
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(location + '.tmp', location);
  const parent = openSync(directory, 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
  state = next;
  return result;
}
export function recoveryKey() {
  return Buffer.from(key);
}
export function seal(value) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
}
export function unseal(value) {
  const data = Buffer.from(value, 'base64'),
    decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString());
}
