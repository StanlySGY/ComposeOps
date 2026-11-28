const SENSITIVE_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|\bPASS\b|(?:API|PRIVATE|ACCESS|SECRET|AUTH|SIGNING)[_-]?KEY)/i;
const MAX_STRING_LENGTH = 12000;

export function isSensitiveKey(key = '') {
  return SENSITIVE_KEY.test(String(key));
}

/** Locate complete values, including quotes and escapes, before replacing any
 * text. Masking a prefix first would destroy the context needed for its tail. */
export function* sensitiveAssignments(source) {
  const heads = /(^|[^A-Za-z0-9_.$-])(?:(['"])([A-Za-z_][A-Za-z0-9_.-]{0,127})\2|([A-Za-z_][A-Za-z0-9_.-]{0,127}))[\t\n\r ]*[=:][ \t]*/g;
  let match;
  while ((match = heads.exec(source))) {
    const key = match[3] || match[4];
    const authorization = /^(?:proxy-)?authorization$/i.test(key);
    if (!authorization && !isSensitiveKey(key)) continue;
    const start = match.index + match[1].length;
    let valueStart = heads.lastIndex;
    // JSON may place a quoted value on the next line. An empty env assignment
    // must not eat the following setting, so only cross newlines for quotes.
    const afterWhitespace = source.slice(valueStart).search(/\S/);
    if (afterWhitespace > 0 && /['"]/.test(source[valueStart + afterWhitespace])) valueStart += afterWhitespace;
    const quote = /['"]/.test(source[valueStart] || '') ? source[valueStart] : '';
    let end = valueStart, valueEnd, complete = false;
    if (quote) {
      valueStart++; end = valueStart;
      while (end < source.length) {
        if (source[end] === '\\' && end + 1 < source.length) { end += 2; continue; }
        if (source[end] === quote) {
          if (quote === "'" && source[end + 1] === "'") { end += 2; continue; }
          complete = true; break;
        }
        end++;
      }
      valueEnd = end;
      if (complete) end++;
    } else {
      const delimiter = authorization ? /[\r\n"']/ : /[\s,;|&`"'\]})]/;
      if (source.startsWith('[REDACTED]', end)) end += '[REDACTED]'.length;
      while (end < source.length && !delimiter.test(source[end])) end++;
      valueEnd = end; complete = end < source.length;
      // Whitespace alone may still precede a JSON string in the next chunk.
      if (end === valueStart && /^\s*$/.test(source.slice(end))) complete = false;
    }
    yield { start, valueStart, valueEnd, end, quote, key, authorization, complete };
    heads.lastIndex = Math.max(heads.lastIndex, end);
  }
}

export function redactText(value) {
  const source = String(value ?? '');
  let output = '', cursor = 0;
  for (const span of sensitiveAssignments(source)) {
    output += source.slice(cursor, span.valueStart) + '[REDACTED]';
    cursor = span.valueEnd;
  }
  return (output + source.slice(cursor))
    .replace(/((?:authorization\s*:\s*)?bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
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
