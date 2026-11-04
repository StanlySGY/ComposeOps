const SENSITIVE_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|\bPASS\b|(?:API|PRIVATE|ACCESS|SECRET|AUTH|SIGNING)[_-]?KEY)/i;
const MAX_STRING_LENGTH = 12000;

export function isSensitiveKey(key = '') {
  return SENSITIVE_KEY.test(String(key));
}

export function redactText(value) {
  return String(value ?? '')
    .replace(/((?:authorization\s*:\s*)?bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:SECRET|TOKEN|PASSWORD|PASSWD|PASS|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|AUTH[_-]?KEY|SIGNING[_-]?KEY)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:"|')?(?:SECRET|TOKEN|PASSWORD|PASSWD|PASS|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|AUTH[_-]?KEY|SIGNING[_-]?KEY)(?:"|')?\s*:\s*")([^"]*)(")/gi, '$1[REDACTED]$3')
    .slice(0, MAX_STRING_LENGTH);
}

export function redactValue(value, key = '') {
  if (isSensitiveKey(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactValue(entryValue, entryKey),
    ]));
  }
  return value;
}

export function redactRows(rows = []) {
  return Array.isArray(rows) ? rows.map((row) => redactValue(row)) : rows;
}

/** 回滚原文仅在当前调用栈可见,不会被 JSON 序列化或审计落库。 */
export function attachPrivateRollback(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: false, configurable: false, writable: false });
  return target;
}
