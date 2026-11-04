/**
 * 值级密钥脱敏(SecretSet 式,借鉴 EnsoCode src/main/services/secretRedactor.ts)。
 *
 * redaction.js 的键名正则只能挡"键名敏感"的结构化字段,防不住
 * `MYSQL_ROOT_PASSWORD=xxx` 这类值以自由文本形态出现在日志/工具结果里。
 * 这里补第二层:工具结果回喂 LLM 前先 harvest——凡键名命中 SENSITIVE_KEY 的
 * 值都会被收进"已知密钥值"集合;之后 redact() 把这些值在一切出站文本
 * (工具结果、挂载日志、页面上下文、最终回复、持久化历史)里的再次出现抹掉。
 *
 * 单用户控制台,集合按进程生命周期累积;提供 reset 仅供测试。
 */
import { isSensitiveKey, redactText } from './redaction.js';

const VALUE_MIN = 4;
const VALUE_MAX = 400;
const MAX_VALUES = 300;

/** KEY=VALUE(KEY 形态宽松,由 isSensitiveKey 把关)与 JSON "KEY":"VALUE" 两种收割形态。 */
const HARVEST_PATTERNS = [
  /(?:^|[\n|;,]|[\s"'{(])([A-Za-z][A-Za-z0-9_.-]{1,63})\s*=\s*(?:"([^"\n]{1,400})"|'([^'\n]{1,400})'|([^\s,;|&`]{1,400}))/g,
  /"([A-Za-z][A-Za-z0-9_.-]{1,63})"\s*:\s*"([^"\n]{1,400})"/g,
];

/** 不依赖键名的静态密钥形态(与 redaction.js 的键值形态互补)。 */
const STATIC_SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b(gh[pou]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(xox[bparsa]-[A-Za-z0-9-]{10,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
];

const harvested = new Set();
const STREAM_TOKEN_PREFIXES = [
  'sk-', 'ghp_', 'gho_', 'ghu_', 'github_pat_', 'xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-', 'AKIA',
  'authorization', 'bearer', 'SECRET', 'TOKEN', 'PASSWORD', 'PASSWD', 'PASS',
  'API_KEY', 'API-KEY', 'PRIVATE_KEY', 'PRIVATE-KEY', 'ACCESS_KEY', 'ACCESS-KEY',
  'AUTH_KEY', 'AUTH-KEY', 'SIGNING_KEY', 'SIGNING-KEY',
  'apiKey', 'privateKey', 'accessKey', 'authKey', 'signingKey',
  '"API_KEY"', '"apiKey"', '"password"', '"token"', '"secret"', "'API_KEY'", "'apiKey'", "'password'", "'token'", "'secret'",
];
const SENSITIVE_ASSIGNMENT_TAIL = /(?:^|[\s,{;])((?:"([^"]{2,64})"|'([^']{2,64})'|([A-Za-z][A-Za-z0-9_.-]{1,63}))\s*[:=]\s*["']?[^"'\s,;|&]*)$/;
const BEARER_TAIL = /(?:^|[\s,{;])(authorization\s*:\s*bearer\s+[A-Za-z0-9._~+/-]*)$/i;
const BEARER_GENERIC_TAIL = /(?:^|[^A-Za-z0-9])(bearer\s+[A-Za-z0-9._~+/-]*)$/i;
const AUTHORIZATION_COLON_TAIL = /(?:^|[^A-Za-z0-9])(authorization\s*:\s*)$/i;
const BEARER_PREFIX_TAIL = /(?:^|[^A-Za-z0-9])(authorization\s*:\s*b(?:e(?:a(?:r(?:e(?:r)?)?)?)?)?)$/i;

function looksLikePlaceholder(value) {
  const v = value.trim().toLowerCase();
  if (!v) return true;
  if (/^(?:\[?redacted\]?|\*+|x{3,}|\.{3,}|<{2,}|>{2,}|null|none|empty|changeme|change[-_]?me|your[-_]?[a-z]+|todo|example|test|placeholder|<[^>]+>|\$\{[^}]*\})$/.test(v)) return true;
  return false;
}

/**
 * 从任意文本收割敏感值(键名命中 SENSITIVE_KEY 才收),去重并限制集合规模。
 * 返回本次新收割的值数量,便于测试与调试。
 */
export function harvestSecretValues(text) {
  const source = String(text ?? '');
  if (!source || source.length > 2_000_000) return 0;
  let added = 0;
  for (const pattern of HARVEST_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const key = match[1];
      const value = [match[2], match[3], match[4]].find((item) => typeof item === 'string' && item.length) || '';
      if (!key || !isSensitiveKey(key)) continue;
      const trimmed = value.trim();
      if (trimmed.length < VALUE_MIN || trimmed.length > VALUE_MAX) continue;
      if (looksLikePlaceholder(trimmed)) continue;
      if (!harvested.has(trimmed)) {
        // 集合超限时淘汰最早的一条,保持内存与替换成本有界
        if (harvested.size >= MAX_VALUES) harvested.delete(harvested.values().next().value);
        harvested.add(trimmed);
        added += 1;
      }
    }
  }
  return added;
}


/**
 * Returns the number of trailing characters that may still be part of a secret.
 * The caller holds this suffix until the next chunk clarifies its boundary, then
 * runs redactSecrets() on the complete text before emitting it.
 */
export function secretStreamHoldbackLength(text) {
  const source = String(text ?? '');
  if (!source) return 0;
  let hold = 0;

  for (const secret of harvested) {
    const max = Math.min(secret.length - 1, source.length);
    for (let length = max; length > hold; length -= 1) {
      if (source.endsWith(secret.slice(0, length))) {
        hold = length;
        break;
      }
    }
  }

  const staticTail = /(?:^|[^A-Za-z0-9])((?:sk-[A-Za-z0-9_-]*|gh[pou]_[A-Za-z0-9]*|github_pat_[A-Za-z0-9_]*|xox[bparsa]-[A-Za-z0-9-]*|AKIA[0-9A-Z]*))$/i.exec(source);
  if (staticTail) hold = Math.max(hold, staticTail[1].length);

  for (const prefix of STREAM_TOKEN_PREFIXES) {
    const max = Math.min(prefix.length, source.length);
    for (let length = max; length > hold; length -= 1) {
      if (!prefix.toLowerCase().startsWith(source.slice(-length).toLowerCase())) continue;
      const boundary = source.length === length ? '' : source[source.length - length - 1];
      if (!boundary || !/[A-Za-z0-9]/.test(boundary)) {
        hold = length;
        break;
      }
    }
  }

  const assignmentTail = SENSITIVE_ASSIGNMENT_TAIL.exec(source);
  if (assignmentTail) {
    const key = assignmentTail[2] || assignmentTail[3] || assignmentTail[4] || '';
    if (isSensitiveKey(key)) hold = Math.max(hold, assignmentTail[1].length);
  }
  const bearerPrefixTail = BEARER_PREFIX_TAIL.exec(source);
  if (bearerPrefixTail) hold = Math.max(hold, bearerPrefixTail[1].length);
  const authorizationTail = AUTHORIZATION_COLON_TAIL.exec(source);
  if (authorizationTail) hold = Math.max(hold, authorizationTail[1].length);
  const bearerTail = BEARER_TAIL.exec(source);
  if (bearerTail) hold = Math.max(hold, bearerTail[1].length);
  const bearerGenericTail = BEARER_GENERIC_TAIL.exec(source);
  if (bearerGenericTail) hold = Math.max(hold, bearerGenericTail[1].length);

  return hold;
}

/**
 * 对成功结束时仍停留在潜在秘密前缀中的尾片段执行保守遮蔽。
 * 例如上游刚好在 sk-abc 或已收割密钥的前半段结束，不能把未完成 token 原样 flush。
 */
export function redactSecretStreamTail(text) {
  const source = String(text ?? '');
  const hold = secretStreamHoldbackLength(source);
  if (!hold) return redactSecrets(source);

  const tail = source.slice(-hold);
  const harvestedPrefix = tail.length >= 4
    && [...harvested].some((secret) => secret.startsWith(tail));
  const staticTokenPrefix = /(?:^|[^A-Za-z0-9])(?:sk-|gh[pou]_|github_pat_|xox[bparsa]-|AKIA)[A-Za-z0-9_-]*$/i.test(tail);
  const assignmentTail = SENSITIVE_ASSIGNMENT_TAIL.exec(source);
  const assignmentKey = assignmentTail && (assignmentTail[2] || assignmentTail[3] || assignmentTail[4] || '');
  const keyOrBearerPrefix = Boolean(
    (assignmentTail && isSensitiveKey(assignmentKey))
    || BEARER_PREFIX_TAIL.exec(source)
    || AUTHORIZATION_COLON_TAIL.exec(source)
    || BEARER_TAIL.exec(source)
    || BEARER_GENERIC_TAIL.exec(source)
  );
  if (harvestedPrefix || staticTokenPrefix || keyOrBearerPrefix) {
    return redactSecrets(source.slice(0, source.length - hold)) + '[REDACTED]';
  }
  return redactSecrets(source);
}

/**
 * 对出站文本做值级脱敏:先过键值形态/Bearer 的静态规则,再按"最长优先"
 * 逐个替换已知密钥值(split/join 避免正则转义问题),最后补静态 token 形态。
 */
export function redactSecrets(text) {
  let out = redactText(text);
  if (harvested.size) {
    const values = [...harvested].sort((a, b) => b.length - a.length);
    for (const value of values) out = out.split(value).join('[REDACTED]');
  }
  for (const pattern of STATIC_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

/**
 * 对将要持久化或输出的结构化数据递归脱敏。
 * 既处理敏感字段名，也处理此前从配置/日志中收割到的秘密值及自由文本中的重复出现。
 */
export function redactSecretValue(value, key = '') {
  if (isSensitiveKey(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactSecretValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactSecretValue(entryValue, entryKey),
    ]));
  }
  return value;
}

/** 仅供测试:清空已收割集合。 */
export function resetSecretRedactor() {
  harvested.clear();
}
