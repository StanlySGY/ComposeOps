import { timingSafeEqual } from 'node:crypto';

/** Normalize OpenSSH SHA-256 fingerprints (SHA256:base64) or raw 64-digit hex. */
export function normalizeSshFingerprint(value) {
  if (value == null || String(value).trim() === '') return '';

  const input = String(value).trim();
  if (input.startsWith('SHA256:')) {
    const encoded = input.slice('SHA256:'.length).replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/]{43}=?$/.test(encoded)) {
      throw Object.assign(new Error('SSH 主机指纹格式无效，请使用 SHA256:Base64 或 64 位 SHA-256 十六进制值'), { statusCode: 400 });
    }
    const digest = Buffer.from(encoded, 'base64');
    if (digest.length !== 32) {
      throw Object.assign(new Error('SSH 主机指纹必须是 SHA-256 指纹'), { statusCode: 400 });
    }
    return digest.toString('hex');
  }

  const hex = input.replace(/:/g, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hex)) {
    throw Object.assign(new Error('SSH 主机指纹格式无效，请使用 SHA256:Base64 或 64 位 SHA-256 十六进制值'), { statusCode: 400 });
  }
  return hex;
}

/** An empty pin preserves compatibility; a configured pin is checked using a constant-time comparison. */
export function createSshHostVerifier(fingerprint) {
  const normalized = normalizeSshFingerprint(fingerprint);
  if (!normalized) return null;
  const expected = Buffer.from(normalized, 'hex');
  return (actualHash) => {
    if (typeof actualHash !== 'string' || !/^[a-f0-9]{64}$/i.test(actualHash)) return false;
    const actual = Buffer.from(actualHash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}
