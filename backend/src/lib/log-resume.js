/** Untrusted WS query: only exact container identities are used by callers. */
export function parseLogResume(value) {
  if (value === undefined) return Object.create(null);
  if (typeof value !== 'string' || value.length > 8192) throw new Error('日志续读参数无效');
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error('日志续读参数无效'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length > 64) throw new Error('日志续读参数无效');
  const result = Object.create(null);
  for (const [id, since] of Object.entries(parsed)) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !Number.isSafeInteger(since) || since <= 0) throw new Error('日志续读参数无效');
    result[id] = since;
  }
  return result;
}
